// PookieGraph queries (pgq): Cypher selectors composed into rules. Browser-safe; loading .pgq files is pgq-load.ts.
import type { PookieGraph } from "./core.js";

export const PG_SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
export type PGSeverity = (typeof PG_SEVERITIES)[number];
export const PG_MODES = ["strict", "lenient", "deep"] as const;
export type PGMode = (typeof PG_MODES)[number];

/**
 * One Cypher query. It must `RETURN id`; in a selector used in `return` or `from`, also `file, line, col` (and it may
 * return `kind`).
 */
export interface PGCypher {
    query: string;
}

/** A set of nodes, such as "every URL read" or "every innerHTML write". Not a finding by itself. */
export interface PGSelector {
    /** Variants: each runs, rows are concatenated and deduplicated by `id`. */
    cypher: PGCypher | PGCypher[];
    /** `$name` in a query is the ids of that selector's rows. If one is empty, so is this selector. */
    uses?: Record<string, PGSelector>;
    /** Keep only rows that a value from one of these selectors flows into. */
    from?: PGSelector | PGSelector[];
    /** How `from` flows are followed (default deep), see runPgq. */
    mode?: PGMode;
    /** Longest flow kept, in hops (default 8). */
    maxHops?: number;
}

/** A rule: its findings are the rows of the `return` selectors. */
export interface PGRule {
    id: string;
    name: string;
    severity: PGSeverity;
    message: string;
    description?: string;
    author?: string;
    tags?: string[];
    return: (PGSelector | PGCypher)[];
}

export interface PgqLocation {
    id: string;
    file: string;
    line: number;
    col: number;
    kind?: string;
}

export interface PgqFinding extends PgqLocation {
    ruleId: string;
    severity: PGSeverity;
    message: string;
    /** Where the value came from, for a selector with `from`. */
    source?: PgqLocation;
    hops?: number;
}

export const DEFAULT_MAX_HOPS = 8;
const PARAM = /^[A-Za-z_]\w*$/;

