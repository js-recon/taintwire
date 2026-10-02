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
