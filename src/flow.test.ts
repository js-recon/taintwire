import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import * as taintwire from "./index.js";

const SEMANTIC = ["REFERS_TO", "READS", "WRITES", "FLOWS_TO"] as const;

// Spec cases 1-20 (21 is the idempotency test below), plus extra cases.
const SRC: Record<string, string> = {
    simple: "const x = 1;\nconst y = x;",
    shadowing: "const x = 1;\nfunction f() {\n    const x = 2;\n    return x;\n}",
    parent: "const x = 1;\nfunction f() {\n    return x;\n}",
    assignment: "let y = 0;\nlet x;\nx = y;",
    readWrite: "let x = 0;\nx = x + 1;",
    compound: "let x = 0, y = 1;\nx += y;",
    logical: "let x, y;\nx ||= y;\nx &&= y;\nx ??= y;",
    update: "let x = 0;\nx++;\n--x;",
    call: "function foo() {}\nconst x = 1;\nfoo(x);",
    staticMember: "const obj = {};\nobj.foo;",
    computedMember: "const obj = {}, key = 'k';\nobj[key];",
    propertyWrite: "const obj = {}, x = 1;\nobj.foo = x;",
    arrayDestructure: "let a, b, values;\n[a, b] = values;",
    objectDestructure: "let x, y, obj;\n({ foo: x, bar: y } = obj);",
    conditional: "const condition = true, x = 1, y = 2;\nconst z = condition ? x : y;",
    template: "const name = 'n';\nconst message = `Hello ${name}`;",
    sequence: "function a() {}\nconst value = 1;\nconst x = (a(), value);",
    nested: "let x, y;\ny = (x = source);",
    ret: "function identity(x) {\n    return x;\n}",
    globals: "const x = location.search;\nconsole.log(x);",
    // beyond the spec's list
    functionExpression: "const f = function internal() {\n    return internal;\n};",
    classExpression: "const C = class Internal {\n    method() {\n        return Internal;\n    }\n};",
    nestedScopes: "const value = 1;\nfunction outer() {\n    function inner() {\n        return value;\n    }\n}",
    forOf: "let x;\nconst values = [];\nfor (x of values) {}\nfor (const y of values) {}",
    nonRefs:
        "const o = {}, x = 1;\nouter: for (;;) { break outer; }\nclass K { x() {} #p = 1; m() { return this.#p; } }\n({ x: 1 }).x;\nfunction n() { return new.target; }",
    computedKey: "const k = 'a';\nconst o = { [k]: 1 };\nclass C { [k]() {} }",
    shorthand: "const x = 1;\nconst o = { x };",
    exports: "const x = 1;\nexport { x as y };\nexport { z } from './m.js';\nexport default x;",
    imports: "import { original as local } from './x.js';\nlocal;",
    types: "type T = number;\nconst T = 1;\nlet v: T = T as T;",
    redeclared: "var x = 1;\nvar x = 2;\nx;",
    defaultParam: "const d = 1;\nfunction f(p = d) {\n    return p;\n}",
    unary: "const x = 1;\nconst a = typeof x, b = !x, c = void x, d = -x;",
    hoisted: "f();\nfunction f() {}\nconsole.log(t);\nlet t = 1;",
};
const file = (name: string) => `${name}.${name === "types" ? "ts" : "js"}`;

let g: taintwire.TaintGraph;
beforeAll(async () => {
    g = await taintwire.TaintGraph.open();
    for (const [name, src] of Object.entries(SRC)) await g.add(src, file(name));
});
afterAll(() => g.close());

