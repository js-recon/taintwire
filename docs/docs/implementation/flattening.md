---
sidebar_position: 4
title: Flattening
---

# Flattening

`flatten(ast, file)` turns a Babel tree into rows: one per node, grouped by node type, one per scope, and one per edge, grouped by the pair of endpoint types. It doesn't touch the database.

## The walk

```ts
const stack: [Node, Node | undefined, Ctx][] = [[ast, undefined, {}]];
while (stack.length) {
    const [node, parent, outer] = stack.pop()!;
    // ...
}
```

Each entry carries the node's parent and its scope context (`{ scope, varScope }`). [Scopes](scopes.md#building-the-tree) explains how that context replaces a push/pop scope stack.

The walk uses an explicit stack, not recursion, because minified bundles nest deeply enough to overflow the JS call stack. Children are found through Babel's `VISITOR_KEYS[node.type]`, the same table Babel's own traversal uses. Node types missing from `VISITOR_KEYS` are treated as leaves.

The visit order is depth-first and reversed, since it's a stack. That doesn't matter for the AST, because order is kept explicitly in `SON.idx`. It does matter for name resolution, which is why that runs after the walk (see [below](#after-the-walk)).

## Ids

```ts
const ids = new Map<Node, string>();
const idOf = (n: Node) => {
    let id = ids.get(n);
    if (!id) ids.set(n, (id = `${n.type}_${randomBytes(8).toString("hex")}`));
    return id;
};
```

- **Format** `<Type>_<16 hex>`, as in the design notes. The type prefix makes ids readable, and it lets `code()` find the table to look in without scanning every table. Babel type names contain no `_`, so `id.slice(0, id.lastIndexOf("_"))` recovers the type.
- **Random rather than sequential.** A graph collects files over many `add()` calls, across processes and reopens. Random ids can't collide between them, and there's no counter to keep in the database. With 64 random bits, a collision is negligible at AST scale.
- **Assigned by object identity.** The `Map` is keyed on the Babel node object. Any code that reaches the same object, whether a `SON` edge, a `slug_ref` or a `DECLARES` edge, gets the same id. That's why `DECLARES` points at the existing `Identifier` node rather than a copy.

## Splitting a node's fields

Each field `k` of a node goes to exactly one place:

| Field | Goes to |
| --- | --- |
| In `SKIP_PROPS`: `type`, `start`, `end`, `loc`, `range`, comments, `tokens`, `errors`, the cs-mast signature key | Dropped. Positions and the hash are columns, the rest is noise for the graph. |
| In `VISITOR_KEYS[node.type]` (a child field) | A `SON {key: k, idx}` edge to each child node, and `props[k]` = `{type, slug_ref}` (or an array of them). |
| Anything else | `props[k]` as is. |

Child fields keep a reference in `props` as well as the edge, so a single row says where its children are without a join. This is the "substitute plus child" idea from the design notes.

Values in child fields that aren't nodes, such as `null` holes in `ArrayExpression.elements` or an absent optional child, are copied into `props` unchanged and get no edge. `idx` is the array index for array fields, and `-1` otherwise.

## Columns

Besides `id`, `type` and `file`:

- **Positions**: `startOffset`/`endOffset` from `node.start`/`node.end`, and `line`/`col`/`endLine`/`endCol` from `node.loc`. Each is `-1` if Babel didn't set it.
- **`name`**: `node.name` if it's a string. Some types have a non-string `name`, such as `JSXAttribute.name` (a node), and those are skipped.
- **`value`**: `scalar(node.value)`. Strings, numbers, booleans and bigints are passed through `String()`. An object with `raw` (`TemplateElement.value = { raw, cooked }`) gives `cooked ?? raw`. Anything else gives `null`.
- **`operator`**: `node.operator` if it's a string.
- **`props`**: `JSON.stringify(props)` with a replacer that turns `bigint`s into strings, since `JSON.stringify` throws on them. Babel 8 stores a real `bigint` in `BigIntLiteral.extra.rawValue`.
- **`hash`**: the digest after the last `$` of the cs-mast signature. See [Parsing and hashing](parsing-and-hashing.md#storing-the-hash).

`name`, `value` and `operator` are copied out of `props` into columns because they're what queries filter on most, and matching on a column is far cheaper than `props CONTAINS ...`.

## Grouping

```ts
nodes: Map<string, Row[]>;                // node type -> rows
scopes: ScopeRow[];                       // all go in the one Scope table
rels: Record<Rel, Map<string, Edge[]>>;   // "FromType\0ToType" -> edges, per edge table in RELS
```

The grouping follows how [storage](storage.md) works. Each node type is its own table, and LadybugDB's `COPY` into an edge table with several FROM/TO pairs has to name one `(from, to)` pair per statement. Grouping up front gives `load()` one `COPY` per group. `\0` separates the pair because it can't appear in a type name.

## After the walk

`REFERS_TO`, `READS`, `WRITES` and `FLOWS_TO` can't be emitted during the walk. A use can be visited before the declaration it resolves to, because of hoisting, uses inside functions declared earlier, and the reversed visit order. So during the walk `flatten()` only records facts as AST nodes:

- each scope's parent and each scope's bindings by name, alongside `PARENT_SCOPE` and `IN_SCOPE`
- each candidate reference `Identifier`, with its parent and scope (`isRef()`)
- each node's flows and writes (`facts()`)

Once the walk ends, a post-pass resolves each reference up the scope chain and turns the recorded facts into edges. It's still one walk over the tree, plus one pass over the recorded lists. See [References](references.md#resolution) and [Value flow](value-flow.md#rules).
