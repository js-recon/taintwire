import { parse, type ParserOptions } from "@babel/parser";
import { isFunction, VISITOR_KEYS, type Node } from "@babel/types";
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
import * as csMastBabelTypes from "@babel/types-7";

// Child keys per node type: ours and cs-mast's. They differ for some nodes (TS enum `members`, `typeParameters` on
// calls, `TSExpressionWithTypeArguments`, ...), and a key we don't walk would drop that subtree from the graph.
const CHILD_KEYS: Record<string, readonly string[]> = {};
for (const keys of [VISITOR_KEYS, csMastBabelTypes.VISITOR_KEYS] as Record<string, readonly string[]>[])
    for (const [t, ks] of Object.entries(keys)) CHILD_KEYS[t] = [...new Set([...(CHILD_KEYS[t] ?? []), ...ks])];

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

/** Raw Ladybug connection; `@ladybugdb/core` (Node) and `@ladybugdb/wasm-core` (browser) share this API. */
export interface LbugConnection {
    query(cypher: string): Promise<unknown>;
    prepare(cypher: string): Promise<unknown>;
    execute(stmt: unknown, params?: Record<string, unknown>): Promise<unknown>;
    close(): Promise<void>;
}

/** What differs between the Node and WASM builds of Ladybug. The entry point (index.ts / browser.ts) sets the default. */
export interface Backend {
    open(dbPath: string): { db: { close(): Promise<void> }; connection: LbugConnection };
    /** Rows of the last statement of a query result. */
    rows(res: unknown): Promise<Record<string, unknown>[]>;
    exists(path: string): boolean | Promise<boolean>;
}

let defaultBackend: Backend;
export const setBackend = (b: Backend) => void (defaultBackend = b);

const randomHex = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
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
    CALLS: ["candidates INT64"], // how many functions this callsite may call
    ARGUMENT_TO: ["arg_index INT64", "callsite STRING"], // the argument's position, and its CallExpression's id (`index` and `call` are Cypher keywords)
    RETURNS_TO: [],
    IMPORTS: ["module_id STRING"], // a bundler require call -> the module factory it loads
    EXPORTS: ["name STRING"], // a module factory -> the value it exports under `name`
} as const;
type Rel = keyof typeof RELS;
/** Every relationship (edge table) a graph has, in layer order: AST, declarations, scopes, resolution, access, flow, calls. */
export const RELATIONS = Object.keys(RELS) as Rel[];
// Ladybug rel tables need at least one FROM/TO pair. open() creates every rel table up front with one real pair
// (and that pair's node tables), so `MATCH ()-[:REFERS_TO]->()` on a graph with none is empty rather than a binder error.
const DEFAULT_PAIRS: Record<Rel, [string, string]> = {
    SON: ["File", "Program"],
    DECLARES: ["VariableDeclarator", "Identifier"],
    CREATES_SCOPE: ["Program", "Scope"],
    PARENT_SCOPE: ["Scope", "Scope"],
    IN_SCOPE: ["Identifier", "Scope"],
    REFERS_TO: ["Identifier", "Identifier"],
    READS: ["CallExpression", "Identifier"],
    WRITES: ["VariableDeclarator", "Identifier"],
    FLOWS_TO: ["Identifier", "Identifier"],
    CALLS: ["CallExpression", "FunctionDeclaration"],
    ARGUMENT_TO: ["Identifier", "Identifier"],
    RETURNS_TO: ["ReturnStatement", "CallExpression"],
    IMPORTS: ["CallExpression", "ObjectMethod"],
    EXPORTS: ["ObjectMethod", "Identifier"],
};
const relMaps = () => Object.fromEntries(Object.keys(RELS).map((r) => [r, new Map()])) as Record<Rel, Edges>;

// Scope nodes: semantic, not AST, so they get their own table. Ids are deterministic (see scopeRow()).
const SCOPE_COLUMNS = { id: "STRING PRIMARY KEY", kind: "STRING", file: "STRING", signature: "STRING", owner_signature: "STRING" } as const;
export type ScopeKind = "global" | "module" | "function" | "block" | "catch" | "class" | "static_block";
type ScopeRow = Record<keyof typeof SCOPE_COLUMNS, string | null>;

type Row = Record<keyof typeof COLUMNS, string | number | null>;
type Edge = {
    from: string;
    to: string;
    key?: string;
    idx?: number;
    access?: string;
    access_signature?: string | null;
    candidates?: number;
    arg_index?: number;
    callsite?: string;
    module_id?: string;
    name?: string;
};
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

// Builtins whose result carries their input (arg 0 for functions, the receiver for methods), for value flow through
// unresolved calls. Encoders (encodeURIComponent, escape) are left out on purpose: their output is safe in HTML.
const PASS_FNS = new Set(["decodeURIComponent", "decodeURI", "unescape", "String", "Object"]);
const PASS_METHODS = new Set(["slice", "substring", "substr", "trim", "trimStart", "trimEnd", "toLowerCase", "toUpperCase", "padStart", "padEnd", "repeat", "normalize", "replace", "replaceAll", "toString", "valueOf", "at", "concat"]);

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
    defs: [Node, Node | null][]; // target Identifier -> the value it's given, or null when that isn't one expression
};

