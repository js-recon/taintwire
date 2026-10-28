import { afterAll, beforeAll, expect, test } from "vitest";
import * as taintwire from "./index.js";

// Chunks in the shapes webpack 5.112 emits (see docs/bundlers/webpack.md): source and sink in different files.
const FILES: Record<string, string> = {
    // minified production: method factory, getter-object and array exports
    "source.js": `"use strict";(self.webpackChunkapp=self.webpackChunkapp||[]).push([[130],{323(s,n,c){function u(){return window.name}const t=window.name;c.d(n,{n:()=>u}),c.d(n,["lM",0,t])}}]);`,
    "sink.js": `(self.webpackChunkapp=self.webpackChunkapp||[]).push([[549],{549(s,e,n){n.d(e,{render:()=>c});var u=n(323);function c(){const o=document.getElementById("o");o.innerHTML=(0,u.n)();o.innerHTML+=u.lM;o.innerHTML+=n(323)["n"]();o.innerHTML+=u.zz}}}]);`,
    // development: string ids, a function-valued factory, a block-bodied getter that re-exports another namespace
    "barrel.js": `(self.webpackChunkapp=self.webpackChunkapp||[]).push([["b"],{"./barrel.js": function (m, e, r) { r.d(e, { again: function () { return x.n; } }); var x = r(323); }}]);`,
    // entry chunk: the runtime's own require function and __webpack_modules__
    "main.js": `(() => { var mods = { 7: (m, e, r) => {} }; function req(id) { var m = { exports: {} }; mods[id](m, m.exports, req); return m.exports; } var b = req("./barrel.js"); document.body.innerHTML = b.again(); })();`,
};

let g: taintwire.TaintGraph;
beforeAll(async () => {
    g = await taintwire.TaintGraph.open();
    await g.addFiles(Object.entries(FILES).map(([filename, code]) => ({ filename, code })));
});
afterAll(() => g.close());

const code = (r: Record<string, unknown>, p: string) => `${r[`${p}f`]}:${FILES[r[`${p}f`] as string].slice(Number(r[`${p}s`]), Number(r[`${p}e`]))}`;
const ends = (p: string) => `${p}.file AS ${p}f, ${p}.startOffset AS ${p}s, ${p}.endOffset AS ${p}e`;
const pairs = async (q: string, extra = "") => (await g.query(`${q} RETURN ${ends("a")}, ${ends("b")}${extra}`)).map((r) => [code(r, "a"), code(r, "b"), ...Object.keys(r).filter((k) => !/^[ab][fse]$/.test(k)).map((k) => r[k])]);

test("IMPORTS: require calls, from factories and from the runtime, to the module factory", async () => {
    const rows = await pairs("MATCH (a)-[e:IMPORTS]->(b)", ", e.module_id AS id");
    expect(rows.map(([a, , id]) => `${a} -> ${id}`).sort()).toEqual(['barrel.js:r(323) -> 323', 'main.js:req("./barrel.js") -> ./barrel.js', "sink.js:n(323) -> 323", "sink.js:n(323) -> 323"]);
    expect(rows.every(([, b, id]) => (b as string).startsWith(id === "323" ? "source.js:323(" : "barrel.js:function"))).toBe(true);
});

test("EXPORTS: getter objects, arrays, block getters", async () => {
    const rows = await pairs("MATCH (a)-[e:EXPORTS]->(b)", ", e.name AS name");
    expect(rows.map(([, b, name]) => `${name} = ${b}`).sort()).toEqual(["again = barrel.js:x.n", "lM = source.js:t", "n = source.js:u", "render = sink.js:c"]);
});

test("CALLS across files resolve through the namespace, inline require and re-exports", async () => {
    const rows = await pairs("MATCH (a:CallExpression)-[:CALLS]->(b) WHERE a.file <> b.file");
    const fn = "source.js:function u(){return window.name}";
    expect(rows.map(([a, b]) => `${a} -> ${b}`).sort()).toEqual([`main.js:b.again() -> ${fn}`, `sink.js:(0,u.n)() -> ${fn}`, `sink.js:n(323)["n"]() -> ${fn}`]);
});

test("taint from window.name reaches every sink across chunks; an unknown key stays unresolved", async () => {
    const rows = await pairs(
        "MATCH (a:MemberExpression)-[:SON {key: 'property'}]->(:Identifier {name: 'name'}), p = (a)-[:FLOWS_TO|ARGUMENT_TO|RETURNS_TO* ACYCLIC 1..30]->(b), (:AssignmentExpression)-[:SON {key: 'right'}]->(b)"
    );
    expect([...new Set(rows.map(([, b]) => b))].sort()).toEqual(["main.js:b.again()", "sink.js:(0,u.n)()", 'sink.js:n(323)["n"]()', "sink.js:u.lM"]);
});

test("files added separately aren't linked", async () => {
    const h = await taintwire.TaintGraph.open();
    for (const f of ["source.js", "sink.js"]) await h.add(FILES[f], f);
    expect(await h.query("MATCH ()-[e:IMPORTS|CALLS]->() RETURN count(e) AS n")).toEqual([{ n: 0 }]);
    await h.close();
});
