import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { parse, type ParserOptions } from "@babel/parser";
import { isFunction, VISITOR_KEYS, type Node } from "@babel/types";
import lbug from "@ladybugdb/core";
import { cs_mast_init, CS_MAST_SIGNATURE_KEY, ParseError, sha256, type CsMastConfig } from "@shriyanss/cs-mast";

// Same options as js-recon, so both see the same AST for the same input.
export const PARSER_OPTIONS: ParserOptions = {
    sourceType: "unambiguous",
    plugins: ["jsx", "typescript"],
    errorRecovery: true,
};

/** `cs-mast` (default) is the Babel AST with a CS-MAST-S hash on every node; `babel` is the plain AST. */
export type Parser = "cs-mast" | "babel";

// Node types come from the @babel/types that cs-mast parses with (Babel 7), not ours (Babel 8).
const require = createRequire(import.meta.url);
const csMastBabelTypes: typeof import("@babel/types") = createRequire(require.resolve("@shriyanss/cs-mast"))("@babel/types");

// scat only covers 25 node types; every other type goes in sinc so every node is hashed.
// cs-mast drops sinc entries already covered by scat, so passing all types is fine.
export const CS_MAST_CONFIG: CsMastConfig = {
    hash: "sha256",
    lang: "js",
    prsr: "@babel/parser",
    scat: ["lit", "id", "op", "decl", "loop", "cond", "name", "val", "op_name"],
    sinc: Object.keys(csMastBabelTypes.VISITOR_KEYS),
    sourceType: "unambiguous",
};

function parseAst(code: string, parser: Parser): Node {
    if (parser === "babel") return parse(code, PARSER_OPTIONS) as unknown as Node;
    try {
        // cs-mast attaches signatures to the raw Babel nodes, so the File node is a normal Babel AST.
        return cs_mast_init(code, CS_MAST_CONFIG).root._raw as Node;
    } catch (e) {
        // cs-mast parses without errorRecovery; the babel parser tolerates more.
        if (e instanceof ParseError) throw new Error(`taintwire: ${e.message} (try { parser: "babel" })`, { cause: e });
        throw e;
    }
}

const BATCH_SIZE = 5000;
// Ladybug's default (8 TiB) mmap reservation is only released on GC, not close(), so a process ran out of
// address space after ~9 opens. 1 TiB is far beyond any AST graph.
const MAX_DB_SIZE = 2 ** 40;
// Not Babel node types, so they can't collide with an AST table.
const SOURCE = "Source";
const SCOPE = "Scope";

// Columns shared by every AST node table. `end` is a Cypher keyword, hence *Offset.
const COLUMNS = {
    id: "STRING PRIMARY KEY",
    type: "STRING",
    file: "STRING",
    startOffset: "INT64",
    endOffset: "INT64",
    line: "INT64",
    col: "INT64",
    endLine: "INT64",
    endCol: "INT64",
    name: "STRING",
    value: "STRING",
    operator: "STRING",
    props: "STRING",
    hash: "STRING", // hex digest of the CS-MAST-S signature; null for the babel parser
} as const;

// Node fields that are either columns already or noise for the graph.
const SKIP_PROPS = new Set(["type", "start", "end", "loc", "range", "leadingComments", "trailingComments", "innerComments", "comments", "errors", "tokens", CS_MAST_SIGNATURE_KEY]);

// Rel tables and their property columns. SON is AST containment; the rest are semantic overlays.
// READS/WRITES carry the Identifier occurrence: `access` (its node id) and `access_signature` (its hash, which is content-only).
const ACCESS = ["access STRING", "access_signature STRING"] as const;
const RELS = {
    SON: ["key STRING", "idx INT64"],
    DECLARES: [],
    CREATES_SCOPE: [],
    PARENT_SCOPE: [],
    IN_SCOPE: [],
    REFERS_TO: [],
    READS: ACCESS,
    WRITES: ACCESS,
    FLOWS_TO: [],
} as const;
type Rel = keyof typeof RELS;
const relMaps = () => Object.fromEntries(Object.keys(RELS).map((r) => [r, new Map()])) as Record<Rel, Edges>;

