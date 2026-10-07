// Print what a saved taintwire graph contains. Needs `npm run build` first.
// Usage: npm run graph:stats -- graph.lbug
import { existsSync } from "node:fs";
import { RELATIONS, TaintGraph } from "../build/index.js";

const path = process.argv[2];
if (!path || !existsSync(path)) {
    console.error("usage: npm run graph:stats -- <file.lbug>");
    process.exit(1);
}
const g = await TaintGraph.open(path);
const n = async (q) => Number((await g.query(q))[0].n);
const table = (rows) => rows.forEach((r) => console.log(`  ${String(r.n).padStart(9)}  ${r.k}`));
try {
    console.log("files:", await n("MATCH (s:Source) RETURN count(*) AS n"));
    console.log(`\nnodes by type (AST node tables, Scope, Source): ${await n("MATCH (x) RETURN count(*) AS n")}`);
    table(await g.query("MATCH (x) RETURN label(x) AS k, count(*) AS n ORDER BY n DESC, k"));
    console.log("\nrelationships:");
    table(await Promise.all(RELATIONS.map(async (r) => ({ k: r, n: await n(`MATCH ()-[e:${r}]->() RETURN count(e) AS n`) }))));
    console.log("\nscopes by kind:");
    table(await g.query("MATCH (s:Scope) RETURN s.kind AS k, count(*) AS n ORDER BY n DESC"));
    // A value-position Identifier with no REFERS_TO and no DECLARES: a global, host API or undeclared name.
    // Static property names, keys, labels, import/export names, meta properties and type names are not references.
    const unresolved = `MATCH (p)-[s:SON]->(i:Identifier)
        WHERE NOT EXISTS { MATCH (i)-[:REFERS_TO]->() } AND NOT EXISTS { MATCH ()-[:DECLARES]->(i) }
          AND NOT (s.key IN ['property', 'key'] AND NOT p.props CONTAINS '"computed":true')
          AND NOT s.key IN ['label', 'imported', 'exported', 'meta'] AND NOT label(p) STARTS WITH 'TS' AND label(p) <> 'PrivateName'`;
    console.log(`\nreferences: ${await n("MATCH ()-[e:REFERS_TO]->() RETURN count(e) AS n")} resolved, ${await n(`${unresolved} RETURN count(*) AS n`)} unresolved; top unresolved names:`);
    table(await g.query(`${unresolved} RETURN i.name AS k, count(*) AS n ORDER BY n DESC LIMIT 10`));
    const calls = await n("MATCH (c) WHERE label(c) IN ['CallExpression', 'OptionalCallExpression'] RETURN count(*) AS n");
    const resolved = await n("MATCH (c)-[:CALLS]->() RETURN count(DISTINCT c) AS n");
    console.log(`\ncalls: ${calls}, resolved ${resolved}, unresolved ${calls - resolved}; unresolved by callee type:`);
    table(
        await g.query(
            "MATCH (c)-[:SON {key: 'callee'}]->(x) WHERE label(c) IN ['CallExpression', 'OptionalCallExpression'] AND NOT EXISTS { MATCH (c)-[:CALLS]->() } RETURN label(x) AS k, count(*) AS n ORDER BY n DESC"
        )
    );
} finally {
    await g.close();
}
