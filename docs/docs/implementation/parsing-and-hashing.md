---
sidebar_position: 3
title: Parsing and hashing
---

# Parsing and hashing

`parseAst(code, parser)` returns a Babel `File` node. The rest of the pipeline works the same whichever parser produced it.

## The `babel` parser

```ts
parse(code, PARSER_OPTIONS);
// PARSER_OPTIONS = { sourceType: "unambiguous", plugins: ["jsx", "typescript"], errorRecovery: true }
```

This is `@babel/parser` 8.0.4, pinned exactly to match JS Recon. `errorRecovery` means recoverable errors, such as redeclarations, are collected on `ast.errors` instead of thrown. `flatten()` drops `errors` along with the other noise fields.

## The `cs-mast` parser (default)

```ts
cs_mast_init(code, CS_MAST_CONFIG).root._raw;
```

[cs-mast](https://cs-mast.ss0x00.com) parses the code with its own `@babel/parser` (7.x) and attaches a CS-MAST-S signature to each raw Babel node under `CS_MAST_SIGNATURE_KEY`. `root._raw` is the ordinary Babel `File` node with those signatures added, so `flatten()` handles it like any other Babel AST and only reads the extra key to fill the `hash` column.

### Config

```ts
export const CS_MAST_CONFIG: CsMastConfig = {
    hash: "sha256",
    lang: "js",
    prsr: "@babel/parser",
    scat: ["lit", "id", "op", "decl", "loop", "cond", "name", "val", "op_name"],
    sinc: Object.keys(csMastBabelTypes.VISITOR_KEYS),
    sourceType: "unambiguous",
};
```

- **`scat`** turns on every cs-mast category. These are its "rich" hashes: identifier names, literal values, operators and so on are part of the hash. Together they cover about 25 node types.
- **`sinc`** lists every other Babel node type. cs-mast gives `sinc` types a structural hash over their type and their children's hashes. Without it, the types `scat` doesn't cover would have no hash. cs-mast drops `sinc` entries that `scat` already covers, so passing the full type list is safe.

### Babel 7 types, not Babel 8

```ts
const csMastBabelTypes = createRequire(require.resolve("@shriyanss/cs-mast"))("@babel/types");
```

`sinc` has to name the node types that cs-mast's Babel produces, and cs-mast depends on Babel 7. Babel 8 renamed and removed some types. So taintwire resolves `@babel/types` *from cs-mast's install location*, and gets the Babel 7 type list rather than its own Babel 8 one.

The walk in `flatten()` still uses taintwire's Babel 8 `VISITOR_KEYS` to find children, even for a Babel 7 tree. Both parsers producing the same tree is what keeps this safe, and a test checks it: `babel parser builds the same tree without signatures` compares per-type node counts from both parsers on the webpack fixture. If a Babel 7 field held children under a key Babel 8 doesn't list, that subtree would end up as JSON in `props` instead of graph nodes, and the counts would differ.

### Error handling

cs-mast parses without `errorRecovery`, so input that Babel would recover from makes it throw `ParseError`. `parseAst()` rethrows that as:

```text
taintwire: <message> (try { parser: "babel" })
```

The original error is kept as `cause`. Errors other than `ParseError` pass through unchanged.

## Storing the hash

A CS-MAST-S signature has the form `<config prefix>$<hex digest>`. The prefix encodes the whole config, including every `sinc` type, so it's about 4.6 KB and identical on every node. `flatten()` stores only the part after the last `$`:

```ts
hash: sig?.slice(sig.lastIndexOf("$") + 1) ?? null;
```

That's 64 hex chars per node. The full signature can be rebuilt with cs-mast's `buildSignatureFromConfig(CS_MAST_CONFIG, hash)`.

### Known collisions

`sinc` types hash only their type and their children. Scalar fields on the node itself aren't part of the hash, so some pairs that differ collide:

| Collides | Why |
| --- | --- |
| `a && b` / `a \|\| b` | `LogicalExpression.operator` isn't in `scat` |
| `` `x${a}` `` / `` `y${a}` `` | `TemplateElement` text isn't hashed |
| `a[b]` / `a.b` | `MemberExpression.computed` is a scalar, and both children are the same `Identifier`s |

These come from cs-mast's category coverage, not from taintwire. Fixing them means extending cs-mast's `scat`, not changing `CS_MAST_CONFIG`.
