---
sidebar_position: 12
title: Property and heap flow (design)
---

# Property and heap flow (design)

:::caution Not implemented

Nothing on this page is in the graph. `READS_PROPERTY`, `WRITES_PROPERTY`, `POINTS_TO` and the heap nodes below are a design for the next phase. Today, member access, destructuring, iteration and object/array literals carry no value flow (see [Value flow: Deferred](value-flow.md#deferred)).

:::

## Why it isn't a small extension

The tempting shortcut is to key properties by binding: treat `obj.foo` as a slot `(binding obj, "foo")`, make `obj.foo = v` flow into the slot, and make reads of `obj.foo` flow out of it. It's wrong in both directions, so it isn't built:

| Case | What the shortcut gets wrong |
| --- | --- |
| `const o2 = obj; o2.foo = v; obj.foo` | Misses the flow: two bindings, one object. |
| `let o = a; o.foo = v; o = b; o.foo` | Invents a flow from `a`'s field to `b`'s, given flow-insensitive bindings. |
| `f(obj)` where `f` does `p.foo = v` | Misses it: the write is through a parameter. |
| `arr.push(v); arr[0]` | Misses it: the write is inside a builtin. |
| `const { search } = location` | `location` is a host object with no binding to key on. |

Each of these needs to know which **object** an expression evaluates to, not which name it's written with. That's points-to analysis.

## Proposed model

**Abstract objects are allocation sites.** Every `ObjectExpression`, `ArrayExpression`, `NewExpression`, function and class is an object. It gets a deterministic `HeapObject` id derived from the allocation site's file and span, like `Scope` ids. Host globals (`window`, `document`, `location`, ...) get one named object each, once a host model exists, because they have no allocation site in the code.

**Points-to sets come from the existing value graph.** `POINTS_TO(expression or binding -> HeapObject)` is the closure of allocation sites over `FLOWS_TO|ARGUMENT_TO|RETURNS_TO`, plus the field edges below. That's inclusion-based (Andersen-style) propagation with a worklist. It's context-insensitive at first, matching the call graph.

**Fields are (object, property name).** A `Field` node per object and static property name, plus `*` for unknown keys and `[]` for array elements:

- `x.p = v`: for each `o` in `pts(x)`, `v -[:FLOWS_TO]-> Field(o, p)` and `AssignmentExpression -[:WRITES_PROPERTY {name: p}]-> Field(o, p)`.
- `x.p`: for each `o` in `pts(x)`, `Field(o, p) -[:FLOWS_TO]-> MemberExpression` and `MemberExpression -[:READS_PROPERTY {name: p}]-> Field(o, p)`.
- `x["p"]` is `x.p`. `x[k]` with a non-literal `k` reads `*` and every field, and writes `*`. That's sound but imprecise. It's better than being unresolved, because taint commonly goes through computed keys.
- `{ p: v }` writes `Field(site, p)`. `[a, b]` writes `Field(site, [])`.
- Destructuring `const { p } = x` is `x.p`, and `[a] = x` is `x[]`. for-of reads `[]`, and for-in yields keys, which are strings and not field values.

**The call graph benefits.** A member call `x.m()` resolves when every object in `pts(x)` has `m` bound to known functions. The same all-or-nothing rule as `CALLS` applies. That's where most unresolved calls in bundles are (see the corpus numbers in `OVERNIGHT_REPORT.md`).

## Hard parts to settle before building

- **Unknown objects.** Parameters of unresolved callers, call results and globals point to "unknown". A field read on unknown must be unknown, not empty, or taint disappears silently. That needs a distinguished `UnknownObject`, and every rule has to handle it.
- **Builtins.** `push`, `concat`, `Object.assign`, spread, `JSON.parse`/`stringify`, `Array.prototype.map` callbacks and string methods (`trim`, `slice`, ...) need models. Without them they're opaque, which is today's behaviour for calls.
- **Prototypes, getters/setters and proxies.** Class instances, `this`, and framework reactivity (Vue `reactive`, Svelte stores, Angular signals) all route property access through code the analysis can't see. Start with own fields of literals and `new` sites, and treat the rest as unknown.
- **Cost.** Andersen's analysis is cubic in the worst case. On minified bundles, field-sensitivity plus `*` reads can blow up. Measure on the corpus before committing to it.

## Tests to write first

- Alias: `const o2 = obj; o2.foo = v; obj.foo` reaches `v`.
- Reassignment: `let o = a; o = b; b.foo = v; a.foo` doesn't reach `v` from `b`'s write, beyond what flow-insensitivity forces. Assert the over-approximation explicitly.
- Through a call: `function set(p, v) { p.foo = v }; set(obj, s); obj.foo` reaches `s`.
- Destructuring: `const { search } = location` with a host model for `location`.
- Computed keys: `o[k] = v; o.anything` reaches `v` through `*`.
- Negative: `obj.foo = v; obj.bar` doesn't reach `v`.
