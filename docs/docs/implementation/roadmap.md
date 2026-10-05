---
sidebar_position: 11
title: Roadmap and limitations
---

# Roadmap and limitations

## Built

- Babel AST to LadybugDB, with one node table per type, `SON {key, idx}` containment edges and `props` slug references.
- A CS-MAST-S hash on every node (`cs-mast` parser), with the plain `babel` parser as a fallback.
- Stored source, with `code(id)` going from a node id back to its text.
- Persistence: build on disk, `save()` from memory, reopen and keep adding files.
- `DECLARES`: binding-introducing node to `Identifier`.
- Scopes: `Scope` nodes with `CREATES_SCOPE`, `PARENT_SCOPE` and `IN_SCOPE`, so every declared binding is attached to the lexical scope it lives in. See [Scopes](scopes.md).
- `REFERS_TO`, `READS` and `WRITES`: each use of a name resolved to its declaration, and each access classified with its exact occurrence. See [References, reads and writes](references.md).
- `FLOWS_TO`: a conservative, flow-insensitive, intra-procedural value-flow graph through expressions and variables. See [Value flow](value-flow.md).

## Planned

What's still needed before taint queries work, in dependency order:

1. **Calls and interprocedural flow.** `CALLS` from each call site to the function it calls, where that can be resolved. `ARGUMENT_TO` from arguments to parameters, and `RETURNS_TO` from `ReturnStatement`s (and concise arrow bodies) to call sites. These extend `FLOWS_TO` across functions.
2. **Property and heap flow.** `READS_PROPERTY`, `WRITES_PROPERTY` and `ALIASES`, covering member access, destructuring, for-of/for-in and object/array literals. All of these are [deferred](value-flow.md#deferred) for now.
3. **Control flow.** A CFG, `CONTROL_DEPENDS_ON` for implicit flows, and optionally reaching definitions or SSA to refine the flow-insensitive binding summaries.
4. **Taint rules.** Source, sink and sanitizer patterns. Taint is then `FLOWS_TO` reachability from a source to a sink.
5. **Integration into JS Recon**, replacing its current taint engine.

Each new edge type is a `RELS` entry plus the emitting code in `flatten()` (or a later pass). `open()`, `save()` and `load()` pick it up from `RELS`. See [Architecture](architecture.md#design-choices).

## Known limitations

| Limitation | Effect | Possible fix |
| --- | --- | --- |
| [Hash collisions](parsing-and-hashing.md#known-collisions) for `sinc` types | `&&`/`\|\|`, template text and `a.b`/`a[b]` can't be told apart by `hash` | Broaden cs-mast's `scat` coverage |
| cs-mast has no error recovery | Malformed input needs `parser: "babel"` and loses hashes | Error recovery upstream in cs-mast |
| Random ids | Ids change on every import | Use `hash` or `file` + `startOffset` for identity |
| `add()` isn't transactional | A failed `COPY` partway through leaves a partial file in the graph | Wrap `add()` in a transaction ([Storage](storage.md#consistency)) |
| Unbounded `code()` source cache | Memory grows with the number of distinct files queried | LRU (marked `ponytail:` in the code) |
| `save()` buffers the whole graph | The whole graph is held in JS memory during the copy | Stream per table, if graphs get that large |
| Babel 7 (cs-mast) tree walked with Babel 8 `VISITOR_KEYS` | A field renamed between versions would turn a subtree into `props` JSON | Guarded by the parser-parity test. Re-check when either Babel is bumped. |
| Labels exist only once seen | Matching an absent type is a binder error | Pre-create all tables, at the cost of about 250 empty tables per graph |
| Simplified scope model | No per-iteration loop scopes, no separate parameter scope, no Annex B function hoisting, no TypeScript namespace scopes | Add them when resolution needs them. See [Scopes: What isn't modelled](scopes.md#what-isnt-modelled) |
| LadybugDB inline-filter bug | `(n {p: v})` followed by an `OPTIONAL MATCH` that finds nothing returns `n`'s properties as `null` | Filter with `WHERE` ([Query cookbook](../api/queries.md#inline-property-maps-before-optional-match)) |
| Flow-insensitive bindings | Every write of a variable reaches every read of it, whatever the order, and `FLOWS_TO` has cycles | Reaching definitions or SSA ([Value flow](value-flow.md#flow-insensitive-bindings)) |
| Per-file resolution | Globals shared between script files, and host objects, stay unresolved | Model the global object and host APIs |
