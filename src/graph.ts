import type { Node } from "@babel/types";
import { flattenFiles } from "./flatten.js";
import { parseAst, type Parser } from "./parse.js";
import { COLUMNS, DEFAULT_PAIRS, relMaps, RELS, SCOPE, SCOPE_COLUMNS, SOURCE, type Edge, type Edges, type Rel, type Row, type ScopeRow } from "./schema.js";

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
    open(dbPath: string, readOnly?: boolean, limits?: Limits): { db: { close(): Promise<void> }; connection: LbugConnection };
    /** Rows of the last statement of a query result. */
    rows(res: unknown): Promise<Record<string, unknown>[]>;
    exists(path: string): boolean | Promise<boolean>;
}

/**
 * Ladybug's memory and CPU. `bufferPoolMB`: the Node build defaults to half of the memory the process may use (its
 * cgroup limit, if any); 0 is Ladybug's own default, a share of the host's RAM. `threads`: query threads.
 */
export type Limits = { bufferPoolMB?: number; threads?: number };
/** addFiles progress: files parsed, then the link walk (0/1, 1/1), then rows loaded into the database. */
export type AddFilesProgress = (stage: "parse" | "link" | "load", done: number, total: number) => void;

/** Query threads when open() isn't given a number (Ladybug's own default is one per core of the host). */
export const DEFAULT_THREADS = 2;

let defaultBackend: Backend;
export const setBackend = (b: Backend) => void (defaultBackend = b);

/** A PookieGraph: a LadybugDB-backed graph of one or more parsed JS files, saved as a single `.pg` file. */
export class PookieGraph {
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

    /**
     * Open (or create) a graph. Defaults to in-memory; pass a path (`.pg`) to persist. `parser` applies to add().
     * `readOnly` opens an existing file without writing to it (no schema setup, no WAL); add() then fails.
     * `bufferPoolMB` and `threads` bound Ladybug's memory and CPU (see Limits, DEFAULT_THREADS).
     */
    static async open(
        dbPath = ":memory:",
        {
            parser = "cs-mast",
            backend = defaultBackend,
            readOnly = false,
            bufferPoolMB,
            threads = DEFAULT_THREADS,
        }: { parser?: Parser; backend?: Backend; readOnly?: boolean } & Limits = {}
    ): Promise<PookieGraph> {
        if (readOnly && !(await backend.exists(dbPath))) throw new Error(`taintwire: no PookieGraph at ${dbPath}`);
        const { db, connection } = backend.open(dbPath, readOnly, { bufferPoolMB, threads });
        const relPairs = Object.fromEntries(Object.keys(RELS).map((r) => [r, new Set()])) as Record<Rel, Set<string>>;
        const g = new PookieGraph(db, connection, new Set(), relPairs, parser, backend);
        // Each file's source is stored once; node code is sliced from it by offset (see code()).
        if (!readOnly) {
            await g.query(`CREATE NODE TABLE IF NOT EXISTS ${SOURCE}(file STRING PRIMARY KEY, code STRING)`);
            await g.query(`CREATE NODE TABLE IF NOT EXISTS ${SCOPE}(${Object.entries(SCOPE_COLUMNS).map(([c, t]) => `${c} ${t}`).join(", ")})`);
        }
        for (const t of await g.query("CALL show_tables() RETURN name, type")) {
            if (t.type === "NODE" && t.name !== SOURCE && t.name !== SCOPE) g.tables.add(t.name as string);
            if (t.type === "REL" && (t.name as string) in RELS) {
                for (const c of await g.query(`CALL show_connection('${t.name}') RETURN *`))
                    g.relPairs[t.name as Rel].add(`${c["source table name"]}\0${c["destination table name"]}`);
            }
        }
        for (const [rel, [from, to]] of Object.entries(DEFAULT_PAIRS) as [Rel, [string, string]][]) {
            if (readOnly || g.relPairs[rel].size) continue;
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
    async addFiles(files: { code: string; filename: string }[], onProgress?: AddFilesProgress): Promise<string[]> {
        const parse = (code: string) => parseAst(code, this.parser);
        const units: [Node, string][] = [];
        for (const f of files) {
            units.push([parse(f.code), f.filename]);
            onProgress?.("parse", units.length, files.length);
        }
        onProgress?.("link", 0, 1);
        const { rootIds, nodes, scopes, rels, evals } = flattenFiles(units, { parse });
        onProgress?.("link", 1, 1);
        // Sources first: a duplicate filename fails on the primary key before any nodes are loaded.
        for (const f of [...files, ...evals]) await this.query(`CREATE (:${SOURCE} {file: $file, code: $code})`, { file: f.filename, code: f.code });
        let total = scopes.length;
        for (const rows of nodes.values()) total += rows.length;
        for (const edges of Object.values(rels)) for (const rows of edges.values()) total += rows.length;
        let done = 0;
        onProgress?.("load", 0, total);
        await this.load(nodes, scopes, rels, onProgress && ((n) => onProgress("load", (done += n), total)));
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
     * Write the whole graph to a new PookieGraph file (`.pg`, a LadybugDB database) at `dbPath`.
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
        const out = await PookieGraph.open(dbPath, { backend: this.backend });
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
    // Each table's rows leave the maps once copied, so the JS heap shrinks as the load goes instead of holding every row to the end.
    private async load(nodes: Map<string, Row[]>, scopes: ScopeRow[], rels: Record<Rel, Edges>, onRows?: (n: number) => void) {
        const cols = Object.keys(COLUMNS).map((c) => `r.${c}`).join(", ");
        for (const [type, rows] of nodes) {
            await this.ensureNodeTable(type);
            if (rows.length) await this.batched(`COPY \`${type}\` FROM (UNWIND $rows AS r RETURN ${cols})`, rows, onRows);
            nodes.delete(type);
        }
        if (scopes.length) await this.batched(`COPY ${SCOPE} FROM (UNWIND $rows AS r RETURN ${Object.keys(SCOPE_COLUMNS).map((c) => `r.${c}`).join(", ")})`, scopes, onRows);
        for (const rel of Object.keys(RELS) as Rel[]) {
            const props = RELS[rel].map((p) => `, r.${p.split(" ")[0]}`).join("");
            for (const [pair, rows] of rels[rel]) {
                const [from, to] = pair.split("\0");
                await this.ensureRelPair(rel, from, to);
                if (rows.length)
                    await this.batched(`COPY ${rel} FROM (UNWIND $rows AS r RETURN r.from, r.to${props}) (from='${from}', to='${to}')`, rows, onRows);
                rels[rel].delete(pair);
            }
        }
    }

    private async batched(cypher: string, rows: object[], onRows?: (n: number) => void) {
        const stmt = await this.connection.prepare(cypher);
        for (let i = 0; i < rows.length; i += BATCH_SIZE) {
            const batch = rows.slice(i, i + BATCH_SIZE);
            await this.backend.rows(await this.connection.execute(stmt, { rows: batch })); // frees WASM results
            onRows?.(batch.length);
        }
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

async function importCode(code: string, opts: { filename?: string; dbPath?: string; parser?: Parser } = {}): Promise<PookieGraph> {
    const graph = await PookieGraph.open(opts.dbPath, { parser: opts.parser });
    await graph.add(code, opts.filename);
    return graph;
}

/** @deprecated Renamed to {@link PookieGraph}. */
export const TaintGraph = PookieGraph;
/** @deprecated Renamed to {@link PookieGraph}. */
export type TaintGraph = PookieGraph;

// `taintwire.import(code)` per LIBRARY.md; `import` is reserved as a binding name, not as an export name.
export { importCode as import };
