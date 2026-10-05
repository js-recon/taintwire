---
sidebar_position: 9
title: Storage
---

# Storage

taintwire stores graphs in [LadybugDB](https://ladybugdb.com/) 0.21.2 through `@ladybugdb/core`. Ladybug is an embedded, Kùzu-derived graph database with a strict schema: every node table and edge table has to be declared before use, with typed columns. This page covers how taintwire maps the [flattened rows](flattening.md) onto that schema, and the Ladybug behaviours that shaped the code.

## Schema

| Table | Kind | Created |
| --- | --- | --- |
| `Source(file STRING PRIMARY KEY, code STRING)` | node | By `open()`, `IF NOT EXISTS` |
| One table per Babel node type, all with the `COLUMNS` set | node | By `ensureNodeTable()`, the first time the type is loaded |
| `SON(key STRING, idx INT64)` | edge, many FROM/TO pairs | By `open()` with one default pair (`DEFAULT_PAIRS`). Further pairs are added by `ensureRelPair()` the first time a (parent type, child type) pair is loaded. |
| `Scope(id STRING PRIMARY KEY, kind, file, signature, owner_signature)` | node | By `open()`, `IF NOT EXISTS` |
| `DECLARES()` | edge, many FROM/TO pairs | Same as `SON` |
| `CREATES_SCOPE()` | edge, one pair per owner type (`FunctionDeclaration -> Scope`, ...) | Same as `SON` |
| `PARENT_SCOPE()` | edge, `Scope -> Scope` | Same as `SON` |
| `IN_SCOPE()` | edge, `Identifier -> Scope` | Same as `SON` |
| `REFERS_TO()` | edge, `Identifier -> Identifier` | Same as `SON` |
| `READS(access STRING, access_signature STRING)` | edge, many FROM/TO pairs (operation type `-> Identifier`) | Same as `SON` |
| `WRITES(access STRING, access_signature STRING)` | edge, many FROM/TO pairs | Same as `SON` |
| `FLOWS_TO()` | edge, many FROM/TO pairs (any expression type to any other) | Same as `SON` |

### Every edge table exists from the start

Ladybug can't create an edge table without a FROM/TO pair. When a graph is opened, any edge table in `RELS` that doesn't exist yet is created with one real pair from `DEFAULT_PAIRS`, for example `REFERS_TO: Identifier -> Identifier` or `READS: CallExpression -> Identifier`. The node tables for that pair are created at the same time. As a result, `MATCH ()-[:CALLS]->()` is an empty result on a graph with no resolved calls, not `Table CALLS does not exist`. The same applies to a reopened database written by an older version.

Node tables stay lazy, apart from those few. Creating all of them up front would add about 250 empty tables to every graph.

### Why a table per node type

Ladybug labels are tables. Putting each Babel type in its own table means `(c:CallExpression)` is a single-table scan, and the label is the AST type, so queries read like the AST. The cost is that a table only exists once its type has been seen, so querying a label the graph doesn't have is a binder error rather than an empty result.

The alternative, one `AstNode` table with a `type` column, would make every typed match a filtered scan over all nodes.

### Edge tables with many pairs

A Ladybug edge table declares the node-table pairs it connects. `SON` can connect any parent type to any child type, so its pairs are added as they're seen:

```ts
pairs.size
    ? `ALTER TABLE ${rel} ADD FROM \`${from}\` TO \`${to}\``
    : `CREATE REL TABLE ${rel}(FROM \`${from}\` TO \`${to}\`, ${props})`;
```

`relPairs: Record<Rel, Set<"from\0to">>` caches which pairs exist, so each pair costs one DDL statement per database.

### Naming constraints

- **`end` is a Cypher keyword**, so Babel's `start`/`end` are stored as `startOffset`/`endOffset`.
- **Table names are backtick-quoted** in generated DDL and queries, in case a Babel type clashes with a keyword.
- **`Source` and `Scope` can't collide** with an AST table, because neither is a Babel type name.

## Bulk loading

```ts
COPY `CallExpression` FROM (UNWIND $rows AS r RETURN r.id, r.type, ...)
COPY SON FROM (UNWIND $rows AS r RETURN r.from, r.to, r.key, r.idx) (from='CallExpression', to='Identifier')
```

`COPY ... FROM (subquery)` is Ladybug's bulk-insert path. The rows go in as a single list parameter, `UNWIND` turns them into a result set, and `COPY` appends it to the table. For an edge table with many pairs, the `(from=..., to=...)` option names the pair, which is why [flattening](flattening.md#grouping) groups edges by endpoint types.

The design notes sketched `MERGE` per node and per edge. An intermediate version created edges with `UNWIND ... MATCH (a), (b) CREATE (a)-[:SON]->(b)`, which was about 4x slower overall than `COPY`.

`batched()` prepares each `COPY` once and runs it over 5,000-row slices (`BATCH_SIZE`), which keeps parameter lists small on large bundles.

Node tables, then the `Scope` rows, load before edge tables, because `COPY` into an edge table needs both endpoints to exist already.

## Opening a database

```ts
new lbug.Database(dbPath, 0, true, false, MAX_DB_SIZE);
//                path, buffer pool (default), compression, read-only, max DB size
```

### `MAX_DB_SIZE = 2 ** 40` (1 TiB)

Ladybug reserves virtual address space for the maximum database size, 8 TiB by default. That reservation is only released when the `Database` object is garbage-collected, not on `close()`, so a process ran out of address space after about nine opens. A 1 TiB cap is far beyond any AST graph and allows many opens per process.

### Discovering an existing graph

`open()` rebuilds its caches from the database itself:

```cypher
CALL show_tables() RETURN name, type          // node tables -> tables set (minus Source and Scope)
CALL show_connection('SON') RETURN *          // FROM/TO pairs -> relPairs
```

So a reopened graph doesn't recreate tables or pairs that already exist, and `add()` behaves the same on a new or reopened database. Only edge tables listed in `RELS` are picked up.

## `code(id)`

1. The table name is the id's type prefix: `id.slice(0, id.lastIndexOf("_"))`. It's checked against the known-tables set before it's put into the query.
2. Fetch `file`, `startOffset` and `endOffset` from that table.
3. Fetch the file's source from `Source` and cache it in a per-graph `Map`.
4. Slice it **in JS**: `src.slice(start, end)`.

The slice has to happen in JS. Babel offsets count UTF-16 code units, while Ladybug's `substring()` counts code points. Any character outside the BMP, such as an emoji, would shift every later offset by one. The test for `code()` puts an emoji before the target expression to catch this.

The source cache is unbounded. That's fine at current scale, and it's marked `ponytail:` in the code for an LRU if graphs outgrow memory.

## `save(dbPath)`

Ladybug's `EXPORT DATABASE` rejects edge tables with several FROM/TO pairs, which every taintwire graph has. So `save()` copies the graph itself:

1. Refuse if `dbPath` exists.
2. Read every node table (`MATCH (n:T) RETURN <COLUMNS>`), every `Scope` row and every edge pair (`MATCH (a:F)-[e:R]->(b:T) RETURN a.id, b.id, <props>`) into the same shapes `flatten()` produces.
3. Read every `Source` row.
4. Open a new graph at `dbPath`, insert the `Source` rows, and run the same `load()` as `add()`.

This reuses the loading path instead of adding a second serializer. The whole graph is held in memory during the copy.

Before loading, `save()` turns off Ladybug's automatic checkpointing (`CALL auto_checkpoint=false`), and it runs one `CHECKPOINT` at the end. The copy is one `COPY` per node table and per (edge, from, to) pair, which is several hundred statements for a typical graph, mostly from `SON` and `FLOWS_TO`. With a checkpoint after each one, a save of the three test fixtures took about 20s. Without them it takes about 4.5s.

## Consistency

`add()` doesn't run in an explicit transaction. Each `COPY` batch is its own statement. A duplicate filename is caught first, by the `Source` insert. But if a later `COPY` fails, for example from an id collision or a crash, the graph keeps the rows already loaded for that file. Wrapping `add()` in `BEGIN TRANSACTION` / `COMMIT` would fix this, once Ladybug's DDL-inside-transaction behaviour has been checked against the lazy table creation.