// Calls, member access, object/array literals, destructuring, iteration and await/yield add no flow yet (see docs/value-flow).
function facts(node: Node, f: Facts) {
    const into = (...xs: (Node | null | undefined)[]) => xs.forEach((x) => x && f.flows.push([x, node]));
    const write = (ts: Node[], only = false, value: Node | null = null) =>
        ts.forEach((t) => (f.writes.push([node, t]), f.defs.push([t, value]), only && f.writeOnly.add(t)));
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
            write(bindingIds(node.left as Node), node.operator === "=", node.operator === "=" && node.left.type === "Identifier" ? node.right : null);
            if (node.left.type === "Identifier") f.stores.push([node, node.left]);
            return;
        case "VariableDeclarator":
            if (!node.init) return;
            write(bindingIds(node.id), false, node.id.type === "Identifier" ? node.init : null);
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
    const { rootIds, ...rest } = flattenFiles([[ast, file]]);
    return { rootId: rootIds[0], ...rest };
}

/**
 * Flatten several files into one set of rows and edges. Names resolve per file as in flatten(); what links the files
 * is the bundler's module registry (webpack 4/5 or Turbopack chunks), so a call into another chunk gets CALLS, ARGUMENT_TO and RETURNS_TO.
 * With `parse`, each `eval("<string literal>")` is parsed and walked as code in the eval's scope, as a virtual file
 * `<file>#eval@<offset>` listed in `evals` (webpack's `devtool: "eval"` builds put every module body in one).
 */
