import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import * as taintwire from "./index.js";
import { edgeList, reaches } from "./test-utils.js";
import { cs_mast_init } from "@shriyanss/cs-mast";
import type { Node } from "@babel/types";

const cs = (code: string) => cs_mast_init(code, taintwire.CS_MAST_CONFIG).root._raw as Node;

const CALL_RELS = ["CALLS", "ARGUMENT_TO", "RETURNS_TO"] as const;

const SRC: Record<string, string> = {
    // CALLS: what resolves
    fnDecl: "function foo(x) {}\nfoo(value);",
    fnExpr: "const foo = function (x) {};\nfoo(value);",
    arrow: "const foo = (x) => x;\nfoo(value);",
    iife: "(function (x) {})(value);\n((x) => x)(value);\n!function (y) {}(value);",
    alias: "function foo(x) {}\nconst bar = foo;\nconst baz = bar;\nbaz(value);\n(0, foo)(value);",
    hoisted: "foo();\nfunction foo() {}",
    reassignedKnown: "function foo(a) {}\nfunction bar(b) {}\nlet f = foo;\nf = bar;\nf(x);",
    choice: "function foo() {}\nfunction bar() {}\nconst h = c ? foo : bar;\nh();\n(c || foo)();\n(foo || bar)();",
    selfName: "const f = function g(n) {\n    return n ? g(n - 1) : 0;\n};\nf(5);",
    optional: "const foo = (x) => x;\nfoo?.(1);",
    recursion: "function f(n) {\n    return f(n - 1);\n}\nf(3);",
    // CALLS: what stays unresolved
    reassignedUnknown: "function foo(a) {}\nlet f = foo;\nf = obj.m;\nf(x);",
    member: "const obj = { foo() {} };\nobj.foo();\nobj['foo']();\nobj[key]();",
    builtins: "eval('1');\nfetch(url);\nsetTimeout(cb, 1);",
    param: "function apply(fn, x) {\n    return fn(x);\n}\napply((v) => v, 1);",
    imported: "import { f } from './x.js';\nf();",
    klass: "class K {}\nK();",
    shadowedCallee: "function foo() {}\nfunction g(foo) {\n    foo();\n}",
    overwritten: "var f = 1;\nfunction f() {}\nf();",
    otherWrites: "function foo() {}\nlet f = foo;\nf += '';\nf();\nlet { g } = o;\ng();\nlet h = foo;\nh++;\nh();",
    cycle: "let p = q;\nlet q = p;\np();",
    defaultedParam: "function noop() {}\nfunction run(cb = noop) {\n    cb();\n}\nrun(other);",
    outOfScope: "function f() {\n    function helper() {}\n}\nhelper();",
    paramReassigned: "function noop() {}\nfunction run(cb) {\n    if (c) cb = noop;\n    cb();\n}\ntry {} catch (e) {\n    if (c) e = noop;\n    e();\n}",
    uninitialized: "let f;\nf();",
    newExpr: "function F(x) {}\nnew F(1);\nF`t`;",
    // ARGUMENT_TO
    id: "function id(x) {\n    return x;\n}\nid(source);",
    defaultParam: "function f(x = defaultValue) {}\nf(value);",
    rest: "function f(a, ...rest) {}\nf(x, y, z);",
    missing: "function f(a, b) {}\nf(x);",
    extra: "function f(a) {}\nf(x, y);",
    spread: "function f(a, b) {}\nf(...xs, y);\nf(x, ...ys);",
    destructuredParams: "function f({ a }, [b], c) {}\nf(o, arr, z);",
    unrelated: "function f(a) {}\nfunction g(b) {}\nf(x);",
    thisParam: "function t(this: Window, a: number) {}\nt(1);",
    // RETURNS_TO
    multipleReturns: "function f(x) {\n    if (x) return a;\n    return b;\n}\nf(1);",
    bareReturn: "function f() {\n    return;\n}\nf();\nfunction g() {}\nconst r = g();",
    nested: "function outer() {\n    function inner() {\n        return 1;\n    }\n    [1].map((v) => {\n        return v;\n    });\n    return 2;\n}\nouter();",
    asyncGen:
        "async function af(x) {\n    return x;\n}\naf(1);\nfunction* gen(x) {\n    return x;\n}\ngen(1);\nconst aa = async (x) => x;\naa(2);",
    // interprocedural paths
    pass: "function pass(x) {\n    return x;\n}\nconst a = source;\nconst b = pass(a);\nsink(b);",
    chain2: "function f(x) {\n    return g(x);\n}\nfunction g(y) {\n    return y;\n}\nconst out = f(source);\nsink(out);",
    nestedCalls: "const id = (x) => x;\nconst out = id(id(source));",
    callsites: "function id(x) {\n    return x;\n}\nconst a = id(s1);\nconst b = id(s2);",
    multiArgs: "function pick(a, b) {\n    return b;\n}\nconst out = pick(source, safe);",
    recursive: "function f(n, x) {\n    return n ? f(n - 1, x) : x;\n}\nconst out = f(3, source);",
    mutual: "function even(n, x) {\n    return n ? odd(n - 1, x) : x;\n}\nfunction odd(n, x) {\n    return n ? even(n - 1, x) : x;\n}\nconst out = even(4, source);",
    opaque: "const out = unknownFn(source);\nconst out2 = obj.m(source);",
    // the end-to-end demos
    demoEval: "function pass(x) {\n    return x;\n}\nconst data = pass(location.search);\neval(data);",
    demoTrim:
        'const q = location.search;\nfunction normalize(x) {\n    return x.trim();\n}\nconst cleanish = normalize(q);\ndocument.getElementById("out").innerHTML = "Results: " + cleanish;',
};
const file = (name: string) => `${name}.${name === "thisParam" ? "ts" : "js"}`;

