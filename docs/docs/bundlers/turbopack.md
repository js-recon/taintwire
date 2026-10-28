---
sidebar_position: 3
title: Turbopack
---

# Turbopack

taintwire links the chunks of a Turbopack build (the Next.js 16 default) through its module registry, the same way it links [webpack](webpack.md) chunks. A call or value read from one chunk into another gets the `CALLS`, `ARGUMENT_TO`, `RETURNS_TO` and `FLOWS_TO` edges it would get if both modules were in one file. That covers ES modules, CommonJS modules and `import()`. Verified on Next.js 16.4.2 production builds; the helper semantics below come from the Turbopack runtime in next.js `v16.4.3` (`turbopack-ecmascript-runtime/js/src/shared/runtime/runtime-utils.ts`).

## What you get

Take a Next.js client page that imports `getPayload` from `source.js` and lazy-loads `renderer.js`, which imports it too:

```js
// xss/source.js
export function getPayload() {
    return window.name;
}

// xss/renderer.js
import { getPayload } from "./source.js";
export function render() {
    document.getElementById("output").innerHTML = getPayload();
}
```

Turbopack puts `source.js` in the page's chunk and `renderer.js` in its own:

```js
// page chunk
(globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push([document.currentScript,
    92640, t => { t.v(e => Promise.all(["static/chunks/1ukv2e6qq3ml9.js"].map(e => t.l(e))).then(() => e(67834))) },
    33736, t => { "use strict"; t.s(["f", 0, function () { return window.name }]) }]);

// 1ukv2e6qq3ml9.js
(globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push([document.currentScript,
    67834, t => { "use strict"; var e = t.i(33736); t.s(["render", 0, function () { document.getElementById("output").innerHTML = (0, e.f)() }]) }]);
```

Load the whole `.next/static/chunks/` with [`addFiles()`](../api/reference.md#graphaddfiles), and the [webpack page's query](webpack.md#what-you-get) finds the path from `window.name` to `innerHTML`, through `(0, e.f)()`, which has no callee without the registry links.

## What's recognised

Every factory gets a context object as its first param, and the module's code goes through it. Below, `ctx` is that param (`t` or `e` once minified).

### Modules

| Runtime shape | Example (minified) | Becomes |
| --- | --- | --- |
| Chunk registration | `(globalThis.TURBOPACK \|\|= []).push([script, 33736, t => {...}, ...])` | Module table: id `33736` → that factory |
| Groups | `push([script, [96517, (e, t, n) => {...}, ...], 23911, ...])` | The inner list is read the same way |
| Several ids, one factory | `push([script, 800, 801, e => {...}])` | Both ids → that factory |
| Factory params | `e => {...}` (ES module), `(e, t, n) => {...}` (CommonJS) | `context`, `module`, `exports`, by position |
| Ids | `33736` (production), `"[project]/app/x.js [app-client] (ecmascript)"` (development) | Numeric or string |

### Exports

| Shape | Example | Becomes |
| --- | --- | --- |
| `ctx.s` | `t.s(["f", 0, value, "g", () => x, v => { x = v }])` | `EXPORTS {name: "f"}` to `value`, `{name: "g"}` to `x`; the setter is skipped |
| `ctx.s` for another module | `e.s([...], 3126)` | The exports of module `3126` |
| `ctx.v` | `e.v(value)` | `module.exports = value`: the namespace's own value and its `default` |
| `ctx.n` | `t.n(t.i(36048))` | This module's namespace is 36048's |
| CommonJS | `n.exports = ...`, `t.named = ...`, `Object.defineProperty(t, "k", {get})` | As for [webpack](webpack.md#exports) |

### Namespaces and imports

| Shape | Example | Resolves to |
| --- | --- | --- |
| `ctx.i(id)` | `var n = t.i(33736)` then `(0, n.f)()` | Module 33736's namespace (`IMPORTS {module_id: "33736"}`) |
| `ctx.r(id)` | `let i = e.r(55944)` then `i.legacy()` | 55944's `module.exports` |
| `.default` of a CommonJS module | `t.i(55944).default.legacy()` | `module.exports`, so `.legacy` is its key |
| `import()` | `t.A(92640).then(m => m.render())`, `const m = await e.A(76398)` | `ctx.A(id)` runs loader module `id`, `e => ....then(() => e(67834))`, so `m` is 67834's namespace |

## How it works

It's the webpack pass in [`flattenFiles()`](../api/reference.md#flattenfiles) with a second runtime dialect: a factory's context param takes the place of webpack's `require` and `exports` params. `ctx.i`/`ctx.r` are the require, `ctx.s` is `require.d`, and `ctx.v` is `module.exports =`. `ctx.A(id)`'s loader takes an import function as its param, and calls of that param are requires. Namespaces, re-exports, alias chains and resolution are shared with webpack, so everything under [How it works](webpack.md#how-it-works) there applies.

## Limitations

| Not handled | Effect | Notes |
| --- | --- | --- |
| Turbopack before Next.js 16 | `push([path, {id: factory}])` and the long helper names (`__turbopack_import__`, ...) aren't recognised | Not verified against those builds |
| `ctx.j` (dynamic `export *` of a CommonJS module) | Keys known only at runtime aren't exported | Needs property flow |
| `ctx.S` (grouped re-exports) | Not linked | Turbopack resolves most re-exports at build time, so imports name the defining module |
| Framework code between the import and the use | `next/dynamic`, `React.lazy` and the interop helpers in Next's own runtime (`i._(e.r(id))`) aren't modelled | As for webpack |
| Development builds | Ids are strings and recognised, but dev chunks also carry HMR and source-map code; not measured | |
| Separate `add()` calls | Chunks aren't linked | Load the whole build with one `addFiles()` |
