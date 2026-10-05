// Test helpers shared by the semantic suites. Not part of the build (see tsconfig.json).
import type { TaintGraph } from "./index.js";

/**
 * Every `rel` edge starting in `file`, as sorted "a -> b" strings: Identifiers as `name`, or `name:decl` for a
 * DECLARES target, and other nodes as `Type(code)`, sliced from `src`.
 */
export async function edgeList(g: TaintGraph, file: string, src: string, rel: string): Promise<string[]> {
    const decls = new Set(
        (await g.query("MATCH ()-[:DECLARES]->(i:Identifier) WHERE i.file = $f RETURN i.id AS id", { f: file })).map(
            (r) => r.id
        )
    );
    const rows = await g.query(
        `MATCH (a)-[e:${rel}]->(b) WHERE a.file = $f RETURN a.id AS a, a.type AS at, a.startOffset AS as, a.endOffset AS ae, a.name AS an, b.id AS b, b.type AS bt, b.startOffset AS bs, b.endOffset AS be, b.name AS bn`,
        { f: file }
    );
    const L = (r: Record<string, unknown>, p: "a" | "b") =>
        r[`${p}t`] === "Identifier"
            ? `${r[`${p}n`]}${decls.has(r[p] as string) ? ":decl" : ""}`
            : `${r[`${p}t`]}(${src.slice(Number(r[`${p}s`]), Number(r[`${p}e`]))})`;
    return rows.map((r) => `${L(r, "a")} -> ${L(r, "b")}`).sort();
}

/** Whether a value path (FLOWS_TO, ARGUMENT_TO, RETURNS_TO; cycle-safe) runs from a node with code `from` to one with code `to`. */
export async function reaches(
    g: TaintGraph,
    file: string,
    src: string,
    from: string,
    to: string,
    rels = "FLOWS_TO|ARGUMENT_TO|RETURNS_TO"
) {
    const rows = await g.query(
        `MATCH (a)-[:${rels}* ACYCLIC 1..30]->(b) WHERE a.file = $f RETURN DISTINCT a.startOffset AS as, a.endOffset AS ae, b.startOffset AS bs, b.endOffset AS be`,
        { f: file }
    );
    return rows.some(
        (r) => src.slice(Number(r.as), Number(r.ae)) === from && src.slice(Number(r.bs), Number(r.be)) === to
    );
}
