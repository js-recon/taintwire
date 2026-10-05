import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import * as taintwire from "./index.js";

// snippet -> sorted "SourceType -> name" DECLARES edges
const CASES: [string, string[]][] = [
    ["var x;", ["VariableDeclarator -> x"]],
    ["let x;", ["VariableDeclarator -> x"]],
    ["const x = 1;", ["VariableDeclarator -> x"]],
    ["{ using x = f(); }", ["VariableDeclarator -> x"]],
    ["async function g() { await using y = f(); }", ["FunctionDeclaration -> g", "VariableDeclarator -> y"]],
    ["const a = 1, b = 2;", ["VariableDeclarator -> a", "VariableDeclarator -> b"]],
    ["const { foo: bar, baz, ...rest } = object;", ["VariableDeclarator -> bar", "VariableDeclarator -> baz", "VariableDeclarator -> rest"]],
    ["const { [key]: v } = o;", ["VariableDeclarator -> v"]],
    ["const [a, , { x: b }, ...rest] = values;", ["VariableDeclarator -> a", "VariableDeclarator -> b", "VariableDeclarator -> rest"]],
    ["function foo(a, { b }, ...rest) {}", ["FunctionDeclaration -> a", "FunctionDeclaration -> b", "FunctionDeclaration -> foo", "FunctionDeclaration -> rest"]],
    ["function f(x = defaultValue, { y = z } = {}) {}", ["FunctionDeclaration -> f", "FunctionDeclaration -> x", "FunctionDeclaration -> y"]],
    ["function* gen(a) {}", ["FunctionDeclaration -> a", "FunctionDeclaration -> gen"]],
    ["async function* ag(a) {}", ["FunctionDeclaration -> a", "FunctionDeclaration -> ag"]],
    ["const f = function inner(x) {};", ["FunctionExpression -> inner", "FunctionExpression -> x", "VariableDeclarator -> f"]],
    ["const f = function (x) {};", ["FunctionExpression -> x", "VariableDeclarator -> f"]],
    ["const g = (x, { y }) => x + y;", ["ArrowFunctionExpression -> x", "ArrowFunctionExpression -> y", "VariableDeclarator -> g"]],
    ["class Foo {}", ["ClassDeclaration -> Foo"]],
    ["const Foo = class Internal {};", ["ClassExpression -> Internal", "VariableDeclarator -> Foo"]],
    ["const Foo = class {};", ["VariableDeclarator -> Foo"]],
    ["const object = { method(a) {}, get p() {}, key: 1 };", ["ObjectMethod -> a", "VariableDeclarator -> object"]],
    [
        "class C { constructor(c) {} method(a) {} static async *gm(g) {} set s(v) {} #privateMethod(b) {} field = 1; }",
        ["ClassDeclaration -> C", "ClassMethod -> a", "ClassMethod -> c", "ClassMethod -> g", "ClassMethod -> v", "ClassPrivateMethod -> b"],
    ],
    ['import defaultValue from "./x.js";', ["ImportDefaultSpecifier -> defaultValue"]],
    ['import { original as alias } from "./x.js";', ["ImportSpecifier -> alias"]],
    ['import { same } from "./x.js";', ["ImportSpecifier -> same"]],
    ['import * as namespace from "./x.js";', ["ImportNamespaceSpecifier -> namespace"]],
    ["try {} catch (error) {}", ["CatchClause -> error"]],
    ["try {} catch ({ name, message }) {}", ["CatchClause -> message", "CatchClause -> name"]],
    ["try {} catch {}", []],
    ["for (const k of ks) {} for (let i = 0; i < n; i++) {} for (var p in o) {}", ["VariableDeclarator -> i", "VariableDeclarator -> k", "VariableDeclarator -> p"]],
    // negatives: wrappers, re-exports, control flow, assignment patterns
    ["export const x = 1;", ["VariableDeclarator -> x"]],
    ["export default function () {}", []],
    ["let x; export { x };", ["VariableDeclarator -> x"]],
    ['export { y } from "./y.js"; export * from "./z.js";', []],
    ["function r() { if (a) return b; switch (c) { case 1: break; } while (d) { continue; } throw e; }", ["FunctionDeclaration -> r"]],
    ["({ a, b } = o); [c] = d; o.p = 1;", []],
];

