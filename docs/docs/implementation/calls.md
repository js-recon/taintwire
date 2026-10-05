---
sidebar_position: 9
title: Calls, arguments and returns
---

# Calls, arguments and returns

The call graph links [value flow](value-flow.md) across function boundaries with three edges:

| Edge | From | To | Meaning |
| --- | --- | --- | --- |
| `CALLS {candidates}` | `CallExpression` / `OptionalCallExpression` | `FunctionDeclaration`, `FunctionExpression` or `ArrowFunctionExpression` | "Static analysis resolves this callsite to this function." |
| `ARGUMENT_TO {arg_index, callsite}` | the argument expression | the parameter's declaration `Identifier` | "This argument, at this callsite, is the value of this parameter." |
| `RETURNS_TO` | `ReturnStatement`, or a concise arrow body | the `CallExpression` | "This returned value is the value of this call." |

```text
function identity(x) { return x; }
const y = identity(source);

source ──ARGUMENT_TO──> x (param) ──FLOWS_TO──> x (use) ──FLOWS_TO──> return x;
                                                                         │ RETURNS_TO
y (decl) <──FLOWS_TO── identity(source) <────────────────────────────────┘
          CallExpression ──CALLS──> FunctionDeclaration identity
```

A taint path is then any path over `FLOWS_TO|ARGUMENT_TO|RETURNS_TO`. `CALLS` itself isn't a value edge: it says which function runs, not which value moves.

## CALLS: what resolves

A callsite resolves when its callee's value is one or more known functions. The callee is evaluated with the same flow-insensitive view as `FLOWS_TO`:

| Callee | Resolves to |
| --- | --- |
| `foo()` with `function foo() {}` | the declaration, wherever it is in the scope (hoisting) |
| `foo()` with `const foo = function () {}` or `= () => {}` | the expression |
| `(function () {})()`, `(() => {})()`, `!function () {}()` | the expression itself (IIFE) |
| `bar()` with `const bar = foo` | whatever `foo` resolves to, through any chain of aliases |
| `(0, foo)()` | `foo`: a sequence's value is its last expression |
| `(c ? foo : bar)()`, `(foo \|\| bar)()` | both |
| `g()` inside `function g() {}` used as an expression | the function expression (its own name) |
| `foo?.()` | as `foo()` |

The name is never matched as text. A callee `Identifier` goes through [`REFERS_TO`](references.md) to its binding, so shadowing, scopes and hoisting are all the same as for any other reference.

### A binding's definitions

To know what a binding holds, every way it can get a value is collected:

| Definition | Value |
| --- | --- |
| `function f() {}` | that function |
| a named function expression's own name | that function |
| `let f = v`, `f = v` | `v`, evaluated as a callee (recursively) |
| a param, catch param or import specifier | **unknown**: the value comes from a caller, a `throw` or another module |
| a class name | **unknown**: calling a class throws |
| a default value `(f = d)`, destructuring `({ f } = o)`, `for (f of xs)`, `f += x`, `f++` | **unknown** |

If any definition is unknown, the call is **unresolved**. It gets no `CALLS` at all, rather than a partial set. This is deliberate. A call to `f` in

```js
function run(cb) { if (c) cb = noop; cb(); }
```

might call `noop`, but also whatever the caller passed. Claiming `CALLS -> noop` would look like a complete answer when it isn't one.

If every definition is known, the call gets one `CALLS` edge per function, and each edge carries `candidates`, the number of functions it may call:

```js
let f = foo;
f = bar;
f(x);       // CALLS -> foo {candidates: 2}, CALLS -> bar {candidates: 2}
```

This matches `FLOWS_TO`: order isn't tracked, so both definitions count. At runtime only `bar` is called here. Filter on `candidates = 1` for calls with a single possible target.

A binding with no definitions (`let f; f();`), or one only defined through itself (`let p = q, q = p;`), is unresolved.

### What stays unresolved

| Pattern | Example | Why |
| --- | --- | --- |
| Globals and host APIs | `eval(x)`, `fetch(u)`, `setTimeout(cb)` | No declaration. No placeholder is created. Find them structurally (callee `Identifier` by name). |
| Member calls | `obj.m()`, `obj[k]()`, `a.b.c()` | Needs property semantics. |
| `.call`, `.apply`, `.bind` | `f.call(t, x)` | Member calls, and they shift arguments. |
| Parameters (higher-order calls) | `function apply(fn) { fn(); }` | `fn` is whatever each caller passes. The callback still flows into `fn` through `ARGUMENT_TO`. |
| Imports | `import { f } from "./x"; f()` | Cross-module: no `IMPORTS`/`EXPORTS` yet. |
| Call results | `make()()` | The returned function isn't tracked as a callee value. |
| Object methods and class methods | `({ m() {} }).m()` | Member calls. |
| `new` | `new F(x)` | Constructor semantics (a new `this`, the returned object) aren't modelled. `NewExpression` gets no `CALLS`. |
| Tagged templates | ``tag`...` `` | The arguments are a strings array plus the substitutions. Not mapped. |
| Other files | `a.js` calls a function in `b.js` | Resolution is per file. |
| Bundler runtimes | webpack's `__webpack_require__(id)` module functions, `e[t].call(...)` | The loader function itself resolves when it's a local function, but module factories are reached through object lookups. That's "unresolved due to bundle/runtime indirection". |

## ARGUMENT_TO

For each `CALLS` edge, arguments are matched to the callee's formal parameters by position:

| Case | Example | Edges |
| --- | --- | --- |
| Plain params | `function f(a, b)`, `f(x, y)` | `x -> a {arg_index: 0}`, `y -> b {arg_index: 1}` |
| Defaults | `function f(x = d)`, `f(v)` | `v -> x`. The default `d` flows into `x` through `FLOWS_TO`, never `ARGUMENT_TO`. |
| Rest | `function f(a, ...rest)`, `f(x, y, z)` | `x -> a`, `y -> rest {arg_index: 1}`, `z -> rest {arg_index: 2}` |
| Missing | `function f(a, b)`, `f(x)` | `x -> a` only. Nothing invented for `b`. |
| Extra | `function f(a)`, `f(x, y)` | `x -> a` only |
| Spread | `f(...xs, y)`, `f(x, ...ys)` | Nothing at or after the spread: positions are unknown. `x -> a` in the second. |
| Destructured params | `function f({ a }, [b], c)` | Only `c`. A destructured param is an element/property read (see [Value flow: Deferred](value-flow.md#deferred)). |
| TypeScript `this` | `function f(this: T, a)`, `f(1)` | `1 -> a`. The `this` annotation isn't a param. |
| Several candidates | `f(x)` where `f` may be `foo` or `bar` | `x` to the first param of each |

The rest edges over-approximate. `rest` holds an array, not each argument. Flowing each argument into the `rest` binding keeps taint and matches what was asked for, but `rest` then summarises every element.

Each edge records:

| Property | Contents |
| --- | --- |
| `arg_index` | The argument's position in the call (`SON {key: 'arguments', idx}`). |
| `callsite` | The `id` of the `CallExpression`. An argument is a child of exactly one call, so this is redundant with the AST, but it makes the edge self-contained. `index` and `call` are Cypher keywords, hence the names. |

The target is the parameter's binding summary (its declaration, or the first declaration if a `var` redeclares it), so `ARGUMENT_TO` and the existing `FLOWS_TO decl -> use` connect.

## RETURNS_TO

For each `CALLS` edge:

- Every `ReturnStatement` with an argument that the callee owns gets `RETURNS_TO` the call. A `return` belongs to the nearest enclosing function, so returns of nested functions and callbacks don't count.
- A concise arrow body (`x => x + 1`) is its return value, so the body expression gets `RETURNS_TO`.
- A bare `return;` and falling off the end produce `undefined`. Nothing is invented for them.
- **Async functions and generators get none.** An async function's call evaluates to a promise, and a generator's to an iterator, not to the returned value. Linking the value to the call would be the "whole-container" shortcut that's avoided elsewhere. `CALLS` and `ARGUMENT_TO` are still created, since the arguments are bound on the call.

The existing `FLOWS_TO` already carries `returned value -> ReturnStatement` and `CallExpression -> wherever its value goes` (a binding, an argument, an operator). `RETURNS_TO` is the missing link between them.

## Context-insensitivity

There's one summary per parameter and one per return, shared by every callsite:

```js
function id(x) { return x; }
const a = id(s1);
const b = id(s2);   // s1 reaches b too
```

Both calls' arguments flow into `x`, and `return x` flows to both calls. So `s1 -> b` and `s2 -> a` are paths. That's the same kind of over-approximation as the flow-insensitive bindings. Removing it needs context-sensitive analysis, such as cloning or call strings, which is later work. Arguments to different params stay separate: in `pick(source, safe)` where `pick` returns `b`, `source` doesn't reach the result.

Recursion and mutual recursion make cycles in `CALLS` and in the value paths. Query with `ACYCLIC`, `TRAIL` or `SHORTEST` ([cookbook](../api/queries.md#flows_to-paths-have-cycles)).

## Implementation

All of it is in `flatten()`, after the [resolution post-pass](references.md#resolution):

1. During the walk, the scope context carries `fn`, the nearest enclosing function, so each `ReturnStatement` is filed under its owner. Calls are collected, and `facts()` records each write's value (`defs`) alongside the existing `WRITES`.
2. Each binding's definitions are gathered from those writes and from its declarations.
3. `callables(value)` returns the set of functions a value may be, or `null` for unknown. It follows aliases through `REFERS_TO`, the branches of `?:` and `||`, the last expression of a sequence, `=` assignments and TS wrappers. A `seen` set stops alias cycles.
4. For each call with a non-empty result: `CALLS`, then `ARGUMENT_TO` by position, then `RETURNS_TO` unless the callee is async or a generator.

The alias walk runs per callsite. Chains are short in practice. A `ponytail:` comment marks memoising it as the fix if they ever aren't.

## Coverage

`src/calls.test.ts` has:

- one snippet per resolution rule (A–H in the task), and the unresolved patterns
- argument mapping with defaults, rest, missing, extra, spread, destructured and TS `this` params, and several candidates
- return ownership with nested functions and callbacks, bare returns, concise bodies, and async functions and generators
- interprocedural reachability: one function, a chain of two, nested calls, several callsites, several arguments, recursion and mutual recursion
- opaque unresolved and member calls
- the two end-to-end demos
- determinism, `babel` parity, `save()` and reopen
- invariants: every `ARGUMENT_TO` is an argument of its `callsite` at `arg_index` and targets a param of a function that callsite `CALLS`, and every `RETURNS_TO` targets a call that `CALLS` the return's owner

Mutation checks were run on each of these rules. Each mutation was caught: argument shift, rest, the `this` filter, spread, return ownership, unknown-definition handling, params as known, async returns, concise bodies and matching callees by name.