export function flattenFiles(units: [Node, string][], { parse }: { parse?: (code: string) => Node } = {}) {
    const ids = new Map<Node, string>();
    const idOf = (n: Node) => {
        let id = ids.get(n);
        if (!id) ids.set(n, (id = `${n.type}_${randomHex()}`));
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
    const selfNames = new Set<Node>(); // named function expressions' own names
    const uses: [Node, Node, string | undefined][] = []; // [Identifier, the operation it's an operand of, its scope]
    const notRef = new Set<Node>(); // `export { a } from "x"`: `a` is the other module's name
    const f: Facts = { flows: [], stores: [], writes: [], writeOnly: new Set(), defs: [] };
    const declarer = new Map<Node, Node>(); // DECLARES target -> its declarer
    const calls: Node[] = [];
    const members: Node[] = [];
    const assigns: Node[] = []; // `=` assignments, for CommonJS exports
    const evals: { filename: string; code: string }[] = [];
    const returns = new Map<Node, Node[]>(); // function -> the ReturnStatements it owns (not its nested functions')

    // Iterative walk: minified bundles nest deep enough to blow the JS stack.
    // Each entry carries its parent, the scopes it sits in (`scope` for lexical bindings, `varScope` for var,
    // and `fn`, the function that owns any `return` in it) and its file.
    type Ctx = { scope?: string; varScope?: string; fn?: Node };
    const stack: [Node, Node | undefined, Ctx, string][] = units.map(([ast, file]) => [ast, undefined, {}, file]);
    while (stack.length) {
        const [node, parent, outer, file] = stack.pop()!;
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
            inner = { scope: s.id!, varScope: VAR_SCOPES.has(kind) ? s.id! : outer.varScope, fn: isFunction(node) ? node : outer.fn };
        }

        const keys = CHILD_KEYS[node.type] ?? [];
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
                stack.push([child, node, ctx, file]);
                if (child.type === "Identifier" && isRef(node, k)) uses.push([child, node, ctx.scope]);
            });
        }
        if (node.type === "ExportNamedDeclaration" && node.source) for (const s of node.specifiers) if (s.type === "ExportSpecifier") notRef.add(s.local);
        facts(node, f);
        if (node.type === "CallExpression" || node.type === "OptionalCallExpression") calls.push(node);
        if (node.type === "MemberExpression") members.push(node);
        if (node.type === "AssignmentExpression" && node.operator === "=") assigns.push(node);
        const [src] = (node as Node & { arguments?: Node[] }).arguments ?? [];
        if (parse && node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "eval" && src?.type === "StringLiteral") {
            let evaluated: Node | undefined;
            try {
                evaluated = parse(src.value);
            } catch {
                // not valid code: stays a string
            }
            if (evaluated) {
                const filename = `${file}#eval@${node.start}`;
                evals.push({ filename, code: src.value });
                push("SON", node.type, evaluated.type, { from: id, to: idOf(evaluated), key: "evaluated", idx: -1 });
                stack.push([evaluated, node, inner, filename]);
            }
        }
        if (node.type === "ReturnStatement" && outer.fn) (returns.get(outer.fn) ?? returns.set(outer.fn, []).get(outer.fn)!).push(node);
        // Same idOf() as SON, so DECLARES targets are the existing Identifier nodes.
        // Every DECLARES target gets its IN_SCOPE from the same declared() call, so the two can't disagree.
        for (const t of declared(node)) {
            push("DECLARES", node.type, t.type, { from: id, to: idOf(t) });
            declarer.set(t, node);
            let s: string | undefined;
            if (node.type === "VariableDeclarator") s = (parent as Node & { kind?: string }).kind === "var" ? outer.varScope : outer.scope;
            // A function/class declaration's own name binds outside it; a named expression's name, params and catch params bind inside.
            else if (kind && !(t === (node as { id?: Node | null }).id && node.type.endsWith("Declaration"))) s = inner.scope;
            else s = outer.scope;
            if (!s) continue;
            push("IN_SCOPE", t.type, SCOPE, { from: idOf(t), to: s });
            declScope.set(t, s);
            // `var x; var x;` or a param redeclared by `var`: one binding, summarised by its first declaration.
            // A named function expression's own name is bound outside its params and body, so any of those shadows it.
            if (node.type === "FunctionExpression" && t === node.id) selfNames.add(t);
            if (!bindings.has(s)) bindings.set(s, new Map());
            const names = bindings.get(s)!;
            const first = names.get((t as Node & { name: string }).name);
            const rank = (d: Node) => (selfNames.has(d) ? 1 : 0);
            if (!first || rank(t) < rank(first) || (rank(t) === rank(first) && t.start! < first.start!))
                names.set((t as Node & { name: string }).name, t);
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

    // A binding's definitions: each value written to it (null if unknown), and what its declarations bind. A function
    // declaration or a named function expression binds that function; params, catch params, imports and classes bind
    // values this pass can't see.
    const defs = new Map<Node, (Node | null)[]>();
    const def = (d: Node | undefined, v: Node | null) => d && (defs.get(d) ?? defs.set(d, []).get(d)!).push(v);
    for (const [t, v] of f.defs) def(binding(t), v);
    for (const [t, by] of declarer) {
        if (by.type === "VariableDeclarator") continue; // an initializer is a write, above
        if (selfNames.has(t) && binding(t) !== t) continue; // a shadowed function-expression name: no use reaches it
        def(binding(t), isFunction(by) && t === (by as { id?: Node | null }).id ? by : null);
    }

    // Webpack's module registry (docs/bundlers/webpack.md), webpack 4 and 5. A chunk registers module factories
    // `{id(module, exports, require) {...}}` (webpack 4 also uses arrays, id = index) by pushing `[[chunkIds], factories]`;
    // the entry chunk keeps its own in `__webpack_modules__` or passes them to the bootstrap IIFE. ES modules export with
    // `require.d(exports, {key: getter})`, `require.d(exports, [key, 0, value, ...])` or `require.d(exports, "key", getter)`;
    // CommonJS ones assign `module.exports` / `exports.key`. An import is a namespace expression (`require(id)`,
    // `require.n(ns)()`, an `import()` callback's param, ...), and `ns.key` reads the exported value, in whichever file it
    // is: `imported()` resolves it for leaves() (so calls resolve) and FLOWS_TO.
    // ponytail: `require.n(ns)` of an ES module (which reads ns.default) is taken as `ns`, as for CommonJS; and nsOf()
    // re-walks alias chains per query, so memoise it if a bundle with long chains gets slow.
    type Any = Node & Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const lit = (n: Node | null | undefined) => (n?.type === "NumericLiteral" || n?.type === "StringLiteral" ? String(n.value) : undefined);
    // A member's static key: `o.k` or `o["k"]`.
    const keyOf = (m: Any) => (m.computed ? lit(m.property) : m.property.type === "Identifier" ? m.property.name : undefined);
    const factories = new Map<string, Node[]>(); // module id -> its factories (two builds in one graph can reuse an id)
    const requires = new Set<Node>(); // require-function bindings: each factory's third param, and the runtime's function
    const moduleOf = new Map<Node, Node>(); // a factory's `module` binding -> the factory
    const exportsOf = new Map<Node, Node>(); // a factory's `exports` binding -> the factory
    const ctxOf = new Map<Node, Node>(); // a Turbopack factory's context binding -> the factory
    // webpack factories take (module, exports, require), Turbopack's (context, module, exports).
    const addFactory = (id: string, fn: Any, turbo = false) => {
        (factories.get(id) ?? factories.set(id, []).get(id)!).push(fn);
        const ps = (fn.params as Node[]).map((p) => (p?.type === "Identifier" ? binding(p) : undefined));
        if (turbo && ps[0]) ctxOf.set(ps[0], fn);
        const [mod, exp, req] = turbo ? [ps[1], ps[2]] : ps;
        if (mod) moduleOf.set(mod, fn);
        if (exp) exportsOf.set(exp, fn);
        if (req) requires.add(req);
    };
    const register = (o: Any | null | undefined) => {
        const found: [string, Any][] = [];
        if (o?.type === "ObjectExpression")
            for (const p of o.properties as Any[]) {
                const fn = p.type === "ObjectMethod" ? p : p.value;
                const id = p.computed ? undefined : lit(p.key);
                if (p.type === "SpreadElement" || !isFunction(fn) || id === undefined) return;
                found.push([id, fn]);
            }
        else if (o?.type === "ArrayExpression")
            for (const [i, fn] of (o.elements as Any[]).entries()) {
                if (fn === null) continue; // a hole: no module with that id in this chunk
                if (!isFunction(fn)) return;
                found.push([String(i), fn]);
            }
        found.forEach(([id, fn]) => addFactory(id, fn));
    };
    // Turbopack (docs/bundlers/turbopack.md): `push([script, [group]?, id, id..., factory, ...])`, where a group is the
    // same list, and each factory is installed under the ids before it. False (nothing registered) for any other array.
    const turboModules = (els: Any[], at: number, out: [string, Any][]): boolean => {
        if (els[at]?.type === "ArrayExpression") {
            if (!turboModules(els[at].elements, 0, out)) return false;
            at++;
        }
        let pending: string[] = [];
        for (const e of els.slice(at)) {
            if (isFunction(e) && pending.length) pending.forEach((id) => out.push([id, e])), (pending = []);
            else if (lit(e) !== undefined) pending.push(lit(e)!);
            else return false;
        }
        return !pending.length;
    };
    const isReq = (e: Any | null | undefined) => e?.type === "Identifier" && requires.has(refers.get(e)!);
    const isHelper = (e: Any | null | undefined, name: string) => e?.type === "MemberExpression" && keyOf(e) === name && isReq(e.object);
    // `ctx.name` on a Turbopack factory's context: `ctx.i(id)` imports, `ctx.s([...])` exports, ...
    const isCtx = (e: Any | null | undefined, name: string) =>
        e?.type === "MemberExpression" && keyOf(e) === name && e.object.type === "Identifier" && ctxOf.has(refers.get(e.object)!);
    const cs = calls as Any[];
    const cw = new Map<Node, string>(); // `require.cw(body)` call -> the module id given to its body
    for (const c of cs) {
        const { callee: f, arguments: args } = c;
        // (self.webpackChunk_x ||= []).push([[chunkIds], factories, runtime?])
        if (f.type === "MemberExpression" && !f.computed && f.property.name === "push" && args[0]?.type === "ArrayExpression") {
            const found: [string, Any][] = [];
            if (args[0].elements[0]?.type === "ArrayExpression") register(args[0].elements[1]);
            else if (turboModules(args[0].elements, 1, found)) found.forEach(([id, fn]) => addFactory(id, fn, true));
        }
        if (isFunction(f)) register(args[0]); // webpack 4's bootstrap: (function (modules) {...})([...])
        // The runtime's `function __webpack_require__(id)` runs `modules[id](module, module.exports, __webpack_require__)`,
        // or `modules[id].call(module.exports, module, module.exports, __webpack_require__)` in webpack 4.
        const viaCall = f.type === "MemberExpression" && !f.computed && f.property.name === "call";
        const target = viaCall ? f.object : f;
        const req = viaCall ? (args.length === 4 ? args[3] : undefined) : args.length === 3 ? args[2] : undefined;
        const fn = req?.type === "Identifier" ? (declarer.get(refers.get(req)!) as Any | undefined) : undefined;
        if (fn?.type === "FunctionDeclaration" && fn.params.length === 1 && target.type === "MemberExpression" && target.computed && refers.get(target.property) === binding(fn.params[0]))
            requires.add(refers.get(req)!);
    }
    for (const [t, by] of declarer) if (by.type === "VariableDeclarator" && by.id === t) register(by.init); // __webpack_modules__
    // webpack 5.112 wraps a CommonJS module inlined into an ES module as `require.cw((module, exports) => {...})`. Runs
    // after the anchors above, so `requires` already holds every factory's require.
    for (const c of cs) if (isHelper(c.callee, "cw") && isFunction(c.arguments[0])) addFactory(`cw@${idOf(c)}`, c.arguments[0]), cw.set(c, `cw@${idOf(c)}`);

    // Exports: each factory's keys and the value(s) behind each. `module.exports = X` is also the namespace's own value.
    const exported = new Map<Node, Map<string, Node[]>>();
    const whole = new Map<Node, Node[]>();
    const getterValues = (g: Any | null | undefined): Node[] =>
        !g || !isFunction(g) ? [] : g.body.type === "BlockStatement" ? (returns.get(g) ?? []).flatMap((r: Any) => r.argument ?? []) : [g.body];
    const add = (fac: Node, key: string | undefined, vs: Node[]) => {
        if (key === undefined) return;
        const keys = exported.get(fac) ?? exported.set(fac, new Map()).get(fac)!;
        for (const v of vs) {
            (keys.get(key) ?? keys.set(key, []).get(key)!).push(v);
            edge("EXPORTS", fac, v, { name: key });
        }
    };
    const bound = (e: Any | null | undefined, to: Map<Node, Node>) => (e?.type === "Identifier" ? to.get(refers.get(e)!) : undefined);
    // `module.exports` of a factory, or its `exports` param: the factory.
    const exportsObj = (e: Any | null | undefined) =>
        bound(e, exportsOf) ?? (e?.type === "MemberExpression" && keyOf(e) === "exports" ? bound(e.object, moduleOf) : undefined);
    // `{key: getter}`, or `[key, 0, value | key, getter, setter?, ...]` (webpack 5.112's require.d and Turbopack's ctx.s)
    const exportsFrom = (fac: Node, defn: Any | null | undefined) => {
        if (defn?.type === "ObjectExpression")
            for (const p of defn.properties as Any[]) {
                if (p.type !== "SpreadElement" && !p.computed) add(fac, p.key.type === "Identifier" ? p.key.name : lit(p.key), getterValues(p.type === "ObjectMethod" ? p : p.value));
            }
        else if (defn?.type === "ArrayExpression") {
            const els = defn.elements as (Any | null)[];
            for (let i = 0; i < els.length; ) {
                const key = lit(els[i++]);
                const b = els[i++];
                add(fac, key, b?.type === "NumericLiteral" && b.value === 0 ? [els[i++]].filter((v): v is Any => !!v) : getterValues(b));
                if (isFunction(els[i])) i++; // Turbopack: a setter after the getter
            }
        }
    };
    const nsAlias = new Map<Node, Node[]>(); // Turbopack `ctx.n(ns)`: the factory's namespace is ns
    for (const c of cs) {
        const { callee: f, arguments: [e, defn, getter] } = c;
        if (isHelper(f, "d")) {
            const fac = bound(e, exportsOf);
            if (!fac) continue;
            if (defn?.type === "ObjectExpression" || defn?.type === "ArrayExpression") exportsFrom(fac, defn);
            else add(fac, lit(defn), getterValues(getter)); // webpack 4: require.d(exports, "key", getter)
        }
        // Turbopack: ctx.s(bindings, id?), ctx.v(value, id?) (module.exports = value), ctx.n(ns, id?). `id` is
        // another module's when the code of several is merged into one factory.
        if (isCtx(f, "s") || isCtx(f, "v") || isCtx(f, "n")) {
            const k = keyOf(f);
            const facs = lit(defn) !== undefined ? (factories.get(lit(defn)!) ?? []) : [ctxOf.get(refers.get(f.object)!)!];
            for (const fac of e ? facs : []) {
                if (k === "s") exportsFrom(fac, e);
                else (k === "v" ? (whole.get(fac) ?? whole.set(fac, []).get(fac)!) : (nsAlias.get(fac) ?? nsAlias.set(fac, []).get(fac)!)).push(e);
            }
        }
        // Object.defineProperty(exports, "key", { value } | { get }), as TypeScript and Babel emit for CommonJS
        if (f.type === "MemberExpression" && keyOf(f) === "defineProperty" && f.object.name === "Object" && !refers.has(f.object) && defn && defn.value !== "__esModule") {
            const fac = exportsObj(e);
            for (const p of fac && getter?.type === "ObjectExpression" ? (getter.properties as Any[]) : []) {
                const k = p.type === "SpreadElement" || p.computed ? undefined : p.key.name ?? lit(p.key);
                if (k === "value") add(fac!, lit(defn), [p.value]);
                if (k === "get") add(fac!, lit(defn), getterValues(p.type === "ObjectMethod" ? p : p.value));
            }
        }
    }
    for (const a of assigns as Any[]) {
        const l = a.left;
        if (l.type !== "MemberExpression") continue;
        const fac = keyOf(l) === "exports" ? bound(l.object, moduleOf) : undefined;
        if (fac) {
            // module.exports = X; an object literal's own keys are named exports too
            (whole.get(fac) ?? whole.set(fac, []).get(fac)!).push(a.right);
            for (const p of a.right.type === "ObjectExpression" ? (a.right.properties as Any[]) : [])
                if (p.type !== "SpreadElement" && !p.computed) add(fac, p.key.name ?? lit(p.key), [p.type === "ObjectMethod" ? p : p.value]);
            continue;
        }
        const target = exportsObj(l.object); // exports.key = v, module.exports.key = v
        if (target) add(target, keyOf(l), [a.right]);
    }
    for (const [fac, vs] of whole) if (!exported.get(fac)?.has("default")) add(fac, "default", vs); // what require.n / require.t read
    // Turbopack's import(): `ctx.A(id)` calls module id's exported loader with the import function, as in
    // `ctx.v(i => Promise.all([...chunk loads]).then(() => i(target)))`, so the loader's param is a require.
    for (const c of cs)
        if (isCtx(c.callee, "A"))
            for (const fac of factories.get(lit(c.arguments[0])!) ?? [])
                for (const v of whole.get(fac) ?? []) if (isFunction(v) && v.params[0]?.type === "Identifier") requires.add(binding(v.params[0])!);

    // Namespaces. `nsOf(e)` is the module id whose namespace `e` is: `require(id)`, `require.t(id, mode)`, a binding whose
    // one definition is one, `require.n(ns)()` (webpack 5) or `require.n(ns).a` (webpack 4), a call of a function that
    // returns one (`a = () => require(1)`, `require.cw(body)`), `await` of an import() promise, or an import() callback's param.
    const paramNs = new Map<Node, string>();
    const single = (e: Any) => {
        const d = refers.get(e);
        const vs = d && defs.get(d);
        return vs?.length === 1 ? vs[0] : undefined;
    };
    // Through aliases (`b = a`) and sequences to the expression that gives a value, iteratively: alias chains in bundles
    // can be long. Stops at a namespace param, which has no definition to follow.
    const follow = (e: Any | null | undefined, seen: Set<Node>): Any | null | undefined => {
        while (e && !seen.has(e) && (e.type === "SequenceExpression" || (e.type === "Identifier" && !paramNs.has(refers.get(e)!)))) {
            seen.add(e);
            e = e.type === "SequenceExpression" ? e.expressions.at(-1) : single(e);
        }
        return e;
    };
    const nsOf = (e0: Any | null | undefined, seen = new Set<Node>()): string | undefined => {
        if (!requires.size && !ctxOf.size) return; // no webpack or Turbopack runtime in these files
        const e = follow(e0, seen);
        if (!e || seen.has(e)) return;
        seen.add(e);
        switch (e.type) {
            case "Identifier":
                return paramNs.get(refers.get(e)!);
            case "AwaitExpression":
                return promiseNs(e.argument, seen);
            case "CallExpression":
                if (isReq(e.callee) && e.arguments.length === 1) return lit(e.arguments[0]);
                if (isCtx(e.callee, "i") || isCtx(e.callee, "r")) return lit(e.arguments[0]); // Turbopack import / require
                if (isHelper(e.callee, "t") && Number(lit(e.arguments[1])) & 1) return lit(e.arguments[0]); // mode & 1: require it
                return returnedNs(e.callee, seen);
            case "MemberExpression":
                if (keyOf(e) === "a") return interopNs(e.object, seen);
                if (keyOf(e) !== "default") return;
                // `ns.default` of a CommonJS module is module.exports, read like the namespace itself (Turbopack's
                // `ctx.i(cjs).default.k`); left to `imported()` for an ES module's own default.
                const id = nsOf(e.object, seen);
                return id !== undefined && (factories.get(id) ?? []).some((fac) => whole.has(fac)) ? id : undefined;
        }
    };
    // The namespace calling `g` returns.
    const returnedNs = (g0: Any | null | undefined, seen: Set<Node>): string | undefined => {
        const g = follow(g0, seen);
        if (!g || seen.has(g)) return;
        seen.add(g);
        if (g.type === "CallExpression") return cw.get(g) ?? interopNs(g, seen);
        const ids = new Set(getterValues(g).map((v) => nsOf(v, seen)));
        return ids.size === 1 ? [...ids][0] : undefined;
    };
    // `require.n(ns)`'s getter, which returns `ns` for a CommonJS module.
    const interopNs = (g0: Any | null | undefined, seen: Set<Node>): string | undefined => {
        const g = follow(g0, seen);
        return g?.type === "CallExpression" && isHelper(g.callee, "n") ? nsOf(g.arguments[0], seen) : undefined;
    };
    // The namespace an import() promise resolves to: `p.then(require.bind(_, id))`, `p.then(require.t.bind(_, id, mode))`
    // or `p.then(() => require(id))`.
    const promiseNs = (p0: Any | null | undefined, seen = new Set<Node>()): string | undefined => {
        const p = follow(p0, seen);
        if (p?.type === "CallExpression" && isCtx(p.callee, "A")) {
            const loaders = (factories.get(lit(p.arguments[0])!) ?? []).flatMap((fac) => whole.get(fac) ?? []);
            const ids = new Set(loaders.flatMap((l) => getterValues(l)).map((r) => promiseNs(r, seen)));
            return ids.size === 1 ? [...ids][0] : undefined;
        }
        if (p?.type !== "CallExpression" || p.callee.type !== "MemberExpression" || keyOf(p.callee) !== "then") return;
        const cb = p.arguments[0] as Any | undefined;
        if (cb?.type === "CallExpression" && cb.callee.type === "MemberExpression" && keyOf(cb.callee) === "bind") {
            const o = cb.callee.object;
            if (isReq(o) || (isHelper(o, "t") && Number(lit(cb.arguments[2])) & 1)) return lit(cb.arguments[1]);
            return;
        }
        return returnedNs(cb, seen);
    };
    for (const c of cs) {
        // An import() callback's first param is the namespace, unless something else is assigned to it.
        const cb = c.callee.type === "MemberExpression" && keyOf(c.callee) === "then" ? (c.arguments[0] as Any | undefined) : undefined;
        const p = cb && isFunction(cb) && cb.params[0]?.type === "Identifier" ? binding(cb.params[0]) : undefined;
        const id = p && defs.get(p)?.length === 1 ? promiseNs(c.callee.object) : undefined;
        if (id !== undefined) paramNs.set(p!, id);
    }
    // IMPORTS: each call that loads a module, synchronously or for an import().
    for (const c of cs) {
        const { callee: f, arguments: args } = c;
        const id = isReq(f) && args.length === 1 ? lit(args[0])
            : isCtx(f, "i") || isCtx(f, "r") || isCtx(f, "A") ? lit(args[0])
            : isHelper(f, "t") ? lit(args[0])
            : f.type === "MemberExpression" && keyOf(f) === "bind" && (isReq(f.object) || isHelper(f.object, "t")) ? lit(args[1])
            : undefined;
        for (const fac of id === undefined ? [] : factories.get(id) ?? []) edge("IMPORTS", c, fac, { module_id: id });
    }
    // A factory's own exports, or those of the namespace(s) Turbopack's `ctx.n(ns)` made its namespace.
    const valuesOf = (id: string | undefined, key: string, seen = new Set<string>()): Node[] => {
        if (id === undefined || seen.has(id)) return [];
        seen.add(id);
        return (factories.get(id) ?? []).flatMap((fac) => exported.get(fac)?.get(key) ?? (nsAlias.get(fac) ?? []).flatMap((ns) => valuesOf(nsOf(ns), key, seen)));
    };
    // The value(s) `ns.key` / `ns["key"]` reads, or undefined if `ns` isn't a namespace or doesn't export `key`.
    const imported = (m: Any): Node[] | undefined => {
        const key = keyOf(m);
        const vs = key === undefined ? [] : valuesOf(nsOf(m.object), key);
        return vs.length ? vs : undefined;
    };
    // A namespace expression's own value: a CommonJS module's `module.exports`.
    const nsValue = (e: Node) => {
        const id = nsOf(e);
        return id === undefined ? undefined : (factories.get(id) ?? []).flatMap((fac) => whole.get(fac) ?? []);
    };
    for (const m of members) {
        for (const v of imported(m) ?? []) edge("FLOWS_TO", v, m);
        if (keyOf(m) === "a") for (const v of nsValue(m) ?? []) edge("FLOWS_TO", v, m);
    }
    for (const c of cs) for (const v of nsValue(c) ?? []) edge("FLOWS_TO", v, c);
    // The functions a value may be, or null if any part of it is unknown. Flow-insensitive like FLOWS_TO: every
    // definition of a binding counts, in any order. `leaves()` reads one value: the functions it is directly, whether
    // any part is unknown, and the bindings it aliases. Explicit stacks throughout: alias chains in bundles can be long.
    type Leaves = { fns: Set<Node>; unknown: boolean; deps: Node[] };
    const leaves = (roots: (Node | null | undefined)[]): Leaves => {
        const out: Leaves = { fns: new Set(), unknown: false, deps: [] };
        const st = [...roots];
        const seen = new Set<Node>(); // re-exports can form a cycle
        while (st.length) {
            const v = st.pop();
            switch (v?.type) {
                case "MemberExpression":
                case "CallExpression":
                case "AwaitExpression": {
                    if (seen.has(v)) break;
                    seen.add(v);
                    // `ns.key`, a namespace's own value (`require(1)()`, `require.n(ns)()`), or webpack 4's `Object(ns.key)`
                    const obj = v.type === "CallExpression" && v.callee.type === "Identifier" && v.callee.name === "Object" && !refers.has(v.callee) && v.arguments.length === 1;
                    const vs = obj ? [v.arguments[0] as Node] : (v.type === "MemberExpression" && imported(v)) || nsValue(v);
                    if (vs?.length) st.push(...vs);
                    else out.unknown = true;
                    break;
                }
                case "FunctionDeclaration":
                case "FunctionExpression":
                case "ArrowFunctionExpression":
                    out.fns.add(v);
                    break;
                case "Identifier": {
                    const d = refers.get(v);
                    if (d) out.deps.push(d);
                    else out.unknown = true;
                    break;
                }
                case "SequenceExpression":
                    st.push(v.expressions.at(-1));
                    break;
                case "AssignmentExpression":
                    if (v.operator === "=") st.push(v.right);
                    else out.unknown = true;
                    break;
                case "ConditionalExpression":
                    st.push(v.consequent, v.alternate);
                    break;
                case "LogicalExpression":
                    st.push(v.left, v.right);
                    break;
                default:
                    if (v && TS_VALUES.has(v.type)) st.push((v as Node & { expression: Node }).expression);
                    else out.unknown = true;
            }
        }
        return out;
    };
    // Each binding's functions over the alias graph, solved once with an iterative Tarjan: the bindings on an alias
    // cycle (`f = g; g = f`) share one result, and a binding's result includes every binding it aliases. Linear overall.
    const info = new Map<Node, Leaves>();
    const leafOf = (d: Node) => info.get(d) ?? info.set(d, leaves(defs.get(d) ?? [])).get(d)!;
    const solved = new Map<Node, Set<Node> | null>();
    const index = new Map<Node, number>();
    const low = new Map<Node, number>();
    const sccStack: Node[] = [];
    const onStack = new Set<Node>();
    const solve = (root: Node) => {
        if (index.has(root)) return;
        const work: [Node, number][] = [[root, 0]];
        while (work.length) {
            const top = work[work.length - 1];
            const d = top[0];
            if (!index.has(d)) {
                index.set(d, index.size);
                low.set(d, index.get(d)!);
                sccStack.push(d);
                onStack.add(d);
            }
            const deps = leafOf(d).deps;
            if (top[1] < deps.length) {
                const w = deps[top[1]++];
                if (!index.has(w)) work.push([w, 0]);
                else if (onStack.has(w)) low.set(d, Math.min(low.get(d)!, index.get(w)!));
                continue;
            }
            work.pop();
            if (work.length) {
                const p = work[work.length - 1][0];
                low.set(p, Math.min(low.get(p)!, low.get(d)!));
            }
            if (low.get(d) !== index.get(d)) continue;
            const members = new Set<Node>();
            for (let w: Node | undefined; w !== d; ) {
                w = sccStack.pop()!;
                onStack.delete(w);
                members.add(w);
            }
            let r: Set<Node> | null = new Set();
            for (const m of members) {
                const l = leafOf(m);
                if (l.unknown) r = null;
                l.fns.forEach((fn) => r?.add(fn));
                for (const x of l.deps) {
                    if (members.has(x)) continue;
                    const rx = solved.get(x)!; // another SCC, already solved
                    if (rx === null) r = null;
                    rx?.forEach((fn) => r?.add(fn));
                }
            }
            for (const m of members) solved.set(m, r);
        }
    };
    const callables = (v: Node): Set<Node> | null => {
        const l = leaves([v]);
        if (l.unknown) return null;
        const r = new Set(l.fns);
        for (const d of l.deps) {
            solve(d);
            const rd = solved.get(d);
            if (rd === null) return null;
            rd?.forEach((fn) => r.add(fn));
        }
        return r;
    };
    // An unresolved builtin that returns (part of) its input: decodeURIComponent(x) and x.slice(1) get FLOWS_TO into the call.
    // ponytail: by name only, with no idea of the receiver's type; a typed builtin model can replace it.
    const passThrough = (c: Any) => {
        const f = c.callee;
        if (f.type === "Identifier" && PASS_FNS.has(f.name) && !refers.has(f) && c.arguments[0]) edge("FLOWS_TO", c.arguments[0], c);
        if (f.type === "MemberExpression" && PASS_METHODS.has(keyOf(f)!)) {
            edge("FLOWS_TO", f.object, c);
            if (keyOf(f) === "concat") for (const a of c.arguments) if (a.type !== "SpreadElement") edge("FLOWS_TO", a, c);
        }
    };
    // The binding a formal parameter declares, if it's a plain name (destructured params need element/property flow).
    const paramName = (p: Node): Node | undefined =>
        p.type === "Identifier" ? p : p.type === "AssignmentPattern" ? paramName(p.left) : p.type === "TSParameterProperty" ? paramName(p.parameter) : p.type === "RestElement" ? paramName(p.argument) : undefined;
    for (const c of calls as (Node & { callee: Node; arguments: Node[] })[]) {
        const targets = callables(c.callee);
        if (!targets?.size) {
            passThrough(c); // unresolved: a global, a param, a member, a call result, ...
            continue;
        }
        for (const fn of targets as Set<Node & { params: Node[]; body: Node; async?: boolean; generator?: boolean }>) {
            edge("CALLS", c, fn, { candidates: targets.size });
            // Arguments by position; a rest param takes every argument from its position on. After a spread, positions are unknown.
            const params = fn.params.filter((p) => !(p.type === "Identifier" && p.name === "this")); // TS `this` isn't a param
            const rest = params.findIndex((p) => p.type === "RestElement");
            for (const [i, a] of c.arguments.entries()) {
                if (a.type === "SpreadElement" || a.type === "ArgumentPlaceholder") break;
                const p = rest >= 0 && i >= rest ? params[rest] : params[i];
                const d = p && paramName(p) && binding(paramName(p)!);
                if (d) edge("ARGUMENT_TO", a, d, { arg_index: i, callsite: idOf(c) });
            }
            // An async function returns a promise and a generator an iterator, not the returned value.
            if (fn.async || fn.generator) continue;
            for (const r of returns.get(fn) ?? []) if ((r as Node & { argument?: Node | null }).argument) edge("RETURNS_TO", r, c);
            if (fn.type === "ArrowFunctionExpression" && fn.body.type !== "BlockStatement") edge("RETURNS_TO", fn.body, c); // concise body
        }
    }
    return { rootIds: units.map(([ast]) => idOf(ast)), nodes, scopes, rels, evals };
}

