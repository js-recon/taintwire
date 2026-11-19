import { afterAll, beforeAll, expect, test } from "vitest";
import * as taintwire from "../src/index.js";
import { linkedVsUnits, sinks } from "./test-utils.js";

// Chunks in the shapes Vite/Rollup and esbuild emit (see docs/bundlers/esm.md): source and sink in different files.
const FILES: Record<string, string> = {
    // Rollup: local bindings exported under short names
    "assets/source.js": `function u(){return window.name}const t=window.name;export{u as n,t as lM};export const c=()=>window.name;export default function d(){return window.name}`,
    "assets/sink.js": `import{n as a,lM as b,c as k}from"./source.js";import dd from"./source.js";import{zz as z}from"./source.js";import{x as y}from"react";const o=document.getElementById("o");o.innerHTML=a();o.innerHTML+=b;o.innerHTML+=k();o.innerHTML+=dd();o.innerHTML+=z;o.innerHTML+=y;`,
    // namespace import, from an absolute path as Vite writes for the base URL
    "assets/ns.js": `import*as s from"/assets/source.js";document.body.innerHTML=s.n();`,
    // barrel re-exports
    "assets/barrel.js": `export{n as again}from"./source.js";export*from"./source.js";`,
    "assets/via-barrel.js": `import{again as g,lM as l}from"./barrel.js";document.title.innerHTML=g();document.head.innerHTML=l;`,
    // dynamic import: .then, await and Vite's preload wrapper
    "assets/dyn.js": `const P=(f,d)=>f();import("./source.js").then(m=>{m1.innerHTML=m.n()});(async()=>{const m=await import("./source.js");m2.innerHTML=m.lM})();P(()=>import("./source.js"),[]).then(m=>{m3.innerHTML=m.c()});`,
    // a wrapper defined in another chunk: the value reaches its param (Nuxt composable shape)
    "assets/wrap.js": `function a(e,t){w.innerHTML=e}export{a as u};`,
    "assets/page.js": `import{u as oe}from"./wrap.js";oe(window.name,{});`,
};

let g: taintwire.PookieGraph;
beforeAll(async () => {
    g = await taintwire.PookieGraph.open();
    await g.addFiles(Object.entries(FILES).map(([filename, code]) => ({ filename, code })));
});
afterAll(() => g.close());

test("named, default, namespace, re-exported and dynamic imports reach across chunks", async () => {
    expect((await sinks(g)).hit).toEqual(
        [
            "a()", "b", "k()", "dd()", // named, export const, default
            "s.n()", // namespace, absolute specifier
            "g()", "l", // export {..} from, export * from
            "m.n()", "m.lM", "m.c()", // import().then, await import(), preload wrapper
            "e", // argument into another chunk's function
        ].sort()
    );
});

test("unknown names and bare package imports stay unlinked", async () => {
    expect((await sinks(g)).clean).toEqual(["y", "z"]);
});

test("each file alone links nothing", async () => {
    let hits = 0;
    for (const [filename, code] of Object.entries(FILES)) {
        const h = await taintwire.PookieGraph.open();
        await h.addFiles([{ filename, code }]);
        // every sink needs another file; a file with no assignment has no table to query
        if (code.includes("innerHTML")) hits += (await sinks(h)).hit.length;
        await h.close();
    }
    expect(hits).toBe(0);
});

test("IMPORTS and EXPORTS edges name the module and the exported key", async () => {
    const imports = await g.query("MATCH (i:ImportDeclaration)-[e:IMPORTS]->(f:File) RETURN DISTINCT e.module_id AS m");
    expect(imports.map((r) => r.m).sort()).toEqual(["assets/barrel.js", "assets/source.js", "assets/wrap.js"]);
    const keys = await g.query("MATCH (f:File)-[e:EXPORTS]->() WHERE f.file = 'assets/source.js' RETURN DISTINCT e.name AS k");
    expect(keys.map((r) => r.k).sort()).toEqual(["c", "default", "lM", "n"]);
});

test("moduleLinks/planUnits: a file defines itself and needs what it imports", async () => {
    const links = new Map(Object.entries(FILES).map(([f, c]) => [f, taintwire.moduleLinks(c, f)]));
    expect(links.get("assets/sink.js")).toEqual({ defines: ["assets/sink.js"], needs: ["assets/source.js"] });
    expect(links.get("assets/ns.js")!.needs).toEqual(["assets/source.js"]);
    const { linked, units } = await linkedVsUnits(FILES);
    expect(units).toEqual(linked);
});

test("Rolldown: import(`./m.js`).then(e => e.a) reads an exported getter-object namespace", async () => {
    const h = await taintwire.PookieGraph.open();
    try {
        await h.addFiles([
            {
                filename: "assets/m.js",
                code: "var e=Object.defineProperty,t=((t,n)=>{let r={};for(var i in t)e(r,i,{get:t[i],enumerable:!0});return r})({getName:()=>n,clean:()=>a});function n(){return window.name}var a=()=>`static`;export{t as a,n as r};",
            },
            {
                filename: "assets/index.js",
                code: "const r=(f,d)=>f();(async()=>{let e=await r(()=>import(`./m.js`).then(e=>e.a),[]);m1.innerHTML=e.getName();m2.innerHTML=e.clean()})();",
            },
        ]);
        const { hit, clean } = await sinks(h);
        expect(hit).toEqual(["e.getName()"]);
        expect(clean).toEqual(["e.clean()"]);
    } finally {
        await h.close();
    }
});