// Strings, backtick names and comments, so `'$fetch'` isn't read as a parameter.
const NOT_CODE = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`]*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
/** The `$name` parameters a Cypher query uses. */
export const cypherParams = (query: string): string[] => [
    ...new Set([...query.replace(NOT_CODE, " ").matchAll(/\$([A-Za-z_]\w*)/g)].map((m) => m[1])),
];

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const isCypher = (x: unknown): x is PGCypher => isObj(x) && "query" in x && !("cypher" in x);
const cyphers = (s: PGSelector): PGCypher[] => [s.cypher].flat();
const froms = (s: PGSelector): PGSelector[] => (s.from === undefined ? [] : [s.from].flat());

// A bare PGCypher in `return` is a selector of one query; cached so it stays one DAG node.
const wrapped = new WeakMap<PGCypher, PGSelector>();
const asSelector = (x: PGSelector | PGCypher): PGSelector => {
    if (!isCypher(x)) return x;
    if (!wrapped.has(x)) wrapped.set(x, { cypher: x });
    return wrapped.get(x)!;
};

/** Problems with `input` (one rule or a list of rules), as messages. Empty means valid. */
export function validatePgq(input: unknown): string[] {
    const errors: string[] = [];
    const rules = Array.isArray(input) ? input : [input];
    const ids = new Set<string>();
    const checked = new Set<unknown>();

    const selector = (s: unknown, at: string, path: unknown[]) => {
        if (path.includes(s)) return void errors.push(`${at}: selector depends on itself (uses/from cycle)`);
        if (checked.has(s)) return;
        if (isCypher(s)) s = asSelector(s);
        if (!isObj(s)) return void errors.push(`${at}: expected a PGSelector or PGCypher`);
        checked.add(s);
        const sel = s as Partial<PGSelector>;
        const qs = sel.cypher === undefined ? [] : [sel.cypher].flat();
        if (!qs.length) errors.push(`${at}.cypher: expected a PGCypher or a non-empty list of them`);
        const provided = new Set(isObj(sel.uses) ? Object.keys(sel.uses) : []);
        qs.forEach((c, i) => {
            const cat = Array.isArray(sel.cypher) ? `${at}.cypher[${i}]` : `${at}.cypher`;
            if (!isCypher(c) || typeof c.query !== "string" || !c.query.trim())
                return void errors.push(`${cat}: expected {query: "<non-empty Cypher>"}`);
            for (const p of cypherParams(c.query))
                if (!provided.has(p)) errors.push(`${cat}: $${p} isn't supplied by uses`);
        });
        if (sel.uses !== undefined && !isObj(sel.uses)) errors.push(`${at}.uses: expected an object of selectors`);
        if (sel.mode !== undefined && !PG_MODES.includes(sel.mode))
            errors.push(`${at}.mode: expected one of ${PG_MODES.join(", ")}`);
        if (sel.maxHops !== undefined && !(Number.isInteger(sel.maxHops) && sel.maxHops >= 0))
            errors.push(`${at}.maxHops: expected a non-negative integer`);
        if ((sel.mode !== undefined || sel.maxHops !== undefined) && sel.from === undefined)
            errors.push(`${at}: mode/maxHops only apply with from`);
        const next = [...path, s];
        for (const [k, d] of Object.entries(isObj(sel.uses) ? sel.uses : {})) {
            if (!PARAM.test(k)) errors.push(`${at}.uses.${k}: a parameter name is letters, digits and _`);
            selector(d, `${at}.uses.${k}`, next);
        }
        if (sel.from !== undefined) {
            const fs = [sel.from].flat();
            if (!fs.length) errors.push(`${at}.from: expected a selector or a non-empty list of them`);
            fs.forEach((f, i) => selector(f, Array.isArray(sel.from) ? `${at}.from[${i}]` : `${at}.from`, next));
        }
    };

    rules.forEach((r, i) => {
        if (!isObj(r)) return void errors.push(`rule ${i}: expected a PGRule object`);
        const at = typeof r.id === "string" && r.id ? r.id : `rule ${i}`;
        for (const k of ["id", "name", "message"] as const)
            if (typeof r[k] !== "string" || !(r[k] as string).trim())
                errors.push(`${at}.${k}: expected a non-empty string`);
        if (!PG_SEVERITIES.includes(r.severity as PGSeverity))
            errors.push(`${at}.severity: expected one of ${PG_SEVERITIES.join(", ")}`);
        for (const k of ["description", "author"] as const)
            if (r[k] !== undefined && typeof r[k] !== "string") errors.push(`${at}.${k}: expected a string`);
        if (r.tags !== undefined && !(Array.isArray(r.tags) && r.tags.every((t) => typeof t === "string")))
            errors.push(`${at}.tags: expected a list of strings`);
        if (typeof r.id === "string") {
            if (ids.has(r.id)) errors.push(`${at}: duplicate rule id`);
            ids.add(r.id);
        }
        if (!Array.isArray(r.return) || !r.return.length)
            return void errors.push(`${at}.return: expected a non-empty list of selectors`);
        r.return.forEach((s, j) => selector(s, `${at}.return[${j}]`, []));
    });
    return errors;
}

/** Prepare every query against `graph`; returns the ones that don't compile. Labels missing from `graph` are not errors. */
export async function checkPgqCypher(graph: PookieGraph, rules: PGRule[]): Promise<string[]> {
    const errors: string[] = [];
    const seen = new Set<string>();
    const visit = async (s: PGSelector, at: string) => {
        for (const c of cyphers(s)) {
            if (seen.has(c.query)) continue;
            seen.add(c.query);
            try {
                const stmt = (await graph.connection.prepare(c.query)) as {
                    isSuccess?(): boolean;
                    getErrorMessage?(): string;
                };
                if (stmt?.isSuccess && !stmt.isSuccess()) throw new Error(stmt.getErrorMessage?.() ?? "prepare failed");
            } catch (e) {
                const msg = (e as Error).message;
                if (!/does not exist/.test(msg)) errors.push(`${at}: ${msg}`);
            }
        }
        for (const [k, d] of Object.entries(s.uses ?? {})) await visit(d, `${at}.uses.${k}`);
        for (const f of froms(s)) await visit(f, `${at}.from`);
    };
    for (const r of rules) for (const [i, s] of r.return.entries()) await visit(asSelector(s), `${r.id}.return[${i}]`);
    return errors;
}

