---
sidebar_position: 6
title: Browser (WASM)
---

# Browser (WASM)

taintwire also runs in the browser, on LadybugDB's WebAssembly build. The API is the same as in Node; only the database engine underneath changes. [taintwire explorer](https://github.com/js-recon/taintwire-explorer) is a working example.

## Install

```bash
npm install @js-recon/taintwire @ladybugdb/wasm-core@0.21.2
```

`@ladybugdb/wasm-core` is an optional peer dependency, so Node users don't download it. Keep its version equal to the `@ladybugdb/core` version taintwire depends on.

## Use

```js
import "./process-shim.js"; // first, see below
import * as taintwire from "@js-recon/taintwire/browser";
import workerUrl from "../node_modules/@ladybugdb/wasm-core/lbug_wasm_worker.js?url"; // Vite

taintwire.setWorkerPath(workerUrl);

const graph = await taintwire.import(code);
const rows = await graph.query("MATCH (c:CallExpression)-[:CALLS]->(f) RETURN c.id, f.id");
await graph.close();
```

Bundlers that honor the `browser` export condition also pick this entry for a plain `@js-recon/taintwire` import. Importing `/browser` explicitly also gets you its TypeScript types, which add `setWorkerPath`.

### The worker script

Ladybug's async WASM build runs the database in a Web Worker loaded from `lbug_wasm_worker.js` (about 24 MB). Call `setWorkerPath(url)` before the first `import()` or `TaintGraph.open()`, with a URL where your build serves that file. `@ladybugdb/wasm-core` doesn't list the file in its `exports`, so import it by path (as above) or copy it into your static assets.

### The `process` shim

`@babel/traverse`, which cs-mast pulls in, reads `process.env` when it loads. Define a minimal `process` before taintwire is imported:

```js
// process-shim.js
globalThis.process ??= { env: { NODE_ENV: "production" }, versions: {}, browser: true };
```

Leave `process.versions.node` unset. cs-mast then hashes with `@noble/hashes` instead of reaching for `node:crypto`.

## Differences from Node

- Databases live in Emscripten's in-memory filesystem. `":memory:"` (the default) is the usual choice; `save(path)` writes inside that filesystem, not to the user's disk.
- `graph.db` / `graph.connection` are `@ladybugdb/wasm-core` objects.
- Query values are the same as in Node: the backend unboxes the `Number` objects the WASM build returns for integers.

## Custom backends

The Node and browser entries differ only in a small `Backend` (open a database, read a result's rows, check whether a path exists). Pass one to `TaintGraph.open(path, { backend })` to run on another Ladybug build. Both entries export `wasmBackend(lbug)`, which wraps any `@ladybugdb/wasm-core` variant; the test suite runs it on the `nodejs` variant from Node.