let g: taintwire.TaintGraph;
beforeAll(async () => {
    g = await taintwire.TaintGraph.open();
    for (const [name, src] of Object.entries(SRC)) await g.add(src, file(name));
});
afterAll(() => g.close());

const edges = (name: string, rel: string) => edgeList(g, file(name), SRC[name], rel);
const flows = (name: string, from: string, to: string) => reaches(g, file(name), SRC[name], from, to);
const calls = (name: string) => edges(name, "CALLS");

test("A: a call to a function declaration", async () => {
    expect(await calls("fnDecl")).toEqual(["CallExpression(foo(value)) -> FunctionDeclaration(function foo(x) {})"]);
});

test("B, C: function and arrow expressions through a const", async () => {
    expect(await calls("fnExpr")).toEqual(["CallExpression(foo(value)) -> FunctionExpression(function (x) {})"]);
    expect(await calls("arrow")).toEqual(["CallExpression(foo(value)) -> ArrowFunctionExpression((x) => x)"]);
});

test("D: IIFEs, including the !function(){}() form", async () => {
    expect(await calls("iife")).toEqual([
        "CallExpression(((x) => x)(value)) -> ArrowFunctionExpression((x) => x)",
        "CallExpression((function (x) {})(value)) -> FunctionExpression(function (x) {})",
        "CallExpression(function (y) {}(value)) -> FunctionExpression(function (y) {})",
    ]);
});

test("E: aliases, alias chains and (0, f)() resolve through REFERS_TO, not names", async () => {
    expect(await calls("alias")).toEqual([
        "CallExpression((0, foo)(value)) -> FunctionDeclaration(function foo(x) {})",
        "CallExpression(baz(value)) -> FunctionDeclaration(function foo(x) {})",
    ]);
    expect(await calls("hoisted")).toEqual(["CallExpression(foo()) -> FunctionDeclaration(function foo() {})"]);
});