let g: taintwire.TaintGraph;
beforeAll(async () => {
    g = await taintwire.TaintGraph.open();
    for (const [i, [src]] of CASES.entries()) await g.add(src, `case${i}.js`);
});
afterAll(() => g.close());

const declaresIn = async (file: string) =>
    (await g.query("MATCH (a)-[:DECLARES]->(i) WHERE a.file = $file RETURN a.type AS a, i.name AS i", { file })).map((r) => `${r.a} -> ${r.i}`).sort();

test.each(CASES.map(([src, want], i) => [src, want, i] as const))("%s", async (_, want, i) => {
    expect(await declaresIn(`case${i}.js`)).toEqual(want);
});

test("only binding-introducing nodes produce DECLARES, and targets are Identifiers", async () => {
    await g.add(readFileSync(new URL("../test/modern.js", import.meta.url), "utf-8"), "modern.js");
    await g.add(readFileSync(new URL("../test/webpack-vue.js", import.meta.url), "utf-8"), "webpack-vue.js");
    const producers = ["VariableDeclarator", "FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "ClassDeclaration", "ClassExpression", "ObjectMethod", "ClassMethod", "ClassPrivateMethod", "ImportSpecifier", "ImportDefaultSpecifier", "ImportNamespaceSpecifier", "CatchClause"];
    for (const r of await g.query("MATCH (a)-[:DECLARES]->(b) RETURN DISTINCT a.type AS a, b.type AS b")) {
        expect(producers).toContain(r.a);
        expect(r.b).toBe("Identifier");
    }
    // a method/property key is never a DECLARES target
    const [keys] = await g.query("MATCH ()-[:SON {key: 'key'}]->(k)<-[:DECLARES]-() RETURN count(k) AS n");
    expect(keys.n).toBe(0);
});

test("DECLARES endpoints are the existing cs-mast nodes, with their hashes", async () => {
    const [ends] = await g.query("MATCH (a)-[:DECLARES]->(b) RETURN count(*) AS n, count(a.hash) AS ah, count(b.hash) AS bh");
    expect(ends.n).toBeGreaterThan(0);
    expect([ends.ah, ends.bh]).toEqual([ends.n, ends.n]);
    for (const r of await g.query("MATCH (a)-[:DECLARES]->(b) RETURN DISTINCT a.hash AS a, b.hash AS b")) {
        expect(r.a).toMatch(/^[0-9a-f]{64}$/);
        expect(r.b).toMatch(/^[0-9a-f]{64}$/);
    }
    // the target is the same node the declarator's SON {key: 'id'} edge reaches, not a copy
    const [same] = await g.query("MATCH (d:VariableDeclarator {file: 'case2.js'})-[:DECLARES]->(i), (d)-[:SON {key: 'id'}]->(j) RETURN i.id = j.id AS eq");
    expect(same.eq).toBe(true);
    const [ids] = await g.query("MATCH (i:Identifier) WITH count(i) AS n, count(DISTINCT i.id) AS d RETURN n = d AS unique");
    expect(ids.unique).toBe(true);
});

test("DECLARES survives save() and reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "taintwire-"));
    const count = "MATCH ()-[e:DECLARES]->() RETURN count(e) AS n";
    try {
        const before = await g.query(count);
        await g.save(join(dir, "d.lbug"));
        const saved = await taintwire.TaintGraph.open(join(dir, "d.lbug"));
        expect(await saved.query(count)).toEqual(before);
        await saved.add("let late;", "late.js"); // reuses the reopened DECLARES table
        expect(await saved.query("MATCH (a {file: 'late.js'})-[:DECLARES]->(i) RETURN i.name AS n")).toEqual([{ n: "late" }]);
        await saved.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