// Every `rel` edge in a case, as "a -> b": Identifiers as `name` or `name:decl` (a DECLARES target), other nodes as `Type(code)`.
async function edges(name: string, rel: string, graph = g): Promise<string[]> {
    const src = SRC[name];
    const decls = new Set(
        (
            await graph.query("MATCH ()-[:DECLARES]->(i:Identifier) WHERE i.file = $f RETURN i.id AS id", {
                f: file(name),
            })
        ).map((r) => r.id)
    );
    const label = (id: string, type: string, s: number, e: number, n: string | null) =>
        type === "Identifier" ? `${n}${decls.has(id) ? ":decl" : ""}` : `${type}(${src.slice(s, e)})`;
    const rows = await graph.query(
        `MATCH (a)-[e:${rel}]->(b) WHERE a.file = $f RETURN a.id AS a, a.type AS at, a.startOffset AS as, a.endOffset AS ae, a.name AS an, b.id AS b, b.type AS bt, b.startOffset AS bs, b.endOffset AS be, b.name AS bn`,
        { f: file(name) }
    );
    const L = (r: Record<string, unknown>, p: "a" | "b") =>
        label(
            r[p] as string,
            r[`${p}t`] as string,
            Number(r[`${p}s`]),
            Number(r[`${p}e`]),
            r[`${p}n`] as string | null
        );
    return rows.map((r) => `${L(r, "a")} -> ${L(r, "b")}`).sort();
}
const all = async (name: string) =>
    Object.fromEntries(await Promise.all(SEMANTIC.map(async (r) => [r, await edges(name, r)])));
// Whether some FLOWS_TO path runs from a node with code `from` to one with code `to` (cycle-safe).
async function flows(name: string, from: string, to: string) {
    const rows = await g.query(
        "MATCH (a)-[:FLOWS_TO* ACYCLIC 1..12]->(b) WHERE a.file = $f RETURN DISTINCT a.startOffset AS as, a.endOffset AS ae, b.startOffset AS bs, b.endOffset AS be",
        { f: file(name) }
    );
    const s = SRC[name];
    return rows.some((r) => s.slice(Number(r.as), Number(r.ae)) === from && s.slice(Number(r.bs), Number(r.be)) === to);
}

test("1: const y = x", async () => {
    expect(await all("simple")).toEqual({
        REFERS_TO: ["x -> x:decl"],
        READS: ["VariableDeclarator(y = x) -> x:decl"],
        WRITES: ["VariableDeclarator(x = 1) -> x:decl", "VariableDeclarator(y = x) -> y:decl"],
        FLOWS_TO: ["NumericLiteral(1) -> x:decl", "x -> y:decl", "x:decl -> x"],
    });
});

test("2: shadowing resolves to the inner declaration", async () => {
    const [r] = await g.query(
        "MATCH (u:Identifier)-[:REFERS_TO]->(d:Identifier) WHERE u.file = 'shadowing.js' RETURN d.startOffset AS d"
    );
    expect(r.d).toBe(SRC.shadowing.indexOf("x = 2"));
});

test("3: a use resolves through the parent scope", async () => {
    expect(await edges("parent", "REFERS_TO")).toEqual(["x -> x:decl"]);
    const [r] = await g.query(
        "MATCH (u:Identifier)-[:REFERS_TO]->(d:Identifier) WHERE u.file = 'parent.js' RETURN d.startOffset AS d"
    );
    expect(r.d).toBe(SRC.parent.indexOf("x = 1"));
});

test("4: assignment", async () => {
    const e = await all("assignment");
    expect(e.REFERS_TO).toEqual(["x -> x:decl", "y -> y:decl"]);
    expect(e.READS).toEqual(["AssignmentExpression(x = y) -> y:decl"]);
    expect(e.WRITES).toContain("AssignmentExpression(x = y) -> x:decl");
    expect(e.FLOWS_TO).toEqual(
        expect.arrayContaining(["y -> AssignmentExpression(x = y)", "AssignmentExpression(x = y) -> x:decl"])
    );
    expect(await flows("assignment", "y", "x")).toBe(true);
});

test("5: x = x + 1 reads and writes one binding, through the BinaryExpression (a cycle)", async () => {
    const e = await all("readWrite");
    expect(e.REFERS_TO).toEqual(["x -> x:decl", "x -> x:decl"]);
    expect(e.READS).toEqual(["BinaryExpression(x + 1) -> x:decl"]);
    expect(e.WRITES).toEqual(["AssignmentExpression(x = x + 1) -> x:decl", "VariableDeclarator(x = 0) -> x:decl"]);
    expect(e.FLOWS_TO).toEqual(
        [
            "x:decl -> x",
            "x -> BinaryExpression(x + 1)",
            "NumericLiteral(1) -> BinaryExpression(x + 1)",
            "BinaryExpression(x + 1) -> AssignmentExpression(x = x + 1)",
            "AssignmentExpression(x = x + 1) -> x:decl",
            "NumericLiteral(0) -> x:decl",
        ].sort()
    );
    const [ids] = await g.query(
        "MATCH (u:Identifier)-[:REFERS_TO]->(d) WHERE u.file = 'readWrite.js' RETURN count(DISTINCT d.id) AS n"
    );
    expect(ids.n).toBe(1);
});

