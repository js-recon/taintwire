---
sidebar_position: 2
title: webpack
---

# webpack

taintwire links the chunks of a webpack 4 or 5 build through its module registry. A call or value read from one chunk into another then gets the same `CALLS`, `ARGUMENT_TO`, `RETURNS_TO` and `FLOWS_TO` edges it would get if both modules were in one file. That covers ES modules, CommonJS modules and `import()`. Verified on webpack 5.112 and 4.47: production (plain and terser-minified), named ids, and development builds, including webpack's default `devtool: "eval"`.

## What you get

Take an app where `renderer.js` imports `getPayload` from `source.js`, and webpack puts `source.js` in its own chunk:

```js
// source.js
export function getPayload() {
    return window.name;
}

// renderer.js
import { getPayload } from "./source.js";
export function render() {
    document.getElementById("output").innerHTML = getPayload();
}
```

The minified build turns this into two files that know nothing of each other's names:

```js
// shared-source.89a1014d.js
(self.webpackChunkapp = self.webpackChunkapp || []).push([[130], {
    323(s, n, c) { function u() { return window.name } c.d(n, { n: () => u }) }
}]);

// 549.705d3f2d.js
(self.webpackChunkapp = self.webpackChunkapp || []).push([[549], {
    549(s, e, n) { n.d(e, { render: () => c }); var u = n(323); function c() { document.getElementById("output").innerHTML = (0, u.n)() } }
}]);
```

