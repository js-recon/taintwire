---
sidebar_position: 7
title: References, reads and writes
---

# References, reads and writes

[Scopes](scopes.md) record where each binding lives. This pass resolves each use of a name to its declaration and records how the binding is used there. It adds three edges:

| Edge | From | To | Meaning |
| --- | --- | --- | --- |
| `REFERS_TO` | `Identifier` (a use) | `Identifier` (a declaration) | "This occurrence of the name resolves to this binding." |
| `READS {access, access_signature}` | the operation | `Identifier` (a declaration) | "This operation consumes the binding's current value." |
| `WRITES {access, access_signature}` | the operation | `Identifier` (a declaration) | "This operation defines, initializes or updates the binding." |

```text
const x = 1;
console.log(x);

VariableDeclarator(x = 1)    ──DECLARES──> Identifier x  (declaration)
VariableDeclarator(x = 1)    ──WRITES────> Identifier x  (declaration)
Identifier x  (use)          ──REFERS_TO─> Identifier x  (declaration)
CallExpression(console.log(x)) ──READS───> Identifier x  (declaration)
```

The three are separate on purpose. `REFERS_TO` is name resolution only, and says nothing about whether the use reads or writes. `READS` and `WRITES` say what the operation does to the binding, and always point at the declaration rather than the use. Value movement is a fourth, separate edge: [`FLOWS_TO`](value-flow.md).

## What counts as a reference

An `Identifier` is a reference when it's a lexical name lookup. Every `Identifier` child the walk pushes is a candidate, unless `isRef(parent, key)` says otherwise:

| Not a reference | Example | Rule |
| --- | --- | --- |
| Declaration targets | `const x`, `function foo`, `catch (e)`, params | Any `DECLARES` target. These never get a `REFERS_TO`, so there are no self-edges. |
| Static property names | `obj.foo`, `obj?.foo` | `property` when the member isn't `computed` |
| Static keys | `{ foo: v }`, `class { method() {} }`, `{ foo }` (the key half) | `key` when the parent isn't `computed`. A shorthand `{ x }` has a separate cloned `value` Identifier, which is a reference. |
| Private names | `this.#p` | Anything under a `PrivateName` |
| Labels | `outer:`, `break outer` | `label` |
| Import and export names | `original` in `import { original as local }`, `y` in `export { x as y }` | `imported` and `exported` |
| Meta properties | `new.target`, `import.meta` | `meta`, and `property` (not computed) |
| Re-exports | `z` in `export { z } from "./m.js"` | The specifier's `local` names the other module's binding, not a local one |
| TypeScript types | `T` in `let v: T` | Anything under a `TS*` node, except the `expression` of `as`, `satisfies`, `!`, `<T>x`, instantiation expressions and `export =` |

Computed forms are references: `key` in `obj[key]`, `{ [key]: v }` and `class { [key]() {} }`.

The candidate's scope is the scope context of the `Identifier` itself. That context already handles [outer keys](scopes.md#building-the-tree), so a computed method key resolves in the class's scope, not the method's.

## Resolution

```text
inner function scope ──PARENT_SCOPE──> outer function scope ──PARENT_SCOPE──> program scope
      (no `value`)                           (no `value`)                     `value` ✓
```

Resolution runs in `flatten()`, but after the walk rather than during it. A use can come before its declaration in the source (hoisting, the TDZ), and the walk visits later siblings first, so a binding might not have been seen yet when its use is. The walk records:

- `parentScope`: each scope's parent, the same edges as `PARENT_SCOPE`.
- `bindings`: scope, then name, then the declaration `Identifier`, filled in alongside `IN_SCOPE`.
- `uses`: each candidate `Identifier`, with the operation it's an operand of (its AST parent) and its scope.

Then, for each use, it looks the name up in the use's scope, then in each `parentScope` in turn, and stops at the first hit. A miss at the root leaves the use unresolved: it gets no `REFERS_TO`, `READS` or `FLOWS_TO` from a declaration.

Nothing is invented for unresolved names. `console`, `location`, `window`, `undefined` and `arguments` have no declaration in the analyzed source, so they stay unresolved. Modelling host and global objects is later work.

Resolution is per file. Scopes never cross files, so two script files that share a global `var` don't resolve to each other.

Shadowing works without special handling: the innermost scope that binds the name wins. Named function and class expressions bind their name inside their own scope, so `internal` inside `function internal() { return internal; }` resolves to the expression's own name.

### One summary declaration per binding

```js
var x = 1;
var x = 2;
```

Both `x`s are `DECLARES` targets with their own `IN_SCOPE`, but they are one binding. The same goes for a parameter redeclared with `var`. `bindings` keeps the declaration with the lowest `startOffset` for each scope and name, and every `REFERS_TO`, `READS`, `WRITES` and `FLOWS_TO` for the binding targets that one node. The second declarator still `WRITES` the binding, through the first `x`, with `access` naming the second `x`.

## READS and WRITES

### The operation

The source of `READS` is the use's direct AST parent: the expression or statement that takes the identifier as an operand.