type Row = Record<string, any>;
type Query = (cypher: string, params?: Record<string, unknown>) => Promise<Row[]>;
interface Hit {
    source: string;
    sink: string;
    hops: number;
}
interface Match {
    row: Row;
    source?: Row;
    hops?: number;
}

// FLOWS_TO doesn't cross unresolved calls or member reads (`new URLSearchParams(location.search).get("q")`,
// `location.hash.slice(1)`), so lenient/deep widen a source to the expressions wrapping it and a sink to the
// expressions inside it, up to 3 levels.
const WRAP = "['object', 'callee', 'arguments', 'argument', 'expression', 'expressions', 'quasis']";
const WIDEN_SOURCE = `MATCH (s)-[e:SON*0..3]->(m) WHERE m.id IN $S AND all(r IN rels(e) WHERE r.key IN ${WRAP})
RETURN DISTINCT m.id AS anchor, s.id AS id`;
const WIDEN_SINK = `MATCH (x)-[e:SON*0..3]->(y) WHERE x.id IN $X AND all(r IN rels(e) WHERE r.key IN ${WRAP} OR r.key IN ['left', 'right', 'consequent', 'alternate'])
RETURN DISTINCT x.id AS anchor, y.id AS id`;
const FLOW = `MATCH p = (s)-[:FLOWS_TO|ARGUMENT_TO|RETURNS_TO* SHORTEST 1..30]->(x)
WHERE s.id IN $S AND x.id IN $X
RETURN s.id AS s, x.id AS x, length(p) AS hops`;
const REACH = `MATCH p = (s)-[:FLOWS_TO|ARGUMENT_TO|RETURNS_TO* SHORTEST 1..30]->(x)
WHERE s.id IN $S
RETURN s.id AS s, x.id AS x, length(p) AS hops`;
// Deep mode rounds: each one gets a value past one more opaque call or member read.
const DEEP_ROUNDS = 4;

/** `ids` mapped to themselves, plus every node the widening query returns for them (node -> the id it widens). */
const widen = async (q: Query, cypher: string, key: string, ids: string[]): Promise<Map<string, string>> => {
    const m = new Map(ids.map((id) => [id, id]));
    for (const r of await q(cypher, { [key]: ids })) if (!m.has(r.id)) m.set(r.id, r.anchor);
    return m;
};

/** Every sink in `sinks` that a source in `sources` reaches, with the shortest hop count found. */
async function flows(q: Query, sources: string[], sinks: string[], mode: PGMode): Promise<Hit[]> {
    const best = new Map<string, Hit>();
    const add = (source: string, sink: string, hops: number) => {
        if (!best.has(sink) || best.get(sink)!.hops > hops) best.set(sink, { source, sink, hops });
    };
    if (!sources.length || !sinks.length) return [];
    const X = mode === "strict" ? new Map(sinks.map((id) => [id, id])) : await widen(q, WIDEN_SINK, "X", sinks);

    if (mode !== "deep") {
        const S =
            mode === "strict" ? new Map(sources.map((id) => [id, id])) : await widen(q, WIDEN_SOURCE, "S", sources);
        for (const [id, source] of S) if (X.has(id)) add(source, X.get(id)!, 0); // source inside the sink expression
        for (const r of await q(FLOW, { S: [...S.keys()], X: [...X.keys()] })) add(S.get(r.s)!, X.get(r.x)!, r.hops);
        return [...best.values()];
    }

    // deep: widen whatever the previous round reached and flow again, so
    // `p = new URLSearchParams(location.search); t = p.get("k"); sink(t)` survives both opaque steps
    const origin = new Map(sources.map((id) => [id, { source: id, hops: 0 }]));
    let frontier = [...sources];
    for (let i = 0; i < DEEP_ROUNDS && frontier.length; i++) {
        for (const r of await q(WIDEN_SOURCE, { S: frontier })) {
            if (!origin.has(r.id)) {
                origin.set(r.id, origin.get(r.anchor)!);
                frontier.push(r.id);
            }
        }
        const next: string[] = [];
        for (const r of await q(REACH, { S: frontier })) {
            if (!origin.has(r.x)) {
                const o = origin.get(r.s)!;
                origin.set(r.x, { source: o.source, hops: o.hops + r.hops });
                next.push(r.x);
            }
        }
        frontier = next;
    }
    for (const [id, sink] of X) {
        const o = origin.get(id);
        if (o) add(o.source, sink, o.hops);
    }
    return [...best.values()];
}

