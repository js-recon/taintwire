---
sidebar_position: 2
title: API reference
---

# API reference

Everything below is exported from `@js-recon/taintwire`. TypeScript declarations ship with the build.

| Export | Kind | Purpose |
| --- | --- | --- |
| [`import()`](#import) | function | Parse code into a new graph |
| [`TaintGraph`](#taintgraph) | class | An open graph: add files, query, save, close |
| [`Parser`](#parser) | type | `"cs-mast" \| "babel"` |
| [`PARSER_OPTIONS`](#parser_options) | const | The `@babel/parser` options |
| [`CS_MAST_CONFIG`](#cs_mast_config) | const | The cs-mast config used to hash every node |
| [`flatten()`](#flatten) | function | Low level: AST to node rows, scope rows and edges, without a database |
| [`flattenFiles()`](#flattenfiles) | function | Low level: `flatten()` for several files at once, linked through a bundler's module registry |
| [`declared()`](#declared) | function | Low level: the identifiers a single AST node declares |
| [`scopeKind()`](#scopekind) | function | Low level: the kind of scope a single AST node creates |
| [`RELATIONS`](#relations) | const | The names of every edge table, in layer order |
| [`isRef()`](#isref) | function | Low level: whether an `Identifier` child is a lexical name lookup |
| [`ScopeKind`](#scopekind) | type | `"global" \| "module" \| "function" \| "block" \| "catch" \| "class" \| "static_block"` |

## `import()`

```ts
function import(
    code: string,
    opts?: { filename?: string; dbPath?: string; parser?: Parser }
): Promise<TaintGraph>;
```

Opens a graph and adds `code` to it. It's shorthand for `TaintGraph.open(dbPath, { parser })` followed by `graph.add(code, filename)`.

| Option | Default | Meaning |
| --- | --- | --- |
| `filename` | `"input.js"` | Stored in every node's `file` column. Must be unique within the graph. |
| `dbPath` | `":memory:"` | Where the LadybugDB database lives. A path creates or opens a file on disk. |
| `parser` | `"cs-mast"` | Which parser to use, see [Parsers](parsers.md). |

Rejects if parsing fails (see [errors](#errors)). You own the returned graph and must `close()` it.

## `TaintGraph`

A LadybugDB-backed graph of one or more parsed files. Create one with `TaintGraph.open()` or `import()`. The constructor is private.

### `TaintGraph.open()`

```ts
static open(dbPath?: string, opts?: { parser?: Parser }): Promise<TaintGraph>;
```

Opens the database at `dbPath`, creating it if it doesn't exist. `dbPath` defaults to `":memory:"`. Opening an existing database picks up its node tables and edge tables, so later `add()` calls reuse them.

`parser` (default `"cs-mast"`) applies to every `add()` on this handle. It isn't stored in the database: reopening a file with a different `parser` is allowed, and only affects files added from then on.

### `graph.add()`

```ts
add(code: string, filename?: string): Promise<string>;
```

Parses `code` and loads its AST into the graph. Returns the `id` of the new `File` node. `filename` defaults to `"input.js"`.

Rejects if `filename` is already in the graph. That check runs before any AST nodes are written.

`add()` is `addFiles([{ code, filename }])`. Files added by separate `add()` calls aren't linked to each other: use `addFiles()` for the chunks of one bundle.

### `graph.addFiles()`

```ts
addFiles(files: { code: string; filename: string }[]): Promise<string[]>;
```

Parses every file and loads them as one unit. Returns the `File` node ids, in the same order as `files`.

Names still resolve per file, as with `add()`. What `addFiles()` adds is the link between files that a bundler's runtime makes. For a webpack 4 or 5 build, a call or value read through the module registry resolves to the function or value in the chunk that defines it, so value paths cross chunks. Load every `.js` file of a build directory in one call. See [Bundler support](../bundlers/index.md).

```ts
import { readdirSync, readFileSync } from "node:fs";
import { TaintGraph } from "@js-recon/taintwire";

const dir = "dist";
const graph = await TaintGraph.open();
await graph.addFiles(
    readdirSync(dir)
        .filter((f) => f.endsWith(".js"))
        .map((f) => ({ filename: f, code: readFileSync(`${dir}/${f}`, "utf8") }))
);
```

Each `eval("<string literal>")` in the files is parsed with the graph's parser and stored as a virtual file `<file>#eval@<offset>`, with its own `Source` row, so `code(id)` works on its nodes. This applies to `add()` too. See [webpack: eval builds](../bundlers/webpack.md#eval-builds).

Rejects if any `filename` is already in the graph or appears twice in `files`.

### `graph.query()`

```ts
query(cypher: string, params?: Record<string, unknown>): Promise<Record<string, LbugValue>[]>;
```

Runs openCypher against the graph and returns one object per row, keyed by the `RETURN` aliases. `INT64` columns come back as JavaScript numbers, `STRING` as strings and missing values as `null`.

- With `params`, the query is prepared and `$name` placeholders are bound from `params`. Use this for any value that comes from input rather than splicing it into the query string.
- If `cypher` holds several `;`-separated statements, only the last statement's rows are returned.

```js
await graph.query("MATCH (i:Identifier {name: $name}) RETURN i.line AS line", { name: "token" });
// [{ line: 12 }, { line: 40 }]
```

See [Graph model](graph-model.md) for what to match on, and [Query cookbook](queries.md) for examples.

### `graph.code()`

```ts
code(id: string): Promise<string>;
```

Returns the exact source text of the node with this `id`, sliced from the stored copy of its file. Works on reopened and saved graphs as well, since the source is stored in the database.

Rejects with `taintwire: no node <id>` if the id doesn't exist.

### `graph.save()`

```ts
save(dbPath: string): Promise<void>;
```

Writes a full copy of the graph to a new LadybugDB database at `dbPath`. The graph you call it on stays open and unchanged. Rejects with `taintwire: refusing to overwrite existing <dbPath>` if anything already exists at `dbPath`.

### `graph.close()`

```ts
close(): Promise<void>;
```

Closes the connection and the database. An in-memory graph is discarded, so `save()` it first if you need it.

### `graph.db` / `graph.connection`

The raw Ladybug `Database` and `Connection` (`@ladybugdb/core` in Node, `@ladybugdb/wasm-core` in the [browser](browser.md)), for anything the wrapper doesn't cover. Writing to the database through them can break the assumptions `add()`, `save()` and `code()` rely on.

## `Parser`

```ts
type Parser = "cs-mast" | "babel";
```

`"cs-mast"` (the default) produces the Babel AST with a CS-MAST-S hash on every node. `"babel"` produces the plain AST with no hashes, and recovers from more syntax errors. See [Parsers](parsers.md).

## `PARSER_OPTIONS`

```ts
const PARSER_OPTIONS = {
    sourceType: "unambiguous",
    plugins: ["jsx", "typescript"],
    errorRecovery: true,
};
```

The `@babel/parser` options the `"babel"` parser uses. They match JS Recon's, so both see the same AST for the same input.

## `CS_MAST_CONFIG`

```ts
const CS_MAST_CONFIG: CsMastConfig = {
    hash: "sha256",
    lang: "js",
    prsr: "@babel/parser",
    scat: ["lit", "id", "op", "decl", "loop", "cond", "name", "val", "op_name"],
    sinc: [/* every Babel node type */],
    sourceType: "unambiguous",
};
```

The cs-mast config behind the `hash` column. To rebuild a node's full CS-MAST-S signature from its stored digest, use cs-mast's `buildSignatureFromConfig(CS_MAST_CONFIG, hash)`.

## `flatten()`

```ts
function flatten(ast: Node, file: string): {
    rootId: string;
    nodes: Map<string, Row[]>;
    scopes: ScopeRow[];
    rels: Record<
        | "SON" | "DECLARES" | "CREATES_SCOPE" | "PARENT_SCOPE" | "IN_SCOPE"
        | "REFERS_TO" | "READS" | "WRITES" | "FLOWS_TO"
        | "CALLS" | "ARGUMENT_TO" | "RETURNS_TO" | "IMPORTS" | "EXPORTS",
        Map<string, Edge[]>
    >;
};
```

Turns a Babel AST into the rows `add()` loads, with no database involved: node rows grouped by node type, `Scope` rows, and edges grouped by `"<fromType>\0<toType>"`. Scope edges use `"Scope"` as the type on their scope end. `REFERS_TO`, `READS`, `WRITES`, `FLOWS_TO`, `CALLS`, `ARGUMENT_TO` and `RETURNS_TO` are resolved within this one file, after the walk. Exported for testing and research, and likely to change.

## `flattenFiles()`

```ts
function flattenFiles(
    units: [ast: Node, file: string][],
    opts?: { parse?: (code: string) => Node }
): {
    rootIds: string[];
    nodes: Map<string, Row[]>;
    scopes: ScopeRow[];
    rels: Record<Relation, Map<string, Edge[]>>; // as flatten()
    evals: { filename: string; code: string }[];
};
```

What `addFiles()` loads. The same as `flatten()`, but for several files, with one `rootId` per unit, in order. Each file keeps its own scopes, and the [webpack registry pass](../bundlers/webpack.md#how-it-works) links them. With `parse`, each `eval("<string literal>")` is parsed and walked in the eval's scope, and listed in `evals` as a virtual file (`addFiles()` stores their `Source` rows). Without it, eval strings stay strings. `flatten(ast, file)` is `flattenFiles([[ast, file]])`. Exported for testing and research, and likely to change.

## `declared()`

```ts
function declared(node: Node): Node[];
```

Returns the `Identifier` nodes that `node` introduces as bindings, which become its outgoing `DECLARES` edges. Returns `[]` for node types that declare nothing. See [Graph model](graph-model.md#declares) for the rules.

## `scopeKind()`

```ts
type ScopeKind = "global" | "module" | "function" | "block" | "catch" | "class" | "static_block";
function scopeKind(node: Node, parent?: Node): ScopeKind | null;
```

Returns the kind of `Scope` that `node` creates, or `null` if it creates none. `parent` is the node's AST parent. It's needed for `BlockStatement`, which creates no scope when it's a function or catch body. See [Graph model](graph-model.md#the-scope-table) for the table of owners.

## `RELATIONS`

```ts
const RELATIONS: readonly ["SON", "DECLARES", "CREATES_SCOPE", "PARENT_SCOPE", "IN_SCOPE", "REFERS_TO", "READS", "WRITES", "FLOWS_TO", "CALLS", "ARGUMENT_TO", "RETURNS_TO", "IMPORTS", "EXPORTS"];
```

The edge tables every graph has, from the moment it's opened. Querying any of them on a graph with no such edges returns no rows. The names are stable. See [Graph model](graph-model.md#edges).

## `isRef()`

```ts
function isRef(parent: Node, key: string): boolean;
```

Whether the `Identifier` at `parent[key]` is a lexical name lookup, and so a candidate for `REFERS_TO`. It's `false` for static property names and keys, labels, import/export names, private names and TypeScript type positions. It doesn't know about declarations: `flatten()` also skips `DECLARES` targets and re-exported names. See [References: What counts as a reference](../implementation/references.md#what-counts-as-a-reference).

## Errors

All errors taintwire raises itself start with `taintwire:`.

| Message | Cause |
| --- | --- |
| `taintwire: <parser message> (try { parser: "babel" })` | The cs-mast parser rejected the input. The original `ParseError` is on `error.cause`. See [Parsers](parsers.md#when-parsing-fails). |
| `taintwire: no node <id>` | `code()` got an id that isn't in the graph. |
| `taintwire: refusing to overwrite existing <path>` | `save()` target already exists. |
| `taintwire: no source stored for <file>` | `code()` found the node but not its file's source. Only happens if the `Source` table was edited by hand. |

A duplicate `filename` in `add()` rejects with LadybugDB's primary-key violation, not a `taintwire:` error. Invalid Cypher in `query()` rejects with LadybugDB's own error, for example `Binder exception: Table WithStatement does not exist.`.
