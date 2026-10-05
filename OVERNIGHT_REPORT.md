# Overnight report: taintwire semantic graph v0

Date: 2026-10-05. Scope: harden the local semantic graph, add a static call graph with argument and return flow, validate on the js-recon-research corpus, document, and measure.

## 1. Starting test count

**132** passing (4 files), at commit `2c88509`.

## 2. Final test count

**158** passing (5 files, `npm test`):

| File | Tests |
| --- | --: |
| `src/calls.test.ts` (new) | 22 |
| `src/declares.test.ts` | 38 |
| `src/flow.test.ts` | 51 |
| `src/index.test.ts` | 9 |
| `src/scopes.test.ts` | 38 |

Outside the repo, in the private workspace `taintwire-working/corpus/`, there are 4 targeted assertions on real bundles plus the 24-target corpus run. The `taintwire-working/webpack-basic-app` export test still passes.

## 3. Commits

| Commit | Summary |
| --- | --- |
| `577de50` | fix: create every relationship table when a graph is opened |
| `dd50dd9` | fix: params and vars shadow a named function expression's own name (+ hardened local tests) |
| `93b5e54` | feat: static call graph with CALLS, ARGUMENT_TO and RETURNS_TO |
| `3716d6d` | docs: document the call graph |
| `76f2ea0` | docs: property and heap flow design (not implemented) |
| `ff2c6e7` | fix: resolve callee aliases iteratively in linear time |
| `3d5b091` | feat: export RELATIONS, the stable list of edge-table names |
| (this file) | docs: overnight report |

All are pushed to `origin/main`.

## 4. Relations implemented

| Relation | Status | Tests | Notes |
| --- | --- | --- | --- |
| `SON` | done (earlier) | index, declares, scopes, flow A20 | AST containment only. No `:CHILD` anywhere (asserted in A20 and test 9). |
| `DECLARES` | done (earlier) | declares (38) | Binding-introducing node to the existing `Identifier`. |
| `CREATES_SCOPE` | done (earlier) | scopes (38) | One per owner, deterministic `Scope` ids. |
| `PARENT_SCOPE` | done (earlier) | scopes | One root per file. Never crosses files. |
| `IN_SCOPE` | done (earlier) | scopes, flow A20 | Exactly one per `DECLARES`. |
| `REFERS_TO` | done, **1 bug fixed** | flow (51) | Use to declaration through the scope chain. A named function expression's own name now ranks below its params and vars. |
| `READS` | done | flow | Operation (direct parent) to declaration. `access` is the occurrence's id, `access_signature` its cs-mast hash. |
| `WRITES` | done | flow | Declarator, assignment, update, for-in/of and default value to declaration. Property writes write no binding. |
| `FLOWS_TO` | done | flow, calls | Flow-insensitive binding summaries. No destructuring, iteration, member, literal or unresolved-call flow. |
| `CALLS` | **new** | calls (22) | All-or-nothing static resolution with a `candidates` count. |
| `ARGUMENT_TO` | **new** | calls | `{arg_index, callsite}`. Rest params take the tail. Nothing at or after a spread, or for destructured params. |
| `RETURNS_TO` | **new** | calls | Valued returns owned by the callee, and concise arrow bodies. None for async functions or generators. |

Not implemented, and not documented as implemented: `READS_PROPERTY`, `WRITES_PROPERTY`, `ALIASES`, `CAPTURES`, `LOADS_MODULE`, `IMPORTS`, `EXPORTS`, `CONTROL_DEPENDS_ON`, any CFG, SSA, or taint rules.

## 5. Semantic behaviour implemented tonight

**Schema (Phase 0).** Every edge table now exists as soon as a graph is opened. Ladybug can't create a rel table without a FROM/TO pair, so each gets one real pair from `DEFAULT_PAIRS`, such as `REFERS_TO: Identifier -> Identifier` and `CALLS: CallExpression -> FunctionDeclaration`. The few node tables those pairs need are created with them. `MATCH ()-[r:REFERS_TO]->() RETURN r` on a graph with no references returns zero rows, and that holds for reopened older databases too. `RELATIONS` exports the names.