test("F: a binding with several known functions may call each, and says so", async () => {
    expect(await calls("reassignedKnown")).toEqual([
        "CallExpression(f(x)) -> FunctionDeclaration(function bar(b) {})",
        "CallExpression(f(x)) -> FunctionDeclaration(function foo(a) {})",
    ]);
    const rows = await g.query("MATCH (c)-[e:CALLS]->() WHERE c.file = 'reassignedKnown.js' RETURN e.candidates AS n");
    expect(rows.map((r) => r.n)).toEqual([2, 2]);
    expect(await calls("choice")).toEqual(
        [
            "CallExpression(h()) -> FunctionDeclaration(function foo() {})",
            "CallExpression(h()) -> FunctionDeclaration(function bar() {})",
            "CallExpression((foo || bar)()) -> FunctionDeclaration(function foo() {})",
            "CallExpression((foo || bar)()) -> FunctionDeclaration(function bar() {})",
        ].sort()
    ); // `c || foo` stays unresolved: `c` is unknown
});

test("F: one unknown definition leaves the call unresolved", async () => {
    expect(await calls("reassignedUnknown")).toEqual([]);
    expect(await calls("otherWrites")).toEqual([]); // compound, destructured, updated
    expect(await calls("overwritten")).toEqual([]); // var f = 1 also defines f
    expect(await calls("cycle")).toEqual([]);
    expect(await calls("uninitialized")).toEqual([]);
});

test("recursion, a named expression calling itself, and optional calls", async () => {
    expect(await calls("recursion")).toEqual([
        "CallExpression(f(3)) -> FunctionDeclaration(function f(n) {\n    return f(n - 1);\n})",
        "CallExpression(f(n - 1)) -> FunctionDeclaration(function f(n) {\n    return f(n - 1);\n})",
    ]);
    expect((await calls("selfName")).length).toBe(2);
    expect(await calls("optional")).toEqual(["OptionalCallExpression(foo?.(1)) -> ArrowFunctionExpression((x) => x)"]);
});

test("G, H: members, builtins, params, imports and classes stay unresolved, with no fake declarations", async () => {
    for (const name of ["member", "builtins", "imported", "klass", "shadowedCallee", "newExpr"])
        expect(await calls(name), name).toEqual([]);
    // a defaulted param isn't just its default: callers pass other values
    expect((await calls("defaultedParam")).filter((c) => c.startsWith("CallExpression(cb()"))).toEqual([]);
    // a param or catch param sometimes reassigned to a known function may still be whatever was passed or thrown
    expect(await calls("paramReassigned")).toEqual([]);
    // never by name: `helper` is only declared inside f
    expect(await calls("outOfScope")).toEqual([]);
    // apply() resolves; fn(x) inside it doesn't (a param), but the callback still flows into fn
    expect(await calls("param")).toEqual([
        "CallExpression(apply((v) => v, 1)) -> FunctionDeclaration(function apply(fn, x) {\n    return fn(x);\n})",
    ]);
    expect(await edges("param", "ARGUMENT_TO")).toEqual([
        "ArrowFunctionExpression((v) => v) -> fn:decl",
        "NumericLiteral(1) -> x:decl",
    ]);
    const [d] = await g.query("MATCH ()-[:DECLARES]->(i:Identifier) WHERE i.file = 'builtins.js' RETURN count(*) AS n");
    expect(d.n).toBe(0);
});

test("ARGUMENT_TO: by position, with the argument index and callsite", async () => {
    expect(await edges("id", "ARGUMENT_TO")).toEqual(["source -> x:decl"]);
    const [e] = await g.query(
        "MATCH (a)-[e:ARGUMENT_TO]->(p:Identifier), (c:CallExpression) WHERE a.file = 'id.js' AND c.id = e.callsite RETURN e.arg_index AS i, c.startOffset AS c, p.startOffset AS p"
    );
    expect(e).toEqual({ i: 0, c: SRC.id.indexOf("id(source)"), p: SRC.id.indexOf("x)") });
});