/** A LadybugDB-backed graph of one or more parsed JS files. */
export class TaintGraph {
    private constructor(
        readonly db: { close(): Promise<void> },
        readonly connection: LbugConnection,
        private readonly tables: Set<string>,
        private readonly relPairs: Record<Rel, Set<string>>,
        private readonly parser: Parser,
        private readonly backend: Backend
    ) {}

    // ponytail: unbounded per-file source cache for code(); add LRU eviction if graphs outgrow memory.
    private readonly sources = new Map<string, string>();

    /** Open (or create) a graph. Defaults to in-memory; pass a path to persist. `parser` applies to add(). */
    static async open(
        dbPath = ":memory:",
        { parser = "cs-mast", backend = defaultBackend }: { parser?: Parser; backend?: Backend } = {}
    ): Promise<TaintGraph> {
        const { db, connection } = backend.open(dbPath);
        const relPairs = Object.fromEntries(Object.keys(RELS).map((r) => [r, new Set()])) as Record<Rel, Set<string>>;
        const g = new TaintGraph(db, connection, new Set(), relPairs, parser, backend);
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
        for (const [rel, [from, to]] of Object.entries(DEFAULT_PAIRS) as [Rel, [string, string]][]) {
            if (g.relPairs[rel].size) continue;
            await g.ensureNodeTable(from);
            await g.ensureNodeTable(to);
            await g.ensureRelPair(rel, from, to);
        }
        return g;
    }