| Code | Reads `x` |
| --- | --- |
| `x + 1` | `BinaryExpression` |
| `const y = x` | `VariableDeclarator` |
| `foo(x)` | `CallExpression`, for both `foo` and `x` |
| `obj.foo`, `obj[key]` | `MemberExpression`, for `obj` (and `key`) |
| `return x` | `ReturnStatement` |
| `if (x)`, `while (x)`, `c ? a : b` | the statement or `ConditionalExpression` |
| `x;` | `ExpressionStatement` |

So in `x = x + 1` the read comes from the `BinaryExpression`, not from the `AssignmentExpression`. The read happens inside `x + 1`.

The source of `WRITES` is the operation that does the write:

| Code | Writes | Also reads the target? |
| --- | --- | --- |
| `let x = v` | `VariableDeclarator`, for every name bound in `id` | no |
| `let x;` | nothing: no initializer, only `DECLARES` | |
| `x = v` | `AssignmentExpression` | no |
| `x += v`, `-=`, `**=`, `<<=`, ... `&&=`, `\|\|=`, `??=` | `AssignmentExpression` | yes, from the same `AssignmentExpression` |
| `x++`, `--x` | `UpdateExpression` | yes |
| `[a, b] = v`, `({ foo: a, ...r } = v)` | `AssignmentExpression`, for each target name | no |
| `for (x of xs)`, `for (x in o)` | the loop | no |
| `for (const x of xs)` | the loop (the iteration assigns `x`; the declarator has no `init`) | no |
| `function f(p = d)`, `const { a = d } = o` | `AssignmentPattern` (the default). The declarator also writes `a`. | no |

Assignment targets are walked with `bindingIds()`, the same pattern walk `DECLARES` uses. It yields the target names of a pattern and skips its keys, so `({ foo: x } = obj)` writes `x`, and `foo` isn't a reference at all.

### Property access isn't a binding access

`obj.foo = x` **reads** `obj` (from the `MemberExpression`) and `x` (from the `AssignmentExpression`), and writes no binding. The assignment changes a property of the object, not the variable `obj`. `bindingIds()` returns nothing for a `MemberExpression`, so no `WRITES` is created. Property reads and writes (`READS_PROPERTY`, `WRITES_PROPERTY`) are a later pass.

### Export specifiers

`export { x }` resolves `x` (`REFERS_TO`) but doesn't read it. An export makes the binding visible to other modules, and the read happens later in the importer. `export default x` does evaluate `x`, so the `ExportDefaultDeclaration` reads it.

### `access` and `access_signature`

`READS` and `WRITES` point at the declaration, so each edge also records which occurrence did the access:

| Property | Contents |
| --- | --- |
| `access` | The `id` of the accessing `Identifier`: the use for a read or an assignment, or the declaration `Identifier` for an initializer. |
| `access_signature` | That `Identifier`'s `hash`, its cs-mast signature digest. `null` with the `babel` parser. |

`access_signature` follows the provenance convention: it's the cs-mast hash and never changes. But a hash describes content, and every `x` `Identifier` hashes the same. `access` is the field that identifies the exact occurrence. It's also what keeps `x + x` from producing two indistinguishable `READS` edges.

```cypher
// Every read of a binding, with the exact occurrence
MATCH (op)-[r:READS]->(d:Identifier), (u:Identifier)
WHERE d.id = $decl AND u.id = r.access
RETURN op.type, u.line, u.col
```

## What isn't modelled

| Not modelled | Example | Why |
| --- | --- | --- |
| Cross-file globals | `a.js: var g` / `b.js: g` | Scopes are per file. |
| Host and global objects | `console`, `window`, `location` | Unresolved by design. No fake declarations. |
| `with` and sloppy direct `eval` | `with (o) { x }` | They change scopes at runtime. `x` resolves statically, which may be wrong. |
| JSX element names | `<Foo />` | `JSXIdentifier` isn't `Identifier`, so the component isn't resolved yet. `{expr}` containers are resolved. |
| TS enum initializers | `enum E { A = x }` | Anything under a `TS*` node is treated as type-level. |
| Function and class declarations as writes | `function f() {}` | Only `DECLARES`. Binding a function value belongs with the call graph. |
| Parameter initialization by calls | `f(1)` writing `p` | Interprocedural: `ARGUMENT_TO`. |
| Order | a read before a write | Every read and write is to the same summary binding. See [Value flow](value-flow.md#flow-insensitive-bindings). |

## Coverage

`src/flow.test.ts` covers all of this and [value flow](value-flow.md) in one suite. For references, reads and writes it has:

- Simple reads.
- Shadowing and parent-scope resolution, checked by declaration offset.
- Plain, compound and logical assignment. The compound case checks `access` and `access_signature` against the left-hand `Identifier`.
- Update expressions, calls, static and computed members, and property writes.
- Array and object destructuring assignment, for-of, and unresolved globals.
- Named function and class expressions, and a three-level scope walk.
- What isn't a reference: labels, keys, private names, `new.target`, a re-export, imported names and TS type names.
- Computed keys, shorthand properties, exports, `var` redeclaration and hoisted/TDZ uses.

Test 21 runs over the three fixtures and checks:

- no duplicate edges, counting `access`
- no self-edges
- every `REFERS_TO` target is a `DECLARES` target with the same name and file
- no declaration target refers anywhere
- every `access` is a resolved use or a declaration, whose `hash` equals `access_signature`
- a re-import gives the same edges, and so does the `babel` parser