// Scope nodes: semantic, not AST, so they get their own table. Ids are deterministic (see scopeRow()).
const SCOPE_COLUMNS = { id: "STRING PRIMARY KEY", kind: "STRING", file: "STRING", signature: "STRING", owner_signature: "STRING" } as const;
export type ScopeKind = "global" | "module" | "function" | "block" | "catch" | "class" | "static_block";
type ScopeRow = Record<keyof typeof SCOPE_COLUMNS, string | null>;

type Row = Record<keyof typeof COLUMNS, string | number | null>;
type Edge = { from: string; to: string; key?: string; idx?: number; access?: string; access_signature?: string | null };
type Edges = Map<string, Edge[]>; // key: `${fromType}\0${toType}`
type Ref = { type: string; slug_ref: string };

const scalar = (v: unknown): string | null => {
    if (["string", "number", "boolean", "bigint"].includes(typeof v)) return String(v);
    // TemplateElement.value is { raw, cooked }
    if (v && typeof v === "object" && "raw" in v) return String((v as { cooked?: string; raw: string }).cooked ?? (v as { raw: string }).raw);
    return null;
};

// The Identifiers a binding pattern binds: pattern values (never object keys), defaults' left side only.
function bindingIds(p: Node | null | undefined): Node[] {
    switch (p?.type) {
        case "Identifier":
            return p.name === "this" ? [] : [p]; // TS `this` parameter isn't a binding
        case "ObjectPattern":
            return p.properties.flatMap((q) => bindingIds(q.type === "RestElement" ? q.argument : (q.value as Node)));
        case "ArrayPattern":
            return p.elements.flatMap(bindingIds);
        case "AssignmentPattern":
            return bindingIds(p.left);
        case "RestElement":
            return bindingIds(p.argument);
        case "TSParameterProperty":
            return bindingIds(p.parameter);
        default:
            return [];
    }
}

/** Identifier nodes `node` introduces as JS bindings (its DECLARES targets). Wrappers, patterns and control flow declare nothing. */
export function declared(node: Node): Node[] {
    switch (node.type) {
        case "VariableDeclarator": // var / let / const / using / await using
            return bindingIds(node.id);
        case "FunctionDeclaration":
        case "FunctionExpression":
            return [node.id, ...node.params].flatMap(bindingIds);
        case "ArrowFunctionExpression":
        case "ObjectMethod":
        case "ClassMethod":
        case "ClassPrivateMethod": // params only: the key is a property name, not a binding
            return node.params.flatMap(bindingIds);
        case "ClassDeclaration":
        case "ClassExpression":
            return bindingIds(node.id);
        case "ImportSpecifier": // the local name, not the imported one
        case "ImportDefaultSpecifier":
        case "ImportNamespaceSpecifier":
            return [node.local];
        case "CatchClause":
            return bindingIds(node.param);
        default:
            return [];
    }
}

const isLexical = (d: Node | null | undefined) => d?.type === "VariableDeclaration" && d.kind !== "var";

/** The kind of scope `node` creates, or null. `parent` tells a function/catch body apart from a nested block. */
export function scopeKind(node: Node, parent?: Node): ScopeKind | null {
    if (isFunction(node)) return "function";
    switch (node.type) {
        case "Program":
            return node.sourceType === "module" ? "module" : "global";
        case "ClassDeclaration":
        case "ClassExpression":
            return "class";
        case "StaticBlock":
            return "static_block";
        case "CatchClause":
            return "catch";
        case "SwitchStatement": // one scope shared by every case
            return "block";
        case "BlockStatement": // a function or catch body is part of that scope
            return parent && (isFunction(parent) || parent.type === "CatchClause") ? null : "block";
        case "ForStatement":
            return isLexical(node.init) ? "block" : null;
        case "ForInStatement":
        case "ForOfStatement":
            return isLexical(node.left) ? "block" : null;
        default:
            return null;
    }
}
// Scopes `var` binds in; the rest only hold lexical bindings.
const VAR_SCOPES = new Set<ScopeKind>(["global", "module", "function", "static_block"]);
// Children evaluated outside the scope their parent creates: method keys, decorators, the switch discriminant.
const OUTER_KEYS = new Set(["key", "decorators", "discriminant"]);

