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

### The scope a binding lives in

```cypher
MATCH (d)-[:DECLARES]->(i:Identifier {name: $name})-[:IN_SCOPE]->(s:Scope)<-[:CREATES_SCOPE]-(o)
RETURN i.line AS line, d.type AS declaredBy, s.kind AS scope, o.type AS owner, o.line AS ownerLine
```

### Every binding in a function

```cypher
MATCH (f:FunctionDeclaration)-[:SON {key: 'id'}]->(:Identifier {name: $fn}),
      (f)-[:CREATES_SCOPE]->(s:Scope)<-[:IN_SCOPE]-(i:Identifier)
RETURN i.name AS name, i.line AS line
```

This returns the params and the top-level `var`, `let` and `const` of the function body. Bindings in nested blocks live in child scopes. To include them, walk down `PARENT_SCOPE`:

```cypher
MATCH (f:FunctionDeclaration)-[:SON {key: 'id'}]->(:Identifier {name: $fn}),
      (f)-[:CREATES_SCOPE]->(:Scope)<-[:PARENT_SCOPE*0..30]-(:Scope)<-[:IN_SCOPE]-(i:Identifier)
RETURN i.name AS name, i.line AS line
```

### A scope's chain up to the root

```cypher
MATCH (i:Identifier {id: $id})-[:IN_SCOPE]->(s:Scope),
      p = (s)-[:PARENT_SCOPE*0..30]->(a:Scope), (o)-[:CREATES_SCOPE]->(a)
RETURN a.kind AS kind, o.type AS owner, o.line AS line
ORDER BY length(p)
```

The first row is the binding's own scope, and the last is the file's `global` or `module` scope.

### Bindings in a file's top-level scope

```cypher
MATCH (:Program {file: $file})-[:CREATES_SCOPE]->(s:Scope)<-[:IN_SCOPE]-(i:Identifier)
RETURN i.name AS name, s.kind AS kind
```

### What a name refers to

```cypher
MATCH (u:Identifier)-[:REFERS_TO]->(d:Identifier)<-[:DECLARES]-(by)
WHERE u.id = $id
RETURN d.id AS decl, d.line AS line, by.type AS declaredBy
```

No row means the name is unresolved: a global, a host API such as `location`, or not a reference at all, like the `foo` in `obj.foo`.

### Every read and write of a variable

```cypher
MATCH (op)-[r:READS|WRITES]->(d:Identifier), (u:Identifier)
WHERE d.id = $decl AND u.id = r.access
RETURN label(r) AS access, op.type AS op, u.line AS line, u.col AS col
ORDER BY line, col
```

`$decl` is the declaration `Identifier` (a `DECLARES` target). `r.access` is the exact occurrence, so `u` is the `x` in the code, not the declaration. For `let u = "/api?" + h; u += "&x=1"; fetch(u);` this returns a `WRITES` from the `VariableDeclarator`, a `WRITES` and a `READS` from the compound `AssignmentExpression`, and a `READS` from the `CallExpression`.

### What flows into a variable

```cypher
MATCH (v)-[:FLOWS_TO]->(d:Identifier)
WHERE d.id = $decl
RETURN v.type AS type, v.line AS line
```

These are the values that are ever assigned to the variable: initializers, assignments and updates, in any order.

### From a source to a sink

```cypher
MATCH (m:MemberExpression)-[:SON {key: 'object'}]->(:Identifier {name: 'location'}),
      (m)-[:SON {key: 'property'}]->(:Identifier {name: 'hash'}),
      p = (m)-[:FLOWS_TO* ACYCLIC 1..30]->(arg),
      (c:CallExpression)-[:SON {key: 'arguments'}]->(arg),
      (c)-[:SON {key: 'callee'}]->(:Identifier {name: 'fetch'})
RETURN c.id AS call, c.line AS line, min(length(p)) AS hops
```

This finds `fetch(u)` in:

```js
const h = location.hash;
let u = "/api?" + h;
u += "&x=1";
fetch(u);
```

To see the route, ask for one shortest path and list its nodes:

```cypher
MATCH (m:MemberExpression)-[:SON {key: 'property'}]->(:Identifier {name: 'hash'}),
      p = (m)-[:FLOWS_TO* SHORTEST 1..30]->(arg),
      (:CallExpression)-[:SON {key: 'arguments'}]->(arg)
RETURN properties(nodes(p), 'type') AS path, properties(nodes(p), 'line') AS lines
// path: [MemberExpression, Identifier h (decl), Identifier h, BinaryExpression, Identifier u (decl), Identifier u]
```

`FLOWS_TO` stops at calls and property reads for now. `fetch(location.hash.slice(1))` has no path, because the `.slice(1)` call is opaque. See [Value flow: Deferred](../implementation/value-flow.md#deferred).

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

A node table is created when its type first appears. Edge tables always exist; see [Graph model](graph-model.md#node-tables). On a graph without numeric literals, `MATCH (n:NumericLiteral)` fails with `Binder exception: Table NumericLiteral does not exist.` To query a type that may be absent, match unlabelled on the `type` column, which is slower:

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

### `FLOWS_TO` paths have cycles

A variable's declaration is the summary of every value it holds, so `x = x + 1` makes a cycle, `x (decl) → x → x + 1 → x = x + 1 → x (decl)`. A plain `-[:FLOWS_TO*1..30]->` walks around it and returns the same route many times. Use Ladybug's recursive-path semantics:

| Syntax | Meaning |
| --- | --- |
| `-[:FLOWS_TO* ACYCLIC 1..30]->` | No node repeats. Usually what you want. |
| `-[:FLOWS_TO* TRAIL 1..30]->` | No edge repeats. |
| `-[:FLOWS_TO* SHORTEST 1..30]->` | One shortest path per pair. |

On `let x = source; x = x + 1; sink(x);`, the path count from `source` to an `x` is 9 with plain `*`, 6 with `ACYCLIC` and 5 with `TRAIL`.

### `MATCH (n)` includes `Source` and `Scope`

Unlabelled matches also hit the `Source` table, which holds the stored file text, and the `Scope` table. Add `WHERE n.type IS NOT NULL` to match AST nodes only.

### Inline property maps before `OPTIONAL MATCH`

LadybugDB 0.21.2 returns wrong results when a node is filtered with an inline property map and then extended with an `OPTIONAL MATCH` that finds nothing. The node's own properties come back as `null`:

```cypher
// Wrong: the root scope (no parent) comes back with s.id = null
MATCH (s:Scope {file: 'app.js'}) OPTIONAL MATCH (s)-[:PARENT_SCOPE]->(p) RETURN s.id, p.id
// Right
MATCH (s:Scope) WHERE s.file = 'app.js' OPTIONAL MATCH (s)-[:PARENT_SCOPE]->(p) RETURN s.id, p.id
```

Filter with `WHERE` whenever an `OPTIONAL MATCH` follows.

### `value` is always a string

Literal values are stored as strings: `{value: '1'}`, not `{value: 1}`. `NumericLiteral` values are the number as JavaScript prints it, so `0x10` is stored as `'16'`.

### `end` is a keyword

Babel's `start`/`end` are stored as `startOffset`/`endOffset`, since `end` is reserved in Cypher.

### Ids aren't stable

Ids are random. Importing the same code twice gives different ids. Use `hash`, or `file` with `startOffset`, to identify the same node across imports.

### Use parameters

Pass values as `$params` rather than building query strings from input. Names from minified or hostile JavaScript can contain quotes.
