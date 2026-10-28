---
sidebar_position: 2
title: webpack
---

# webpack

taintwire links the chunks of a webpack 5 build through its module registry. A call or value read from one chunk into another then gets the same `CALLS`, `ARGUMENT_TO`, `RETURNS_TO` and `FLOWS_TO` edges it would get if both modules were in one file. Verified on webpack 5.112: production (plain and terser-minified), named ids (`moduleIds: "named"`) and development builds with `devtool: false`.

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

That's the same two-hop path (`FLOWS_TO`, then `RETURNS_TO`) as on the unbundled source. Without the registry links the path doesn't exist, because `(0, u.n)()` has no callee.

To look at the module graph itself:

```cypher
// which require calls load which modules
MATCH (r:CallExpression)-[i:IMPORTS]->(f) RETURN r.file AS from, i.module_id AS module, f.file AS defined_in
// what each module exports
MATCH (f)-[e:EXPORTS]->(v) RETURN f.file AS file, e.name AS name, v.type AS value
```

## What's recognised

| Runtime shape | Example (minified) | Becomes |
| --- | --- | --- |
| Chunk registration | `(self.webpackChunk_x ||= []).push([[130], { 323(e, n, t) {...} }])` | Module table: id `323` → that factory |
| Entry chunk modules | `var __webpack_modules__ = { 269(e) {...} }` | The same table |
| Factory forms | `323(e,n,t){}`, `323: function(e,n,t){}`, `"./src/a.js": (e,n,t) => {}` | Numeric or string id. The 2nd param is the exports object, the 3rd is `require` |
| Getter exports | `t.d(n, { nm: () => getPayload, Ay: () => defaultPayload })` | `EXPORTS {name: "nm"}` to `getPayload` |
| Value exports (5.112+) | `t.d(n, ["lM", 0, payload])` | `EXPORTS {name: "lM"}` to `payload` |
| Block-bodied getters | `t.d(e, { x: function () { return v; } })` | The returned value |
| Imports | `var s = t(323)` | `IMPORTS {module_id: "323"}`, and `s` is that module's namespace |
| Inline imports | `t(323).nm` | The same, without a binding |
| Runtime require | `function __webpack_require__(id) {... modules[id](m, m.exports, __webpack_require__) ...}` | Its calls (entry code in `main.js`) are imports too |
| Namespace reads | `(0, s.nm)()`, `s.lM`, `s["default"]` | Resolved to the exported value |
| Re-exports | `t.d(e, { again: () => x.nm })` in a barrel module | Followed into the other namespace |

## How it works

All of this happens in [`flattenFiles()`](../api/reference.md#flattenfiles), after names are resolved and before calls are resolved.

1. **One walk over every file.** Each file keeps its own `Program` scope, so names resolve within each file exactly as with `add()`. The pass only adds edges between files where the registry says so.
2. **Module table.** It looks for object literals whose properties are all functions keyed by a number or string, either as the second element of a `push([[chunkIds], …])` argument or as a variable's initialiser. Each property is a factory. Its second and third parameters' bindings are recorded as that module's `exports` and `require`. The runtime's own require function is recognised from its body, which calls `modules[id](module, module.exports, itself)`.
3. **Export table.** A call `R.d(E, definition)`, where `R` refers to a `require` binding and `E` to a factory's `exports`, defines that factory's exports. Both the getter-object form and the array form (`key, 0, value` for a value, `key, getter` for a getter) are read. Each export is an `EXPORTS` edge.
4. **Namespaces.** A call to a `require` binding with one literal argument is that module's namespace (an `IMPORTS` edge to each factory with that id). So is a variable whose only definition is such a call.
5. **Member resolution.** A read `ns.key` or `ns["key"]` on a namespace resolves to the value(s) that module exports as `key`. This feeds two things:
    - **Calls.** The callee resolver that already handles aliases, `(0, f)` and `?:` treats the read as an alias of the exported value, so `(0, u.n)()` gets `CALLS` to `function u` in the other chunk. `ARGUMENT_TO` and `RETURNS_TO` follow from that, as for any resolved call.
    - **Values.** `FLOWS_TO` runs from the exported value to the read, so `export const payload = window.name` reaches `out.innerHTML += s.lM`.

A re-export's value is itself a namespace read, so resolution follows it into the next module. Cycles stop.

The pass is structural and costs one walk over call sites. A module id defined by more than one factory, for example two webpack builds loaded into one graph, resolves to all of them.

## Limitations

| Not handled | Effect | Notes |
| --- | --- | --- |
| CommonJS modules (`module.exports = {...}`, `exports.x =`) and `require.n` interop | Reads of a CommonJS module's exports stay unresolved | Needs [property flow](../implementation/property-design.md) |
| The namespace an `import()` resolves to | In `t.e(549).then(() => t(549)).then((m) => m.render())`, `m.render()` stays unresolved. Code inside the lazy chunk is analysed normally | Needs promise flow |
| `devtool: "eval"` development builds (webpack's development default) | Module code is a string inside `eval()`, so it isn't in the AST | Build with `devtool: false`, or use a production build |
| webpack 4 | `R.d(E, "name", getter)` isn't recognised | |
| Separate `add()` calls | Chunks aren't linked | Load the whole build with one `addFiles()` |
| Scope-hoisted modules | Nothing to do: concatenated modules in one chunk are plain lexical references and already resolve | |
| Unresolved calls in the source or sink | `decodeURIComponent(location.hash.slice(1))` breaks the path even in one plain file | Not specific to bundles. See [Value flow: Deferred](../implementation/value-flow.md#deferred) |
