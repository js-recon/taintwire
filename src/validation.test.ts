// Findings and extra invariants from the post-implementation validation (VALIDATION_REPORT.md).
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, test } from "vitest";
import * as taintwire from "./index.js";

const SRC: Record<string, string> = {
    // TS nodes whose child keys differ between cs-mast's Babel 7 and our Babel 8
    tsKeys: "enum E { A = 1, B = 2 }\nconst y = f<string>(x);\nclass A implements B<number> {}\ntype F = (a: string) => void;",
    callsites: "function f(p) {\n    return p;\n}\nconst a = f(x);\nconst b = f(y);",
    nestedReturn: "function outer(x) {\n    const inner = () => {\n        return 'inner';\n    };\n    return x;\n}\nconst o = outer(s);\ninner();",
    sameNames: "function foo(a) {}\nfunction g() {\n    function foo(b) {}\n    foo(x);\n}\nfoo(y);",
};
const file = (name: string) => `${name}.${name === "tsKeys" ? "ts" : "js"}`;

let g: taintwire.TaintGraph;
beforeAll(async () => {
    g = await taintwire.TaintGraph.open();
    for (const [name, src] of Object.entries(SRC)) await g.add(src, file(name));
    for (const f of ["modern.js", "webpack-vue.js", "component.tsx"]) await g.add(readFileSync(new URL(`../test/${f}`, import.meta.url), "utf-8"), f);
});
afterAll(() => g.close());

// A child node that wasn't walked stays inline in its parent's props instead of becoming a { type, slug_ref } reference.
// Except a hashbang (and its comments): no Babel version visits Program.interpreter, so cs-mast doesn't hash it either; it stays as data.
const inlineNodes = (props: string) => {
    let n = 0;
    JSON.parse(props, (_, v) => {
        if (v && typeof v === "object" && typeof v.type === "string" && !("slug_ref" in v) && v.type !== "InterpreterDirective" && !v.type.startsWith("Comment")) n++;
        return v;
    });
    return n;
};

test("regression: cs-mast's Babel 7 child keys are walked (TS enum members, type arguments, implements)", async () => {
    const rows = await g.query("MATCH (n) WHERE n.file = 'tsKeys.ts' RETURN n.type AS t, n.props AS p");
    expect(rows.filter((r) => inlineNodes(r.p as string) > 0).map((r) => r.t)).toEqual([]);
    const types = new Set(rows.map((r) => r.t));
    for (const t of ["TSEnumMember", "TSTypeParameterInstantiation", "TSExpressionWithTypeArguments", "TSFunctionType"]) expect(types, t).toContain(t);
    // still type-level: nothing under them is a value reference
    expect((await g.query("MATCH (u)-[:REFERS_TO]->() WHERE u.file = 'tsKeys.ts' RETURN count(*) AS n"))[0].n).toBe(0);
});

test("no AST node is left inline in props, over every fixture", async () => {
    const rows = await g.query("MATCH (n) WHERE n.type IS NOT NULL RETURN n.type AS t, n.props AS p");
    expect(rows.filter((r) => inlineNodes(r.p as string) > 0).map((r) => r.t)).toEqual([]);
});

test("ARGUMENT_TO keeps each argument with its own callsite", async () => {
    const rows = await g.query(
        "MATCH (a:Identifier)-[e:ARGUMENT_TO]->(), (c:CallExpression)-[:SON {key: 'arguments'}]->(a) WHERE a.file = 'callsites.js' RETURN a.name AS arg, e.callsite = c.id AS own ORDER BY arg"
    );
    expect(rows).toEqual([
        { arg: "x", own: true },
        { arg: "y", own: true },
    ]);
});

test("a nested function's return never reaches the outer function's callsite", async () => {
    const rows = await g.query(
        "MATCH (r)-[:RETURNS_TO]->(c)-[:SON {key: 'callee'}]->(f:Identifier) WHERE r.file = 'nestedReturn.js' RETURN r.startOffset AS r, f.name AS callee"
    );
    expect(rows).toEqual([{ r: SRC.nestedReturn.indexOf("return x"), callee: "outer" }]); // `inner()` is out of scope here
});

test("same-named functions in different scopes are told apart by scope, not name", async () => {
    const rows = await g.query(
        "MATCH (c:CallExpression)-[:CALLS]->(f:FunctionDeclaration), (c)-[:SON {key: 'arguments'}]->(a:Identifier) WHERE c.file = 'sameNames.js' RETURN a.name AS arg, f.startOffset AS fn ORDER BY arg"
    );
    expect(rows).toEqual([
        { arg: "x", fn: SRC.sameNames.indexOf("function foo(b)") },
        { arg: "y", fn: SRC.sameNames.indexOf("function foo(a)") },
    ]);
});

test("invariants: READS from the access's parent, RETURNS_TO from the callee's own returns, DECLARES under the declarer", async () => {
    const zero = async (q: string) => expect((await g.query(q))[0].n, q).toBe(0);
    await zero("MATCH (op)-[r:READS]->() WHERE NOT EXISTS { MATCH (op)-[:SON]->(u:Identifier) WHERE u.id = r.access } RETURN count(*) AS n");
    await zero("MATCH ()-[r:READS]->(d) WHERE NOT EXISTS { MATCH (u:Identifier)-[:REFERS_TO]->(d) WHERE u.id = r.access } RETURN count(*) AS n");
    await zero("MATCH (p)-[e:SON]->() WITH p, e.key AS k, e.idx AS i, count(*) AS m WHERE m > 1 RETURN count(*) AS n");
    await zero("MATCH (d)-[:DECLARES]->(i) WHERE NOT EXISTS { MATCH (d)-[:SON*1..12]->(i) } RETURN count(*) AS n");
    // the nearest function above a ReturnStatement is a function its call CALLS
    const FN = "['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod', 'ClassMethod', 'ClassPrivateMethod']";
    await zero(
        `MATCH (r:ReturnStatement)-[:RETURNS_TO]->(c) WHERE NOT EXISTS { MATCH (c)-[:CALLS]->(fn)-[:SON*1..30]->(r) WHERE NOT EXISTS { MATCH (fn)-[:SON*1..30]->(m)-[:SON*1..30]->(r) WHERE label(m) IN ${FN} } } RETURN count(*) AS n`
    );
});