test("ARGUMENT_TO: defaults, rest, missing, extra, spread and destructured params", async () => {
    expect(await edges("defaultParam", "ARGUMENT_TO")).toEqual(["value -> x:decl"]); // not defaultValue
    expect(await edges("rest", "ARGUMENT_TO")).toEqual(["x -> a:decl", "y -> rest:decl", "z -> rest:decl"]);
    const idx = await g.query(
        "MATCH (a)-[e:ARGUMENT_TO]->(p) WHERE a.file = 'rest.js' RETURN a.name AS a, e.arg_index AS i ORDER BY i"
    );
    expect(idx).toEqual([
        { a: "x", i: 0 },
        { a: "y", i: 1 },
        { a: "z", i: 2 },
    ]);
    expect(await edges("missing", "ARGUMENT_TO")).toEqual(["x -> a:decl"]);
    expect(await edges("extra", "ARGUMENT_TO")).toEqual(["x -> a:decl"]);
    expect(await edges("spread", "ARGUMENT_TO")).toEqual(["x -> a:decl"]); // nothing at or after a spread
    expect(await edges("destructuredParams", "ARGUMENT_TO")).toEqual(["z -> c:decl"]);
    expect(await edges("unrelated", "ARGUMENT_TO")).toEqual(["x -> a:decl"]); // never g's b, though the index matches
    expect(await edges("thisParam", "ARGUMENT_TO")).toEqual(["NumericLiteral(1) -> a:decl"]); // TS `this` isn't a param
    expect(await edges("reassignedKnown", "ARGUMENT_TO")).toEqual(["x -> a:decl", "x -> b:decl"]);
});

test("RETURNS_TO: every explicit return of the callee, and nothing else", async () => {
    expect(await edges("multipleReturns", "RETURNS_TO")).toEqual([
        "ReturnStatement(return a;) -> CallExpression(f(1))",
        "ReturnStatement(return b;) -> CallExpression(f(1))",
    ]);
    expect(await edges("bareReturn", "RETURNS_TO")).toEqual([]); // no synthetic undefined
    expect(await edges("nested", "RETURNS_TO")).toEqual(["ReturnStatement(return 2;) -> CallExpression(outer())"]);
    expect(await edges("arrow", "RETURNS_TO")).toEqual(["x -> CallExpression(foo(value))"]); // a concise body is the return value
});

test("RETURNS_TO: async functions and generators return a promise or an iterator, so none", async () => {
    expect((await calls("asyncGen")).length).toBe(3);
    expect(await edges("asyncGen", "ARGUMENT_TO")).toEqual([
        "NumericLiteral(1) -> x:decl",
        "NumericLiteral(1) -> x:decl",
        "NumericLiteral(2) -> x:decl",
    ]);
    expect(await edges("asyncGen", "RETURNS_TO")).toEqual([]);
});

test("interprocedural: one function, a two-function chain and nested calls", async () => {
    expect(await flows("pass", "source", "b")).toBe(true);
    // ...all the way to the sink's argument
    const [p] = await g.query(
        `MATCH (s:Identifier {name: 'source'}), p = (s)-[:FLOWS_TO|ARGUMENT_TO|RETURNS_TO* SHORTEST 1..30]->(arg),
               (c:CallExpression)-[:SON {key: 'arguments'}]->(arg), (c)-[:SON {key: 'callee'}]->(:Identifier {name: 'sink'})
         WHERE s.file = 'pass.js'
         RETURN properties(rels(p), '_label') AS rels`
    );
    expect(p.rels).toEqual([
        "FLOWS_TO",
        "FLOWS_TO",
        "ARGUMENT_TO",
        "FLOWS_TO",
        "FLOWS_TO",
        "RETURNS_TO",
        "FLOWS_TO",
        "FLOWS_TO",
    ]);
    expect(await flows("chain2", "source", "out")).toBe(true);
    expect(await flows("nestedCalls", "source", "out")).toBe(true);
});

