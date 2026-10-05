---
sidebar_position: 3
title: Graph model
---

# Graph model

This is the schema your queries run against.

## At a glance

`fetch(location.hash)` becomes this graph. Each box is a node labelled with its Babel type. Each arrow is a `SON` edge, annotated with its `key` and, for array children, `idx`.

```text
File
└─ SON {key: program} ─> Program
   └─ SON {key: body, idx: 0} ─> ExpressionStatement
      └─ SON {key: expression} ─> CallExpression
         ├─ SON {key: callee} ─> Identifier {name: "fetch"}
         └─ SON {key: arguments, idx: 0} ─> MemberExpression
            ├─ SON {key: object} ─> Identifier {name: "location"}
            └─ SON {key: property} ─> Identifier {name: "hash"}
```

Follow the Babel AST and you're following the graph. [AST Explorer](https://astexplorer.net/) with the `@babel/parser` setting is the quickest way to see which type and key to match.

## Node tables

Each Babel node type gets its own node table, named after the type: `File`, `Program`, `CallExpression`, `Identifier`, `JSXElement`, `TSTypeAnnotation` and so on. `MATCH (c:CallExpression)` scans only call expressions.

A table is created the first time its node type is seen. If no file in the graph has a `WithStatement`, then `MATCH (n:WithStatement)` fails with `Table WithStatement does not exist`, rather than returning no rows.

Every AST table has the same columns:

