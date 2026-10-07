---
slug: /
title: taintwire
sidebar_label: Introduction
---

# taintwire

![taintwire](/img/banner.png)

taintwire parses JavaScript into a Babel AST and loads it into an embedded [LadybugDB](https://ladybugdb.com/) graph, where you query it with openCypher. Every AST node becomes a graph node labelled with its Babel type, and every parent-to-child link becomes an edge. With the default parser, every node also gets a [CS-MAST-S](https://cs-mast.ss0x00.com) structural hash.

```js
import * as taintwire from "@js-recon/taintwire";

const graph = await taintwire.import(`fetch(location.hash)`, { filename: "app.js" });
const rows = await graph.query(
    `MATCH (c:CallExpression)-[:SON {key: 'callee'}]->(:Identifier {name: $fn})
     RETURN c.id AS id, c.line AS line`,
    { fn: "fetch" }
);
console.log(await graph.code(rows[0].id)); // fetch(location.hash)
await graph.close();
```

:::caution Research stage

taintwire is pre-1.0 and not yet on npm. The API and graph schema will change before it replaces the [JS Recon](https://github.com/js-recon/js-recon) taint engine. So far, the graph has:

- AST containment (`SON`)
- binding declarations (`DECLARES`)
- lexical scopes (`Scope`, `CREATES_SCOPE`, `PARENT_SCOPE`, `IN_SCOPE`)
- name resolution (`REFERS_TO`)
- access classification (`READS`, `WRITES`)
- intra-procedural value flow (`FLOWS_TO`)
- a static call graph with argument and return flow (`CALLS`, `ARGUMENT_TO`, `RETURNS_TO`)

Property and heap flow, module recovery, control flow and taint rules aren't in yet. See the [roadmap](implementation/roadmap.md).

:::

## Two sets of docs

- **[API](api/getting-started.md)**: for people using taintwire as a library. Covers installation, the exported functions and classes, the graph schema you query against, and a query cookbook.
- **[Implementation](implementation/motivation.md)**: for people researching or changing taintwire. Covers why it's built this way, how source turns into graph rows, how those rows are stored in LadybugDB, and what's known to be missing or imprecise.