    /** Parse `code` and load its AST into the graph. Returns the id of the File node. */
    async add(code: string, filename = "input.js"): Promise<string> {
        return (await this.addFiles([{ code, filename }]))[0];
    }

    /**
     * Parse and load several files together, such as every chunk of a bundle, so that references between them
     * (a webpack module registry) resolve. Files loaded by separate calls aren't linked. Returns the File node ids, in order.
     */
    async addFiles(files: { code: string; filename: string }[]): Promise<string[]> {
        const parse = (code: string) => parseAst(code, this.parser);
        const { rootIds, nodes, scopes, rels, evals } = flattenFiles(files.map((f) => [parse(f.code), f.filename]), { parse });
        // Sources first: a duplicate filename fails on the primary key before any nodes are loaded.
        for (const f of [...files, ...evals]) await this.query(`CREATE (:${SOURCE} {file: $file, code: $code})`, { file: f.filename, code: f.code });
        await this.load(nodes, scopes, rels);
        return rootIds;
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
        if (await this.backend.exists(dbPath)) throw new Error(`taintwire: refusing to overwrite existing ${dbPath}`);
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
        const out = await TaintGraph.open(dbPath, { backend: this.backend });
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
    async query(cypher: string, params?: Record<string, unknown>): Promise<Record<string, unknown>[]> {
        // ponytail: the prepared statement is never closed, which leaks in the WASM worker; cache or close if param queries get hot.
        const res = params ? await this.connection.execute(await this.connection.prepare(cypher), params) : await this.connection.query(cypher);
        return this.backend.rows(res);
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
            await this.backend.rows(await this.connection.execute(stmt, { rows: rows.slice(i, i + BATCH_SIZE) })); // frees WASM results
    }

    private async ensureNodeTable(type: string) {
        if (this.tables.has(type) || type === SCOPE) return;
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