| Column | Type | Contents |
| --- | --- | --- |
| `id` | `STRING` (primary key) | `<Type>_<16 hex chars>`, for example `CallExpression_959aa3eaf5d5d7ce`. Random, so a re-import gives new ids. |
| `type` | `STRING` | The Babel type, same as the table name. |
| `file` | `STRING` | The `filename` passed to `import()` or `add()`. |
| `startOffset`, `endOffset` | `INT64` | Babel's `start`/`end`: UTF-16 code-unit offsets into the file. |
| `line`, `col` | `INT64` | Start position. `line` is 1-based, `col` 0-based. |
| `endLine`, `endCol` | `INT64` | End position, same bases. |
| `name` | `STRING` | The node's `name` when it's a string (`Identifier`, `JSXIdentifier`, ...), otherwise `null`. |
| `value` | `STRING` | The node's `value` as a string (`StringLiteral`, `NumericLiteral`, `BooleanLiteral`, `BigIntLiteral`, ...). For `TemplateElement` it's the cooked text, or the raw text if there's no cooked form. Otherwise `null`. |
| `operator` | `STRING` | The node's `operator` (`BinaryExpression`, `AssignmentExpression`, `UnaryExpression`, ...), otherwise `null`. |
| `props` | `STRING` | JSON of every other Babel field. See [props](#props). |
| `hash` | `STRING` | 64 hex chars: the CS-MAST-S digest of the node's subtree. `null` with the `babel` parser. See [hash](#hash). |

Positions that Babel didn't record are `-1`.

`value` is always a string. `1` is stored as `'1'`, so match it as `{value: '1'}` or `n.value IN ['468', '469']`.

## The `Source` table

`Source(file STRING PRIMARY KEY, code STRING)` holds each file's full source once. `code()` slices node text from it. It isn't an AST table, so it has no `type` column. That matters for unlabelled matches:

```cypher
// Counts AST nodes AND Source rows:
MATCH (n) RETURN count(*)
// Counts AST nodes only:
MATCH (n) WHERE n.type IS NOT NULL RETURN count(*)
```

## Edges

### `SON`

`(parent)-[:SON {key, idx}]->(child)` for every child node in the AST.

| Property | Type | Contents |
| --- | --- | --- |
| `key` | `STRING` | The Babel field holding the child: `callee`, `arguments`, `body`, `left`, `object`, `property`, ... |
| `idx` | `INT64` | Position in the field when it's an array (`arguments`, `body`, `params`, ...), otherwise `-1`. |

Use `key` to tell children apart. For example, `-[:SON {key: 'callee'}]->` is the function being called, while `-[:SON {key: 'arguments', idx: 0}]->` is its first argument.

### `DECLARES`

`(declarer)-[:DECLARES]->(identifier)` links a node to each `Identifier` it introduces as a JavaScript binding. The target is the same `Identifier` node that's already in the tree, not a copy. It has the same `id` and `hash`, and is still reachable through `SON`. `DECLARES` has no properties.

| Declarer | Declares |
| --- | --- |
| `VariableDeclarator` | The bound names in `id`. Covers `var`, `let`, `const`, `using` and `await using`. |
| `FunctionDeclaration`, `FunctionExpression` | Its own name (if any) and its parameters' bound names. |
| `ArrowFunctionExpression`, `ObjectMethod`, `ClassMethod`, `ClassPrivateMethod` | Its parameters' bound names. The method key is a property name, not a binding. |
| `ClassDeclaration`, `ClassExpression` | Its name, if any. |
| `ImportSpecifier`, `ImportDefaultSpecifier`, `ImportNamespaceSpecifier` | The local name: `alias` in `import { original as alias }`. |
| `CatchClause` | The bound names in its parameter. `catch {}` declares nothing. |

Destructuring declares the bound names only. `const { foo: bar, baz = 1, ...rest } = o` declares `bar`, `baz` and `rest`. It doesn't declare the key `foo`, and nothing in the default value `1` is declared.

Nothing else declares. In particular:

- Wrappers: `VariableDeclaration`, `ExportNamedDeclaration`, `ExportDefaultDeclaration`. The declarator or function inside them is the declarer.
- Re-exports: `export { y } from "./y.js"`, `export * from "./z.js"`.
- Assignment to existing names: `({ a } = o)`, `[c] = d`, `o.p = 1`.
- A TypeScript `this` parameter.

`DECLARES` says nothing about scope yet. A `FunctionDeclaration` declares its own name even though that name lives in the enclosing scope. Finding the declaration an identifier *refers to* needs scope analysis, which isn't built yet.

## `props`

`props` is a JSON string of every Babel field that isn't a column or a child. Fields holding child nodes are kept, but replaced with a reference to the child:

```json
{"object": {"type": "Identifier", "slug_ref": "Identifier_b0ad8a1fd19c9391"},
 "computed": true,
 "property": {"type": "Identifier", "slug_ref": "Identifier_e6a29340f12f90f8"}}
```

`slug_ref` is the child's `id`, so it's the node at the other end of the matching `SON` edge. Arrays of children become arrays of references, with `null` for holes.

Not stored: `loc`, `range`, `start`, `end` (these are columns), comments, `tokens` and parser `errors`.

To filter on a field that isn't a column, match on the JSON text:

```cypher
// a[b], not a.b
MATCH (m:MemberExpression) WHERE m.props CONTAINS '"computed":true' RETURN m.id
```

## `hash`

With the default `cs-mast` parser, every node's `hash` is the SHA-256 digest of its [CS-MAST-S](https://cs-mast.ss0x00.com) signature. That's a Merkle-style hash over the node and its subtree. Two nodes with the same hash have the same structure, which lets you match repeated code across files and builds:

```cypher
MATCH (a:FunctionExpression), (b:FunctionExpression)
WHERE a.hash = b.hash AND a.id < b.id
RETURN a.file, a.line, b.file, b.line
```

Identifier names, literal values and operators of the core categories are part of the hash. `x => x + 1` and `y => y + 1` hash differently.

Some node types only hash their type and children, not their own scalar fields. These pairs hash the same:

- `a && b` and `a || b`: `LogicalExpression`'s operator isn't hashed.
- Template literals that differ only in their literal text.
- `a[b]` and `a.b`: `MemberExpression.computed` isn't hashed.

Confirm a hash match with `code()` or the columns when this matters.