test("6: compound assignment reads and writes the target", async () => {
    const e = await all("compound");
    expect(e.READS).toEqual(["AssignmentExpression(x += y) -> x:decl", "AssignmentExpression(x += y) -> y:decl"]);
    expect(e.WRITES).toContain("AssignmentExpression(x += y) -> x:decl");
    expect(e.FLOWS_TO).toEqual(
        expect.arrayContaining([
            "x -> AssignmentExpression(x += y)",
            "y -> AssignmentExpression(x += y)",
            "AssignmentExpression(x += y) -> x:decl",
        ])
    );
    // the read and the write go through the same lhs occurrence
    const rows = await g.query(
        "MATCH (a:AssignmentExpression)-[e:READS|WRITES]->(d:Identifier {name: 'x'}) WHERE a.file = 'compound.js' RETURN label(e) AS rel, e.access AS access, e.access_signature AS sig"
    );
    const [lhs] = await g.query(
        "MATCH (:AssignmentExpression)-[:SON {key: 'left'}]->(i:Identifier) WHERE i.file = 'compound.js' RETURN i.id AS id, i.hash AS hash"
    );
    expect(rows.map((r) => [r.access, r.sig])).toEqual([
        [lhs.id, lhs.hash],
        [lhs.id, lhs.hash],
    ]);
});

test("7: logical assignments read and write the target", async () => {
    const e = await all("logical");
    for (const op of ["||=", "&&=", "??="]) {
        expect(e.READS).toContain(`AssignmentExpression(x ${op} y) -> x:decl`);
        expect(e.WRITES).toContain(`AssignmentExpression(x ${op} y) -> x:decl`);
    }
});

test("8: update expressions read and write", async () => {
    const e = await all("update");
    for (const u of ["x++", "--x"]) {
        expect(e.READS).toContain(`UpdateExpression(${u}) -> x:decl`);
        expect(e.WRITES).toContain(`UpdateExpression(${u}) -> x:decl`);
        expect(e.FLOWS_TO).toEqual(
            expect.arrayContaining([`x -> UpdateExpression(${u})`, `UpdateExpression(${u}) -> x:decl`])
        );
    }
});

test("9: a call reads callee and argument, with no call semantics", async () => {
    expect(await edges("call", "READS")).toEqual([
        "CallExpression(foo(x)) -> foo:decl",
        "CallExpression(foo(x)) -> x:decl",
    ]);
    expect((await edges("call", "FLOWS_TO")).filter((e) => e.includes("CallExpression"))).toEqual([]);
    const tables = (await g.query("CALL show_tables() RETURN name")).map((r) => r.name);
    for (const t of ["CALLS", "ARGUMENT_TO", "RETURNS_TO", "CHILD"]) expect(tables).not.toContain(t);
});

test("10: static member access reads the object only", async () => {
    expect(await edges("staticMember", "REFERS_TO")).toEqual(["obj -> obj:decl"]);
    expect(await edges("staticMember", "READS")).toEqual(["MemberExpression(obj.foo) -> obj:decl"]);
    expect(await edges("staticMember", "FLOWS_TO")).not.toContain("obj -> MemberExpression(obj.foo)");
});

test("11: computed member access reads object and key", async () => {
    expect(await edges("computedMember", "READS")).toEqual([
        "MemberExpression(obj[key]) -> key:decl",
        "MemberExpression(obj[key]) -> obj:decl",
    ]);
});

test("12: a property write reads the object and writes no binding", async () => {
    const e = await all("propertyWrite");
    expect(e.READS).toEqual(["AssignmentExpression(obj.foo = x) -> x:decl", "MemberExpression(obj.foo) -> obj:decl"]);
    expect(e.WRITES).not.toContain("AssignmentExpression(obj.foo = x) -> obj:decl");
    expect(e.WRITES.filter((w: string) => w.startsWith("AssignmentExpression"))).toEqual([]);
});

