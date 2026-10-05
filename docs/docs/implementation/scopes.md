---
sidebar_position: 6
title: Scopes
---

# Scopes

Scope construction adds `Scope` nodes to the graph, which record where each JavaScript binding lives. [`DECLARES`](declares.md) records which syntax introduced a binding. Scopes add the other half: which lexical environment holds it. Together they're what `REFERS_TO` will resolve names against. See the [roadmap](roadmap.md).

```text
function foo(a) { const x = 1; }

Program ──CREATES_SCOPE──> Scope {kind: global} <──IN_SCOPE── Identifier foo
                                ^
                          PARENT_SCOPE
                                │
FunctionDeclaration ──CREATES_SCOPE──> Scope {kind: function} <──IN_SCOPE── Identifier a
                                                              <──IN_SCOPE── Identifier x
```

The semantics follow ECMAScript as described on MDN: [Scope](https://developer.mozilla.org/en-US/docs/Glossary/Scope), [`var`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/var), [`let`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/let), [`const`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/const), [`function`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/function), [`class`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/class), [class expressions](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/class), [`try...catch`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/try...catch), [`for`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/for), [`switch`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/switch) and [static initialization blocks](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Classes/Static_initialization_blocks).

## What it covers

Scope construction answers four questions:

- What scopes exist?
- Which AST node created each one?
- What is each scope's parent?
- Which scope owns each declared binding?

It doesn't answer "which declaration does this identifier refer to". That's the job of `REFERS_TO`, a separate later pass. The `x` in `console.log(x)` has no scope edge.

## Which nodes create scopes

`scopeKind(node, parent)` decides this for each node. The `parent` argument is only needed to tell a function or catch body apart from a nested block.

| Owner | `kind` | Notes |
| --- | --- | --- |
| `Program` | `module` if `sourceType === "module"`, otherwise `global` | The root. Exactly one per file, with no parent. |
| `FunctionDeclaration`, `FunctionExpression`, `ArrowFunctionExpression`, `ObjectMethod`, `ClassMethod`, `ClassPrivateMethod` | `function` | Babel's `isFunction` alias, which is the same set `declared()` handles. |
| `ClassDeclaration`, `ClassExpression` | `class` | Every class, named or not. Private names and a class expression's own name live here. |
| `StaticBlock` | `static_block` | |
| `CatchClause` | `catch` | |
| `BlockStatement` | `block` | Not when it's a function's body or a catch body. Those belong to the function or catch scope. |
| `ForStatement` | `block` | Only when `init` is a lexical declaration (`let`, `const`, `using` or `await using`). |
| `ForInStatement`, `ForOfStatement` | `block` | Only when `left` is a lexical declaration. |
| `SwitchStatement` | `block` | One scope shared by every case. `SwitchCase` creates nothing. |

Each owner creates at most one scope, and every scope has exactly one owner.

## Where a binding goes

Every `DECLARES` edge gets exactly one `IN_SCOPE` edge for its target. Both edges come from the same `declared(node)` call in `flatten()`, so the two can't disagree. Scope construction doesn't decide for itself what counts as a declaration.

The walk keeps two scopes for each position in the tree:

- `scope`: the innermost scope, which is where lexical bindings go.
- `varScope`: the innermost `function`, `static_block`, `module` or `global` scope, which is where `var` bindings go.

`block`, `catch`, `class` and `switch` scopes change `scope` but leave `varScope` alone. That's why `var` escapes blocks and catch clauses but stops at a function or a static block.

The declarer decides which scope its bindings go in:

| Declarer | Binding | Scope |
| --- | --- | --- |
| `VariableDeclarator` under `var` | every bound name | `varScope` |
| `VariableDeclarator` under `let`, `const`, `using`, `await using` | every bound name | `scope` |
| `FunctionDeclaration` | its name | the scope **around** it |
| `FunctionDeclaration` | its params | its own function scope |
| `FunctionExpression` | its name and its params | its own function scope |
| `ArrowFunctionExpression`, `ObjectMethod`, `ClassMethod`, `ClassPrivateMethod` | its params | its own function scope |
| `ClassDeclaration` | its name | the scope **around** it |
| `ClassExpression` | its name | its own class scope |
| `CatchClause` | its param's bound names | its own catch scope |
| Import specifiers | the local name | the module scope |

In code, that's this rule: a `VariableDeclarator` picks by its parent's `kind`. Any other declarer that creates a scope puts its bindings inside that scope, except the own name of a `*Declaration`, which goes outside.

```js
const outer = function internal(x) { return internal(x); };
// outer    -> the scope around the VariableDeclarator
// internal -> the FunctionExpression's function scope
// x        -> the FunctionExpression's function scope

function foo() {
    if (c) { var x; let y; }
}
// x -> foo's function scope (var skips the block)
// y -> the if-block's block scope
```

## Building the tree

Scopes are built in the same iterative walk that produces `SON` and `DECLARES`, so there's no second traversal. Each stack entry carries its parent node and the scope context it sits in:

```ts
type Ctx = { scope?: string; varScope?: string };
const stack: [Node, Node | undefined, Ctx][] = [[ast, undefined, {}]];
```

When the walk pops a node:

1. If `scopeKind(node, parent)` returns a kind, it creates a `Scope` row, a `CREATES_SCOPE` edge from the node, and a `PARENT_SCOPE` edge to the current `scope` (except for the root). The context for the node's children becomes the new scope.
2. Children are pushed with the new context. Children under `key`, `decorators` or `discriminant` are pushed with the **outer** context instead, because they're evaluated outside the scope their parent creates. That covers computed method keys, decorators and the `switch` discriminant. A computed class method key ends up in the class scope, not the method's function scope.
3. Each `declared()` target gets `DECLARES` and `IN_SCOPE`, using the rule above.

The context replaces the push and pop of a classic scope stack. A node's children see the scope it created, and siblings never see it, because each stack entry holds its own context.

## Identity and provenance

Scopes aren't AST nodes, so they live in their own `Scope` table with their own columns:

| Column | Contents |
| --- | --- |
| `id` | `Scope_` + the first 16 hex chars of `sha256(file \0 ownerType \0 ownerStart \0 ownerEnd)`. Primary key. |
| `kind` | One of the kinds above, lowercase. |
| `file` | The owner's file. |
| `signature` | `sha256("scope:<kind>:<owner_signature>")`, 64 hex chars. |
| `owner_signature` | The owner's `hash`, the digest of its CS-MAST-S signature. |

Both hashes use cs-mast's own `sha256` export, so they follow the same convention as every node's `hash`.

There are two identifiers because they do different jobs:

- **`signature` is provenance.** It's derived only from the owner's cs-mast hash and the kind. Like `hash`, it's the same wherever the same code appears, so two identical functions in two bundles have scopes with the same signature. That makes it useful for matching across builds. It can't be a key, though, because identical code in two places would collide.
- **`id` is identity.** It adds the file and the owner's position, so it's unique within a graph. It's still deterministic: re-importing the same source under the same filename gives the same scope ids. No owner type creates two scopes, and no two owners of the same type share a span, so the inputs can't repeat within a file.

With the `babel` parser, nodes have no hash, so `signature` and `owner_signature` are `null`. `id` and the scope tree are the same as with `cs-mast`.

AST node ids are random, but scope ids aren't. Scope ids carry no state between imports, so there's nothing a random id would protect against, and a deterministic id lets a test check that two imports produce identical scopes.

## What isn't modelled

These are deliberate. Each needs either a later pass or control flow, which this pass doesn't have.

| Not modelled | Example | Why |
| --- | --- | --- |
| References (`REFERS_TO`) | `console.log(x)` | The next pass. Uses of a name get no edge here. |
| Hoisting | `foo(); function foo() {}` | Nothing moves. `foo` is simply `IN_SCOPE` of the program scope, and the declaration stays where it is. |
| Temporal dead zone | `console.log(x); let x = 1;` | Initialization state is control flow, not scope. |
| Per-iteration loop environments | `for (let i...) fns.push(() => i)` | The loop gets one scope. Static name resolution doesn't need one per iteration. |
| A separate parameter scope | `function f(a = () => b) { var b; }` | ECMAScript adds a separate environment for the body when params have default expressions. Params and body share one function scope here. |
| Annex B function-in-block hoisting | `{ function g() {} }` in sloppy mode | `g` is lexical to the block, as in strict mode. Sloppy mode also creates a `var` binding for it in the function, which isn't modelled. |
| A separate catch body scope | `catch (e) { let e2; }` | `e2` goes in the catch scope with `e`. The spec has two environments, but nothing a static resolver needs tells them apart. |
| TypeScript-only scopes | `namespace N { var x; }` | `TSModuleBlock` creates no scope, and TS-only declarations (`enum`, `declare`) have no `DECLARES` edges yet. |
| `with` and sloppy direct `eval` | `with (o) { x }` | They extend scopes at runtime. A static model can't capture that. |

## Coverage

`src/scopes.test.ts` holds a case table where each snippet maps every bound name to its scope chain, written innermost first, for example `function:ClassMethod < class:ClassDeclaration < global:Program`. It covers program, function, nested function, `var` and lexical, nested block, function expression, arrow, class, named class expression, catch, destructured catch, `for`, `for` with `var`, `switch` and static block cases. Further cases cover `for...of`/`for...in`, `var` escaping a catch, a block inside a static block, function declarations in blocks, object and private methods, anonymous classes, hoisting, TDZ, `using`, `await using` and export wrappers.

Further tests check that:

- A class creates a class scope even when nothing binds in it, and that the `Internal` in `return Internal` gets no `IN_SCOPE`.
- A `var` loop creates no scope, a `switch` creates exactly one, and a function body creates none.
- Computed method keys sit outside the method's scope.
- Provenance holds: `owner_signature` equals the owner's `hash`, `signature` equals `sha256("scope:<kind>:<owner_signature>")`, ids are reproducible across imports, and the same code under another filename gets new ids but the same signatures.
- The graph is idempotent and well formed over all three fixtures: one scope per owner, one owner per scope, at most one parent, one root per file (always `Program`), no parent in another file, one `IN_SCOPE` per `DECLARES`, and no duplicate edges.
- The `babel` parser builds the same scope tree, with `null` signatures.
- Scopes survive `save()` and reopening, and a reopened graph keeps adding scopes.
