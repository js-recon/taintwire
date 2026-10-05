---
sidebar_position: 8
title: Roadmap and limitations
---

# Roadmap and limitations

## Built

- Babel AST to LadybugDB, with one node table per type, `SON {key, idx}` containment edges and `props` slug references.
- A CS-MAST-S hash on every node (`cs-mast` parser), with the plain `babel` parser as a fallback.
- Stored source, with `code(id)` going from a node id back to its text.
- Persistence: build on disk, `save()` from memory, reopen and keep adding files.
- `DECLARES`: binding-introducing node to `Identifier`.

## Planned

What's still needed before taint queries work, in dependency order:

1. **Scopes.** Scope nodes or edges (program, function, block, class, catch, module), so a binding is attached to the scope it lives in, not just to its declarer. This also fixes the function-name and params ambiguity described in [DECLARES](declares.md#choices-and-their-reasons).
2. **`REFERS_TO`.** From each referencing `Identifier` to the binding `Identifier` it resolves to, using scopes. This is the step from "who introduces this name" to "which variable is this".
3. **Data-flow edges.** Edges for values moving between nodes, such as initialization, assignment and argument passing. Taint is then reachability over these edges from a source pattern to a sink pattern.
4. **Call graph.** From each call site to the function it calls, where that can be resolved.
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
