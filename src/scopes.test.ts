import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "@shriyanss/cs-mast";
import { afterAll, beforeAll, expect, test } from "vitest";
import * as taintwire from "./index.js";

const G = "global:Program";
const M = "module:Program";
const fn = (owner: string, ...up: string[]) => [`function:${owner}`, ...up].join(" < ");

// snippet -> binding name -> its scope chain, innermost first ("kind:OwnerType < ... < root")
const CASES: [string, string, Record<string, string>][] = [
    ["A script", "const x = 1;", { x: G }],
    ["A module", 'import foo from "./foo.js";\nconst x = foo;', { foo: M, x: M }],
    ["B function", "function foo(a) { const b = a; }", { foo: G, a: fn("FunctionDeclaration", G), b: fn("FunctionDeclaration", G) }],
    [
        "C nested functions",
        "const x = 1; function outer(a) { const y = 2; function inner(b) { const z = 3; } }",
        {
            x: G,
            outer: G,
            a: fn("FunctionDeclaration", G),
            y: fn("FunctionDeclaration", G),
            inner: fn("FunctionDeclaration", G),
            b: fn("FunctionDeclaration", "function:FunctionDeclaration", G),
            z: fn("FunctionDeclaration", "function:FunctionDeclaration", G),
        },
    ],
    [
        "D var vs let/const",
        "function foo() { if (true) { var x = 1; let y = 2; const z = 3; } }",
        { foo: G, x: fn("FunctionDeclaration", G), y: `block:BlockStatement < ${fn("FunctionDeclaration", G)}`, z: `block:BlockStatement < ${fn("FunctionDeclaration", G)}` },
    ],
    ["D top-level block", "{ var x; let y; }", { x: G, y: `block:BlockStatement < ${G}` }],
    ["E nested blocks", "{ let outer; { let inner; } }", { outer: `block:BlockStatement < ${G}`, inner: `block:BlockStatement < block:BlockStatement < ${G}` }],
    ["F function expression", "const f = function internal(a) {};", { f: G, internal: fn("FunctionExpression", G), a: fn("FunctionExpression", G) }],
    ["G arrow", "const f = (a, { b }) => { const c = a; };", { f: G, a: fn("ArrowFunctionExpression", G), b: fn("ArrowFunctionExpression", G), c: fn("ArrowFunctionExpression", G) }],
    ["H class declaration", "class Foo { method(a) {} }", { Foo: G, a: fn("ClassMethod", "class:ClassDeclaration", G) }],
    ["I named class expression", "const Foo = class Internal { method() { return Internal; } };", { Foo: G, Internal: `class:ClassExpression < ${G}` }],
    ["J catch", "try {} catch (error) { const x = error; }", { error: `catch:CatchClause < ${G}`, x: `catch:CatchClause < ${G}` }],
    ["K destructured catch", "try {} catch ({ message, code }) {}", { message: `catch:CatchClause < ${G}`, code: `catch:CatchClause < ${G}` }],
    ["L for let", "for (let i = 0; i < 10; i++) { let value = i; }", { i: `block:ForStatement < ${G}`, value: `block:BlockStatement < block:ForStatement < ${G}` }],
    ["M for var", "function foo() { for (var i = 0; i < 10; i++) {} }", { foo: G, i: fn("FunctionDeclaration", G) }],
    ["N switch", "switch (x) { case 1: let a; break; case 2: let b; break; }", { a: `block:SwitchStatement < ${G}`, b: `block:SwitchStatement < ${G}` }],
    ["O static block", "class Foo { static { var x; let y; } }", { Foo: G, x: `static_block:StaticBlock < class:ClassDeclaration < ${G}`, y: `static_block:StaticBlock < class:ClassDeclaration < ${G}` }],
    // beyond the spec's list
    ["for-of const / for-in var", "for (const k of ks) {} for (var p in o) {}", { k: `block:ForOfStatement < ${G}`, p: G }],
    ["catch body var escapes to the var scope", "function f() { try {} catch (e) { var v; } }", { f: G, e: `catch:CatchClause < ${fn("FunctionDeclaration", G)}`, v: fn("FunctionDeclaration", G) }],
    ["static block var nested in a block", "class C { static { { var x; } } }", { C: G, x: `static_block:StaticBlock < class:ClassDeclaration < ${G}` }],
    ["function declared in a block is lexical", "{ function g(a) {} }", { g: `block:BlockStatement < ${G}`, a: fn("FunctionDeclaration", "block:BlockStatement", G) }],
    ["object method", "const o = { m(a) {} };", { o: G, a: fn("ObjectMethod", G) }],
    ["private method", "class C { #p(a) {} }", { C: G, a: fn("ClassPrivateMethod", "class:ClassDeclaration", G) }],
    ["anonymous class expression", "const K = class { m(a) {} };", { K: G, a: fn("ClassMethod", "class:ClassExpression", G) }],
    ["hoisting doesn't move anything", "foo(); function foo() {}", { foo: G }],
    ["no TDZ", "console.log(x); let x = 1;", { x: G }],
    ["using", "{ using r = f(); }", { r: `block:BlockStatement < ${G}` }],
    ["await using", "async function g() { await using r = f(); }", { g: G, r: fn("FunctionDeclaration", G) }],
    ["export wrappers", "export const a = 1; export function b(p) {} export default class {}", { a: M, b: M, p: fn("FunctionDeclaration", M) }],
];

