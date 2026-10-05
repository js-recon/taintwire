---
sidebar_position: 5
title: DECLARES
---

# DECLARES

`DECLARES` is the first semantic edge on top of the AST. It links a node to each `Identifier` it introduces as a JavaScript binding. It's the base that `REFERS_TO` and data flow will build on. See the [roadmap](roadmap.md).

## Where edges come from

During the [walk](flattening.md#the-walk), each node is passed to `declared(node)`, and an edge is pushed for every identifier it returns:

```ts
for (const t of declared(node)) push("DECLARES", node, t, { from: id, to: idOf(t) });
```

`idOf(t)` is the same identity-keyed id function `SON` uses, so the target is the `Identifier` already in the tree. It's never a copy. A test checks this: a `VariableDeclarator`'s `DECLARES` target and its `SON {key: 'id'}` child have the same id.

## `declared(node)`

| Node type | Bindings |
| --- | --- |
| `VariableDeclarator` | `bindingIds(id)` |
| `FunctionDeclaration`, `FunctionExpression` | `bindingIds` of `id` and each param |
| `ArrowFunctionExpression`, `ObjectMethod`, `ClassMethod`, `ClassPrivateMethod` | `bindingIds` of each param |
| `ClassDeclaration`, `ClassExpression` | `bindingIds(id)` |
| `ImportSpecifier`, `ImportDefaultSpecifier`, `ImportNamespaceSpecifier` | `local` |
| `CatchClause` | `bindingIds(param)` |
| anything else | none |

## `bindingIds(pattern)`

This recursively collects the identifiers a binding pattern binds:

| Pattern | Recurses into |
| --- | --- |
| `Identifier` | itself, unless it's `this` (a TypeScript `this` parameter isn't a binding) |
| `ObjectPattern` | each property's `value`, or a `RestElement`'s `argument`. **Never** the key. |
| `ArrayPattern` | each element (holes are `null` and yield nothing) |
| `AssignmentPattern` | `left` only. The default value is an expression, not a binding. |
| `RestElement` | `argument` |
| `TSParameterProperty` | `parameter` (`constructor(private x)`) |

## Choices and their reasons

- **The declarator, not the declaration.** `const a = 1, b = 2` has one `VariableDeclaration` and two `VariableDeclarator`s. The declarator owns both the name and its initializer (`init`), so it's the node data flow will start from.
- **Method keys aren't bindings.** `{ method(a) {} }` binds `a` but not `method`. The key is a property name. A test checks that no `SON {key: 'key'}` target is ever a `DECLARES` target.
- **Wrappers declare nothing.** `ExportNamedDeclaration`, `ExportDefaultDeclaration` and `VariableDeclaration` only wrap the real declarer. `export { x }` and re-exports (`export { y } from`, `export *`) refer to bindings rather than creating them.
- **Assignments aren't declarations.** `({ a } = o)` writes to an existing binding. That will be a reference edge, not `DECLARES`.
- **Scope is a separate edge.** A `FunctionDeclaration` declares its own name and its params, even though the name binds in the enclosing scope and the params bind inside the function. `DECLARES` only answers "who introduces this name". `IN_SCOPE` answers "where does it live", and it's emitted from the same `declared()` call. See [Scopes](scopes.md).

## Coverage

`src/declares.test.ts` holds 36 cases, each a snippet with its expected sorted `Declarer -> name` edges. They cover every declaration form, from `using` and `await using` through destructuring with computed keys and defaults, generators, class private methods, every import form and catch params. There are also negatives: export wrappers, re-exports, control flow and assignment patterns. Further tests check that only the producers in the table above ever emit `DECLARES`, that targets are always `Identifier`s that keep their hashes, and that the edges survive `save()` and reopening.
