# taintwire

Graph-based AST/taint analysis for JavaScript. Parses JS through [CS-MAST](https://cs-mast.ss0x00.com) (the Babel AST with a Merkle-style hash on every node) and loads the AST into an embedded [LadybugDB](https://ladybugdb.com/) graph, queryable with openCypher.

> Research stage. API will change before it replaces JS Recon's taint engine.

## Usage

```js
import * as taintwire from "@js-recon/taintwire";

const graph = await taintwire.import(code, { filename: "app.abc123.js" }); // in-memory
await graph.add(otherCode, "chunk.js"); // more files into the same graph

const rows = await graph.query(
    `MATCH (c:CallExpression)-[:SON {key: 'callee'}]->(:Identifier {name: $fn})
     RETURN c.file, c.line, c.col`,
    { fn: "eval" }
);
await graph.close();
```

Persist with `taintwire.import(code, { dbPath: "graph.lbug" })`, or write an in-memory graph out with `await graph.save("graph.lbug")` (refuses to overwrite). Reopen with `taintwire.TaintGraph.open("graph.lbug")`. The raw Ladybug handles are on `graph.db` / `graph.connection`.

### Parser

`parser` picks how source is parsed, per graph: `taintwire.import(code, { parser })` or `TaintGraph.open(dbPath, { parser })`.

- `"cs-mast"` (default): `@shriyanss/cs-mast` with every `scat` category on and every other Babel node type in `sinc` (`CS_MAST_CONFIG`), so every node gets a hash. Parses without error recovery, so malformed input throws; fall back to `"babel"` for it.
- `"babel"`: `@babel/parser` with the same options as JS Recon (`PARSER_OPTIONS`); `hash` is null.

Both produce the same tree.

## Graph model

- Every Babel node becomes a graph node **labelled by its AST type** (`File`, `Program`, `CallExpression`, ...), id `<type>_<random hex>`.
- Parent → child edges are `SON {key, idx}`: `key` is the Babel field (`callee`, `arguments`, `body`, ...), `idx` the array index or `-1`.
- Node columns: `id, type, file, startOffset, endOffset, line, col, endLine, endCol, name, value, operator, props, hash`.
  - `name` (identifiers), `value` (literals, stringified; template `cooked`), `operator` are pulled out for querying.
  - `props` is a JSON string of the remaining fields; child-node fields are replaced with `{type, slug_ref}` pointing at the child's id.
  - `hash` is the 64-hex digest of the node's CS-MAST-S signature, so structurally identical subtrees can be matched with `a.hash = b.hash`. The full signature is `buildSignatureFromConfig(CS_MAST_CONFIG, hash)` from cs-mast; it isn't stored because its prefix lists every `sinc` type (~4.6 KB) and is the same on every node.
  - Non-scat nodes hash only their type and children, so some scalar differences collide: `a && b` / `a || b` (LogicalExpression operator), template text, `a[b]` / `a.b`.
  - Offsets are `startOffset`/`endOffset` because `end` is a Cypher keyword.

## Development

```sh
npm install
npm test
npm run build
```