let g: taintwire.TaintGraph;
beforeAll(async () => {
    g = await taintwire.TaintGraph.open();
    for (const [i, [, src]] of CASES.entries()) await g.add(src, `case${i}.js`);
});
afterAll(() => g.close());

// Every scope in `file` as its chain up to the root.
async function chains(file: string) {
    const rows = await g.query(
        "MATCH (o)-[:CREATES_SCOPE]->(s:Scope) WHERE s.file = $file OPTIONAL MATCH (s)-[:PARENT_SCOPE]->(p:Scope) RETURN s.id AS id, s.kind AS kind, o.type AS owner, p.id AS parent",
        { file }
    );
    const byId = new Map(rows.map((r) => [r.id as string, r]));
    const chain = (id: string): string => {
        const r = byId.get(id)!;
        return [`${r.kind}:${r.owner}`, ...(r.parent ? [chain(r.parent as string)] : [])].join(" < ");
    };
    return new Map(rows.map((r) => [r.id as string, chain(r.id as string)]));
}

async function bindings(file: string) {
    const scopes = await chains(file);
    const rows = await g.query("MATCH (i:Identifier {file: $file})-[:IN_SCOPE]->(s:Scope) RETURN i.name AS name, s.id AS scope", { file });
    return Object.fromEntries(rows.map((r) => [r.name as string, scopes.get(r.scope as string)]));
}

test.each(CASES.map(([name, src, want], i) => [name, src, want, i] as const))("%s: %s", async (_, __, want, i) => {
    expect(await bindings(`case${i}.js`)).toEqual(want);
});

const fileOf = (name: string) => `case${CASES.findIndex(([n]) => n === name)}.js`;
const scopeList = async (name: string) => [...(await chains(fileOf(name))).values()].sort();

test("H: the class creates a class scope even with nothing bound in it", async () => {
    expect(await scopeList("H class declaration")).toEqual([G, `class:ClassDeclaration < ${G}`, fn("ClassMethod", "class:ClassDeclaration", G)].sort());
});

test("I: the ReturnStatement's Internal is a use, not a binding", async () => {
    const rows = await g.query("MATCH (i:Identifier) WHERE i.file = $file AND i.name = 'Internal' OPTIONAL MATCH (i)-[e:IN_SCOPE]->() RETURN i.id AS i, count(e) AS n ORDER BY n", {
        file: fileOf("I named class expression"),
    });
    expect(rows.map((r) => r.n)).toEqual([0, 1]);
});