test("13: array destructuring assignment", async () => {
    const e = await all("arrayDestructure");
    expect(e.READS).toEqual(["AssignmentExpression([a, b] = values) -> values:decl"]);
    expect(e.WRITES).toEqual([
        "AssignmentExpression([a, b] = values) -> a:decl",
        "AssignmentExpression([a, b] = values) -> b:decl",
    ]);
    // destructuring is an element read: no flow into a or b until the property pass
    expect(await flows("arrayDestructure", "values", "a")).toBe(false);
});

test("14: object destructuring assignment; keys aren't references", async () => {
    const e = await all("objectDestructure");
    expect(e.REFERS_TO).toEqual(["obj -> obj:decl", "x -> x:decl", "y -> y:decl"]);
    expect(e.READS).toEqual(["AssignmentExpression({ foo: x, bar: y } = obj) -> obj:decl"]);
    expect(e.WRITES).toEqual([
        "AssignmentExpression({ foo: x, bar: y } = obj) -> x:decl",
        "AssignmentExpression({ foo: x, bar: y } = obj) -> y:decl",
    ]);
});

test("15: a conditional's test is read but doesn't flow", async () => {
    const e = await all("conditional");
    const C = "ConditionalExpression(condition ? x : y)";
    expect(e.READS).toEqual([`${C} -> condition:decl`, `${C} -> x:decl`, `${C} -> y:decl`]);
    expect(e.FLOWS_TO).toEqual(expect.arrayContaining([`x -> ${C}`, `y -> ${C}`, `${C} -> z:decl`]));
    expect(e.FLOWS_TO).not.toContain(`condition -> ${C}`);
});

test("16: template literal", async () => {
    expect(await edges("template", "FLOWS_TO")).toEqual(
        expect.arrayContaining([
            "name -> TemplateLiteral(`Hello ${name}`)",
            "TemplateLiteral(`Hello ${name}`) -> message:decl",
        ])
    );
});

test("17: only a sequence's last expression is its value", async () => {
    const into = (await edges("sequence", "FLOWS_TO")).filter((e) => e.endsWith("-> SequenceExpression(a(), value)"));
    expect(into).toEqual(["value -> SequenceExpression(a(), value)"]);
});

test("18: a nested assignment's value flows on", async () => {
    const e = await edges("nested", "FLOWS_TO");
    expect(e).toEqual(
        [
            "source -> AssignmentExpression(x = source)",
            "AssignmentExpression(x = source) -> x:decl",
            "AssignmentExpression(x = source) -> AssignmentExpression(y = (x = source))",
            "AssignmentExpression(y = (x = source)) -> y:decl",
        ].sort()
    );
    expect(await flows("nested", "source", "y")).toBe(true);
});

test("19: return reads the parameter and flows into the ReturnStatement", async () => {
    const e = await all("ret");
    expect(e.REFERS_TO).toEqual(["x -> x:decl"]);
    expect(e.READS).toEqual(["ReturnStatement(return x;) -> x:decl"]);
    expect(e.FLOWS_TO).toEqual(["x -> ReturnStatement(return x;)", "x:decl -> x"]);
});

test("20: unresolved globals stay unresolved, with no fake declarations", async () => {
    const e = await all("globals");
    expect(e.REFERS_TO).toEqual(["x -> x:decl"]);
    expect(e.READS).toEqual(["CallExpression(console.log(x)) -> x:decl"]);
    expect(e.FLOWS_TO).toEqual(["MemberExpression(location.search) -> x:decl", "x:decl -> x"]);
    const [d] = await g.query(
        "MATCH ()-[:DECLARES]->(i:Identifier) WHERE i.file = 'globals.js' RETURN collect(i.name) AS n"
    );
    expect(d.n).toEqual(["x"]);
});

test("named function and class expressions resolve their own name inside", async () => {
    expect(await edges("functionExpression", "REFERS_TO")).toEqual(["internal -> internal:decl"]);
    expect(await edges("classExpression", "REFERS_TO")).toEqual(["Internal -> Internal:decl"]);
});

test("resolution walks every parent scope", async () => {
    expect(await edges("nestedScopes", "REFERS_TO")).toEqual(["value -> value:decl"]);
});