Load the whole `dist/` with [`addFiles()`](../api/reference.md#graphaddfiles), and the [source-to-sink query](../api/queries.md#across-functions) you'd write for one file finds it:

```cypher
MATCH (src:MemberExpression)-[:SON {key: 'object'}]->(:Identifier {name: 'window'}),
      (src)-[:SON {key: 'property'}]->(:Identifier {name: 'name'}),
      p = (src)-[:FLOWS_TO|ARGUMENT_TO|RETURNS_TO* SHORTEST 1..30]->(v),
      (:AssignmentExpression)-[:SON {key: 'right'}]->(v)
RETURN properties(nodes(p), 'type') AS path, properties(nodes(p), 'file') AS files
// path:  [MemberExpression, ReturnStatement, CallExpression]
// files: [shared-source.89a1014d.js, shared-source.89a1014d.js, 549.705d3f2d.js]
```

That's the same two-hop path (`FLOWS_TO`, then `RETURNS_TO`) as on the unbundled source. Without the registry links the path doesn't exist, because `(0, u.n)()` has no callee. The webpack 4 build of the same app, `Object(o.a)()` with a module array, gives the same path.

To look at the module graph itself:

```cypher
// which calls load which modules (require, import(), require.t)
MATCH (r:CallExpression)-[i:IMPORTS]->(f) RETURN r.file AS from, i.module_id AS module, f.file AS defined_in
// what each module exports
MATCH (f)-[e:EXPORTS]->(v) RETURN f.file AS file, e.name AS name, v.type AS value
```

## What's recognised

### Modules

| Runtime shape | Example (minified) | Becomes |
| --- | --- | --- |
| Chunk registration | `(self.webpackChunk_x ||= []).push([[130], { 323(e, n, t) {...} }])`, webpack 4's `window.webpackJsonp` | Module table: id `323` → that factory |
| Module arrays (webpack 4) | `push([[3], [, function (n, e, t) {...}, , ...]])` | Id = array index. Holes are skipped |
| Entry chunk modules | `var __webpack_modules__ = {...}`, webpack 4's `!function (modules) {...}([...])` | The same table |
| Factory forms | `323(e,n,t){}`, `323: function(e,n,t){}`, `"./src/a.js": (e,n,t) => {}` | Numeric or string id. Params are `module`, `exports`, `require`, by position |
| Runtime require | `function r(id) {... modules[id](m, m.exports, r) ...}`, webpack 4's `modules[id].call(m.exports, m, m.exports, r)` | Its calls (entry code in `main.js`) are imports too |
| Inlined CommonJS (5.112+) | `var r = t.cw((module, exports) => {...})` | A module of its own. `r()` is its namespace |

### Exports

| Shape | Example | Becomes |
| --- | --- | --- |
| Getter object | `t.d(n, { nm: () => getPayload })` | `EXPORTS {name: "nm"}` to `getPayload` |
| Value array (5.112+) | `t.d(n, ["lM", 0, payload])` | `EXPORTS {name: "lM"}` to `payload` |
| Three-argument getter (webpack 4) | `t.d(o, "a", function () { return u; })` | `EXPORTS {name: "a"}` to `u` |
| `module.exports = X` | `e.exports = function () {...}`, `e.exports = { legacy: ... }` | `EXPORTS {name: "default"}` to `X`, plus one per key of an object literal |
| `exports.k = v` | `n.K = function () {...}`, `module.exports.k = v` | `EXPORTS {name: "K"}` |
| `Object.defineProperty` | `Object.defineProperty(exports, "k", { get: function () { return m.k; } })`, or `{ value: v }` | `EXPORTS {name: "k"}` to the getter's value or `v` |

### Namespaces and imports

| Shape | Example | Resolves to |
| --- | --- | --- |
| `require(id)` | `var s = t(323)`, inline `t(323).nm` | Module 323's namespace (`IMPORTS {module_id: "323"}`) |
| Lazy require | `a = () => t(269)` then `a().legacy()` | 269's namespace |
| CommonJS default (`require.n`) | `s = t.n(o)` then `s()()` (webpack 5) or `s.a.legacy()` (webpack 4) | `o`'s namespace, whose own value is `module.exports` |
| `import()` | `t.e(480).then(() => t(480)).then(m => m.lazyPayload())`, `.then(t.bind(null, 8))` | `m` is 480's namespace |
| `import()` of CommonJS (`require.t`) | `.then(() => t.t(574, 23)).then(m => m.default())`, `.then(t.t.bind(null, 4, 7))` | `m.default` is `module.exports` |
| `await import()` | `const m = await t.e(480).then(() => t(480))` | `m` is 480's namespace |
| Namespace reads | `(0, s.nm)()`, `Object(s.a)()`, `s.lM`, `s["default"]` | The exported value |
| A namespace's own value | `t(574)()`, `s()()` | `module.exports` of a CommonJS module |
| Re-exports | `t.d(e, { again: () => x.nm })`, `defineProperty(..., { get() { return m.k; } })` | Followed into the other namespace |

### `eval` builds

webpack's development default, `devtool: "eval"`, puts every module body in a string:

```js
"./src/source.js": (__unused_webpack_module, __webpack_exports__, __webpack_require__) => {
    eval("{__webpack_require__.d(__webpack_exports__, { getPayload: () => (getPayload) }); function getPayload() {...} }\n//# sourceURL=...");
}
```

Each `eval("<string literal>")` is parsed and walked as code in the scope of the eval call, so `__webpack_require__` and `__webpack_exports__` resolve to the factory's params. This applies to any direct eval of a constant string, not only webpack's. The code becomes a virtual file named `<file>#eval@<offset>`: its nodes have that `file`, `graph.code(id)` returns their text, and `(eval call)-[:SON {key: "evaluated"}]->(File)` links it to the call.

## How it works

All of this happens in [`flattenFiles()`](../api/reference.md#flattenfiles), after names are resolved and before calls are resolved.

1. **One walk over every file.** Each file keeps its own `Program` scope, so names resolve within each file exactly as with `add()`. An `eval` literal is walked as a child unit, in its caller's scope.
2. **Module table.** It looks for object literals or arrays whose entries are all functions, in the three places webpack puts them: a `push([[chunkIds], …])` argument, a variable's initialiser, or the argument of the bootstrap IIFE. Each entry is a factory, and its params' bindings are recorded as that module's `module`, `exports` and `require`. The runtime's own require function is recognised from its body. `require.cw(body)` adds an inline module.
3. **Export table.** `R.d(E, …)` in all three forms, plus `module.exports = X`, `exports.k = v` and `Object.defineProperty(exports, "k", …)`, define each factory's exports. Each export is an `EXPORTS` edge. `module.exports = X` is also the module's `default` and the namespace's own value.
4. **Namespaces.** One function, `nsOf()`, decides which module's namespace an expression is: a require call, `require.t(id, mode)`, `require.n(ns)()` / `.a`, a call of a function that returns one (`require.cw`, `() => require(id)`), `await` of an `import()` promise, or a variable whose only definition is one of those. An `import()` promise is `p.then(require.bind(_, id))`, `p.then(require.t.bind(_, id, mode))` or `p.then(() => require(id))`. A `.then` callback's first param on such a promise is that namespace too.
5. **Resolution.** `ns.key` resolves to the exported value(s), and a namespace expression resolves to its `module.exports`. This feeds the call resolver, which treats it as an alias, so `CALLS`, `ARGUMENT_TO` and `RETURNS_TO` cross chunks. It also feeds `FLOWS_TO` from the exported value to the read.

Re-exports are followed, and cycles stop. Alias chains are followed iteratively, so long minified chains are fine. A module id defined by more than one factory, for example two builds in one graph, resolves to all of them.

## Builtins on the path

Real sources often pass through string builtins before the sink, as in `decodeURIComponent(location.hash.slice(1))`. Taint has to go through those calls too: Chromium percent-encodes `<>` in `location.hash`, so a hash-based XSS only fires after the decode. taintwire gives `FLOWS_TO` from the input to the result for unresolved `decodeURIComponent`, `decodeURI`, `unescape`, `String` and `Object`, and from the receiver of `slice`, `substring`, `substr`, `trim*`, `toLowerCase`, `toUpperCase`, `pad*`, `repeat`, `normalize`, `replace`, `replaceAll`, `toString`, `valueOf`, `at` and `concat`. Encoders (`encodeURIComponent`, `escape`) are left out, because their output is safe in HTML. See [Value flow](../implementation/value-flow.md#builtins).

## Limitations

| Not handled | Effect | Notes |
| --- | --- | --- |
| Framework code between the import and the use | `React.lazy(() => import("./x"))` reads `.default` inside React, so the component's flow isn't connected | Needs models of the framework |
| Non-literal `eval` | `eval(code)` with a computed string isn't parsed | Only string literals are known statically |
| Promise chains beyond the import | `.then(m => m.x).then(x => ...)` doesn't carry `x` | Only the namespace itself is modelled |
| `require.n` of an ES module | Treated as the namespace, not `ns.default` | Webpack only emits it for CommonJS modules |
| Separate `add()` calls | Chunks aren't linked | Load the whole build with one `addFiles()` |
| CommonJS objects built up indirectly | `const o = {}; o.f = …; module.exports = o` exports nothing by name | Needs [property flow](../implementation/property-design.md) |