test("M/N: no lexical scope for a var loop, one shared scope for a switch", async () => {
    // the empty `{}` loop body is a block, but the loop itself creates nothing
    expect(await scopeList("M for var")).toEqual([G, fn("FunctionDeclaration", G), `block:BlockStatement < ${fn("FunctionDeclaration", G)}`].sort());
    expect(await scopeList("N switch")).toEqual([G, `block:SwitchStatement < ${G}`].sort());
    const [same] = await g.query("MATCH (a:Identifier {file: $file, name: 'a'})-[:IN_SCOPE]->(s), (b:Identifier {file: $file, name: 'b'})-[:IN_SCOPE]->(t) RETURN s.id = t.id AS eq", {
        file: fileOf("N switch"),
    });
    expect(same.eq).toBe(true);
});

test("a function body is not a separate block scope; a nested block is", async () => {
    await g.add("function foo() { let a; { let b; } }", "body.js");
    expect(await bindings("body.js")).toEqual({ foo: G, a: fn("FunctionDeclaration", G), b: `block:BlockStatement < ${fn("FunctionDeclaration", G)}` });
    const [n] = await g.query("MATCH (f:FunctionDeclaration)-[:SON {key: 'body'}]->(b:BlockStatement) WHERE f.file = 'body.js' OPTIONAL MATCH (b)-[e:CREATES_SCOPE]->() RETURN count(e) AS n");
    expect(n.n).toBe(0);
});

test("computed method keys are evaluated outside the method's scope", async () => {
    await g.add("class C { [(() => 1)()]() {} }", "key.js");
    expect([...(await chains("key.js")).values()].sort()).toEqual(
        [G, `class:ClassDeclaration < ${G}`, fn("ArrowFunctionExpression", "class:ClassDeclaration", G), fn("ClassMethod", "class:ClassDeclaration", G)].sort()
    );
});

test("P: scope provenance and deterministic signatures", async () => {
    const rows = await g.query("MATCH (o)-[:CREATES_SCOPE]->(s:Scope) RETURN s.id AS id, s.kind AS kind, s.signature AS sig, s.owner_signature AS osig, o.hash AS hash");
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
        expect(r.id).toMatch(/^Scope_[0-9a-f]{16}$/);
        expect(r.osig).toBe(r.hash);
        expect(r.osig).toMatch(/^[0-9a-f]{64}$/);
        expect(r.sig).toBe(sha256(`scope:${r.kind}:${r.osig}`));
    }
    // reproducible: the same source in a fresh graph gives the same scope ids and signatures
    const src = CASES.map(([, s]) => s).find((s) => s.startsWith("class Foo { static"))!;
    const snap = async (graph: taintwire.TaintGraph) =>
        (await graph.query("MATCH (s:Scope) RETURN s.id AS id, s.kind AS kind, s.signature AS sig, s.owner_signature AS osig ORDER BY id")).map((r) => JSON.stringify(r));
    const a = await taintwire.import(src, { filename: "same.js" });
    const b = await taintwire.import(src, { filename: "same.js" });
    expect(await snap(a)).toEqual(await snap(b));
    // under another filename: new ids, same signatures
    await b.add(src, "copy.js");
    const sigs = async (file: string) => (await b.query("MATCH (s:Scope {file: $file}) RETURN s.signature AS sig ORDER BY sig", { file })).map((r) => r.sig);
    expect(await sigs("copy.js")).toEqual(await sigs("same.js"));
    const [ids] = await b.query("MATCH (s:Scope) RETURN count(DISTINCT s.id) AS n");
    expect(ids.n).toBe(6);
    await Promise.all([a.close(), b.close()]);
});