test("for-of writes its target each iteration, without element flow", async () => {
    const e = await all("forOf");
    expect(e.READS).toEqual([
        "ForOfStatement(for (const y of values) {}) -> values:decl",
        "ForOfStatement(for (x of values) {}) -> values:decl",
    ]);
    expect(e.WRITES).toEqual(
        expect.arrayContaining([
            "ForOfStatement(for (x of values) {}) -> x:decl",
            "ForOfStatement(for (const y of values) {}) -> y:decl",
        ])
    );
    expect(await flows("forOf", "values", "x")).toBe(false);
});

test("labels, property and method names, private names and meta properties aren't references", async () => {
    expect(await edges("nonRefs", "REFERS_TO")).toEqual([]);
});

test("computed keys are references, in the scope outside the method", async () => {
    expect(await edges("computedKey", "REFERS_TO")).toEqual(["k -> k:decl", "k -> k:decl"]);
});

test("shorthand properties read the binding", async () => {
    expect(await edges("shorthand", "READS")).toEqual(["ObjectProperty(x) -> x:decl"]);
});

test("exports: a local export names the binding without reading it; a re-export isn't local", async () => {
    expect(await edges("exports", "REFERS_TO")).toEqual(["x -> x:decl", "x -> x:decl"]);
    expect(await edges("exports", "READS")).toEqual(["ExportDefaultDeclaration(export default x;) -> x:decl"]);
});

test("imports: the local name is the declaration, the imported name isn't a reference", async () => {
    expect(await edges("imports", "REFERS_TO")).toEqual(["local -> local:decl"]);
});

test("TS type names aren't value references", async () => {
    // `T` in `T as T` (the value) resolves; the annotation and the asserted type don't
    expect(await edges("types", "REFERS_TO")).toEqual(["T -> T:decl"]);
    expect(await edges("types", "FLOWS_TO")).toEqual(
        expect.arrayContaining(["T -> TSAsExpression(T as T)", "TSAsExpression(T as T) -> v:decl"])
    );
});

test("a var redeclaration shares the first declaration as its summary", async () => {
    expect(await edges("redeclared", "WRITES")).toEqual([
        "VariableDeclarator(x = 1) -> x:decl",
        "VariableDeclarator(x = 2) -> x:decl",
    ]);
    const [n] = await g.query(
        "MATCH (a)-[:WRITES]->(d) WHERE a.file = 'redeclared.js' RETURN count(DISTINCT d.id) AS n"
    );
    expect(n.n).toBe(1);
    expect(await flows("redeclared", "2", "x")).toBe(true);
});

test("a default parameter writes and flows into the parameter", async () => {
    const e = await all("defaultParam");
    expect(e.WRITES).toContain("AssignmentPattern(p = d) -> p:decl");
    expect(await flows("defaultParam", "d", "return p;")).toBe(true);
});

test("unary operators carry their operand's value, except void", async () => {
    const into = (await edges("unary", "FLOWS_TO")).filter((e) => e.startsWith("x -> "));
    expect(into).toEqual(["x -> UnaryExpression(!x)", "x -> UnaryExpression(-x)", "x -> UnaryExpression(typeof x)"]);
    expect(await edges("unary", "READS")).toContain("UnaryExpression(void x) -> x:decl");
});

test("hoisted and TDZ uses still resolve (no control flow)", async () => {
    expect(await edges("hoisted", "REFERS_TO")).toEqual(["f -> f:decl", "t -> t:decl"]);
});

