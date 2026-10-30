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

// Older Turbopack production builds (Next.js 15.3-15.5), chunks verbatim from js-recon-research
// turbopack/cross-chunk-shapes-next15 (chunks-15.3.9, chunks-15.5.28). `safe` keys must stay clean.
const OLD: Record<string, { files: Record<string, string>; sinks: string[] }> = {
    // 15.3/15.4: push([script, {id: factory}]), one context param destructured as `var {m: t, e: i} = ctx`,
    // ctx.s({name: getter}), import() as ctx.r(loader)(ctx.i); plus a hand-written [getter, setter] export
    "next-15.3": {
        files: {
            "page.js": `(globalThis.TURBOPACK=globalThis.TURBOPACK||[]).push(["object"==typeof document?document.currentScript:void 0,{74323:e=>{"use strict";var{g:t,__dirname:n}=e;{function a(){return window.name}e.s({default:()=>o,getPayload:()=>a,payload:()=>t});let t=window.name;function o(){return window.name}}},55198:e=>{"use strict";var{g:t,__dirname:n}=e;e.s({default:()=>r});var a=e.i(31636),o=e.i(38653),i=e.i(74323);function r(){return(0,o.useEffect)(()=>{console.log("payload length",(0,i.getPayload)().length),e.r(60718)(e.i).then(e=>e.render())},[]),(0,a.jsx)("div",{id:"output"})}},60718:e=>{var{g:t,__dirname:n}=e;e.v(t=>Promise.all(["static/chunks/e06dfd80e3460c85.js"].map(t=>e.l(t))).then(()=>t(50742)))}}]);`,
            "sink.js": `(globalThis.TURBOPACK=globalThis.TURBOPACK||[]).push(["object"==typeof document?document.currentScript:void 0,{38443:function(e){var{g:n,__dirname:r,m:t,e:i}=e;t.exports=function(){return window.name}},66743:e=>{"use strict";var{g:n,__dirname:r}=e;e.s({}),e.i(74323)},39997:e=>{"use strict";var{g:n,__dirname:r}=e;e.s({}),e.i(74323),e.i(66743)},69121:e=>{"use strict";var{g:n,__dirname:r}=e;e.s({reexported:()=>t.getPayload});var t=e.i(74323)},32424:function(e){var{g:n,__dirname:r,m:t,e:i}=e;t.exports={legacy:()=>window.name}},85140:function(e){var{g:n,__dirname:r,m:t,e:i}=e;i.named=function(){return window.name}},7705:function(e){var{g:n,__dirname:r,m:t,e:i}=e;{"use strict";let n=e.r(32424);Object.defineProperty(i,"viaDefine",{enumerable:!0,get:function(){return n.legacy}})}},49293:function(e){var{g:n,__dirname:r,m:t,e:i}=e;{let n=e.r(74323);t.exports={fromEsm:()=>n.getPayload()}}},50742:e=>{"use strict";var{g:n,__dirname:r}=e;e.s({render:()=>s});var t=e.i(74323);e.i(39997);var i=e.i(69121),a=e.i(32424),o=e.i(38443),u=e.i(85140),c=e.i(7705),l=e.i(49293);function s(){let n=document.getElementById("output");n.innerHTML=(0,t.getPayload)(),n.innerHTML+=t.payload,n.innerHTML+=(0,t.default)(),n.innerHTML+=(0,i.reexported)(),n.innerHTML+=a.default.legacy(),n.innerHTML+=(0,o.default)(),n.innerHTML+=(0,u.named)(),n.innerHTML+=(0,c.viaDefine)(),n.innerHTML+=(0,l.fromEsm)(),e.r(77326)(e.i).then(e=>{n.innerHTML+=e.lazyPayload()}),e.r(80721)(e.i).then(e=>{n.innerHTML+=e.default()}),d(n)}async function d(n){let r=await e.r(77326)(e.i);n.innerHTML+=r.lazyPayload()}},77326:e=>{var{g:n,__dirname:r}=e;e.v(n=>Promise.all(["static/chunks/893261be227c375b.js"].map(n=>e.l(n))).then(()=>n(68417)))},80721:e=>{var{g:n,__dirname:r}=e;e.v(e=>Promise.resolve().then(()=>e(38443)))}}]);`,
            "lazy.js": `(globalThis.TURBOPACK=globalThis.TURBOPACK||[]).push(["object"==typeof document?document.currentScript:void 0,{68417:o=>{"use strict";var{g:t,__dirname:e}=o;function n(){return window.name}o.s({lazyPayload:()=>n})}}]);`,
            "live.js": `(globalThis.TURBOPACK=globalThis.TURBOPACK||[]).push(["object"==typeof document?document.currentScript:void 0,{800:e=>{"use strict";var{g:t}=e;let v=window.name;e.s({live:[()=>v,e=>{v=e}]})},801:e=>{var n=e.i(800);document.body.innerHTML=n.live;document.body.innerHTML=n.zz}}]);`,
        },
        sinks: ["(0,t.getPayload)()", "t.payload", "(0,t.default)()", "(0,i.reexported)()", "a.default.legacy()", "(0,o.default)()", "(0,u.named)()", "(0,c.viaDefine)()", "(0,l.fromEsm)()", "e.lazyPayload()", "e.default()", "r.lazyPayload()", "n.live"],
    },
    // 15.5: the flat list and (context, module, exports) of 16.x, but ctx.s([name, getter, ...]) without value tags
    "next-15.5": {
        files: {
            "page.js": `(globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push(["object"==typeof document?document.currentScript:void 0,94867,e=>{"use strict";function t(){return window.name}e.s(["default",()=>o,"getPayload",()=>t,"payload",()=>n]);let n=window.name;function o(){return window.name}},29918,e=>{"use strict";e.s(["default",()=>a]);var t=e.i(43476),n=e.i(71645),o=e.i(94867);function a(){return(0,n.useEffect)(()=>{console.log("payload length",(0,o.getPayload)().length),e.A(6670).then(e=>e.render())},[]),(0,t.jsx)("div",{id:"output"})}},6670,e=>{e.v(t=>Promise.all(["static/chunks/3e909bd0462966e1.js"].map(t=>e.l(t))).then(()=>t(3126)))}]);`,
            "sink.js": `(globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push(["object"==typeof document?document.currentScript:void 0,57611,(e,n,t)=>{n.exports=function(){return window.name}},55944,(e,n,t)=>{n.exports={legacy:()=>window.name}},55604,(e,n,t)=>{t.named=function(){return window.name}},5305,(e,n,t)=>{"use strict";let i=e.r(55944);Object.defineProperty(t,"viaDefine",{enumerable:!0,get:function(){return i.legacy}})},43181,(e,n,t)=>{let i=e.r(94867);n.exports={fromEsm:()=>i.getPayload()}},3126,e=>{"use strict";e.s(["render",()=>l],3126);var n=e.i(94867),t=e.i(55944),i=e.i(57611),a=e.i(55604),r=e.i(5305),o=e.i(43181);function l(){let l=document.getElementById("output");l.innerHTML=(0,n.getPayload)(),l.innerHTML+=n.payload,l.innerHTML+=(0,n.default)(),l.innerHTML+=(0,n.getPayload)(),l.innerHTML+=t.default.legacy(),l.innerHTML+=(0,i.default)(),l.innerHTML+=(0,a.named)(),l.innerHTML+=(0,r.viaDefine)(),l.innerHTML+=(0,o.fromEsm)(),e.A(76398).then(e=>{l.innerHTML+=e.lazyPayload()}),e.A(33201).then(e=>{l.innerHTML+=e.default()}),u(l)}async function u(n){let t=await e.A(76398);n.innerHTML+=t.lazyPayload()}},76398,e=>{e.v(n=>Promise.all(["static/chunks/967107713baf698f.js"].map(n=>e.l(n))).then(()=>n(32641)))},33201,e=>{e.v(e=>Promise.resolve().then(()=>e(57611)))}]);`,
            "lazy.js": `(globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push(["object"==typeof document?document.currentScript:void 0,32641,o=>{"use strict";function t(){return window.name}o.s(["lazyPayload",()=>t])}]);`,
        },
        sinks: ["(0,n.getPayload)()", "n.payload", "(0,n.default)()", "t.default.legacy()", "(0,i.default)()", "(0,a.named)()", "(0,r.viaDefine)()", "(0,o.fromEsm)()", "e.lazyPayload()", "e.default()", "t.lazyPayload()"],
    },
};

for (const [name, { files, sinks }] of Object.entries(OLD))
    test(`${name}: taint from window.name reaches every sink across chunks; an unknown key stays clean`, async () => {
        const h = await taintwire.TaintGraph.open();
        await h.addFiles(Object.entries(files).map(([filename, code]) => ({ filename, code })));
        const rows = await h.query(
            "MATCH (a:MemberExpression)-[:SON {key: 'property'}]->(:Identifier {name: 'name'}), p = (a)-[:FLOWS_TO|ARGUMENT_TO|RETURNS_TO* ACYCLIC 1..30]->(b), (:AssignmentExpression)-[:SON {key: 'right'}]->(b) RETURN DISTINCT b.file AS f, b.startOffset AS s, b.endOffset AS e"
        );
        await h.close();
        expect([...new Set(rows.map((r) => files[r.f as string].slice(Number(r.s), Number(r.e))))].sort()).toEqual([...sinks].sort());
    });