test("Q: one scope per owner, one IN_SCOPE per DECLARES, no duplicate edges", async () => {
    await g.add(readFileSync(new URL("../test/modern.js", import.meta.url), "utf-8"), "modern.js");
    await g.add(readFileSync(new URL("../test/webpack-vue.js", import.meta.url), "utf-8"), "webpack-vue.js");
    await g.add(readFileSync(new URL("../test/component.tsx", import.meta.url), "utf-8"), "component.tsx");
    const one = async (q: string) => expect((await g.query(q)).filter((r) => r.n !== 1)).toEqual([]);
    await one("MATCH (o)-[:CREATES_SCOPE]->(s:Scope) RETURN o.id AS o, count(s) AS n");
    await one("MATCH (o)-[:CREATES_SCOPE]->(s:Scope) RETURN s.id AS s, count(o) AS n");
    await one("MATCH (s:Scope)-[:PARENT_SCOPE]->(p:Scope) RETURN s.id AS s, count(p) AS n");
    await one("MATCH ()-[:DECLARES]->(i:Identifier) OPTIONAL MATCH (i)-[e:IN_SCOPE]->(:Scope) RETURN i.id AS i, count(e) AS n");
    await one("MATCH (s:Scope) OPTIONAL MATCH (o)-[e:CREATES_SCOPE]->(s) RETURN s.id AS s, count(e) AS n");
    // exactly one root per file: the Program's
    const roots = await g.query("MATCH (o)-[:CREATES_SCOPE]->(s:Scope) WHERE NOT (s)-[:PARENT_SCOPE]->() RETURN s.file AS file, o.type AS owner");
    expect(new Set(roots.map((r) => r.file)).size).toBe(roots.length);
    expect(new Set(roots.map((r) => r.owner))).toEqual(new Set(["Program"]));
    // a parent is always in the same file
    const [cross] = await g.query("MATCH (s:Scope)-[:PARENT_SCOPE]->(p:Scope) WHERE s.file <> p.file RETURN count(*) AS n");
    expect(cross.n).toBe(0);
    const [counts] = await g.query("MATCH ()-[d:DECLARES]->() WITH count(d) AS d MATCH ()-[e:IN_SCOPE]->() RETURN d, count(e) AS e");
    expect(counts.e).toBe(counts.d);
    for (const rel of ["CREATES_SCOPE", "PARENT_SCOPE", "IN_SCOPE"]) {
        const [dup] = await g.query(`MATCH (a)-[e:${rel}]->(b) WITH a.id AS a, b.id AS b, count(e) AS n WHERE n > 1 RETURN count(*) AS n`);
        expect(dup.n, rel).toBe(0);
    }
});

test("the babel parser builds the same scopes, without signatures", async () => {
    const a = await taintwire.TaintGraph.open();
    const b = await taintwire.TaintGraph.open(":memory:", { parser: "babel" });
    for (const [i, [, src]] of CASES.entries()) await Promise.all([a.add(src, `case${i}.js`), b.add(src, `case${i}.js`)]);
    const q = "MATCH (i:Identifier)-[:IN_SCOPE]->(s:Scope) RETURN i.file AS file, i.name AS name, s.id AS id, s.kind AS kind ORDER BY file, i.startOffset";
    expect(await b.query(q)).toEqual(await a.query(q));
    const [nul] = await b.query("MATCH (s:Scope) RETURN count(*) AS n, count(s.signature) AS sig, count(s.owner_signature) AS osig");
    expect([nul.sig, nul.osig]).toEqual([0, 0]);
    await Promise.all([a.close(), b.close()]);
});

test("scopes survive save() and reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "taintwire-"));
    const q = "MATCH (a)-[e]->(s:Scope) RETURN label(e) AS rel, count(*) AS n ORDER BY rel";
    try {
        const before = await g.query(q);
        await g.save(join(dir, "s.lbug"));
        const saved = await taintwire.TaintGraph.open(join(dir, "s.lbug"));
        expect(await saved.query(q)).toEqual(before);
        expect(await saved.query("MATCH (s:Scope) RETURN count(*) AS n")).toEqual(await g.query("MATCH (s:Scope) RETURN count(*) AS n"));
        await saved.add("{ let late; }", "late.js"); // reuses the reopened Scope table and rel pairs
        expect(await saved.query("MATCH (i:Identifier {file: 'late.js'})-[:IN_SCOPE]->(s:Scope)-[:PARENT_SCOPE]->(p:Scope) RETURN i.name AS i, s.kind AS s, p.kind AS p")).toEqual([
            { i: "late", s: "block", p: "global" },
        ]);
        await saved.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
