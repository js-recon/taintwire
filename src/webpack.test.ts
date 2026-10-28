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

// Round 2: CommonJS, interop, import(), webpack 4 and eval builds. One graph per bundle; `safe` sinks must stay clean.
const BUNDLES: Record<string, Record<string, string>> = {
    // webpack 5.112, minified: CommonJS factories, require.n / require.cw / lazy requires, import() and await
    wp5: {
        "cjs.js": `(self.webpackChunkapp=self.webpackChunkapp||[]).push([[7],{127(e,n){n.K=function(){return window.name}},574(e){e.exports=function(){return window.name}},269(e){e.exports={legacy:()=>window.name,safe:()=>"<b>ok</b>"}},368(e,n,t){const r=t(480);Object.defineProperty(n,"viaDefine",{enumerable:!0,get:function(){return r.lazyPayload}})},480(e,s,a){function n(){return window.name}a.d(s,{lazyPayload:()=>n})}}]);`,
        "app.js": `(self.webpackChunkapp=self.webpackChunkapp||[]).push([[8],{136(e,n,t){var r=t.cw((e,n)=>{n.inl=function(){return window.name}}),a=()=>t(269),o=t(574),s=t.n(o),c=t(127),l=t(368);function u(){const e=document.body;e.innerHTML=s()();e.innerHTML=(0,c.K)();e.innerHTML=a().legacy();e.innerHTML=(0,r().inl)();e.innerHTML=(0,l.viaDefine)();e.innerHTML=t(574)();t.e(480).then(()=>t(480)).then(n=>{e.innerHTML=n.lazyPayload()});Promise.resolve().then(()=>t.t(574,23)).then(n=>{e.innerHTML=n.default()});(async function(){const n=await t.e(480).then(()=>t(480));e.innerHTML=n.lazyPayload()})();e.innerHTML=a().safe();e.innerHTML=encodeURIComponent(window.name)}u()}}]);`,
    },
    // webpack 4.47, minified: module arrays, 3-argument require.d, Object(ns.k)(), require.n(ns).a, the IIFE registry
    wp4: {
        "main.js": `!function(e){var t={};function o(r){if(t[r])return t[r].exports;var n=t[r]={i:r,l:!1,exports:{}};return e[r].call(n.exports,n,n.exports,o),n.l=!0,n.exports}o(0)}([function(e,r,t){Promise.all([t.e(2)]).then(t.bind(null,1)).then(e=>e.render())}]);`,
        "2.js": `(window.webpackJsonp=window.webpackJsonp||[]).push([[2],[,function(n,e,t){"use strict";t.r(e),t.d(e,"render",(function(){return f}));var i=t(2),o=t(3),r=t.n(o);function f(){document.body.innerHTML=Object(i.a)();document.body.innerHTML=r.a.legacy();document.body.innerHTML=Object(i.b)()}},function(n,o,t){"use strict";function u(){return window.name}function s(){return "safe"}t.d(o,"a",(function(){return u})),t.d(o,"b",(function(){return s}))},function(n,e){n.exports={legacy:()=>window.name}}]]);`,
    },
    // webpack 5 development with devtool: "eval": every module body is a string
    eval: {
        "e.js": `(self.webpackChunkapp=self.webpackChunkapp||[]).push([["e"],{"./src/e.js":(__unused_webpack_module, __webpack_exports__, __webpack_require__) => { eval("{__webpack_require__.d(__webpack_exports__, { ev: () => (ev) });\\nfunction ev() { return window.name; }\\n}\\n//# sourceURL=webpack://app/./src/e.js?"); }}]);`,
        "u.js": `(self.webpackChunkapp=self.webpackChunkapp||[]).push([["u"],{"./src/u.js":(m, e, __webpack_require__) => { eval("var x = __webpack_require__(\\"./src/e.js\\");\\ndocument.body.innerHTML = (0,x.ev)();\\ndocument.body.innerHTML = 'safe' + x.missing;"); }}]);`,
    },
};
const open = async (bundle: string) => {
    const h = await taintwire.TaintGraph.open();
    await h.addFiles(Object.entries(BUNDLES[bundle]).map(([filename, code]) => ({ filename, code })));
    return h;
};
// The innerHTML right-hand sides window.name reaches, and those it doesn't, as code.
const sinks = async (h: taintwire.TaintGraph) => {
    const rhs = async (q: string) => new Set(await Promise.all((await h.query(q)).map((r) => h.code(r.id as string))));
    const sink = "(a:AssignmentExpression)-[:SON {key: 'left'}]->(:MemberExpression)-[:SON {key: 'property'}]->(:Identifier {name: 'innerHTML'}), (a)-[:SON {key: 'right'}]->(v)";
    const all = await rhs(`MATCH ${sink} RETURN v.id AS id`);
    const hit = await rhs(
        `MATCH (s:MemberExpression)-[:SON {key: 'property'}]->(:Identifier {name: 'name'}), (s)-[:FLOWS_TO|ARGUMENT_TO|RETURNS_TO* ACYCLIC 1..30]->(v), ${sink} RETURN DISTINCT v.id AS id`
    );
    return { hit: [...hit].sort(), clean: [...all].filter((c) => !hit.has(c)).sort() };
};

test("webpack 5: CommonJS exports, require.n, require.cw, lazy requires, import() callbacks and await", async () => {
    const h = await open("wp5");
    expect(await sinks(h)).toEqual({
        hit: ["(0,c.K)()", "(0,l.viaDefine)()", "(0,r().inl)()", "a().legacy()", "n.default()", "n.lazyPayload()", "s()()", "t(574)()"],
        clean: ["a().safe()", "encodeURIComponent(window.name)"],
    });
    const exp = await h.query("MATCH (f)-[e:EXPORTS]->(v) RETURN e.name AS name ORDER BY name");
    expect(exp.map((r) => r.name)).toEqual(["K", "default", "default", "inl", "lazyPayload", "legacy", "safe", "viaDefine"]);
    await h.close();
});

test("webpack 4: module arrays, require.d(e, k, getter), Object(ns.k)(), require.n(ns).a and the bootstrap's registry", async () => {
    const h = await open("wp4");
    expect(await sinks(h)).toEqual({ hit: ["Object(i.a)()", "r.a.legacy()"], clean: ["Object(i.b)()"] });
    // main.js's import() callback param is module 1's namespace, so e.render() reaches render in the chunk
    const calls = await h.query("MATCH (c:CallExpression)-[:CALLS]->(f) WHERE c.file = 'main.js' AND f.file = '2.js' RETURN c.id AS id");
    expect(await Promise.all(calls.map((r) => h.code(r.id as string)))).toEqual(["e.render()"]);
    await h.close();
});

test("eval builds: string-literal eval bodies are walked in the eval's scope, as virtual files", async () => {
    const h = await open("eval");
    expect(await sinks(h)).toEqual({ hit: ["(0,x.ev)()"], clean: ["'safe' + x.missing"] });
    const files = await h.query("MATCH (s:Source) RETURN s.file AS f ORDER BY f");
    const at = (f: string) => `${f}#eval@${BUNDLES.eval[f].indexOf("eval(")}`;
    expect(files.map((r) => r.f)).toEqual(["e.js", at("e.js"), "u.js", at("u.js")]);
    const [ev] = await h.query("MATCH (fn:FunctionDeclaration) RETURN fn.id AS id");
    expect(await h.code(ev.id as string)).toBe("function ev() { return window.name; }");
    expect(await h.query("MATCH (:CallExpression)-[e:SON {key: 'evaluated'}]->(f:File) RETURN count(f) AS n")).toEqual([{ n: 2 }]);
    await h.close();
});
