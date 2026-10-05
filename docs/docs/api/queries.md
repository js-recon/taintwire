---
sidebar_position: 4
title: Query cookbook
---

# Query cookbook

Working queries against the [graph model](graph-model.md), and the gotchas specific to it. Every query runs through `graph.query(cypher, params)`. LadybugDB's [Cypher manual](https://docs.ladybugdb.com/cypher/) covers the language itself.

## Recipes

### Calls to a named function

```cypher
MATCH (c:CallExpression)-[:SON {key: 'callee'}]->(:Identifier {name: $fn})
RETURN c.id AS id, c.file AS file, c.line AS line, c.col AS col
```

With `{ fn: "eval" }`, this finds `eval(...)`. It doesn't find `window.eval(...)`, where the callee is a `MemberExpression`.

### Method calls (`x.method(...)`)

```cypher
MATCH (c:CallExpression)-[:SON {key: 'callee'}]->(m:MemberExpression)
      -[:SON {key: 'property'}]->(:Identifier {name: $method})
RETURN c.id AS id, c.line AS line
```

### Reads of `location.hash`

```cypher
MATCH (m:MemberExpression)-[:SON {key: 'object'}]->(:Identifier {name: 'location'}),
      (m)-[:SON {key: 'property'}]->(:Identifier {name: 'hash'})
RETURN m.id AS id, m.line AS line
```

### Assignments to `.innerHTML`

```cypher
MATCH (a:AssignmentExpression)-[:SON {key: 'left'}]->(:MemberExpression)
      -[:SON {key: 'property'}]->(:Identifier {name: 'innerHTML'})
RETURN a.id AS id
```

Pass the `id` to `graph.code()` to get the statement's text.

### Where a name is declared

```cypher
MATCH (d)-[:DECLARES]->(i:Identifier {name: $name})
RETURN d.type AS declaredBy, i.file AS file, i.line AS line
```

This finds every binding with that name, in any scope. It's a name match, not resolution of one particular reference.

### The function enclosing a node

```cypher
MATCH (f)-[:SON*1..30]->(n:CallExpression {id: $id})
WHERE f.type IN ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression',
                 'ObjectMethod', 'ClassMethod', 'ClassPrivateMethod']
RETURN f.id AS id, f.type AS type, f.line AS line
```

This returns every enclosing function, outermost included. Order by `f.startOffset DESC` and take the first row for the innermost one.

### Calls inside a function

```cypher
MATCH (f:FunctionDeclaration)-[:SON*1..30]->(c:CallExpression)
RETURN f.id AS fn, count(c) AS calls
```

### Repeated code

```cypher
MATCH (a:FunctionExpression), (b:FunctionExpression)
WHERE a.hash = b.hash AND a.id < b.id
RETURN a.file, a.line, b.file, b.line
```

This needs the `cs-mast` parser, and has [known collisions](graph-model.md#hash).

### Node counts by type

```cypher
MATCH (n) WHERE n.type IS NOT NULL
RETURN n.type AS type, count(*) AS n ORDER BY n DESC
```

## Gotchas

### Labels only exist once seen

A node table is created when its type first appears. On a graph without numeric literals, `MATCH (n:NumericLiteral)` fails with `Binder exception: Table NumericLiteral does not exist.` To query a type that may be absent, match unlabelled on the `type` column, which is slower:

```cypher
MATCH (n) WHERE n.type = 'NumericLiteral' RETURN n.id
```

### Variable-length paths stop at depth 30

LadybugDB caps variable-length paths at 30 hops. An unbounded `-[:SON*]->` stops there without an error, and an explicit bound above 30 is rejected. Minified bundles easily nest deeper than 30. Raise the cap per connection:

```cypher
CALL var_length_extend_max_depth=200
```

```js
await graph.query("CALL var_length_extend_max_depth=200");
await graph.query("MATCH (f:FunctionDeclaration)-[:SON*1..200]->(c:CallExpression) RETURN count(c)");
```

### `MATCH (n)` includes `Source`

Unlabelled matches also hit the `Source` table, which holds the stored file text. Add `WHERE n.type IS NOT NULL` to match AST nodes only.

### `value` is always a string

Literal values are stored as strings: `{value: '1'}`, not `{value: 1}`. `NumericLiteral` values are the number as JavaScript prints it, so `0x10` is stored as `'16'`.

### `end` is a keyword

Babel's `start`/`end` are stored as `startOffset`/`endOffset`, since `end` is reserved in Cypher.

### Ids aren't stable

Ids are random. Importing the same code twice gives different ids. Use `hash`, or `file` with `startOffset`, to identify the same node across imports.

### Use parameters

Pass values as `$params` rather than building query strings from input. Names from minified or hostile JavaScript can contain quotes.