test("interprocedural: callsites are merged (context-insensitive), arguments are not", async () => {
    // a known over-approximation: both calls share id's return, so s1 also reaches b
    expect(await flows("callsites", "s1", "a")).toBe(true);
    expect(await flows("callsites", "s1", "b")).toBe(true);
    // but an argument only reaches its own parameter
    expect(await flows("multiArgs", "safe", "out")).toBe(true);
    expect(await flows("multiArgs", "source", "out")).toBe(false);
});

test("interprocedural: recursion and mutual recursion (cycles are expected)", async () => {
    expect(await flows("recursive", "source", "out")).toBe(true);
    expect(await flows("mutual", "source", "out")).toBe(true);
    const [n] = await g.query("MATCH (c)-[:CALLS]->(f) WHERE c.file = 'mutual.js' RETURN count(*) AS n");
    expect(n.n).toBe(3);
});

test("interprocedural: unresolved and member calls are opaque", async () => {
    expect(await flows("opaque", "source", "out")).toBe(false);
    expect(await flows("opaque", "source", "out2")).toBe(false);
});

test("demo: location.search through pass() into eval()", async () => {
    const [p] = await g.query(
        `MATCH (src:MemberExpression)-[:SON {key: 'object'}]->(:Identifier {name: 'location'}),
               (src)-[:SON {key: 'property'}]->(:Identifier {name: 'search'}),
               p = (src)-[:FLOWS_TO|ARGUMENT_TO|RETURNS_TO* SHORTEST 1..30]->(arg),
               (sink:CallExpression)-[:SON {key: 'arguments'}]->(arg), (sink)-[:SON {key: 'callee'}]->(:Identifier {name: 'eval'})
         WHERE src.file = 'demoEval.js'
         RETURN properties(nodes(p), 'type') AS types, properties(nodes(p), 'name') AS names, properties(rels(p), '_label') AS rels`
    );
    // source -> argument -> parameter -> use -> return -> call result -> binding -> sink argument
    expect(p.types).toEqual([
        "MemberExpression",
        "Identifier",
        "Identifier",
        "ReturnStatement",
        "CallExpression",
        "Identifier",
        "Identifier",
    ]);
    expect(p.names).toEqual([null, "x", "x", null, null, "data", "data"]);
    expect(p.rels).toEqual(["ARGUMENT_TO", "FLOWS_TO", "FLOWS_TO", "RETURNS_TO", "FLOWS_TO", "FLOWS_TO"]);
});

test("demo: x.trim() is a member call, so the path stops at x (no fake member-call flow)", async () => {
    expect(await flows("demoTrim", "location.search", "x")).toBe(true); // through q and the argument
    expect(await flows("demoTrim", "location.search", "cleanish")).toBe(false);
    // with a resolvable function the same sink is reached: see demoEval
});

test("regression: alias cycles share their definitions", async () => {
    // f and g alias each other, and between them only ever hold foo
    const h = await taintwire.import("function foo() {}\nlet f = foo;\nlet g = f;\nf = g;\ng();\nf();", { filename: "cyc.js" });
    const rows = await h.query("MATCH (c:CallExpression)-[e:CALLS]->(fn:FunctionDeclaration) RETURN count(c) AS n, min(e.candidates) AS k");
    expect(rows).toEqual([{ n: 2, k: 1 }]);
    await h.close();
});

test("regression: a 20,000-link alias chain resolves without recursion (was a stack overflow, and quadratic)", async () => {
    const n = 20000;
    const forward = "const a0 = function (x) { return x; };\n" + Array.from({ length: n }, (_, i) => `const a${i + 1} = a${i};\na${i + 1}(1);`).join("\n");
    const reversed = Array.from({ length: n }, (_, i) => `const a${i} = a${i + 1};\na${i}(1);`).join("\n") + `\nconst a${n} = (x) => x;`;
    for (const code of [forward, reversed]) {
        const { rels } = taintwire.flatten(cs(code), "chain.js");
        expect([...rels.CALLS.values()].reduce((a, e) => a + e.length, 0)).toBe(n);
    }
});

