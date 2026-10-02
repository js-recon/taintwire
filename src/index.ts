import { randomBytes } from "node:crypto";
import { parse, type ParserOptions } from "@babel/parser";
import { VISITOR_KEYS, type Node } from "@babel/types";
import lbug from "@ladybugdb/core";

// Same options as js-recon, so both see the same AST for the same input.
export const PARSER_OPTIONS: ParserOptions = {
    sourceType: "unambiguous",
    plugins: ["jsx", "typescript"],
    errorRecovery: true,
};

const BATCH_SIZE = 5000;

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
} as const;

// Node fields that are either columns already or noise for the graph.
const SKIP_PROPS = new Set(["type", "start", "end", "loc", "range", "leadingComments", "trailingComments", "innerComments", "comments", "errors", "tokens"]);

type Row = Record<keyof typeof COLUMNS, string | number | null>;
type Edge = { from: string; to: string; key: string; idx: number };
type Ref = { type: string; slug_ref: string };

const scalar = (v: unknown): string | null => {
    if (["string", "number", "boolean", "bigint"].includes(typeof v)) return String(v);
    // TemplateElement.value is { raw, cooked }
    if (v && typeof v === "object" && "raw" in v) return String((v as { cooked?: string; raw: string }).cooked ?? (v as { raw: string }).raw);
    return null;
};

/** Flatten a Babel AST into per-type node rows and per-(parent,child)-type CHILD edges. */
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
    const edges = new Map<string, Edge[]>(); // key: `${parentType}\0${childType}`

    // Iterative walk: minified bundles nest deep enough to blow the JS stack.
    const stack: Node[] = [ast];
    while (stack.length) {
        const node = stack.pop()!;
        const id = idOf(node);
        const keys: readonly string[] = VISITOR_KEYS[node.type] ?? [];
        const props: Record<string, unknown> = {};

        for (const [k, v] of Object.entries(node)) {
            if (SKIP_PROPS.has(k)) continue;
            if (!keys.includes(k)) {
                props[k] = v;
                continue;
            }
            // Child nodes become CHILD edges; the property keeps a slug reference to the child.
            props[k] = Array.isArray(v) ? v.map(ref) : ref(v);
            (Array.isArray(v) ? v : [v]).forEach((child, i) => {
                if (!isNode(child)) return;
                const pair = `${node.type}\0${child.type}`;
                if (!edges.has(pair)) edges.set(pair, []);
                edges.get(pair)!.push({ from: id, to: idOf(child), key: k, idx: Array.isArray(v) ? i : -1 });
                stack.push(child);
            });
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
        });
    }
    return { rootId: idOf(ast), nodes, edges };
}

/** A LadybugDB-backed graph of one or more parsed JS files. */
export class TaintGraph {
    private constructor(
        readonly db: lbug.Database,
        readonly connection: lbug.Connection,
        private readonly tables: Set<string>,
        private readonly childPairs: Set<string>
    ) {}

    /** Open (or create) a graph. Defaults to in-memory; pass a path to persist. */
    static async open(dbPath = ":memory:"): Promise<TaintGraph> {
        const db = new lbug.Database(dbPath);
        const conn = new lbug.Connection(db);
        const g = new TaintGraph(db, conn, new Set(), new Set());
        for (const t of await g.query("CALL show_tables() RETURN name, type")) {
            if (t.type === "NODE") g.tables.add(t.name as string);
            if (t.type === "REL" && t.name === "CHILD") {
                for (const c of await g.query("CALL show_connection('CHILD') RETURN *"))
                    g.childPairs.add(`${c["source table name"]}\0${c["destination table name"]}`);
            }
        }
        return g;
    }

    /** Parse `code` and load its AST into the graph. Returns the id of the File node. */
    async add(code: string, filename = "input.js"): Promise<string> {
        const { rootId, nodes, edges } = flatten(parse(code, PARSER_OPTIONS) as unknown as Node, filename);

        // COPY is Ladybug's bulk path; UNWIND+MATCH+CREATE for edges was ~10x slower.
        const cols = Object.keys(COLUMNS).map((c) => `r.${c}`).join(", ");
        for (const [type, rows] of nodes) {
            await this.ensureNodeTable(type);
            await this.batched(`COPY \`${type}\` FROM (UNWIND $rows AS r RETURN ${cols})`, rows);
        }
        for (const [pair, rows] of edges) {
            const [from, to] = pair.split("\0");
            await this.ensureChildPair(from, to);
            await this.batched(
                `COPY CHILD FROM (UNWIND $rows AS r RETURN r.from, r.to, r.key, r.idx) (from='${from}', to='${to}')`,
                rows
            );
        }
        return rootId;
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

    private async ensureChildPair(from: string, to: string) {
        const pair = `${from}\0${to}`;
        if (this.childPairs.has(pair)) return;
        await this.query(
            this.childPairs.size
                ? `ALTER TABLE CHILD ADD FROM \`${from}\` TO \`${to}\``
                : `CREATE REL TABLE CHILD(FROM \`${from}\` TO \`${to}\`, key STRING, idx INT64)`
        );
        this.childPairs.add(pair);
    }
}

async function importCode(code: string, opts: { filename?: string; dbPath?: string } = {}): Promise<TaintGraph> {
    const graph = await TaintGraph.open(opts.dbPath);
    await graph.add(code, opts.filename);
    return graph;
}

// `taintwire.import(code)` per LIBRARY.md; `import` is reserved as a binding name, not as an export name.
export { importCode as import };