**CALLS (Phase 2).**

- **How a callee resolves.** It's evaluated as a value: through `REFERS_TO` to its binding, then over the binding's definitions. Definitions are function declarations, named function expressions' own names, `let f = v` / `f = v` (followed through aliases), the last expression of a sequence, both branches of `?:` and `||`, `=` chains and TS wrappers. IIFEs (`(function(){})()`, `(() => {})()`, `!function(){}()`) and `f?.()` resolve directly.
- **All or nothing.** If any definition is unknown, the call gets no `CALLS` edge at all. Unknown means a param, catch param, import, class, default value, destructuring, for-in/of target, compound or update write, member value, call result or unresolved global. Partial sets would look like complete answers, so they're never emitted.
- **Several known definitions** (`let f = foo; f = bar; f()`) give a may-call edge to each, carrying `candidates: 2`. That's the same flow-insensitivity as `FLOWS_TO`.
- **Never resolved:** member calls (`obj.m()`, `a[k]()`, `.call`/`.apply`), globals and builtins (`eval`, `fetch`, `setTimeout`), `new`, tagged templates and calls into other files. No fake declarations are created.
- **Implementation.** Aliases form a graph between bindings. It's solved once with an iterative Tarjan SCC pass, so bindings on an alias cycle share a result and the whole thing is linear.

**ARGUMENT_TO (Phase 3).**

- Arguments map to params by position. The target is the parameter's declaration `Identifier` (its binding summary), with `{arg_index, callsite}` on the edge.
- A default param gets the argument, never its default. A rest param takes every argument from its position on, each edge keeping its original index.
- Missing arguments add nothing. Extra arguments go nowhere unless there's a rest param.
- Nothing is mapped at or after a spread.
- Destructured params get nothing, since that would be element or property flow.
- A TypeScript `this` param is skipped when counting positions.
- `index` and `call` are Cypher keywords, so the properties are named `arg_index` and `callsite`.

**RETURNS_TO (Phase 4).**

- Every `ReturnStatement` with an argument that's owned by the callee gets `RETURNS_TO` the call. The owner is the nearest enclosing function, so returns of nested functions and callbacks never attach to the outer call.
- A concise arrow body is the return value, so it gets the edge.
- A bare `return;` and an implicit `undefined` get nothing.
- Async functions and generators get no `RETURNS_TO`, because their call evaluates to a promise or an iterator. `CALLS` and `ARGUMENT_TO` are still created for them.

**Interprocedural reachability (Phase 5).** Paths over `FLOWS_TO|ARGUMENT_TO|RETURNS_TO` cross functions. There are tests for:

- one function, a chain of two, and nested calls (`id(id(source))`)
- several callsites (context-insensitive merging, asserted as a known over-approximation)
- several arguments, with the precision check that `pick(source, safe)` returning `b` doesn't reach `source`
- several returns, recursion and mutual recursion (cycles expected; queries use `ACYCLIC`/`SHORTEST`)
- opaque unresolved and member calls

**Demo (Phase 8).** `function pass(x) { return x; } const data = pass(location.search); eval(data);` The test retrieves the path with Cypher:

```text
MemberExpression(location.search) -ARGUMENT_TO-> x (param) -FLOWS_TO-> x -FLOWS_TO-> ReturnStatement
  -RETURNS_TO-> CallExpression(pass(...)) -FLOWS_TO-> data (decl) -FLOWS_TO-> data (eval's argument)
```

The source and the sink are matched structurally, since `location` and `eval` have no declarations. The `x.trim()` variant is asserted to have **no** path past `x`, because member calls are opaque. That's an honest false negative, not a sanitizer claim.

