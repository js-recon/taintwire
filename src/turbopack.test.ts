import { afterAll, beforeAll, expect, test } from "vitest";
import * as taintwire from "./index.js";

// Chunks as Next.js 16.4 (Turbopack) emits them for js-recon-research turbopack/cross-chunk-shapes, trimmed to the modules
// that matter. `C` is the chunk prelude; source and sink modules are in different files.
const C = `(globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push(["object"==typeof document?document.currentScript:void 0,`;
const FILES: Record<string, string> = {
    // page chunk: ESM source module 94867, loader modules 6670 (chunk load) and 33201 (already loaded)
    "page.js": `${C}29918,t=>{"use strict";var o=t.i(94867);t.s(["default",0,function(){return t.A(6670).then(t=>t.render()),(0,o.getPayload)().length}])},6670,t=>{t.v(e=>Promise.all(["static/chunks/sink.js"].map(e=>t.l(e))).then(()=>e(3126)))},94867,t=>{"use strict";let e=window.name;t.s(["default",0,function(){return window.name},"getPayload",0,function(){return window.name},"payload",0,e])}]);`,
    // CommonJS modules (context, module, exports), a nested group, two ids sharing one factory, a getter with a setter
    "cjs.js": `${C}[5305,(e,n,t)=>{"use strict";let i=e.r(55944);Object.defineProperty(t,"viaDefine",{enumerable:!0,get:function(){return i.legacy}})}],55604,(e,n,t)=>{t.named=function(){return window.name}},57611,(e,n,t)=>{n.exports=function(){return window.name}},33201,e=>{e.v(e=>Promise.resolve().then(()=>e(57611)))},43181,(e,n,t)=>{let i=e.r(94867);n.exports={fromEsm:()=>i.getPayload()}},55944,(e,n,t)=>{n.exports={legacy:()=>window.name}},76398,e=>{e.v(n=>Promise.all(["static/chunks/lazy.js"].map(n=>e.l(n))).then(()=>n(32641)))},800,801,e=>{let v=window.name;e.s(["live",()=>v,e=>{v=e}])}]);`,
    "lazy.js": `${C}32641,o=>{"use strict";o.s(["lazyPayload",0,function(){return window.name}])}]);`,
    // the sink module; its exports go to its own id (`ctx.s(bindings, 3126)`)
    "sink.js": `${C}3126,e=>{"use strict";var n=e.i(94867),t=e.i(55944),i=e.i(57611),r=e.i(55604),a=e.i(5305),o=e.i(43181),w=e.i(900),x=e.i(801);async function l(n){let t=await e.A(76398);n.innerHTML+=t.lazyPayload()}e.s(["render",0,function(){let u=document.getElementById("output");u.innerHTML=(0,n.getPayload)(),u.innerHTML+=n.payload,u.innerHTML+=(0,n.default)(),u.innerHTML+=t.default.legacy(),u.innerHTML+=(0,i.default)(),u.innerHTML+=(0,r.named)(),u.innerHTML+=(0,a.viaDefine)(),u.innerHTML+=(0,o.fromEsm)(),u.innerHTML+=(0,w.getPayload)(),u.innerHTML+=x.live,u.innerHTML+=n.zz,e.A(76398).then(e=>{u.innerHTML+=e.lazyPayload()}),e.A(33201).then(e=>{u.innerHTML+=e.default()}),l(u)}],3126)}]);`,
    // an entry re-exporting another module's namespace (ctx.n), with a dev-style string id
    "entry.js": `${C}900,function(t){t.n(t.i("[project]/xss/source.js [app-client] (ecmascript)"))},"[project]/xss/source.js [app-client] (ecmascript)",t=>{t.s(["getPayload",0,function(){return window.name}])}]);`,
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

test("IMPORTS: ctx.i, ctx.r, ctx.A and a loader's import function, to the module factory", async () => {
    const rows = await pairs("MATCH (a)-[e:IMPORTS]->(b)", ", e.module_id AS id");
    const ids = rows.map(([a, , id]) => `${(a as string).split(":")[0]} ${id}`);
    for (const want of ["page.js 94867", "page.js 6670", "page.js 3126", "cjs.js 55944", "cjs.js 57611", "cjs.js 32641", "sink.js 76398", "sink.js 801", "entry.js [project]/xss/source.js [app-client] (ecmascript)"])
        expect(ids).toContain(want);
});

test("EXPORTS: ctx.s values and getters, ctx.v, CommonJS module.exports / exports.k / defineProperty", async () => {
    const rows = await pairs("MATCH (a)-[e:EXPORTS]->(b)", ", e.name AS name");
    const names = new Set(rows.map(([a, , name]) => `${(a as string).split(":")[0]} ${name}`));
    for (const want of ["page.js getPayload", "page.js payload", "page.js default", "cjs.js viaDefine", "cjs.js named", "cjs.js legacy", "cjs.js fromEsm", "cjs.js live", "lazy.js lazyPayload", "sink.js render"]) expect(names).toContain(want);
    // two ids, one factory: one set of exports
    expect(rows.filter(([, , name]) => name === "live")).toHaveLength(1);
});

test("taint from window.name reaches every sink across chunks; an unknown key stays clean", async () => {
    const rows = await pairs(
        "MATCH (a:MemberExpression)-[:SON {key: 'property'}]->(:Identifier {name: 'name'}), p = (a)-[:FLOWS_TO|ARGUMENT_TO|RETURNS_TO* ACYCLIC 1..30]->(b), (:AssignmentExpression)-[:SON {key: 'right'}]->(b)"
    );
    expect([...new Set(rows.map(([, b]) => b))].sort()).toEqual(
        [
            "(0,n.getPayload)()",
            "n.payload",
            "(0,n.default)()",
            "t.default.legacy()",
            "(0,i.default)()",
            "(0,r.named)()",
            "(0,a.viaDefine)()",
            "(0,o.fromEsm)()",
            "(0,w.getPayload)()",
            "x.live",
            "t.lazyPayload()",
            "e.lazyPayload()",
            "e.default()",
        ].map((s) => `sink.js:${s}`).sort()
    );
});

test("files added separately aren't linked", async () => {
    const h = await taintwire.TaintGraph.open();
    for (const f of ["lazy.js", "sink.js"]) await h.add(FILES[f], f);
    expect(await h.query("MATCH ()-[e:IMPORTS]->() RETURN count(e) AS n")).toEqual([{ n: 0 }]);
    await h.close();
});
