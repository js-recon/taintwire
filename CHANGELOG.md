# Changelog

## 0.2.0-alpha.3 - 2026-11-09

### Added

- `PookieGraph.open()` takes `bufferPoolMB` and `threads` (see the new [Memory](https://taintwire.js-recon.io/next/api/memory) page). In the Node build the buffer pool defaults to half of the memory the process may use, which is the container's limit if there is one. Ladybug's own default is sized from the host's RAM even inside a container, so it could grow past the container's limit until the container killed the process. Query threads default to 2 (`DEFAULT_THREADS`), where Ladybug ran one per core of the host.
- `moduleLinks(code, filename)` scans one file for the bundler module ids it registers and loads. `planUnits(links)` splits files into units: each file plus the files that define what it loads, transitively. Each unit can be loaded as its own graph.

### Fixed

- The Node backend now closes each query result once it is read. Open results kept native memory until they were garbage collected, which outlived the graph's `close()`. Opening graphs one after another grew memory by about 700 MB over 8 graphs.
- `load()` drops each table's rows once they are copied, so the JS heap shrinks during a load instead of holding every row to the end.

## 0.2.0-alpha.2 - 2026-11-06

### Added

- Docs: a new [PookieGraph aliases (pga)](https://taintwire.js-recon.io/next/api/pga) page. It covers the `pga` aliases (`lib/pga.pgq`) and the shared sink sets (`lib/sinks.pgq`) of the taintwire-queries pack: every alias and the Cypher it expands to, the 13 sink sets and what each one matches, and how to use them from another query pack given that the sandbox only allows imports from inside the same pack.

### Changed

- Docs: the pgq page's rule example now spreads a shared sink set into `cypher`. The Getting started and pgq pages define taintwire, PookieGraph and PookieGraph Query, show how to install the alpha from npm, and explain how selectors and rules divide the work.

No code changes since 0.2.0-alpha.1.

## 0.2.0-alpha.1 - 2026-11-06

### Added

- **PookieGraph queries (pgq).** A `.pgq` file is a TypeScript module of Cypher selectors (`PGSelector`) and rules (`PGRule`, with a severity of `info`, `low`, `medium`, `high` or `critical`). Selectors chain through `uses` (`$name` parameters) and follow taint flow with `from` (strict, lenient or deep, plus `maxHops`).
    - `loadPgq(files)` evaluates `.pgq` files in a sandboxed Node process. The process runs under the permission model and can read only its query pack. It can import only other `.pgq` files, and `fetch`, `getBuiltinModule` and `kill` are removed. Needs Node 22.15 or newer.
    - `validatePgq()` checks rules, and `checkPgqCypher()` compiles their queries against a graph.
    - `runPgq(graph, rules)` runs rules and returns findings with their source and hop count. Its flow runner comes from js-recon's analyze engine.
- `PookieGraph.open(path, { readOnly: true })` opens a saved graph without writing to it.
- `graph.addFiles()` and `flattenFiles()` load several files as one unit, linked through the bundler's module registry, with the new `IMPORTS` and `EXPORTS` edges. Supported registries:
    - webpack 5 (`push` and `__webpack_modules__` factories, `R.d` exports, `R(id)` namespaces)
    - webpack 4 (module arrays, the IIFE registry)
    - CommonJS (`module.exports`, `exports.k`) with `require.n/.t` interop
    - `import()`
    - `eval("<literal>")` builds, parsed as virtual files
    - Turbopack from Next.js 15.3 to 16.x
- Builtin pass-through `FLOWS_TO` edges for decoders and string methods (`decodeURIComponent`, `slice`, `trim`, `concat`, ...). Encoders get none.
- Versioned docs: `/` serves the latest stable release, and `/next` serves the docs for alpha and beta releases.

### Changed

- The graph is now called a **PookieGraph**, and `.pg` is its file extension. `TaintGraph` was renamed to `PookieGraph`; `TaintGraph` remains as a deprecated alias.

## 0.1.1 - 2026-10-07

### Added

- Browser support: `@js-recon/taintwire/browser` (also picked by bundlers through the `browser` export condition) runs the same API on LadybugDB's WASM build. Install `@ladybugdb/wasm-core@0.21.2` alongside it; it is an optional peer dependency. `setWorkerPath()` points Ladybug at its worker script.
- `TaintGraph.open(path, { backend })`, the `Backend` type and `wasmBackend()` for running on another Ladybug build.

### Changed

- The engine no longer imports `node:crypto`, `node:fs` or `node:module`. cs-mast's Babel 7 node types come from a pinned `@babel/types-7` alias instead of a `createRequire` lookup.

## 0.1.0 - 2026-10-07

First public release on npm as `@js-recon/taintwire`.

### Added

- `taintwire.import()` parses JavaScript (through CS-MAST by default, or plain Babel) into an embedded LadybugDB graph you can query with openCypher. `graph.add()` loads more files into the same graph.
- Every AST node becomes a graph node with its CS-MAST-S structural hash. Parent-to-child links are stored as `SON` edges.
- `TaintGraph.save()` writes the graph to a LadybugDB file, and `TaintGraph.code()` maps a node id back to its source.
- Semantic layer:
    - scopes (`Scope` nodes, `CREATES_SCOPE`, `PARENT_SCOPE`, `IN_SCOPE`)
    - declarations (`DECLARES`)
    - references (`REFERS_TO`, `READS`, `WRITES`)
    - intra-procedural `FLOWS_TO`
- Static call graph: `CALLS`, `ARGUMENT_TO`, `RETURNS_TO`.
- `RELATIONS`, the stable list of edge-table names.
- `npm run graph:stats -- <file.lbug>` prints what a saved graph contains.
- Docs site at https://taintwire.js-recon.io.

### Fixed

- Child keys now come from both Babel and cs-mast, so subtrees cs-mast walks but Babel doesn't (for example TS enum `members`) are no longer dropped from the graph.
- Callee aliases resolve iteratively in linear time.
- Params and vars now shadow a named function expression's own name.
- Opening a graph creates every relationship table.
