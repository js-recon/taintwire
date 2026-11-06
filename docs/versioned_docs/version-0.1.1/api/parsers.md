---
sidebar_position: 5
title: Parsers
---

# Parsers

taintwire has two parsers. Both produce the same Babel AST, with the same node types and fields, using the JS Recon options (`sourceType: "unambiguous"`, `jsx` and `typescript` plugins). They differ in hashing and in error tolerance.

| | `"cs-mast"` (default) | `"babel"` |
| --- | --- | --- |
| Engine | `@shriyanss/cs-mast` (`@babel/parser` 7 inside) | `@babel/parser` 8 |
| `hash` column | 64-hex CS-MAST-S digest on every node | `null` |
| Recoverable syntax errors | Throws | Recovers and keeps parsing |

Choose the parser per graph handle:

```js
await taintwire.import(code, { parser: "babel" });
await taintwire.TaintGraph.open("graph.lbug", { parser: "babel" });
```

Every `add()` on that handle uses it. The choice isn't stored in the database, so a graph on disk can contain files from both parsers. Files added with `babel` just have `null` hashes.

## When to use which

Use **`cs-mast`** unless you have a reason not to. The hash lets you match identical code across files, builds and minification runs. See [Graph model: hash](graph-model.md#hash).

Use **`babel`** when cs-mast rejects the input. Babel's `errorRecovery` accepts code like `let a = 1; let a = 2;` (a redeclaration) that cs-mast refuses, and still builds the full tree.

## When parsing fails

With `cs-mast`, a parse error rejects with a `taintwire:` error that suggests the fallback. The original cs-mast `ParseError` is on `error.cause`:

```text
taintwire: @babel/parser failed: Identifier 'a' has already been declared. (1:13) (try { parser: "babel" })
```

To fall back automatically:

```js
async function importAny(code, filename) {
    try {
        return await taintwire.import(code, { filename });
    } catch (e) {
        if (!e.message.includes('(try { parser: "babel" })')) throw e;
        return taintwire.import(code, { filename, parser: "babel" });
    }
}
```

A handle's parser can't be changed once it's open. To add a file that failed to a graph on disk, `close()` the graph, reopen it with `TaintGraph.open(dbPath, { parser: "babel" })`, then `add()` the file. An in-memory graph can't be reopened, so build it on disk (`dbPath`) if you expect to need this.

With `babel`, `@babel/parser` still throws on input it can't recover from. That error is passed through unchanged.
