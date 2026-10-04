import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import * as taintwire from "./index.js";

const code = readFileSync(new URL("../test/webpack-vue.js", import.meta.url), "utf-8");

test("imports webpack chunk as AST graph", async () => {
    const g = await taintwire.import(code, { filename: "app.abc123.js" });

    // File -> Program -> ExpressionStatement -> CallExpression (the .push([...]))
    const [root] = await g.query(
        "MATCH (f:File)-[:CHILD {key: 'program'}]->(:Program)-[:CHILD {key: 'body', idx: 0}]->(:ExpressionStatement)-[:CHILD]->(c:CallExpression) RETURN f.file AS file, c.props AS props"
    );
    expect(root.file).toBe("app.abc123.js");

    // child properties are substituted with slug refs that point at the CHILD edge target
    const callee = JSON.parse(root.props as string).callee;
    expect(callee.type).toBe("MemberExpression");
    const [m] = await g.query("MATCH (m:MemberExpression {id: $id})-[:CHILD {key: 'property'}]->(p:Identifier) RETURN p.name AS name", { id: callee.slug_ref });
    expect(m.name).toBe("push");

    // webpack module ids are keys of the modules object
    const mods = await g.query("MATCH (:ObjectProperty)-[:CHILD {key: 'key'}]->(k:NumericLiteral) WHERE k.value IN ['468', '469'] RETURN k.value AS v ORDER BY v");
    expect(mods.map((r) => r.v)).toEqual(["468", "469"]);

    const [si] = await g.query("MATCH (c:CallExpression)-[:CHILD {key: 'callee'}]->(:Identifier {name: 'setInterval'}) RETURN c.line AS line");
    expect(si.line).toBe(30);
    await g.close();
});

test("persists to disk and adds more files after reopening", async () => {
    const dir = mkdtempSync(join(tmpdir(), "taintwire-"));
    const dbPath = join(dir, "graph.lbug");
    try {
        await (await taintwire.import(code, { filename: "a.js", dbPath })).close();
        const g = await taintwire.TaintGraph.open(dbPath);
        await g.add("fetch(location.hash)", "b.js"); // reuses existing tables/CHILD pairs, adds new ones
        const files = await g.query("MATCH (f:File) RETURN f.file AS file ORDER BY file");
        expect(files.map((r) => r.file)).toEqual(["a.js", "b.js"]);
        await g.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("save() writes an in-memory graph to a LadybugDB file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "taintwire-"));
    const dbPath = join(dir, "saved.lbug");
    const count = "MATCH (n) WITH count(n) AS n MATCH ()-[e:CHILD]->() RETURN n, count(e) AS e";
    try {
        const g = await taintwire.import(code, { filename: "app.js" });
        const before = await g.query(count);
        await g.save(dbPath);
        await expect(g.save(dbPath)).rejects.toThrow(/refusing to overwrite/);
        await g.close();

        const saved = await taintwire.TaintGraph.open(dbPath);
        expect(await saved.query(count)).toEqual(before);
        const [si] = await saved.query("MATCH (c:CallExpression)-[:CHILD {key: 'callee'}]->(:Identifier {name: 'setInterval'}) RETURN c.line AS line");
        expect(si.line).toBe(30);
        await saved.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("code() resolves a node id to its source, across save()", async () => {
    const dir = mkdtempSync(join(tmpdir(), "taintwire-"));
    try {
        const g = await taintwire.import('const s = "😀"; fetch(location.hash);', { filename: "c.js" });
        const id = "MATCH (c:CallExpression) RETURN c.id AS id";
        const [{ id: callId }] = await g.query(id);
        // the emoji is 2 UTF-16 units: a code-point-based slice would be off by one
        expect(await g.code(callId as string)).toBe("fetch(location.hash)");
        await expect(g.code("CallExpression_nope")).rejects.toThrow(/no node/);
        await expect(g.add("x", "c.js")).rejects.toThrow();

        const dbPath = join(dir, "c.lbug");
        await g.save(dbPath);
        await g.close();
        const saved = await taintwire.TaintGraph.open(dbPath);
        expect(await saved.code(callId as string)).toBe("fetch(location.hash)");
        await saved.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("cs-mast parser (default) hashes every node", async () => {
    const g = await taintwire.import(code, { filename: "app.abc123.js" });
    const [all] = await g.query("MATCH (n) WHERE n.type IS NOT NULL RETURN count(*) AS nodes, count(n.hash) AS hashed");
    expect(all.hashed).toBe(all.nodes);
    for (const r of await g.query("MATCH (n) WHERE n.type IS NOT NULL RETURN DISTINCT n.hash AS hash")) expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
    // non-scat types (sinc) are Merkle hashes over their children: different calls, different hashes
    const [calls] = await g.query("MATCH (c:CallExpression)-[:CHILD {key: 'callee'}]->(:Identifier {name: 'setInterval'}), (d:CallExpression)-[:CHILD {key: 'callee'}]->(:Identifier {name: 'n'}) RETURN c.hash = d.hash AS eq LIMIT 1");
    expect(calls.eq).toBe(false);
    // name is in scat, so identical names hash identically and different names don't
    const [same] = await g.query("MATCH (a:Identifier {name: 'e'}), (b:Identifier {name: 'e'}) WHERE a.id < b.id RETURN a.hash = b.hash AS eq LIMIT 1");
    expect(same.eq).toBe(true);
    const [diff] = await g.query("MATCH (a:Identifier {name: 'e'}), (b:Identifier {name: 't'}) RETURN a.hash = b.hash AS eq LIMIT 1");
    expect(diff.eq).toBe(false);
    // the hash is a node property (column), not buried in props
    const [p] = await g.query("MATCH (n:Identifier) RETURN n.props AS props LIMIT 1");
    expect(JSON.parse(p.props as string)).not.toHaveProperty("cs-mast-s-hash");
    await g.close();
});

test("babel parser builds the same tree without signatures", async () => {
    const countByType = "MATCH (n) WHERE n.type IS NOT NULL RETURN n.type AS type, count(*) AS n ORDER BY type";
    const cs = await taintwire.import(code, { filename: "app.abc123.js" });
    const babel = await taintwire.import(code, { filename: "app.abc123.js", parser: "babel" });
    expect(await babel.query(countByType)).toEqual(await cs.query(countByType));
    const [hashed] = await babel.query("MATCH (n) WHERE n.hash IS NOT NULL RETURN count(*) AS n");
    expect(hashed.n).toBe(0);
    await cs.close();
    await babel.close();
});

test("cs-mast hashes every node type in modern JS, TypeScript and JSX", async () => {
    const g = await taintwire.import(readFileSync(new URL("../test/modern.js", import.meta.url), "utf-8"), { filename: "modern.js" });
    await g.add(readFileSync(new URL("../test/component.tsx", import.meta.url), "utf-8"), "component.tsx");
    const types = await g.query("MATCH (n) WHERE n.type IS NOT NULL RETURN n.type AS type, count(*) AS total, count(n.hash) AS hashed");
    expect(types.length).toBeGreaterThan(100);
    expect(types.filter((t) => t.hashed !== t.total).map((t) => t.type)).toEqual([]);
    await g.close();
});

test("cs-mast parse errors point at the babel parser, which recovers", async () => {
    const broken = "let a = 1; let a = 2;"; // redeclaration: recoverable error
    await expect(taintwire.import(broken)).rejects.toThrow(/try \{ parser: "babel" \}/);
    const g = await taintwire.import(broken, { parser: "babel" });
    const [d] = await g.query("MATCH (d:VariableDeclaration) RETURN count(*) AS n");
    expect(d.n).toBe(2);
    await g.close();
});
