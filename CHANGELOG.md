# Changelog

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