const hashOf = (n: Node): string | null => {
    const sig = (n as Node & { [CS_MAST_SIGNATURE_KEY]?: string })[CS_MAST_SIGNATURE_KEY];
    // Only the digest: the signature prefix lists every sinc type (~4.6 KB) and is identical on every node.
    return sig?.slice(sig.lastIndexOf("$") + 1) ?? null;
};

// id: unique per graph (file + owner position). signature: content-derived like `hash`, so identical code in two places shares it.
function scopeRow(kind: ScopeKind, owner: Node, file: string): ScopeRow {
    const ownerSig = hashOf(owner);
    return {
        id: `${SCOPE}_${sha256(`${file}\0${owner.type}\0${owner.start}\0${owner.end}`).slice(0, 16)}`,
        kind,
        file,
        signature: ownerSig && sha256(`scope:${kind}:${ownerSig}`),
        owner_signature: ownerSig,
    };
}

// TS nodes whose `expression` is a runtime value; every other Identifier under a TS node is type-level.
const TS_VALUES = new Set(["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "TSTypeAssertion", "TSInstantiationExpression", "TSExportAssignment"]);

/** Whether the Identifier at `parent[key]` is a lexical name lookup, not a property name, label, import/export name or type. */
export function isRef(parent: Node, key: string): boolean {
    if (key === "label" || key === "imported" || key === "exported") return false;
    if ((key === "key" || key === "property") && !(parent as { computed?: boolean }).computed) return false;
    if (parent.type === "PrivateName") return false;
    return !parent.type.startsWith("TS") || (TS_VALUES.has(parent.type) && key === "expression");
}

// Value-flow and binding-write facts, in AST nodes; flatten() resolves targets to declarations once every binding is known.
type Facts = {
    flows: [Node, Node][]; // value -> the expression/statement it contributes to
    stores: [Node, Node][]; // value -> the binding of a target Identifier
    writes: [Node, Node][]; // operation -> target Identifier
    writeOnly: Set<Node>; // target Identifiers that aren't also read
};

// Calls, member access, object/array literals, destructuring, iteration and await/yield add no flow yet (see docs/value-flow).
function facts(node: Node, f: Facts) {
    const into = (...xs: (Node | null | undefined)[]) => xs.forEach((x) => x && f.flows.push([x, node]));
    const write = (ts: Node[], only = false) => ts.forEach((t) => (f.writes.push([node, t]), only && f.writeOnly.add(t)));
    switch (node.type) {
        case "BinaryExpression":
        case "LogicalExpression":
            return into(node.left as Node, node.right);
        case "ConditionalExpression": // the test picks a value but isn't one: control, not data
            return into(node.consequent, node.alternate);
        case "UnaryExpression": // void is always undefined; delete's result says whether a property went away
            if (node.operator !== "void" && node.operator !== "delete") into(node.argument);
            return;
        case "TemplateLiteral":
            return into(...(node.expressions as Node[]));
        case "SequenceExpression": // only the last expression is the result
            return into(node.expressions.at(-1));
        case "ReturnStatement":
            return into(node.argument);
        case "UpdateExpression": // prefix and postfix both depend on the old value
            into(node.argument);
            write(bindingIds(node.argument));
            if (node.argument.type === "Identifier") f.stores.push([node, node.argument]);
            return;
        case "AssignmentExpression": // the expression's value is the right side (combined with the old value if compound)
            into(node.right, node.operator === "=" ? null : (node.left as Node));
            write(bindingIds(node.left as Node), node.operator === "=");
            if (node.left.type === "Identifier") f.stores.push([node, node.left]);
            return;
        case "VariableDeclarator":
            if (!node.init) return;
            write(bindingIds(node.id));
            if (node.id.type === "Identifier") f.stores.push([node.init, node.id]);
            return;
        case "AssignmentPattern": // a default value
            write(bindingIds(node.left));
            if (node.left.type === "Identifier") f.stores.push([node.right, node.left]);
            return;
        case "ForInStatement":
        case "ForOfStatement": {
            const decl = node.left.type === "VariableDeclaration";
            return write(decl ? (node.left as Node & { declarations: { id: Node }[] }).declarations.flatMap((d) => bindingIds(d.id)) : bindingIds(node.left), !decl);
        }
        default:
            if (TS_VALUES.has(node.type) && node.type !== "TSExportAssignment") into((node as Node & { expression: Node }).expression);
    }
}

/** Flatten a Babel AST into per-type node rows, Scope rows and per-(from,to)-type edges. */
export function flatten(ast: Node, file: string) {
    const ids = new Map<Node, string>();
    const idOf = (n: Node) => {
        let id = ids.get(n);
        if (!id) ids.set(n, (id = `${n.type}_${randomBytes(8).toString("hex")}`));
        return id;
    };
    const isNode = (v: unknown): v is Node => !!v && typeof (v as Node).type === "string";
    const ref = (v: unknown): Ref | unknown => (isNode(v) ? { type: v.type, slug_ref: idOf(v) } : v);

    const nodes = new Map<string, Row[]>();
    const scopes: ScopeRow[] = [];
    const rels = relMaps();
    const push = (rel: Rel, from: string, to: string, e: Edge) => {
        const pair = `${from}\0${to}`;
        if (!rels[rel].has(pair)) rels[rel].set(pair, []);
        rels[rel].get(pair)!.push(e);
    };
    const edge = (rel: Rel, a: Node, b: Node, e: Partial<Edge> = {}) => push(rel, a.type, b.type, { from: idOf(a), to: idOf(b), ...e });

    // Recorded during the walk, resolved after it: a use can come before its declaration, and later siblings are walked first.
    const parentScope = new Map<string, string>();
    const bindings = new Map<string, Map<string, Node>>(); // scope -> name -> its first declaration
    const declScope = new Map<Node, string>(); // DECLARES target -> its scope
    const uses: [Node, Node, string | undefined][] = []; // [Identifier, the operation it's an operand of, its scope]
    const notRef = new Set<Node>(); // `export { a } from "x"`: `a` is the other module's name
    const f: Facts = { flows: [], stores: [], writes: [], writeOnly: new Set() };

    // Iterative walk: minified bundles nest deep enough to blow the JS stack.
    // Each entry carries its parent and the scopes it sits in: `scope` for lexical bindings, `varScope` for var.
    type Ctx = { scope?: string; varScope?: string };
    const stack: [Node, Node | undefined, Ctx][] = [[ast, undefined, {}]];
    while (stack.length) {
        const [node, parent, outer] = stack.pop()!;
        const id = idOf(node);

        const kind = scopeKind(node, parent);
        let inner = outer;
        if (kind) {
            const s = scopeRow(kind, node, file);
            scopes.push(s);
            push("CREATES_SCOPE", node.type, SCOPE, { from: id, to: s.id! });
            if (outer.scope) {
                push("PARENT_SCOPE", SCOPE, SCOPE, { from: s.id!, to: outer.scope });
                parentScope.set(s.id!, outer.scope);
            }
            inner = { scope: s.id!, varScope: VAR_SCOPES.has(kind) ? s.id! : outer.varScope };
        }

        const keys: readonly string[] = VISITOR_KEYS[node.type] ?? [];
        const props: Record<string, unknown> = {};

        for (const [k, v] of Object.entries(node)) {
            if (SKIP_PROPS.has(k)) continue;
            if (!keys.includes(k)) {
                props[k] = v;
                continue;
            }
            // Child nodes become SON edges; the property keeps a slug reference to the child.
            props[k] = Array.isArray(v) ? v.map(ref) : ref(v);
            (Array.isArray(v) ? v : [v]).forEach((child, i) => {
                if (!isNode(child)) return;
                push("SON", node.type, child.type, { from: id, to: idOf(child), key: k, idx: Array.isArray(v) ? i : -1 });
                const ctx = OUTER_KEYS.has(k) ? outer : inner;
                stack.push([child, node, ctx]);
                if (child.type === "Identifier" && isRef(node, k)) uses.push([child, node, ctx.scope]);
            });
        }
        if (node.type === "ExportNamedDeclaration" && node.source) for (const s of node.specifiers) if (s.type === "ExportSpecifier") notRef.add(s.local);
        facts(node, f);
        // Same idOf() as SON, so DECLARES targets are the existing Identifier nodes.
        // Every DECLARES target gets its IN_SCOPE from the same declared() call, so the two can't disagree.
        for (const t of declared(node)) {
            push("DECLARES", node.type, t.type, { from: id, to: idOf(t) });
            let s: string | undefined;
            if (node.type === "VariableDeclarator") s = (parent as Node & { kind?: string }).kind === "var" ? outer.varScope : outer.scope;
            // A function/class declaration's own name binds outside it; a named expression's name, params and catch params bind inside.
            else if (kind && !(t === (node as { id?: Node | null }).id && node.type.endsWith("Declaration"))) s = inner.scope;
            else s = outer.scope;
            if (!s) continue;
            push("IN_SCOPE", t.type, SCOPE, { from: idOf(t), to: s });
            declScope.set(t, s);
            // `var x; var x;` or a param redeclared by `var`: one binding, summarised by its first declaration
            if (!bindings.has(s)) bindings.set(s, new Map());
            const names = bindings.get(s)!;
            const first = names.get((t as Node & { name: string }).name);
            if (!first || t.start! < first.start!) names.set((t as Node & { name: string }).name, t);
        }

        const n = node as Node & { name?: unknown; value?: unknown; operator?: unknown };
        if (!nodes.has(node.type)) nodes.set(node.type, []);
        nodes.get(node.type)!.push({
            id,
            type: node.type,
            file,
            startOffset: node.start ?? -1,
            endOffset: node.end ?? -1,
            line: node.loc?.start.line ?? -1,
            col: node.loc?.start.column ?? -1,
            endLine: node.loc?.end.line ?? -1,
            endCol: node.loc?.end.column ?? -1,
            name: typeof n.name === "string" ? n.name : null,
            value: scalar(n.value),
            operator: typeof n.operator === "string" ? n.operator : null,
            props: JSON.stringify(props, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
            hash: hashOf(node),
        });
    }

    // REFERS_TO: the nearest enclosing scope that binds the name. Unresolved names (globals, host APIs) get no edge.
    const refers = new Map<Node, Node>();
    for (const [use, op, scope] of uses) {
        if (declScope.has(use) || notRef.has(use)) continue;
        const name = (use as Node & { name: string }).name;
        let decl: Node | undefined;
        for (let s = scope; s && !decl; s = parentScope.get(s)) decl = bindings.get(s)?.get(name);
        if (!decl) continue;
        refers.set(use, decl);
        edge("REFERS_TO", use, decl);
        // An export specifier names the binding without reading it.
        if (f.writeOnly.has(use) || op.type === "ExportSpecifier") continue;
        edge("READS", op, decl, { access: idOf(use), access_signature: hashOf(use) });
        edge("FLOWS_TO", decl, use);
    }
    // A target's binding: the declaration summarising it, or the one it refers to.
    const binding = (t: Node) =>
        declScope.has(t) ? bindings.get(declScope.get(t)!)!.get((t as Node & { name: string }).name) : refers.get(t);
    for (const [op, t] of f.writes) {
        const d = binding(t);
        if (d) edge("WRITES", op, d, { access: idOf(t), access_signature: hashOf(t) });
    }
    for (const [a, b] of f.flows) edge("FLOWS_TO", a, b);
    for (const [v, t] of f.stores) {
        const d = binding(t);
        if (d) edge("FLOWS_TO", v, d);
    }
    return { rootId: idOf(ast), nodes, scopes, rels };
}

/** A LadybugDB-backed graph of one or more parsed JS files. */
export class TaintGraph {
    private constructor(
        readonly db: lbug.Database,
        readonly connection: lbug.Connection,
        private readonly tables: Set<string>,
        private readonly relPairs: Record<Rel, Set<string>>,
        private readonly parser: Parser
    ) {}

    // ponytail: unbounded per-file source cache for code(); add LRU eviction if graphs outgrow memory.
    private readonly sources = new Map<string, string>();

    /** Open (or create) a graph. Defaults to in-memory; pass a path to persist. `parser` applies to add(). */
    static async open(dbPath = ":memory:", { parser = "cs-mast" }: { parser?: Parser } = {}): Promise<TaintGraph> {
        const db = new lbug.Database(dbPath, 0, true, false, MAX_DB_SIZE);
        const conn = new lbug.Connection(db);
        const relPairs = Object.fromEntries(Object.keys(RELS).map((r) => [r, new Set()])) as Record<Rel, Set<string>>;
        const g = new TaintGraph(db, conn, new Set(), relPairs, parser);
        // Each file's source is stored once; node code is sliced from it by offset (see code()).
        await g.query(`CREATE NODE TABLE IF NOT EXISTS ${SOURCE}(file STRING PRIMARY KEY, code STRING)`);
        await g.query(`CREATE NODE TABLE IF NOT EXISTS ${SCOPE}(${Object.entries(SCOPE_COLUMNS).map(([c, t]) => `${c} ${t}`).join(", ")})`);
        for (const t of await g.query("CALL show_tables() RETURN name, type")) {
            if (t.type === "NODE" && t.name !== SOURCE && t.name !== SCOPE) g.tables.add(t.name as string);
            if (t.type === "REL" && (t.name as string) in RELS) {
                for (const c of await g.query(`CALL show_connection('${t.name}') RETURN *`))
                    g.relPairs[t.name as Rel].add(`${c["source table name"]}\0${c["destination table name"]}`);
            }
        }
        return g;
    }

    /** Parse `code` and load its AST into the graph. Returns the id of the File node. */
    async add(code: string, filename = "input.js"): Promise<string> {
        const { rootId, nodes, scopes, rels } = flatten(parseAst(code, this.parser), filename);
        // Source first: a duplicate filename fails on the primary key before any nodes are loaded.
        await this.query(`CREATE (:${SOURCE} {file: $file, code: $code})`, { file: filename, code });
        await this.load(nodes, scopes, rels);
        return rootId;
    }

    /** The source code of the node with this id. */
    async code(id: string): Promise<string> {
        const type = id.slice(0, id.lastIndexOf("_"));
        if (!this.tables.has(type)) throw new Error(`taintwire: no node ${id}`);
        const [n] = await this.query(`MATCH (n:\`${type}\` {id: $id}) RETURN n.file AS file, n.startOffset AS s, n.endOffset AS e`, { id });
        if (!n) throw new Error(`taintwire: no node ${id}`);
        let src = this.sources.get(n.file as string);
        if (src === undefined) {
            const [row] = await this.query(`MATCH (s:${SOURCE} {file: $file}) RETURN s.code AS code`, { file: n.file });
            if (!row) throw new Error(`taintwire: no source stored for ${n.file}`);
            this.sources.set(n.file as string, (src = row.code as string));
        }
        // Sliced in JS: Babel offsets are UTF-16 units, Ladybug's substring() counts code points.
        return src.slice(Number(n.s), Number(n.e));
    }

    /**
     * Write the whole graph to a new LadybugDB file at `dbPath`.
     * Copies rows itself: Ladybug's EXPORT DATABASE rejects a rel table with multiple FROM/TO pairs.
     */
    async save(dbPath: string): Promise<void> {
        if (existsSync(dbPath)) throw new Error(`taintwire: refusing to overwrite existing ${dbPath}`);
        const nodes = new Map<string, Row[]>();
        const rels = relMaps();
        const cols = Object.keys(COLUMNS).map((c) => `n.${c} AS ${c}`).join(", ");
        for (const type of this.tables) nodes.set(type, (await this.query(`MATCH (n:\`${type}\`) RETURN ${cols}`)) as Row[]);
        for (const rel of Object.keys(RELS) as Rel[])
            for (const pair of this.relPairs[rel]) {
                const [from, to] = pair.split("\0");
                const props = RELS[rel].map((p) => `, e.${p.split(" ")[0]} AS ${p.split(" ")[0]}`).join("");
                const q = `MATCH (a:\`${from}\`)-[e:${rel}]->(b:\`${to}\`) RETURN a.id AS from, b.id AS to${props}`;
                rels[rel].set(pair, (await this.query(q)) as Edge[]);
            }
        const scopes = (await this.query(`MATCH (s:${SCOPE}) RETURN ${Object.keys(SCOPE_COLUMNS).map((c) => `s.${c} AS ${c}`).join(", ")}`)) as ScopeRow[];
        const sources = await this.query(`MATCH (s:${SOURCE}) RETURN s.file AS file, s.code AS code`);
        const out = await TaintGraph.open(dbPath);
        try {
            // One COPY per (rel, from, to) pair; checkpointing after each made save() ~4x slower.
            await out.query("CALL auto_checkpoint=false");
            for (const s of sources) await out.query(`CREATE (:${SOURCE} {file: $file, code: $code})`, s);
            await out.load(nodes, scopes, rels);
            await out.query("CHECKPOINT");
        } finally {
            await out.close();
        }
    }

    /** Run an openCypher query. For multi-statement input, returns the last statement's rows. */
    async query(cypher: string, params?: Record<string, unknown>): Promise<Record<string, lbug.LbugValue>[]> {
        const res = params
            ? await this.connection.execute(await this.connection.prepare(cypher), params as Record<string, lbug.LbugValue>)
            : await this.connection.query(cypher);
        return (Array.isArray(res) ? res[res.length - 1] : res).getAll();
    }

    async close(): Promise<void> {
        await this.connection.close();
        await this.db.close();
    }

    // COPY is Ladybug's bulk path; UNWIND+MATCH+CREATE for edges was ~4x slower overall.
    private async load(nodes: Map<string, Row[]>, scopes: ScopeRow[], rels: Record<Rel, Edges>) {
        const cols = Object.keys(COLUMNS).map((c) => `r.${c}`).join(", ");
        for (const [type, rows] of nodes) {
            await this.ensureNodeTable(type);
            if (rows.length) await this.batched(`COPY \`${type}\` FROM (UNWIND $rows AS r RETURN ${cols})`, rows);
        }
        if (scopes.length) await this.batched(`COPY ${SCOPE} FROM (UNWIND $rows AS r RETURN ${Object.keys(SCOPE_COLUMNS).map((c) => `r.${c}`).join(", ")})`, scopes);
        for (const rel of Object.keys(RELS) as Rel[]) {
            const props = RELS[rel].map((p) => `, r.${p.split(" ")[0]}`).join("");
            for (const [pair, rows] of rels[rel]) {
                const [from, to] = pair.split("\0");
                await this.ensureRelPair(rel, from, to);
                if (rows.length)
                    await this.batched(`COPY ${rel} FROM (UNWIND $rows AS r RETURN r.from, r.to${props}) (from='${from}', to='${to}')`, rows);
            }
        }
    }

    private async batched(cypher: string, rows: object[]) {
        const stmt = await this.connection.prepare(cypher);
        for (let i = 0; i < rows.length; i += BATCH_SIZE)
            await this.connection.execute(stmt, { rows: rows.slice(i, i + BATCH_SIZE) as unknown as lbug.LbugValue });
    }

    private async ensureNodeTable(type: string) {
        if (this.tables.has(type)) return;
        const cols = Object.entries(COLUMNS).map(([c, t]) => `${c} ${t}`).join(", ");
        await this.query(`CREATE NODE TABLE \`${type}\`(${cols})`);
        this.tables.add(type);
    }

    private async ensureRelPair(rel: Rel, from: string, to: string) {
        const pair = `${from}\0${to}`;
        const pairs = this.relPairs[rel];
        if (pairs.has(pair)) return;
        await this.query(
            pairs.size
                ? `ALTER TABLE ${rel} ADD FROM \`${from}\` TO \`${to}\``
                : `CREATE REL TABLE ${rel}(${[`FROM \`${from}\` TO \`${to}\``, ...RELS[rel]].join(", ")})`
        );
        pairs.add(pair);
    }
}

async function importCode(code: string, opts: { filename?: string; dbPath?: string; parser?: Parser } = {}): Promise<TaintGraph> {
    const graph = await TaintGraph.open(opts.dbPath, { parser: opts.parser });
    await graph.add(code, opts.filename);
    return graph;
}

// `taintwire.import(code)` per LIBRARY.md; `import` is reserved as a binding name, not as an export name.
export { importCode as import };