**Property semantics (Phase 6): stopped.** A correct model needs points-to analysis over allocation sites: aliases, reassignment, writes through params and builtins, host objects. Keying properties by binding name would be wrong in both directions. The design is in `docs/docs/implementation/property-design.md`.

## 6. Bugs found and fixed

1. **Named function expression shadowing** (`dd50dd9`). In `function g(g) { return g; }` and `function g() { var g = 1; return g; }`, the use resolved to the function's own name. The name and the params share one scope in the model, and the canonical declaration was the earliest. ECMAScript binds the name outside the params and body. The name now ranks below any other declaration of it in that scope. Regression test added.
2. **Edge tables missing on graphs without such edges** (`577de50`). A binder error instead of zero rows. Fixed with eager tables, and tested, including through save and reopen.
3. **Quadratic, stack-overflowing alias resolution** (`ff2c6e7`). Found by the Phase 10 scaling test. Alias chains were walked recursively per callsite: 16,000 chained aliases took 33 s, and about 2,000 overflowed the default JS stack and crashed `add()`. It's now an iterative SCC pass: 0.54 s for 16,000. The regression test (20,000 links, both directions) fails on the old code with `RangeError: Maximum call stack size exceeded`.
4. **Test-helper issues found along the way** (no product impact). `p = (a)-[*]->(b)-[:SON]->(c)` binds `p` to the whole chain, so `length(p)` included the `SON` hops. Ladybug rejects `ORDER BY` on an alias that shadows a node variable.

No cs-mast bugs were found. Every corpus file parsed with cs-mast, and the `babel` parser gives identical edges (parity tests). The only difference is that Babel 8 calls `import()` an `ImportExpression` where cs-mast's Babel 7 says `CallExpression`, so the parity test compares positions.

## 7–9. Real-world corpus (js-recon-research)

24 built artifacts from 8 ecosystems. Runner: `taintwire-working/corpus/run.mjs` (private workspace). Results: `results.md` / `results.json` there.

**Every target succeeded.** cs-mast parsed every file (no fallback to `babel`), the graphs built, scopes, `DECLARES`, `REFERS_TO` and `FLOWS_TO` are present in all of them, and save/reopen kept identical node and relation counts.

