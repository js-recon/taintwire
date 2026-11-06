---
sidebar_position: 1
title: Getting started
---

# Getting started

## Requirements

- Node.js 22 or later. CI tests Node 22 and 24 on Linux and macOS.
- An ESM project. The package is `"type": "module"` and has no CommonJS build.

## Install

`@js-recon/taintwire` isn't published to npm yet. Until it is, build it from source and install the local copy:

```bash
git clone https://github.com/js-recon/taintwire.git
cd taintwire
npm install
npm run build

# in your project
npm install /path/to/taintwire
```

## Your first graph

```js
import * as taintwire from "@js-recon/taintwire";

const code = `
const q = location.hash.slice(1);
document.getElementById("out").innerHTML = q;
`;

// Parse `code` and load it into a new in-memory graph.
const graph = await taintwire.import(code, { filename: "app.js" });

// Find every assignment to `.innerHTML`.
const sinks = await graph.query(`
    MATCH (a:AssignmentExpression)-[:SON {key: 'left'}]->(:MemberExpression)
          -[:SON {key: 'property'}]->(:Identifier {name: 'innerHTML'})
    RETURN a.id AS id, a.line AS line
`);

for (const { id, line } of sinks) console.log(line, await graph.code(id));
// 3 document.getElementById("out").innerHTML = q

await graph.close();
```

`import` is a reserved word, so you can't write `import { import } from ...`. Use a namespace import as above, or rename it:

```js
import { import as importCode, TaintGraph } from "@js-recon/taintwire";
```

## More than one file

A graph can hold any number of files. Each needs a unique `filename`, and every node records which file it came from in its `file` column.

```js
const graph = await taintwire.import(mainJs, { filename: "main.3f2a.js" });
await graph.add(chunkJs, "chunk.91bc.js");

await graph.query("MATCH (f:File) RETURN f.file AS file");
// [{ file: "main.3f2a.js" }, { file: "chunk.91bc.js" }]
```

## Persisting graphs

Graphs are in-memory by default. There are two ways to get one onto disk:

```js
// 1. Build straight into a LadybugDB file.
const graph = await taintwire.import(code, { dbPath: "graph.lbug" });

// 2. Build in memory, then write a copy out. Refuses to overwrite an existing path.
const mem = await taintwire.import(code);
await mem.save("graph.lbug");
```

Reopen a saved graph with `TaintGraph.open()`. You can keep adding files to it:

```js
const graph = await taintwire.TaintGraph.open("graph.lbug");
await graph.add(moreCode, "late-chunk.js");
```

The file is a standard LadybugDB 0.21 database, so other Ladybug tools of the same version can open it too.

## Next steps

- [API reference](reference.md): every export and method.
- [Graph model](graph-model.md): the node tables, columns and edges you query.
- [Query cookbook](queries.md): working queries and the Cypher gotchas specific to this graph.
- [Parsers](parsers.md): `cs-mast` against `babel`, and what to do when parsing fails.
