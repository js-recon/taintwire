---
sidebar_position: 2
title: Architecture
---

# Architecture

All of taintwire is in `src/index.ts`, about 560 lines. There are three stages, and only the last one touches the database.

```text
            parseAst()                  flatten()                     load()
source ──────────────────> Babel AST ──────────────> rows + edges ───────────────> LadybugDB
       cs-mast | babel     (+ hash per    per-type node rows,   CREATE/ALTER tables,
                            node)         per-type-pair edges   COPY in batches
```

## `add(code, filename)`

1. **Parse.** `parseAst()` runs cs-mast or `@babel/parser` and returns the Babel `File` node. See [Parsing and hashing](parsing-and-hashing.md).
2. **Flatten.** `flatten()` walks the tree once and produces:
   - `nodes`: `Map<type, Row[]>`, one row per AST node, grouped by node type (one group per table).
   - `scopes`: one `Scope` row per lexical environment.
   - `rels.SON`, `rels.DECLARES`, `rels.CREATES_SCOPE`, `rels.PARENT_SCOPE`, `rels.IN_SCOPE`, `rels.REFERS_TO`, `rels.READS`, `rels.WRITES` and `rels.FLOWS_TO`: `Map<"fromType\0toType", Edge[]>`, edges grouped by the pair of endpoint tables.
   - `rootId`: the `File` node's id, which `add()` returns.

   The last four come from a short post-pass at the end of `flatten()` that resolves names once every binding in the file is known. See [Flattening](flattening.md), [DECLARES](declares.md), [Scopes](scopes.md), [References](references.md) and [Value flow](value-flow.md).
3. **Store the source.** `CREATE (:Source {file, code})`. This runs before any AST rows are written, so a duplicate `filename` fails on `Source`'s primary key while the graph is still untouched.
4. **Load.** `load()` creates any missing node tables and edge-table pairs, then bulk-loads each group, including the `Scope` rows, with `COPY ... FROM (UNWIND $rows ...)` in batches of 5,000. See [Storage](storage.md).

## Code map

| Symbol | Role |
| --- | --- |
| `PARSER_OPTIONS` | `@babel/parser` options, identical to JS Recon's |
| `CS_MAST_CONFIG` | cs-mast config: all `scat` categories, every other Babel type in `sinc` |
| `parseAst()` | Picks the parser and wraps cs-mast `ParseError`s |
| `COLUMNS` | The column set shared by every AST node table |
| `SKIP_PROPS` | Babel fields that never go into `props` |
| `RELS` | Edge tables and their property columns (`SON: key, idx`; `READS`, `WRITES`: `access, access_signature`; `DECLARES`, `CREATES_SCOPE`, `PARENT_SCOPE`, `IN_SCOPE`, `REFERS_TO`, `FLOWS_TO`: none) |
| `SCOPE_COLUMNS` | The columns of the `Scope` table |
| `scalar()` | Turns `value` into a string for the `value` column |
| `bindingIds()` / `declared()` | Which identifiers a node binds (the `DECLARES` targets) |
| `scopeKind()` | Which kind of scope a node creates, if any |
| `hashOf()` | The digest part of a node's cs-mast signature |
| `scopeRow()` | A `Scope` row with its deterministic id and signature |
| `isRef()` | Whether an `Identifier` child is a lexical name lookup |
| `facts()` | A node's value flows and binding writes, before resolution |
| `flatten()` | Iterative AST walk into rows and edges, then the resolution post-pass |
| `TaintGraph.open()` | Opens the DB, creates `Source` and `Scope`, discovers existing tables and pairs |
| `TaintGraph.add()` / `load()` | Parse, flatten, store source, bulk load |
| `ensureNodeTable()` / `ensureRelPair()` | Lazy DDL |
| `batched()` | One prepared `COPY`, run per 5,000-row slice |
| `TaintGraph.code()` | Id to source text, via the `Source` table |
| `TaintGraph.save()` | Row-by-row copy into a new database |
| `importCode` (exported as `import`) | `open()` + `add()` |

## Design choices

- **One file, few abstractions.** There's no plugin system and no per-relation classes. Edge tables are driven by the `RELS` const, so a new edge type means a `RELS` entry plus the code that emits its edges in `flatten()`. `open()`, `save()` and `load()` already loop over `RELS`.
- **Rows are built in JS, then bulk-copied.** Grouping is done in memory, so the database only sees large homogeneous `COPY`s. The design notes sketched one `MERGE` per node and edge, but `COPY` is much faster. See [Storage](storage.md#bulk-loading).
- **The AST is the schema.** Table names, `SON.key` values and `props` fields come straight from Babel. Nothing is renamed, so Babel's docs and AST Explorer describe the graph exactly.
- **The source is stored.** Every node can be turned back into source text from the database alone, including after `save()` and reopening.