**Next.js was not tested.** No app under `next/` has build output or installed dependencies. An offline install from the npm cache failed (`next@16.1.0` isn't cached). A build would need network installs, which the instructions said not to fight. Recorded as a blocker.

| Target (file under js-recon-research) | Framework / bundler | Bytes | Import | Nodes | Edges | REFERS_TO | FLOWS_TO | CALLS | ARGUMENT_TO | RETURNS_TO | Calls resolved | Top unresolved callees | Save | DB | Reopen |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --- | --: | --: | --- |
| webpack basic_app index (`webpack/basic_app/dist/index.bundle.js`) | webpack 5 (plain JS) | 616 | 0.2 s | 142 | 236 | 13 | 30 | 2 | 1 | 0 | 2/12 (17%) | member 9, global 1 | 1.0 s | 7 MB | ✓ |
| react vuln_app_webpack main (`react/vuln_app_webpack/dist/assets/main.8a907a4f3c1e732e4d9d.js`) | React + webpack | 22,223 | 1.3 s | 7,032 | 15,357 | 1,552 | 3,316 | 76 | 116 | 81 | 66/390 (17%) | member 217, bound-unknown 47, (0, x.y) 41 | 5.7 s | 66 MB | ✓ |
| react vuln_app_webpack react-dom (`react/vuln_app_webpack/dist/assets/vendor-react-dom.fe25c8e6e5bea3a0f43b.js`) | React (vendor) + webpack | 178,115 | 6.9 s | 58,674 | 141,417 | 15,886 | 33,751 | 1,832 | 3,645 | 1,880 | 1832/2781 (66%) | member 622, bound-unknown 178, global 141 | 12.8 s | 134 MB | ✓ |
| react vuln_app_webpack lazy chunk (`react/vuln_app_webpack/dist/assets/132.ee8385c57d5efc2cf00d.js`) | React + webpack (async chunk) | 5,209 | 0.6 s | 1,043 | 1,902 | 149 | 320 | 10 | 15 | 8 | 10/60 (17%) | member 19, (0, x.y) 17, bound-unknown 9 | 2.6 s | 25 MB | ✓ |
| react vuln_app index (`react/vuln_app/dist/assets/index-BpDs_mxk.js`) | React + Vite | 3,245 | 0.6 s | 879 | 1,586 | 131 | 235 | 15 | 14 | 12 | 15/90 (17%) | (0, x.y) 41, bound-unknown 15, import() 11 | 1.8 s | 20 MB | ✓ |
| react vuln_app Post (`react/vuln_app/dist/assets/Post-Ck0sG56A.js`) | React + Vite (route chunk) | 3,633 | 0.7 s | 1,099 | 1,554 | 91 | 162 | 0 | 0 | 0 | 0/65 (0%) | (0, x.y) 35, bound-unknown 16, member 10 | 2.1 s | 20 MB | ✓ |
| react complex_vuln_app index (`react/complex_vuln_app/dist/assets/index-DoBs2Sa7.js`) | React + Vite | 192,997 | 7.2 s | 66,176 | 156,625 | 17,500 | 36,688 | 1,943 | 3,818 | 1,850 | 1937/3045 (64%) | member 713, bound-unknown 211, global 152 | 15.3 s | 146 MB | ✓ |
| react 0.14 webpack (`react/version-detect-test/webpack-react-0.14/dist/main.c77438c17e412109fa00.js`) | React 0.14 + webpack | 128,599 | 4.2 s | 36,955 | 76,922 | 7,410 | 14,921 | 226 | 417 | 223 | 221/2076 (11%) | member 937, bound-unknown 891, global 19 | 9.8 s | 116 MB | ✓ |
| react 20-cve-app jquery (`react/20-cve-app/dist/assets/jquery-C_VVYSll.js`) | jQuery (Vite chunk) | 87,941 | 3.7 s | 31,262 | 70,399 | 7,609 | 16,500 | 403 | 655 | 449 | 396/1755 (23%) | member 1282, bound-unknown 59, global 16 | 8.8 s | 108 MB | ✓ |
| react 20-cve-app Search (`react/20-cve-app/dist/assets/Search-_iURM8gp.js`) | React + Vite (route chunk) | 40,443 | 1.7 s | 11,594 | 26,234 | 2,498 | 6,188 | 191 | 220 | 354 | 191/595 (32%) | member 238, bound-unknown 127, global 36 | 6.2 s | 77 MB | ✓ |
| vue basic_app index (`vue/basic_app/dist/assets/index-C82FLvsE.js`) | Vue 3 + Vite | 91,574 | 4.5 s | 34,284 | 84,037 | 9,093 | 17,637 | 1,200 | 2,224 | 1,021 | 1180/2226 (53%) | member 727, bound-unknown 278, global 38 | 10.8 s | 126 MB | ✓ |
| vue pinia-app index (`vue/pinia-app/dist/assets/index-ClgQKJim.js`) | Vue 3 + Pinia + Vite | 101,479 | 4.6 s | 38,553 | 94,057 | 10,143 | 19,687 | 1,313 | 2,367 | 1,170 | 1293/2523 (51%) | member 860, bound-unknown 317, global 42 | 11.3 s | 131 MB | ✓ |
| vue pinia-app CartView (`vue/pinia-app/dist/assets/CartView-3BdJ2z66.js`) | Vue 3 + Vite (route chunk) | 1,464 | 0.4 s | 493 | 942 | 94 | 157 | 0 | 0 | 0 | 0/58 (0%) | bound-unknown 49, member 9 | 1.2 s | 12 MB | ✓ |
| nuxt vuln_app client entry (`nuxt/vuln_app/.output/public/_nuxt/C0BQX5ee.js`) | Nuxt 3 (client) | 198,431 | 7.9 s | 70,525 | 164,797 | 17,075 | 33,731 | 2,177 | 3,566 | 2,082 | 2153/4561 (47%) | member 1715, bound-unknown 543, global 110 | 18.8 s | 174 MB | ✓ |
| nuxt vuln_app server fetch (`nuxt/vuln_app/.nuxt/dist/server/_nuxt/fetch-Dj2TLp3p.js`) | Nuxt 3 (server chunk) | 17,006 | 1.0 s | 2,714 | 5,490 | 530 | 926 | 18 | 34 | 24 | 18/139 (13%) | member 64, bound-unknown 53, global 2 | 4.3 s | 43 MB | ✓ |
| svelte vuln_app client chunk (`svelte/vuln_app/build/client/_app/immutable/chunks/D7hspacH.js`) | SvelteKit (client) | 32,396 | 2.1 s | 11,132 | 23,435 | 2,266 | 4,533 | 185 | 231 | 183 | 183/594 (31%) | member 307, bound-unknown 74, global 29 | 7.6 s | 86 MB | ✓ |
| svelte vuln_app server index (`svelte/vuln_app/build/server/chunks/index-CXAd9s1W.js`) | SvelteKit (server) | 185,883 | 3.4 s | 24,733 | 51,485 | 4,841 | 9,139 | 357 | 589 | 490 | 352/1334 (26%) | member 771, bound-unknown 154, global 38 | 10.9 s | 124 MB | ✓ |
| svelte vuln_app handler (`svelte/vuln_app/build/handler.js`) | SvelteKit adapter-node (plain Node) | 41,016 | 1.2 s | 5,156 | 9,497 | 804 | 1,536 | 44 | 59 | 62 | 44/258 (17%) | member 169, bound-unknown 28, global 15 | 5.4 s | 58 MB | ✓ |
| svelte ecommerce client chunk (`svelte/ecommerce_app/build/client/_app/immutable/chunks/BSFrUaz7.js`) | SvelteKit (client) | 47,429 | 2.6 s | 15,818 | 34,118 | 3,285 | 6,626 | 321 | 434 | 445 | 317/947 (33%) | member 514, bound-unknown 75, global 40 | 8.7 s | 102 MB | ✓ |
| angular vuln_app main (`angular/vuln_app/dist/devhub-angular/browser/main-R2OIKKQA.js`) | Angular (esbuild) | 256,105 | 7.6 s | 73,048 | 145,227 | 12,661 | 24,635 | 953 | 1,661 | 1,249 | 953/5253 (18%) | member 2718, bound-unknown 1328, call result 112 | 16.6 s | 171 MB | ✓ |
| angular vuln_app chunk (`angular/vuln_app/dist/devhub-angular/browser/chunk-M4T5QPYK.js`) | Angular (esbuild chunk) | 159,029 | 6.2 s | 54,183 | 129,489 | 13,111 | 25,300 | 1,874 | 3,344 | 1,708 | 1871/3337 (56%) | member 1214, bound-unknown 162, optional member 39 | 14.8 s | 158 MB | ✓ |
| angular vuln_app polyfills (`angular/vuln_app/dist/devhub-angular/browser/polyfills-5CFQRCPP.js`) | Angular polyfills (zone.js) | 34,585 | 1.9 s | 10,944 | 25,299 | 2,691 | 5,355 | 154 | 285 | 118 | 154/482 (32%) | member 270, bound-unknown 52, global 3 | 7.4 s | 81 MB | ✓ |
| angular inline-sourcemap main (`angular/inline-sourcemap-app/dist/inline-sourcemap-app/browser/main.js`) | Angular dev build + inline sourcemap (3.8 MB) | 3,822,022 | 14.4 s | 139,036 | 318,198 | 30,746 | 55,752 | 4,961 | 8,964 | 4,594 | 4957/8584 (58%) | member 3090, bound-unknown 247, global 119 | 26.9 s | 226 MB | ✓ |
| generic infinite-blog server (`generic/infinite-blog/server.js`) | plain Node | 1,779 | 0.3 s | 162 | 305 | 23 | 47 | 0 | 0 | 0 | 0/16 (0%) | member 13, global 2, bound-unknown 1 | 0.9 s | 7 MB | ✓ |

Import times are from an uncontended run. Counts are identical across both runs (before and after the alias fix).

**Targeted assertions on real code** (`taintwire-working/corpus/assertions.test.mjs`, all 4 pass):

- **React + Vite, `DebugConsole` chunk.** A `postMessage` handler `let e = e => { ... runExpr(e.data.expr) }` and `const runExpr = expr => { ... eval(expr) ... }`. The handler's `e` resolves to its own param, not the `let e` it's assigned to. `runExpr(...)` resolves to the `const` arrow declared later in the source. `e.data.expr` reaches `eval`'s argument as `ARGUMENT_TO -> FLOWS_TO`. That's a real interprocedural path in a production bundle.
- **React + Vite, `Search` chunk.** The `${e}` in the `innerHTML` template resolves to the effect's local `let e`, not the outer `[e, t] = useState`, and flows into the `innerHTML` assignment in 3 hops. `window.location.search` does **not** reach it, because it goes through `new URLSearchParams(...).get('q')`, and both `new` and member calls are opaque. That's asserted as a known false negative.
- **React + webpack 5 runtime.** `u(434)` resolves to the require function `function u(e)`, gets `434 -ARGUMENT_TO-> e {arg_index: 0}`, and both of `u`'s returns `RETURNS_TO` it. The module-factory call `a[e](t, t.exports, u)` and the in-module require `t(540)` (a factory param) are unresolved, which is runtime indirection, as expected.
- **webpack basic_app.** Both IIFEs resolve. The async validator's param is fed by `e.target.value` (`ARGUMENT_TO`), and it has no `RETURNS_TO` because it's async.

## 10. Performance

| Input | Bytes | Nodes | Edges | Import | Of which: parse / flatten (all semantics) / load | Save | Saved DB |
| --- | --: | --: | --: | --: | --- | --: | --: |
| tiny: webpack basic_app | 616 | 142 | 236 | 0.23 s | | 1.0 s | 6.7 MB |
| medium: React app chunk (webpack) | 22,223 | 7,032 | 15,357 | 1.3 s | | 5.7 s | 66 MB |
| representative: react-dom (webpack) | 178,115 | 58,674 | 141,417 | 6.3–6.9 s | 0.6 s / **0.24 s** / 5.4 s | 12.8 s | 135 MB |
| large: Angular dev build + inline sourcemap | 3,822,022 | 139,036 | 318,198 | 14.4 s | | 26.9 s | 225 MB |

Scaling of `flatten()` (all analysis, no database) on synthetic shapes. Time per doubling is about 2×, so linear:

| Shape | n = 2k | 4k | 8k | 16k |
| --- | --: | --: | --: | --: |
| N functions, each called | 120 ms | 240 ms | 518 ms | 1,345 ms |
| alias chain of N, each called (after the fix) | 70 ms | 130 ms | 292 ms | 538 ms |
| reversed alias chain | 54 ms | 114 ms | 232 ms | 493 ms |
| alias cycle of N + 1 outside definition | 75 ms | 109 ms | 265 ms | 614 ms |
| one scope, N bindings, 2N reads | 60 ms | 116 ms | 234 ms | 471 ms |
| N nested functions (n = 250…2000) | 4 ms | 7 ms | 15 ms | 33 ms |

Findings:

- The analysis is cheap. Ladybug loading dominates: one `COPY` per node type and per (edge, from-type, to-type) pair, about 500 statements for react-dom, at about 10 ms each. Disabling auto-checkpoint helps `save()` about 4× (done earlier) but makes no difference to in-memory `add()`.
- Saved files are large: at least about 6.7 MB, and about 750 bytes per edge.
- Both are recorded as known limitations. Neither was optimized tonight, since they're constant factors, not algorithmic.
- The only algorithmic problem found was alias resolution, which is fixed.

## 11. Known unsupported syntax and semantics

- **Property and heap flow:** member reads and writes, destructuring, for-of/for-in elements, object/array literal contents, spread, and builtins (`push`, `map`, `trim`, ...). Design only.
- **Modules:** `import`/`export` across files, webpack/Vite/rolldown module factories, chunk registration and `__webpack_require__`-style indirection. Resolution is per file.
- **Calls:** `new`, tagged templates, `.call`/`.apply`/`.bind`, higher-order calls through params, method calls, and getters/setters.
- **Async:** Promise and callback semantics (`then`, `await` values), and generator iteration.
- **Control:** CFG, control dependence and implicit flows. Conditional tests are `READS` only.
- **Scope model simplifications (unchanged):**
  - no per-iteration loop environments, no separate parameter scope, no Annex B function-in-block hoisting
  - `catch (e) { var e = 1 }` writes the function-level `e`, while the spec says it assigns the catch param
  - a class's inner name binding is merged with the outer one
  - TS namespaces aren't scopes
  - `with` and direct `eval` aren't modelled
- **JSX:** element names (`JSXIdentifier`) aren't resolved. `{expr}` containers are.
- **Context:** context-insensitive. There's one summary per param and per return.

## 12. Known false-positive risks

- **Flow-insensitive bindings.** Every write of a variable reaches every read, in any order, including across loop iterations and dead code.
- **Context-insensitive calls.** `id(s1)` and `id(s2)` share `id`'s param and return, so `s1` reaches the second call's result. This is tested and documented.
- **May-call sets** (`candidates > 1`). Every candidate gets its arguments and returns, although only one runs at a time.
- **Rest params.** Every tail argument flows into `rest`, which then summarises every element.
- **Script-global functions.** In script (non-module) files, top-level `function f` and `var f` are properties of the global object, and another script can overwrite them. `CALLS` assumes the local definitions are the only ones.
- **`with` and direct `eval`** can rebind names at runtime that are resolved statically here.
- **Duplicate `function f` declarations** in one scope give `candidates: 2`, although the last one wins.

## 13. Known false-negative risks

The biggest is anything through a member call or property read: `URLSearchParams.get`, `.trim()`, `obj.data`, `JSON.parse`, `arr.map(cb)`. The others:

- destructuring and iteration
- object and array literals
- unresolved callees (globals, params, imports and member values): no `ARGUMENT_TO` or `RETURNS_TO`
- async/await and Promise chains
- cross-file and cross-module flow, including everything behind bundler module loaders
- `new` (constructors)
- Annex B block functions called outside their block
- a single unknown definition making a call unresolved (all-or-nothing)

## 14. Unresolved call patterns (corpus)

Across the 24 targets, **18,145 of 41,181 calls (44%) resolve statically**. Large library-heavy bundles reach 47–66%: react-dom 66%, the Vue apps 51–53%, the Nuxt client 47%, the Angular chunk 56%, and the 3.8 MB Angular build 58%. Small app chunks get 0–33%, and jQuery 23%. Polymorphic calls (`candidates > 1`) are rare: at most 16 per bundle.

| Callee shape (unresolved) | Typical source | Share |
| --- | --- | --- |
| `MemberExpression` (`obj.m()`, `a[k]()`) | Methods, DOM/host APIs, module namespaces (`i.useState`) | By far the largest in every target |
| Identifier bound, unknown definition | Module-factory params (webpack `t(540)`), ESM imports between chunks (Vite/rolldown/esbuild `import { d as t }`), callback params, destructured imports | Second largest. Dominant in React 0.14/webpack (891) and Angular main (1328) |
| `SequenceExpression` | `(0, i.useState)(...)` / `(0, x.jsx)(...)`, where the last expression is a member | Large in Vite/rolldown React chunks |
| Identifier unresolved (global) | `fetch`, `setTimeout`, `require`, `Object`, `Promise`, `document`, ... | Small: host APIs, by design |
| `Import` (`import()`), `Super` | Dynamic imports, class constructors | Small |
| `CallExpression` callee | Curried calls `f()()` | Small |

## 15. Bundle patterns that defeat analysis today

- **Webpack module factories** are called through `a[e](t, t.exports, u)`, and modules call each other through the factory's `require` param (`t(540)`, `t.n(...)`, `t.d(...)`, `t.e(45).then(t.bind(t, 45))`). Unresolved due to bundle/runtime indirection. The loader function itself (`u(434)`) does resolve.
- **ESM chunks (Vite, rolldown, esbuild, Angular)** import their dependencies by name from other chunk files, so every cross-chunk call is "bound, unknown definition".
- **Namespace calls** like `(0, i.useState)(...)` and `(0, x.jsx)(...)`, which are member calls through a module namespace object.
- **Framework runtimes** call app code through callbacks (`useEffect(() => ...)`, Vue setup functions, Svelte component factories, Angular DI). The app functions are values passed to unresolved calls, so they're never `CALLS` targets.
- **Reactive proxies** (Vue `reactive`, Svelte stores, Angular signals) route values through property access.

None of these got fake semantics.

## 16. Recommended next phase

1. **Module recovery for bundles.** Webpack: map module ids to factory functions (`{434(e, n, t) {...}}`) and treat `t(id)`/`u(id)` as `LOADS_MODULE`, plus factory exports. ESM chunks: link `import { a as b } from "./chunk.js"` to the exporting chunk's binding when both files are in one graph. This would turn the largest "bound, unknown" bucket into resolved calls and argument flow. The pieces are a `RESOLVES_TO` / `IMPORTS` / `EXPORTS` layer.
2. **Property and heap flow**, following `property-design.md`, starting with allocation sites, own fields of object literals and `this` in classes. Host-object models for `location`, `document` and `URLSearchParams`, as sources.
3. **Builtin and host models** for common pass-through methods (`String.prototype.*`, `Array.prototype.map/filter`, `JSON.*`, `Promise.then`, `addEventListener` callbacks), as declarative summaries rather than code.
4. **Load performance.** Fewer edge-table pairs, or batching, before graphs get larger.
5. Only then **taint rules** (sources, sinks, sanitizers) on top of `FLOWS_TO|ARGUMENT_TO|RETURNS_TO` reachability.

## 17. Reproduce

```sh
cd taintwire
npm ci
npm run build
npm test                         # 158 tests, 5 files

# docs
cd docs && npm ci && npm run build && cd ..

# private workspace (needs ../js-recon-research and the build above)
cd ../taintwire-working/corpus
node run.mjs                     # 24 targets -> results.md / results.json
node --test assertions.test.mjs  # 4 targeted assertions on real bundles
cd ../webpack-basic-app && npm test
```

Mutation checks were run with a throwaway script that applied one change to `src/index.ts`, ran the suite, and restored the file. Each of these made at least one test fail:

- shadowing order (outermost wins)
- static property names treated as references
- declarations allowed to self-reference
- compound targets not read
- the conditional test flowing
- every sequence element flowing
- whole-object destructuring flow
- decl-to-use flow removed
- the function-expression self-name rank
- argument index shifted by one
- rest and spread handling, and the TS `this` filter
- return ownership given to the outer function
- async returns allowed
- concise bodies dropped
- unknown definitions ignored, and unresolved callees ignored
- params treated as known
- callees matched by name
- SCC dependency results dropped
- eager tables disabled