// Rows that become findings or sources need a location; a selector used only through `uses` can return just `id`.
const loc = (r: Row): PgqLocation => {
    if (r.file == null || r.line == null || r.col == null)
        throw new Error("a selector in return or from must RETURN id, file, line and col");
    return {
        id: r.id,
        file: r.file,
        line: Number(r.line),
        col: Number(r.col),
        ...(r.kind != null && { kind: String(r.kind) }),
    };
};

/**
 * Run `rules` on `graph`. Selectors are evaluated once per call however many rules share them. Flow modes for `from`:
 * strict follows FLOWS_TO|ARGUMENT_TO|RETURNS_TO from source node to sink node; lenient also widens both ends through
 * up to 3 wrapping expressions; deep repeats lenient for 4 rounds. A rule that fails is reported in `errors` and the
 * others still run.
 */
export async function runPgq(
    graph: PookieGraph,
    rules: PGRule[]
): Promise<{ findings: PgqFinding[]; errors: { ruleId: string; message: string }[] }> {
    const q: Query = async (cypher, params) => {
        try {
            return await graph.query(cypher, params);
        } catch (e) {
            if (/does not exist/.test((e as Error).message)) return []; // no node of that AST type in this graph
            throw e;
        }
    };
    await q("CALL var_length_extend_max_depth=60");

    const memo = new Map<PGSelector, Promise<Match[]>>();
    const evaluate = (s: PGSelector): Promise<Match[]> => {
        if (!memo.has(s)) memo.set(s, evaluateOnce(s));
        return memo.get(s)!;
    };
    const evaluateOnce = async (s: PGSelector): Promise<Match[]> => {
        const params: Record<string, string[]> = {};
        for (const [name, dep] of Object.entries(s.uses ?? {})) {
            const ms = await evaluate(dep);
            if (!ms.length) return [];
            params[name] = ms.map((m) => m.row.id);
        }
        const sources = new Map<string, Row>();
        for (const f of froms(s)) for (const m of await evaluate(f)) sources.set(m.row.id, m.row);
        if (froms(s).length && !sources.size) return [];

        // concat, not push(...rows): a large graph's query can return more rows than fit in an argument list
        let rows: Row[] = [];
        for (const c of cyphers(s)) rows = rows.concat(await q(c.query, params));
        if (rows.some((r) => r.id == null)) throw new Error("every query must RETURN id");
        const byId = new Map(rows.map((r) => [r.id as string, r]));
        if (!froms(s).length) return [...byId.values()].map((row) => ({ row }));

        const maxHops = s.maxHops ?? DEFAULT_MAX_HOPS;
        const hits = await flows(q, [...sources.keys()], [...byId.keys()], s.mode ?? "deep");
        return hits
            .filter((h) => h.hops <= maxHops)
            .map((h) => ({ row: byId.get(h.sink)!, source: sources.get(h.source), hops: h.hops }));
    };

    const findings: PgqFinding[] = [];
    const errors: { ruleId: string; message: string }[] = [];
    for (const rule of rules) {
        try {
            const seen = new Set<string>();
            for (const s of rule.return)
                for (const m of await evaluate(asSelector(s))) {
                    if (seen.has(m.row.id)) continue;
                    seen.add(m.row.id);
                    findings.push({
                        ruleId: rule.id,
                        severity: rule.severity,
                        message: rule.message,
                        ...loc(m.row),
                        ...(m.source && { source: loc(m.source), hops: m.hops }),
                    });
                }
        } catch (e) {
            errors.push({ ruleId: rule.id, message: (e as Error).message });
        }
    }
    return { findings, errors };
}
