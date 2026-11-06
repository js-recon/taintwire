---
sidebar_position: 8
title: Value flow
---

# Value flow

`A -[:FLOWS_TO]-> B` means the value represented by `A` may contribute to the value represented by `B`. It's data flow, and the graph later taint queries traverse. It isn't name resolution ([`REFERS_TO`](references.md)), access classification ([`READS`/`WRITES`](references.md#reads-and-writes)), AST containment (`SON`) or a call edge. `FLOWS_TO` has no properties.

This version is deliberately small. It covers values moving through expressions, into variables and back out of them, within the code of each file. [`ARGUMENT_TO` and `RETURNS_TO`](calls.md) extend it across statically resolved calls. Properties and control flow come later.

```text
const input = source;
let x = input;
x = x + "!";
console.log(x);

source ──> input (decl) ──> input (use) ──> x (decl) ──> x (use, rhs) ──> x + "!" ──> x = x + "!" ──┐
                                                ^                                                  │
                                                └──────────────────────────────────────────────────┘
                                           x (decl) ──> x (use, in console.log)
```

## Flow-insensitive bindings

A binding's declaration `Identifier` is the summary node for every value the binding ever holds:

- **Writes go in.** The value written flows to the declaration: `init → x(decl)`, `AssignmentExpression → x(decl)`.
- **Reads come out.** Each read occurrence gets an edge from the declaration: `x(decl) → x(use)`. A `REFERS_TO` that isn't a read, such as an assignment's left side or `export { x }`, gets no such edge.

So every write reaches every read, wherever they are in the code. That's an over-approximation, which is the intent. It can't miss a flow that the per-file program allows, and it doesn't pretend to track order. Reaching definitions or SSA can refine it later.

It also means cycles are normal. `x = x + 1` gives `x(decl) → x(use) → x + 1 → x = x + 1 → x(decl)`. Path queries need cycle protection. Ladybug's `ACYCLIC` (no repeated node) or `TRAIL` (no repeated edge) path semantics do this:

```cypher
MATCH p = (src)-[:FLOWS_TO* ACYCLIC 1..30]->(sink)
```

See the [query cookbook](../api/queries.md#flows_to-paths-have-cycles).

## Rules

`facts(node)` runs on every node during the walk. It records flows in terms of AST nodes, and also writes. After [resolution](references.md#resolution), any flow into a target `Identifier` is redirected to its binding's summary declaration. A flow into an unresolved target is dropped.

| Node | Flows |
| --- | --- |
| `VariableDeclarator` | `init → binding`, when `id` is an `Identifier` |
| `AssignmentExpression` `=` | `right → the assignment`, then `the assignment → binding` (when `left` is an `Identifier`) |
| `AssignmentExpression` compound or logical (`+=`, `\|\|=`, ...) | `left (a read) → the assignment`, `right → the assignment`, `the assignment → binding` |
| `UpdateExpression` | `argument → the update`, `the update → binding` |
| `AssignmentPattern` | `right (the default) → binding`, when `left` is an `Identifier` |
| `BinaryExpression`, `LogicalExpression` | `left → node`, `right → node` |
| `ConditionalExpression` | `consequent → node`, `alternate → node`. Not `test`. |
| `UnaryExpression` | `argument → node`, except `void` and `delete` |
| `TemplateLiteral` | each `${}` expression `→ node` |
| `SequenceExpression` | the last expression `→ node` only |
| `ReturnStatement` | `argument → node` |
| `TSAsExpression`, `TSSatisfiesExpression`, `TSNonNullExpression`, `TSTypeAssertion`, `TSInstantiationExpression` | `expression → node` (they don't change the value) |
| a resolved read | `declaration → use` |

Notes on the less obvious rows:

- **An assignment is an expression.** Its own value is what it assigned, so the value goes through the `AssignmentExpression` node on its way to the binding. That way, in `y = (x = source)`, the inner assignment flows into `x` and also onwards into the outer assignment and on to `y`.
- **The conditional test isn't data.** `c ? a : b` chooses between `a` and `b`, but `c` isn't part of the result. That's control dependence (`CONTROL_DEPENDS_ON`, later). `c` is still a `READ`.
- **`void x`** is always `undefined`. **`delete x`** is a boolean about whether a property was removed. Neither carries `x`'s value. `typeof`, `!`, `+`, `-` and `~` do.
- **Postfix and prefix updates.** `x++` returns the old value and `++x` the new one, but both depend only on `x`'s old value. So they share the same edges.
- **Sequences.** In `(a(), value)`, only `value` is the result. `a()` is evaluated for its effects.
- **Unresolved operands still flow.** In `location + 1`, `location` has no declaration, but the `Identifier` is still a value-producing expression: `location → BinaryExpression`. That's where a later source rule attaches taint.

## Deferred

None of these create `FLOWS_TO` yet. They're `READS`/`WRITES` only, or nothing.

| Deferred | Example | Why | Later |
| --- | --- | --- | --- |
| Arguments into the call's value | `foo(x)` | The result needn't depend on any argument. `foo` and `x` are read. For a resolved call, `x` goes `ARGUMENT_TO` the param and the result comes back through `RETURNS_TO`. | [done](calls.md) for resolved calls |
| Unresolved calls | `eval(x)`, `obj.m(x)` | Opaque: no flow through them. | property pass, host models |
| Member reads | `obj.foo` | The property's value isn't the object. No `obj → obj.foo`. The `MemberExpression` itself still flows on, for example into `const y = obj.foo`. | `READS_PROPERTY` |
| Property writes | `obj.foo = v` | The heap isn't modelled. `v` flows into the assignment but stops there. | `WRITES_PROPERTY`, `ALIASES` |
| Destructuring | `const { a } = o`, `[a] = arr` | It's a property or element read, like `obj.foo`. `a` is written, but nothing flows into it. | property pass |
| for-of / for-in | `for (x of xs)` | Elements and keys are element reads. `x` is written, with no flow. | property pass |
| Object and array literals | `[x]`, `{ k: x }` | Aggregate contents need heap modelling. | property pass |
| `await`, `yield`, Promises, callbacks | `await p` | Promise and callback semantics. | later |
| Function values | `function f() {}` | The function isn't a `FLOWS_TO` value flowing into `f`. The call graph reads declarations directly. | |
| Implicit flow | `if (secret) y = 1` | Control dependence. | `CONTROL_DEPENDS_ON` |

## Coverage

`src/flow.test.ts` checks the spec's value-flow cases by exact edge list:

- `const y = x`, `x = y`, and `x = x + 1` with its cycle
- compound and logical assignment, and update expressions
- calls (no flow from arguments into the call)
- the conditional without its test, the template literal, and the sequence's last expression only
- nested assignment, and return
- unresolved globals

It also checks that there's no flow through destructuring or for-of. It covers the TS `as` passthrough, the `var` redeclaration summary, default parameters and unary operators. Reachability is checked with `FLOWS_TO* ACYCLIC` paths.