test("21: idempotent and well formed over the fixtures", async () => {
    const h = await taintwire.TaintGraph.open();
    const fixtures = ["modern.js", "webpack-vue.js", "component.tsx"];
    for (const f of fixtures) await h.add(readFileSync(new URL(`../test/${f}`, import.meta.url), "utf-8"), f);
    for (const rel of SEMANTIC) {
        const [dup] = await h.query(
            `MATCH (a)-[e:${rel}]->(b) WITH a.id AS a, b.id AS b, e.access AS x, count(e) AS n WHERE n > 1 RETURN count(*) AS n`.replace(
                ", e.access AS x",
                rel.startsWith("READ") || rel === "WRITES" ? ", e.access AS x" : ""
            )
        );
        expect(dup.n, rel).toBe(0);
    }
    const zero = async (q: string) => expect((await h.query(q))[0].n, q).toBe(0);
    await zero("MATCH (a)-[:REFERS_TO]->(a) RETURN count(*) AS n");
    await zero("MATCH (u)-[:REFERS_TO]->(d) WHERE NOT EXISTS { MATCH ()-[:DECLARES]->(d) } RETURN count(*) AS n");
    await zero("MATCH ()-[:DECLARES]->(u)-[:REFERS_TO]->() RETURN count(*) AS n");
    await zero("MATCH (u)-[:REFERS_TO]->(d) WHERE u.name <> d.name OR u.file <> d.file RETURN count(*) AS n");
    await zero("MATCH (u)-[:REFERS_TO]->(d)-[:IN_SCOPE]->(s:Scope) WHERE s.file <> u.file RETURN count(*) AS n");
    // every access is a resolved use or a declaration, and its signature is that node's hash
    for (const rel of ["READS", "WRITES"]) {
        const rows = await h.query(
            `MATCH ()-[e:${rel}]->(d) RETURN e.access AS a, e.access_signature AS s, d.name AS name`
        );
        expect(rows.length, rel).toBeGreaterThan(0);
        const ids = new Map(
            (
                await h.query(
                    "MATCH (i:Identifier) WHERE EXISTS { MATCH (i)-[:REFERS_TO]->() } OR EXISTS { MATCH ()-[:DECLARES]->(i) } RETURN i.id AS id, i.hash AS hash, i.name AS name"
                )
            ).map((r) => [r.id, r])
        );
        for (const r of rows) {
            expect(ids.get(r.a)?.hash).toBe(r.s);
            expect(ids.get(r.a)?.name).toBe(r.name);
        }
    }
    // re-importing gives the same edges (keyed by position, since AST ids are random)
    // types only for cs-mast vs cs-mast: Babel 8's ImportExpression is a CallExpression in cs-mast's Babel 7
    const snap = async (graph: taintwire.TaintGraph, typed = true) => {
        const out: string[] = [];
        for (const rel of SEMANTIC)
            for (const r of await graph.query(
                `MATCH (a)-[e:${rel}]->(b) RETURN a.file AS f, a.type AS at, a.startOffset AS a, a.endOffset AS ae, b.type AS bt, b.startOffset AS b, b.endOffset AS be`
            ))
                out.push(
                    typed
                        ? `${rel} ${r.f} ${r.at}@${r.a} ${r.bt}@${r.b}`
                        : `${rel} ${r.f} ${r.a}-${r.ae} ${r.b}-${r.be}`
                );
        return out.sort();
    };
    const again = await taintwire.TaintGraph.open();
    for (const f of fixtures) await again.add(readFileSync(new URL(`../test/${f}`, import.meta.url), "utf-8"), f);
    expect(await snap(again)).toEqual(await snap(h));
    // the babel parser gives the same edges, with null signatures
    const babel = await taintwire.TaintGraph.open(":memory:", { parser: "babel" });
    for (const f of fixtures) await babel.add(readFileSync(new URL(`../test/${f}`, import.meta.url), "utf-8"), f);
    expect(await snap(babel, false)).toEqual(await snap(h, false));
    const [nul] = await babel.query("MATCH ()-[e:READS]->() RETURN count(e) AS n, count(e.access_signature) AS s");
    expect(nul.n).toBeGreaterThan(0);
    expect(nul.s).toBe(0);
    await Promise.all([h.close(), again.close(), babel.close()]);
});

test("semantic edges survive save() and reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "taintwire-"));
    const q =
        "MATCH (a)-[e:REFERS_TO|READS|WRITES|FLOWS_TO]->(b) RETURN label(e) AS rel, count(*) AS n, count(e.access) AS acc ORDER BY rel";
    try {
        const before = await g.query(q);
        await g.save(join(dir, "f.lbug"));
        const saved = await taintwire.TaintGraph.open(join(dir, "f.lbug"));
        expect(await saved.query(q)).toEqual(before);
        await saved.add("let late = 1; late;", "late.js"); // reuses the reopened rel pairs
        expect(
            await saved.query("MATCH (s)-[e:READS]->(d:Identifier {file: 'late.js'}) RETURN s.type AS s, d.name AS d")
        ).toEqual([{ s: "ExpressionStatement", d: "late" }]);
        await saved.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
