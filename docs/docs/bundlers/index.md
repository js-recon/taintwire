---
sidebar_position: 1
title: Overview
---

# Bundler support

A bundler takes an app's source files and emits a few output files (chunks), and it decides which module goes in which chunk. Inside one chunk it can often merge modules into a single scope (scope hoisting). An import then becomes a plain reference, and taintwire follows it like any other name.

Across chunks it can't merge them. The importing chunk reaches the exporting one through the bundler's **runtime module registry**: a lookup by module id, followed by a property read on the module's exports object. Static analysis that only sees names and lexical scopes loses the path at that point. A DOM XSS whose source is in one chunk and whose sink is in another has no path at all, and the bundler alone decides whether that happens. Lazy-loaded routes and components (`import()`, `React.lazy`, `next/dynamic`), and modules shared between them, are the usual trigger.

taintwire rebuilds those links for the bundlers below, so taint queries written for a single file work unchanged on a build directory.

## Using it

Load **every** `.js` file of the build in **one** [`graph.addFiles()`](../api/reference.md#graphaddfiles) call:

```ts
const graph = await TaintGraph.open();
await graph.addFiles(files); // [{ filename, code }, ...] for every chunk
```

Files are linked only within a single `addFiles()` call. Chunks added one at a time with `add()` stay separate graphs of names, exactly as before. There's no flag to set: taintwire recognises a bundler's runtime from the code's structure, and code with no registry is loaded exactly as with `add()`.

## Support

| Bundler | Status | What's linked |
| --- | --- | --- |
| [webpack 5](webpack.md) | Supported | ES and CommonJS modules, `require.n`/`require.t`/`require.cw` interop, `import()`, `eval` dev builds. Calls, arguments, returns and value reads cross chunks |
| [webpack 4](webpack.md) | Supported | The same, plus module arrays, `require.d(exports, "name", getter)` and `Object(ns.k)()` |
| [Turbopack](turbopack.md) (Next.js 16) | Supported | ES and CommonJS modules, `ctx.s`/`ctx.v`/`ctx.n` exports, `import()` through loader modules. Calls, arguments, returns and value reads cross chunks |
| Rspack | Not yet | Emits a webpack-compatible runtime, so it may already work, but it hasn't been tested |
| Vite / Rollup / esbuild | Not yet | Chunks link with real ES `import`/`export`, which taintwire doesn't resolve across files yet |