test("no duplicate call edges; save() and reopen keep them; babel builds the same", async () => {
    for (const rel of CALL_RELS) {
        const [dup] = await g.query(
            `MATCH (a)-[e:${rel}]->(b) WITH a.id AS a, b.id AS b, ${rel === "ARGUMENT_TO" ? "e.callsite" : "''"} AS c, count(e) AS n WHERE n > 1 RETURN count(*) AS n`
        );
        expect(dup.n, rel).toBe(0);
    }
    const q = "MATCH (a)-[e:CALLS|ARGUMENT_TO|RETURNS_TO]->(b) RETURN label(e) AS rel, count(*) AS n ORDER BY rel";
    const dir = mkdtempSync(join(tmpdir(), "taintwire-"));
    try {
        await g.save(join(dir, "c.lbug"));
        const saved = await taintwire.TaintGraph.open(join(dir, "c.lbug"));
        expect(await saved.query(q)).toEqual(await g.query(q));
        await saved.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
    const pos =
        "MATCH (a)-[e:CALLS|ARGUMENT_TO|RETURNS_TO]->(b) RETURN label(e) AS rel, a.file AS f, a.startOffset AS s, b.startOffset AS t ORDER BY rel, f, s, t";
    const babel = await taintwire.TaintGraph.open(":memory:", { parser: "babel" });
    const again = await taintwire.TaintGraph.open();
    for (const [name, src] of Object.entries(SRC))
        await Promise.all([babel.add(src, file(name)), again.add(src, file(name))]);
    expect(await babel.query(pos)).toEqual(await g.query(pos));
    expect(await again.query(pos)).toEqual(await g.query(pos)); // deterministic across imports
    await Promise.all([babel.close(), again.close()]);
});

test("call edges over the fixtures and every case: each edge is consistent with CALLS", async () => {
    const h = await taintwire.TaintGraph.open();
    for (const f of ["modern.js", "webpack-vue.js", "component.tsx"])
        await h.add(readFileSync(new URL(`../test/${f}`, import.meta.url), "utf-8"), f);
    for (const [name, src] of Object.entries(SRC)) await h.add(src, file(name)); // the fixtures alone resolve few calls
    const zero = async (q: string) => expect((await h.query(q))[0].n, q).toBe(0);
    // ARGUMENT_TO: the source is an argument of the callsite it names, and the target is a param of a function that callsite CALLS
    await zero(
        "MATCH (a)-[e:ARGUMENT_TO]->(p) WHERE NOT EXISTS { MATCH (c)-[s:SON {key: 'arguments'}]->(a) WHERE c.id = e.callsite AND s.idx = e.arg_index } RETURN count(*) AS n"
    );
    await zero(
        "MATCH (a)-[e:ARGUMENT_TO]->(p) WHERE NOT EXISTS { MATCH (c)-[:CALLS]->(fn)-[:DECLARES]->(p) WHERE c.id = e.callsite } RETURN count(*) AS n"
    );
    // RETURNS_TO: the target is a call that CALLS the function owning the return
    await zero(
        "MATCH (r)-[:RETURNS_TO]->(c) WHERE NOT EXISTS { MATCH (c)-[:CALLS]->(fn)-[:SON*1..30]->(r) } RETURN count(*) AS n"
    );
    // CALLS targets are functions; candidates matches the number of targets
    await zero(
        "MATCH ()-[:CALLS]->(fn) WHERE NOT fn.type IN ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'] RETURN count(*) AS n"
    );
    await zero("MATCH (c)-[e:CALLS]->() WITH c, e.candidates AS k, count(*) AS n WHERE k <> n RETURN count(*) AS n");
    const [n] = await h.query("MATCH ()-[e:CALLS]->() RETURN count(e) AS n");
    expect(n.n).toBeGreaterThan(0);
    await h.close();
});
