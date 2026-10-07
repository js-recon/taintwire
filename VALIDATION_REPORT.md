# Taintwire post-implementation validation report

**Date:** 2026-10-06.

**Scope:** an independent audit of the overnight semantic-graph work (`OVERNIGHT_REPORT.md`). The code, tests, generated
graphs and runtime behaviour were treated as authoritative. The overnight report was used only to reproduce its claims.

**Companion document:** [GRAPH_SCHEMA.md](GRAPH_SCHEMA.md), the concise public schema.

**Repository state:** nothing was committed. All changes are left in the working tree (see §20).

## 0. Baseline (before any change)

| | |
| --- | --- |
| Overnight commits | `94e7efb`..`4f042f6` (2026-10-04 23:01 → 2026-10-05 02:02). The report's own "starting point" is `2c88509` (132 tests). The last pre-semantic commit is `73ac6af`. |
| Commit audited (HEAD) | `4f042f6` "docs: overnight report for the semantic graph v0", working tree clean |
| Test command | `npm test` (`vitest run --testTimeout=30000`) |
| Result | **158 / 158 passed**, 5 files, 0 skipped |
| Runtime | 33.3 s wall (vitest: 32.7 s) |
| Overnight diff | 24 files, +3313 / −68. `src/index.ts` +465. New: `calls.test.ts` (22), `flow.test.ts` (51), `scopes.test.ts` (38), `test-utils.ts`, plus docs. |

The overnight report's relation list, test counts and corpus numbers were reproduced exactly. For the 24 shared
targets, the independent corpus run in §9 gives identical node and edge counts.

## 1. Executive summary

| Property | Verdict | Why |
| --- | --- | --- |
| Structurally valid | **PASS** (after fix #1) | The SON tree is exact: one parent per node, unique `(parent, key, idx)`, and no `CHILD`. **Bug #1:** with the default cs-mast parser, subtrees under Babel-7-only child keys were silently dropped. That affected TS enum members, call type arguments, `implements`, and function-type params. Fixed. JS-only bundles were unaffected. |
| Scope-valid | **PASS** | var/let/const, function/param/self-name, class/static-block, catch, switch and loop scopes all match the spec. Every non-root Scope has exactly one parent, and there is one root per file. Known spec simplifications are documented (§15). |
| Name-resolution-valid | **PASS** | Shadowing (block, param, catch, sibling, function-expression self-name), property names vs. lexical names, shorthand, computed keys and unresolved globals all behave correctly. No fake declarations. It holds over 32 real bundles: 0 invariant violations across about 330k REFERS_TO edges. |
| Local-flow-valid | **PASS** (flow-insensitive, partial coverage) | Expression flow is correct, and the conditional test is excluded. Cycles are safe. Destructuring, iteration and property flow are deliberately absent, so no whole-container shortcuts exist. |
| Call-graph-valid | **PARTIAL** | Every emitted CALLS edge is sound with respect to lexical aliasing: all-or-nothing, scope-based, never by name. But only **47.1 %** of the 54,957 corpus calls resolve, because member, import, param and module-loader calls are out of scope. |
| Interprocedural-flow-valid | **PARTIAL** | ARGUMENT_TO and RETURNS_TO are exact for resolved calls: provenance via `callsite`, nearest-function return ownership, rest, default and spread handling. Paths compose end to end (`source → pass() → sink`, `a() → b()`). Analysis is context-insensitive, and any path through a member call, unresolved call or property stops. |

Bottom line: the graph is **accurate where it speaks**. No invariant failed on any real bundle, and every mutation of
core semantics was caught (§8). Its **coverage on bundled code is limited by design**: no properties, modules or
callbacks. One real implementation bug (#1) was found and fixed.

## 2. Exact node-type inventory

### 2.1 Categories

| Category | Tables | Origin |
| --- | --- | --- |
| AST nodes | One table per Babel node type actually seen. 45 tables in the rich fixture (below). 17–66 distinct types per real bundle. Any Babel type can appear (`JSX*`, `TS*`, `Import`, `Super`, ...). | cs-mast (Babel 7.29.8) by default, or `@babel/parser` 8.0.4 |
| Semantic / synthetic | `Scope` | Taintwire |
| Storage | `Source` (`file`, `code`). No edges. | Taintwire |
| Bundle-specific nodes | **none** | |
| Always-present AST tables (even empty) | `File`, `Program`, `Identifier`, `VariableDeclarator`, `CallExpression`, `FunctionDeclaration`, `ReturnStatement`. They are created by the eager relationship-table pairs. | Taintwire |

### 2.2 Rich fixture (`rich.js`, 1,113 bytes)

The fixture covers var/let/const, nested scopes, function declarations and expressions, an arrow, a class with field,
private field, static field, static block, constructor, method and private method, a nested block with shadowing,
assignments, compound assignment and update, object and computed access, calls, arguments, returns, object and array
destructuring with defaults and rest, for-of, for-in, switch and try/catch.

It was saved to `.lbug`, reopened and introspected with `CALL show_tables()`, `table_info()` and `show_connection()`.

| Node type | Origin | Important properties | Semantic role | Count |
| --- | --- | --- | --- | --: |
| Identifier | Babel | `name`, `hash`, positions | binding (DECLARES target, IN_SCOPE source, REFERS_TO/READS/WRITES target, flow summary) or use (REFERS_TO source, FLOWS_TO node, ARGUMENT_TO source) | 98 |
| VariableDeclaration | Babel | `props.kind` | none directly. Its `kind` decides the var vs. lexical scope. | 19 |
| VariableDeclarator | Babel | | DECLARES and WRITES source, READS operation | 19 |
| Scope | **Taintwire** | `id`, `kind`, `file`, `signature`, `owner_signature` | scope tree | 18 |
| NumericLiteral | Babel | `value` (string) | FLOWS_TO / ARGUMENT_TO source | 15 |
| ExpressionStatement | Babel | | READS operation (`x;`) | 12 |
| BlockStatement | Babel | | scope owner, unless it is a function or catch body | 11 |
| MemberExpression | Babel | | READS operation (object, computed key). A value node (flows out, never in). | 10 |
| AssignmentExpression | Babel | `operator` | READS, WRITES, FLOWS_TO node | 6 |
| CallExpression | Babel | | CALLS source, RETURNS_TO target, READS operation, FLOWS_TO node | 6 |
| ReturnStatement | Babel | | FLOWS_TO target, RETURNS_TO source | 5 |
| BinaryExpression | Babel | `operator` | FLOWS_TO node, READS operation | 4 |
| ObjectProperty | Babel | `props.computed`, `props.shorthand` | READS operation (value or computed key). The static key is not a reference. | 4 |
| ArrayExpression, ObjectExpression | Babel | | READS operation. Flows out as a whole, with no element flow in. | 2, 1 |
| AssignmentPattern | Babel | | WRITES source (default value) | 2 |
| ClassMethod, ClassPrivateMethod | Babel | `props.kind`, `props.static` | DECLARES (params), scope owner. Never CALLS targets. | 2, 1 |
| PrivateName, ClassPrivateProperty, ClassProperty, ClassBody, ThisExpression | Babel | | structural only | 2, 1, 1, 1, 2 |
| RestElement, ArrayPattern, ObjectPattern | Babel | | structural. Their bindings are DECLARES targets of the declarator or function. | 2, 1, 1 |
| StringLiteral | Babel | `value` | value node | 2 |
| ArrowFunctionExpression, FunctionExpression, FunctionDeclaration | Babel | `props.async`, `props.generator` | DECLARES source, scope owner, CALLS target | 1 each |
| ClassDeclaration | Babel | | DECLARES (name in the outer scope), class-scope owner | 1 |
| CatchClause | Babel | | DECLARES (param), catch-scope owner | 1 |
| ForInStatement, ForOfStatement | Babel | | scope owner (lexical head), WRITES the target, READS the iterable | 1, 1 |
| SwitchStatement, SwitchCase | Babel | | switch is a block-scope owner, and its discriminant is read in the outer scope | 1, 1 |
| StaticBlock | Babel | | `static_block` scope owner (a var scope) | 1 |
| ConditionalExpression | Babel | | FLOWS_TO node (branches only) | 1 |
| UpdateExpression | Babel | `operator` | READS + WRITES, FLOWS_TO | 1 |
| IfStatement, TryStatement, BreakStatement | Babel | | structural. IfStatement reads its test. | 1 each |
| File, Program | Babel | `Program.props.sourceType` | root. Program owns the global or module scope. | 1, 1 |
| Source | **Taintwire** | `file` (PK), `code` | text storage for `code()` | 1 |

### 2.3 Node properties

All AST tables have one column set (confirmed: one distinct `table_info` signature across the 43 AST tables):

| Property | Meaning | On | Unique | Deterministic | Derived by |
| --- | --- | --- | --- | --- | --- |
| `id` (PK) | `<Type>_<16 random hex>`, one AST occurrence | all AST nodes | yes | **no** (random per import, preserved by save/reopen) | Taintwire |
| `type` | Babel type | all AST | no | yes | Babel |
| `file` | file name | all AST, Scope, Source | no | yes | Taintwire |
| `startOffset`/`endOffset`, `line`/`col`/`endLine`/`endCol` | position (UTF-16 offsets, 1-based lines) | all AST | (file, type, span) effectively unique | yes | Babel |
| `name`, `value`, `operator` | scalar Babel fields | where present | no | yes | Babel |
| `props` | JSON of the remaining fields, with children as `{type, slug_ref}` | all AST | no | no (embeds ids) | Taintwire |
| `hash` | CS-MAST-S Merkle digest of the subtree content | all AST (cs-mast) | **no** | yes | cs-mast |
| Scope `id` | `Scope_` + sha256(file, owner type, start, end)[:16] | Scope | yes | **yes** | Taintwire |
| Scope `kind` | global / module / function / block / catch / class / static_block | Scope | no | yes | Taintwire |
| Scope `signature` | sha256(`scope:<kind>:<owner hash>`) | Scope | **no** (content) | yes | Taintwire over cs-mast |
| Scope `owner_signature` | the owner's `hash` | Scope | no | yes | cs-mast |

**Signature vs. occurrence.** This was verified. In `let x = 1; x = x + x;`, all four `x` occurrences have the same
`hash`, while each READS/WRITES edge's `access` is a distinct `id` that points at the exact occurrence (flow test A18).

Nothing in the schema uses a hash as an occurrence key:

- `access` and `callsite` are node ids.
- `access_signature` is documented as content only.
- Scope `id` is positional; only `signature` is content-based.

## 3. Exact relationship inventory

There are 12 relationship tables. They match `RELATIONS` exactly, they exist from `open()`, and empty ones return
zero rows. Endpoint pairs below are those observed in the rich fixture and corpus (`show_connection`).

| Relation | Source types | Target types | Properties | Meaning | Status |
| --- | --- | --- | --- | --- | --- |
| SON | any AST node | any AST node | `key STRING`, `idx INT64` (−1 for scalar) | AST containment, parent to child | stable (fixed, #1) |
| DECLARES | VariableDeclarator, FunctionDeclaration/Expression, ArrowFunctionExpression, ObjectMethod, ClassMethod, ClassPrivateMethod, ClassDeclaration/Expression, Import(Default/Namespace)Specifier, CatchClause | Identifier | none | the node introduces this binding identifier | stable |
| CREATES_SCOPE | scope owners (§GRAPH_SCHEMA) | Scope | none | the owner creates this scope | stable |
| PARENT_SCOPE | Scope | Scope | none | child scope to enclosing scope | stable |
| IN_SCOPE | Identifier (binding) | Scope | none | the scope the binding lives in | stable |
| REFERS_TO | Identifier (use) | Identifier (binding) | none | lexical resolution | semantic |
| READS | the use's AST parent (any expression or statement) | Identifier (binding) | `access`, `access_signature` | the operation reads the binding at occurrence `access` | semantic |
| WRITES | VariableDeclarator, AssignmentExpression, UpdateExpression, ForIn/ForOfStatement, AssignmentPattern | Identifier (binding) | `access`, `access_signature` | the operation writes the binding at occurrence `access` | semantic |
| FLOWS_TO | value nodes (Identifier, literals, expressions, ReturnStatement, AssignmentExpression, ...) | value nodes | none | a value contributes to another value (flow-insensitive) | semantic, partial |
| CALLS | CallExpression, OptionalCallExpression | FunctionDeclaration, FunctionExpression, ArrowFunctionExpression | `candidates INT64` | may-call | semantic, partial |
| ARGUMENT_TO | argument expression (any value node) | Identifier (param binding) | `arg_index INT64`, `callsite STRING` (CallExpression id) | argument passed to the param at a specific call | semantic |
| RETURNS_TO | ReturnStatement, or a concise arrow body expression | CallExpression, OptionalCallExpression | none | returned value becomes the call's value | semantic |

Every relationship is deterministic, in the sense that the same source gives the same edge set (§18).

| Relation | Structural / semantic | Flow-sensitive? | Cycles? | Implementation (`src/index.ts`) |
| --- | --- | --- | --- | --- |
| SON | structural | n/a | no (a tree) | `flatten()` walk, `push("SON", …)` |
| DECLARES | structural-semantic | n/a | no | `declared()`, walk |
| CREATES_SCOPE | scope | n/a | no | `scopeKind()`, `scopeRow()` |
| PARENT_SCOPE | scope | n/a | no (a tree) | walk ctx |
| IN_SCOPE | scope | n/a | no | walk ctx (`varScope`/`scope`) |
| REFERS_TO | name resolution | no (no TDZ or hoisting order) | no | post-walk scope-chain lookup |
| READS | access | no | no | post-walk, from `uses` |
| WRITES | access | no | no | `facts()` → `f.writes` |
| FLOWS_TO | data flow | **no** (flow-insensitive) | **yes** (`x = x + 1`, loops) | `facts()` flows and stores, plus decl→use |
| CALLS | call graph | no | **yes** (recursion) | `leaves()`, Tarjan SCC `solve()`, `callables()` |
| ARGUMENT_TO | interprocedural | no, context-insensitive | yes, with FLOWS_TO (recursion) | the calls loop |
| RETURNS_TO | interprocedural | no, context-insensitive | yes | `returns` map (nearest function) |

## 4. Connection diagram (real schema)

```text
Source (storage only, no edges)

File ──SON{key:program}──> Program ──CREATES_SCOPE──> Scope{kind: global|module}  (root: no PARENT_SCOPE)
                              │                          ^
                             SON                         │ PARENT_SCOPE (child -> parent)
                              v                          │
 FunctionDeclaration ─CREATES_SCOPE─> Scope{function} ───┘
   │  ├─DECLARES──> Identifier f (name) ──IN_SCOPE──> enclosing Scope
   │  └─DECLARES──> Identifier p (param) ──IN_SCOPE──> the function's Scope
   │
   │SON ... VariableDeclarator ─DECLARES──> Identifier x:decl ──IN_SCOPE──> Scope (var scope or block)
   │              │      └────WRITES{access}──> x:decl
   │              └─ init value ──FLOWS_TO──> x:decl
   │
   │SON ... Identifier x (use) ──REFERS_TO──> x:decl
   │            ^   └──FLOWS_TO──> its parent expression ──FLOWS_TO──> ... ──> ReturnStatement
   │            │
   │       x:decl ──FLOWS_TO──> x (use)               parent op ──READS{access = use id}──> x:decl
   │
CallExpression ──CALLS{candidates}──> FunctionDeclaration | FunctionExpression | ArrowFunctionExpression
   │  argument[i] ──ARGUMENT_TO{arg_index: i, callsite: call id}──> p (param binding)
   └< ReturnStatement (owned by the callee) ──RETURNS_TO
       CallExpression ──FLOWS_TO──> whatever consumes it (binding, return, operator ...)
```

Dependency order, as computed in `flatten()`:

1. **SON** comes first.
2. **DECLARES**, **CREATES_SCOPE**, **PARENT_SCOPE** and **IN_SCOPE** are built during the walk.
3. **REFERS_TO** is built after the walk. It needs every binding and the scope tree.
4. **READS** comes next. It needs REFERS_TO.
5. **WRITES** needs REFERS_TO for uses and IN_SCOPE for declarations.
6. **FLOWS_TO** needs REFERS_TO and the binding summaries.
7. **CALLS** needs REFERS_TO and the definitions (WRITES values plus declarers).
8. **ARGUMENT_TO** and **RETURNS_TO** need CALLS.

## 5. Relation semantics

Notation: `d(x)` is the canonical binding Identifier of `x`, which is the earliest declaration of that name in its scope.

- **SON(p, c, key, idx)**: `c` is `p[key]` or `p[key][idx]` in the Babel AST.
  - Example: `f(a)` gives `Call -SON{callee,-1}-> f` and `Call -SON{arguments,0}-> a`.
  - Limitation: hashbangs stay in `Program.props`.
- **DECLARES(n, i)**: `i ∈ declared(n)`, the binding identifiers introduced by `n`.
  - Example: `const {a: b = 1} = o` gives `Declarator -DECLARES-> b`. There is no edge to the key `a`.
  - Limitation: TS `enum`/`namespace`/`import x = require()` declare nothing.
- **CREATES_SCOPE(o, s)** and **PARENT_SCOPE(s, s′)**: `o` creates `s`, and `s′` is the nearest enclosing scope.
  - Example: `function f(){ if(1){ let b } }` gives `Program→S0`, `f→S1 -PARENT-> S0`, and `Block→S2 -PARENT-> S1`.
  - Limitations: no separate parameter scope and no per-iteration scopes. A class's inner name is merged into the outer binding.
- **IN_SCOPE(i, s)**: binding `i` lives in `s`.
  - `var` goes to the nearest function, module, global or static-block scope.
  - Function or class *declaration* names go to the enclosing scope.
  - *Expression* names and params go to the node's own scope.
  - Example: §5 spec fixture `a → function, b, c → block` (verified).
- **REFERS_TO(u, d)**: `u` is a value-position Identifier, and `d = d(name)` in the nearest scope on `u`'s chain that binds the name.
  - Example: `let x; { let x; x }` resolves the inner use to the inner `x`.
  - Limitations: no TDZ; `with` and direct `eval` are ignored.
- **READS(op, d, access=u)**: `u` REFERS_TO `d`, `op` is `u`'s AST parent, and `u` isn't a pure `=` target or an `export {u}` specifier.
  - Example: `obj.foo = x` gives `MemberExpression -READS-> obj` and `AssignmentExpression -READS-> x`, and there is no WRITE.
- **WRITES(op, d, access=t)**: `op` assigns binding target `t`.
  - Example: `x += y` gives READS and WRITES of `x` from the AssignmentExpression with the same `access`.
- **FLOWS_TO(a, b)**: the value of `a` may become part of the value of `b`, or `b` is a binding written from `a`.
  - Example: `const z = c ? x : y` gives `x → Cond`, `y → Cond` and `Cond → z`, and no `c → Cond`.
- **CALLS(c, f, candidates=k)**: every definition the callee can evaluate to is a known function, and `f` is one of the `k` such functions.
  - Example: `let f = foo; f = bar; f()` gives two edges with `k = 2`.
- **ARGUMENT_TO(a, p, arg_index=i, callsite=c)**: `c` CALLS `f`, `a = c.arguments[i]`, and `p = d(param_i(f))`, where a rest param absorbs `i ≥ rest`.
  - Example: `f(x); f(y)` gives `x→p{callsite: c1}` and `y→p{callsite: c2}`.
- **RETURNS_TO(r, c)**: `c` CALLS `f`, `f` is neither async nor a generator, and `r` is a valued `return` whose nearest enclosing function is `f`, or the concise body of arrow `f`.
  - Example: a nested arrow's `return 'inner'` never reaches `outer()`.

## 6. Node semantics

- **AST nodes** are the Babel nodes themselves. Semantic edges reuse those exact nodes, so a DECLARES target is the
  same row SON reaches. Taintwire never creates AST nodes, and there are no synthetic declarations for globals.
- **Scope** is the only synthetic node. Its id is positional and deterministic. Its signature is content-based, so
  identical code in two places shares it.
- **Binding Identifier** (a DECLARES target) doubles as the variable's summary node in FLOWS_TO. All writes flow into
  it, and it flows to every read.
- **Signature vs. node id:**
  - `hash` and Scope `signature` are content addresses: deterministic, and shared by identical code.
  - Node `id` is an occurrence address: unique, random per import, and stable across save and reopen.
  - Relationship properties that point at occurrences use ids.

## 7. Test results

| | Before | After |
| --- | --: | --: |
| Test files | 5 | 6 (`src/validation.test.ts` added) |
| Tests | 158 | **164** |
| Passing | 158 | **164** |
| Failing | 0 | 0 |
| Skipped | 0 | 0 |
| Runtime (wall) | 33.3 s | 40.0 s (6 files) |

The new tests in `src/validation.test.ts` are:

1. **Regression for bug #1:** TS enum members, type arguments, `implements` and function types are walked, and
   remain non-references. This failed before the fix.
2. **No AST node is left inline in `props`** over every fixture. This also failed before the fix, on `component.tsx`.
3. **ARGUMENT_TO callsite provenance:** `f(x); f(y)` keeps `x` and `y` with their own `callsite`.
4. **Nested returns** never reach the outer call.
5. **Same-named functions** in different scopes resolve by scope.
6. **Extra global invariants:**
   - READS comes from the access's AST parent.
   - The READS access REFERS_TO the target.
   - SON `(parent, key, idx)` is unique.
   - A DECLARES target is under its declarer.
   - A RETURNS_TO source's *nearest* function is a CALLS target.

There are also 41 graph invariants (§16), checked outside the suite with
`scratchpad/invariants.mjs` on the fixtures, about 50 probe snippets and 32 real bundles: **0 violations
anywhere**.

## 8. Mutation-test results

Each mutation was applied alone to `src/index.ts`. The full suite was then run and the file restored.

| # | Mutation | Detected | Failing tests | Caught by (first few) |
|---|---|---|--:|---|
| 1 | shadowing: outermost binding wins | **yes** | 5 | G, H: members, builtins, params, imports and classes stay unresolved, ; 2: shadowing resolves to the inner declaration; A15: shadowing across global, param, block and catch scopes |
| 2 | obj.foo: static property name treated as lexical | **yes** | 4 | labels, property and method names, private names and meta properties a; A1: host globals stay unresolved; static property names never resolve,; A20: global invariants over every case |
| 3 | FLOWS_TO decl->use reversed | **yes** | 13 | interprocedural: one function, a two-function chain and nested calls; interprocedural: callsites are merged (context-insensitive), arguments; interprocedural: recursion and mutual recursion (cycles are expected) |
| 4 | argument index 0 mapped to parameter 1 | **yes** | 9 | G, H: members, builtins, params, imports and classes stay unresolved, ; ARGUMENT_TO: by position, with the argument index and callsite; ARGUMENT_TO: defaults, rest, missing, extra, spread and destructured p |
| 5 | CALLS resolved by name globally (unresolved callee looked up in any scope) | **yes** | 2 | G, H: members, builtins, params, imports and classes stay unresolved, ; a nested function's return never reaches the outer function's callsite |
| 6 | nested-function return owned by the outermost function | **yes** | 3 | RETURNS_TO: every explicit return of the callee, and nothing else; a nested function's return never reaches the outer function's callsite; invariants: READS from the access's parent, RETURNS_TO from the callee |
| 7 | conditional test flows into the result | **yes** | 1 | 15: a conditional's test is read but doesn't flow |
| 8 | whole-container destructuring flow | **yes** | 1 | A12: destructuring declarations read and write, with no whole-object f |
| 9 | var bound in the block scope instead of the var scope | **yes** | 4 | D var vs let/const: function foo() { if (true) { var x = 1; let y = 2;; D top-level block: { var x; let y; }; catch body var escapes to the var scope: function f() { try {} catch ( |
| 10 | compound assignment target not read | **yes** | 4 | 6: compound assignment reads and writes the target; 7: logical assignments read and write the target; A8: compound and logical assignment results flow back into the target |
| 11 | async/generator returns allowed | **yes** | 1 | RETURNS_TO: async functions and generators return a promise or an iter |
| 12 | Babel 7 child keys not walked (bug #1 regression) | **yes** | 2 | regression: cs-mast's Babel 7 child keys are walked (TS enum members, ; no AST node is left inline in props, over every fixture |
| 13 | CALLS partial resolution (unknown definitions ignored) | **yes** | 1 | F: a binding with several known functions may call each, and says so |

**13 / 13 mutations detected**, all by real assertion failures (not timeouts or crashes). The six mutations the brief required are #1–#6. Weakly guarded (caught by a single test): conditional-test flow, whole-container destructuring flow, async/generator returns, partial CALLS resolution. Mutation #5 (global by-name CALLS) was caught by only one pre-existing test (`G, H`) plus one new validation test. The run harness is `scratchpad/mutate.mjs`, outside the repo. An earlier run was discarded because vitest's default 10 s `hookTimeout` expired under load and was misread as detection. The final run used `--hookTimeout=120000`.

## 9. Real-world bundle results

**33 targets** were selected:

- 30 built artifacts from `js-recon-research`: generic, webpack, React (webpack, Vite, Parcel, rsbuild, React 0.14, 18
  and 19), jQuery, Vue 3 (three apps), Nuxt 3, SvelteKit, Angular.
- 3 production **Next.js** chunks from `js-recon-tests/data/16471`, a recorded real-world Next.js site. No Next.js app
  in js-recon-research has build output.

**32 imported**. The 33rd (Nuxt 2 legacy) was a target-selection error by this run: `pages/` contains only
subdirectories. It is not a Taintwire failure.

**Totals:**

| Measure | Value |
| --- | --: |
| Source bytes | 6.76 MB |
| Nodes | 976,361 |
| Edges | 2,248,426 |
| Calls | 54,957 |
| Calls resolved | 25,881 (**47.1 %**) |
| Invariant violations | 0, on every target |
| Save/reopen counts | identical, on every target |

Polymorphic calls (`candidates > 1`) are rare.

| # | Framework | Bundler | File | Bytes | Import | Nodes | Types | Scopes | DECLARES | REFERS_TO | READS | WRITES | FLOWS_TO | CALLS | ARG_TO | RET_TO | Calls resolved | Unres. refs | Save | DB | Reopen | Invariants |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | generic | plain Node | `server.js` | 1,779 | 0.2 s | 162 | 17 | 6 | 16 | 23 | 23 | 8 | 47 | 0 | 0 | 0 | 0/16 (0%) | 5 | 0.7 s | 7 MB | ✓ | ✓ |
| 2 | webpack | webpack 5 | `index.bundle.js` | 616 | 0.2 s | 142 | 21 | 7 | 9 | 13 | 13 | 5 | 30 | 2 | 1 | 0 | 2/12 (17%) | 6 | 0.7 s | 7 MB | ✓ | ✓ |
| 3 | React | webpack | `main.8a907a4f3c1e732e4d9d.js` | 22,223 | 1.2 s | 7,032 | 43 | 237 | 457 | 1,552 | 1,432 | 366 | 3,316 | 76 | 116 | 81 | 66/390 (17%) | 95 | 4.4 s | 66 MB | ✓ | ✓ |
| 4 | React (react-dom vendor) | webpack | `vendor-react-dom.fe25c8e6e5bea3a0f43b.js` | 178,115 | 6.1 s | 58,674 | 44 | 1,422 | 2,861 | 15,886 | 13,830 | 3,355 | 33,751 | 1,832 | 3,645 | 1,880 | 1,832/2,781 (66%) | 341 | 10.9 s | 135 MB | ✓ | ✓ |
| 5 | React (async chunk) | webpack | `132.ee8385c57d5efc2cf00d.js` | 5,209 | 0.5 s | 1,043 | 37 | 32 | 60 | 149 | 137 | 38 | 320 | 10 | 15 | 8 | 10/60 (17%) | 14 | 2.3 s | 25 MB | ✓ | ✓ |
| 6 | React | Vite | `index-BpDs_mxk.js` | 3,245 | 0.5 s | 879 | 33 | 34 | 40 | 131 | 131 | 23 | 235 | 15 | 14 | 12 | 15/90 (17%) | 6 | 1.6 s | 20 MB | ✓ | ✓ |
| 7 | React (route chunk) | Vite | `Post-Ck0sG56A.js` | 3,633 | 0.5 s | 1,099 | 37 | 15 | 33 | 91 | 90 | 18 | 162 | 0 | 0 | 0 | 0/65 (0%) | 5 | 1.7 s | 21 MB | ✓ | ✓ |
| 8 | React | Vite | `index-DoBs2Sa7.js` | 192,997 | 7.8 s | 66,176 | 52 | 1,631 | 3,211 | 17,500 | 15,364 | 3,604 | 36,688 | 1,943 | 3,818 | 1,850 | 1,937/3,045 (64%) | 414 | 12.1 s | 147 MB | ✓ | ✓ |
| 9 | React 0.14 | webpack | `main.c77438c17e412109fa00.js` | 128,599 | 4.4 s | 36,955 | 45 | 994 | 2,981 | 7,410 | 7,123 | 1,699 | 14,921 | 226 | 417 | 223 | 221/2,076 (11%) | 200 | 8.3 s | 116 MB | ✓ | ✓ |
| 10 | React 18 | webpack | `main.5607a80fa94755dcec68.js` | 141,059 | 4.9 s | 46,881 | 45 | 1,219 | 2,485 | 12,447 | 10,782 | 2,795 | 26,642 | 1,343 | 2,593 | 1,422 | 1,335/2,073 (64%) | 302 | 9.5 s | 125 MB | ✓ | ✓ |
| 11 | React 19 | Vite | `index-DKy0_WTS.js` | 186,318 | 7.2 s | 61,606 | 46 | 1,536 | 3,097 | 16,867 | 14,763 | 3,536 | 35,270 | 1,854 | 3,655 | 1,801 | 1,848/2,865 (65%) | 371 | 12.8 s | 139 MB | ✓ | ✓ |
| 12 | React | Parcel | `public.d52476b0.js` | 144,901 | 5.9 s | 47,936 | 45 | 1,340 | 2,583 | 12,744 | 10,937 | 2,936 | 27,216 | 1,393 | 2,840 | 1,370 | 1,385/2,120 (65%) | 304 | 9.6 s | 126 MB | ✓ | ✓ |
| 13 | React | rsbuild (rspack) | `index.97c967a1.js` | 1,272 | 0.5 s | 560 | 35 | 18 | 45 | 132 | 121 | 40 | 255 | 2 | 1 | 2 | 2/34 (6%) | 6 | 2.0 s | 19 MB | ✓ | ✓ |
| 14 | jQuery | Vite chunk | `jquery-C_VVYSll.js` | 87,941 | 3.4 s | 31,262 | 45 | 739 | 1,859 | 7,609 | 6,868 | 1,459 | 16,500 | 403 | 655 | 449 | 396/1,755 (23%) | 148 | 7.6 s | 108 MB | ✓ | ✓ |
| 15 | React (route chunk) | Vite | `Search-_iURM8gp.js` | 40,443 | 1.6 s | 11,594 | 43 | 283 | 834 | 2,498 | 2,325 | 632 | 6,188 | 191 | 220 | 354 | 191/595 (32%) | 307 | 5.2 s | 77 MB | ✓ | ✓ |
| 16 | Vue 3 | Vite | `index-C82FLvsE.js` | 91,574 | 3.9 s | 34,284 | 54 | 1,168 | 2,851 | 9,093 | 8,717 | 1,825 | 17,637 | 1,200 | 2,224 | 1,021 | 1,180/2,226 (53%) | 264 | 8.6 s | 126 MB | ✓ | ✓ |
| 17 | Vue 3 + Pinia | Vite | `index-ClgQKJim.js` | 101,479 | 4.4 s | 38,553 | 57 | 1,353 | 3,199 | 10,143 | 9,699 | 2,023 | 19,687 | 1,313 | 2,367 | 1,170 | 1,293/2,523 (51%) | 322 | 10.1 s | 131 MB | ✓ | ✓ |
| 18 | Vue 3 (route chunk) | Vite | `CartView-3BdJ2z66.js` | 1,464 | 0.4 s | 493 | 27 | 12 | 35 | 94 | 93 | 13 | 157 | 0 | 0 | 0 | 0/58 (0%) | 0 | 1.2 s | 12 MB | ✓ | ✓ |
| 19 | Vue 3 options API | Vite | `index-CIz1io0l.js` | 105,157 | 4.9 s | 40,138 | 56 | 1,347 | 3,328 | 10,701 | 10,235 | 2,170 | 20,774 | 1,403 | 2,548 | 1,198 | 1,383/2,624 (53%) | 344 | 10.8 s | 132 MB | ✓ | ✓ |
| 20 | Nuxt 3 (client entry) | Vite | `C0BQX5ee.js` | 198,431 | 7.6 s | 70,525 | 63 | 2,401 | 5,471 | 17,075 | 16,355 | 3,544 | 33,731 | 2,177 | 3,566 | 2,082 | 2,153/4,561 (47%) | 796 | 15.6 s | 173 MB | ✓ | ✓ |
| 21 | Nuxt 3 (server chunk) | Vite/Nitro | `fetch-Dj2TLp3p.js` | 17,006 | 1.1 s | 2,714 | 49 | 140 | 173 | 530 | 522 | 98 | 926 | 18 | 34 | 24 | 18/139 (13%) | 37 | 3.7 s | 43 MB | ✓ | ✓ |
| 22 | Nuxt 2 (legacy, client) | webpack 4 | `nuxt/nuxt2-legacy-app/.nuxt/dist/client/pages (/\.js$/)` | ERROR: not found |
| 23 | SvelteKit (client chunk) | Vite | `D7hspacH.js` | 32,396 | 2.6 s | 11,132 | 58 | 335 | 792 | 2,266 | 2,117 | 536 | 4,533 | 185 | 231 | 183 | 183/594 (31%) | 243 | 6.4 s | 86 MB | ✓ | ✓ |
| 24 | SvelteKit (server) | Vite | `index-CXAd9s1W.js` | 185,883 | 3.4 s | 24,733 | 66 | 1,147 | 1,652 | 4,841 | 4,652 | 1,088 | 9,139 | 357 | 589 | 490 | 352/1,334 (26%) | 382 | 8.7 s | 124 MB | ✓ | ✓ |
| 25 | SvelteKit adapter-node | Rollup | `handler.js` | 41,016 | 1.3 s | 5,156 | 62 | 173 | 277 | 804 | 751 | 187 | 1,536 | 44 | 59 | 62 | 44/258 (17%) | 58 | 5.2 s | 59 MB | ✓ | ✓ |
| 26 | SvelteKit (client chunk) | Vite | `BSFrUaz7.js` | 47,429 | 2.5 s | 15,818 | 60 | 518 | 1,156 | 3,285 | 3,058 | 785 | 6,626 | 321 | 434 | 445 | 317/947 (33%) | 355 | 7.2 s | 102 MB | ✓ | ✓ |
| 27 | Angular (main) | esbuild | `main-R2OIKKQA.js` | 256,105 | 7.2 s | 73,048 | 61 | 2,920 | 5,330 | 12,661 | 12,340 | 2,182 | 24,635 | 953 | 1,661 | 1,249 | 953/5,253 (18%) | 429 | 14.0 s | 171 MB | ✓ | ✓ |
| 28 | Angular (chunk) | esbuild | `chunk-M4T5QPYK.js` | 159,029 | 6.1 s | 54,183 | 60 | 2,355 | 5,102 | 13,111 | 12,516 | 2,541 | 25,300 | 1,874 | 3,344 | 1,708 | 1,871/3,337 (56%) | 260 | 12.4 s | 158 MB | ✓ | ✓ |
| 29 | Angular polyfills (zone.js) | esbuild | `polyfills-5CFQRCPP.js` | 34,585 | 1.9 s | 10,944 | 50 | 418 | 875 | 2,691 | 2,607 | 561 | 5,355 | 154 | 285 | 118 | 154/482 (32%) | 99 | 5.4 s | 81 MB | ✓ | ✓ |
| 30 | Angular dev build + inline sourcemap | esbuild | `main.js` | 3,822,022 | 14.0 s | 139,036 | 62 | 7,628 | 11,506 | 30,746 | 29,858 | 6,021 | 55,752 | 4,961 | 8,964 | 4,594 | 4,957/8,584 (58%) | 1,896 | 22.6 s | 226 MB | ✓ | ✓ |
| 31 | Next.js (webpack runtime) | webpack (Next.js) | `webpack-66270684c580d69d.js` | 7,962 | 0.8 s | 1,511 | 35 | 54 | 88 | 342 | 321 | 67 | 731 | 15 | 8 | 11 | 11/77 (14%) | 31 | 4.1 s | 31 MB | ✓ | ✓ |
| 32 | Next.js (framework / React) | webpack (Next.js) | `framework-4556c45dd113b893.js` | 293,897 | 6.4 s | 46,741 | 43 | 1,204 | 2,452 | 12,385 | 10,723 | 2,776 | 26,688 | 1,333 | 2,581 | 1,410 | 1,325/2,044 (65%) | 295 | 9.4 s | 124 MB | ✓ | ✓ |
| 33 | Next.js (shared chunk) | webpack (Next.js) | `727-633ffe50c209b966.js` | 230,112 | 4.3 s | 35,351 | 54 | 951 | 2,421 | 7,553 | 7,168 | 1,612 | 18,296 | 457 | 861 | 648 | 447/1,939 (23%) | 833 | 11.3 s | 120 MB | ✓ | ✓ |

"Unres. refs" counts value-position Identifiers with no lexical binding: host globals such as `Object`, `Error`,
`Symbol`, `window`, `document`, `arguments` and `ngDevMode`. None of them received a declaration.

**Manually inspected resolved calls and paths:**

- **React/webpack:** `u(434)` resolves to the webpack require function `function u(e){var n=i[e]…}`. The outer bundle
  IIFE and minified local helpers resolve, for example `r(c) → function r(e){return 0===e.length?null:e[0]}`.
- **Next.js shared chunk:** `m(this, e, t, r, !1)` resolves to the local `function m(e, t, r, n, o)`. The babel
  helper IIFE `(function () { throw new TypeError("Invalid attempt to spread non-iterable…") })` also resolves.
- **SvelteKit:** `p(_.href)` resolves through an alias to `function(...h){…}` (a rest param). `wt(g.url)` resolves.
- **Interprocedural paths:** in each of the three bundles there are paths of the form
  `arg -ARGUMENT_TO-> param -FLOWS_TO-> … ReturnStatement -RETURNS_TO-> call`.
- **Return ownership:** the invariant checker confirmed that every RETURNS_TO source's *nearest* function is a CALLS
  target of the call, on all 32 bundles.

**Import success is not semantic correctness.** Most framework data flow goes through property access, imports or
callbacks (§11, §13), and none of that is in the graph.

## 10. Supported call forms

Each form below resolves to a CALLS edge, with ARGUMENT_TO and RETURNS_TO where they apply. All were verified by probe
and test.

- Function declaration (`function foo(){}; foo()`), including a hoisted call before the declaration.
- Function or arrow expression through `const`, `let` or `var`, including `var f = function(){}` called before it.
- IIFEs:
  - `(function(){})()`
  - `(() => x)()`
  - `!function(){}()`
  - `(h = function(){})()`
- Aliases and alias chains (`const bar = foo; bar()`), including cycles (`f = g; g = f`), solved by Tarjan SCC in
  linear time.
- Callee wrappers:
  - `(0, f)()`
  - `c ? foo : bar` and `foo || bar` (when every leaf is known)
  - TS `f!()` and `(f as any)()`
- `f?.()`.
- Reassigned variables with only known functions (`let f = foo; f = bar; f()`): a may-call with `candidates = 2`.
- Recursion, mutual recursion, and a named function expression calling itself.
- Same function name in different scopes, resolved by scope (test added).

## 11. Unsupported call forms (no CALLS edge)

Shares are from the corpus: unresolved calls by cause, 29,076 calls in total.

| Cause | Share | Examples | Missing capability |
| --- | --: | --- | --- |
| member on a local object, `this` or an expression | 57.7 % | `obj.m()`, `this.x()`, `a[k]()`, `e.exports.f()` | property / points-to analysis |
| local variable with an unknown definition | 10.2 % | `const {f} = o; f()`, `let f; [f] = …`, `f = obj.m; f()`, `f += …` | reaching definitions plus property analysis |
| member on an unresolved global (host API) | 7.9 % | `document.getElementById()`, `Object.keys()`, `JSON.parse()` | host and builtin models |
| import binding | 5.4 % | `import { d as t } from "./chunk.js"; t()` | cross-module linking |
| global, host or undeclared | 5.2 % | `fetch()`, `setTimeout()`, `require()`, `eval()` | builtin models (deliberately no fake declarations) |
| `.call`/`.apply`/`.bind` | 3.9 % | `f.call(null, x)`, `f.bind(o)()` | `Function.prototype` models |
| param / callback | 3.7 % | `function run(cb){ cb() }` | higher-order flow (callables through ARGUMENT_TO) |
| param called with a literal id | 2.4 % | webpack `t(540)`, `n(338)` inside module factories | bundler module semantics |
| Promise `then`/`catch`/`finally` | 1.3 % | `p.then(cb)` | Promise / callback semantics |
| `(0, ns.fn)()` namespace call | 0.9 % | `(0, i.useState)()`, `(0, x.jsx)()` | property analysis on module namespaces |
| curried `f()()` | 0.7 % | `f()(1)` | callables through RETURNS_TO |
| `super()`, `import()` | 0.6 % | | constructor / dynamic import models |
| other callee shapes | <0.2 % | `(c || foo)()` with unknown `c`, `this()` | |

These are also never calls in the model: `new F()`, tagged templates, getters and setters, function declarations in
blocks called outside the block (no Annex B), and calls across files.

## 12. Supported flow forms (FLOWS_TO)

- Initializer to binding (`const x = y`).
- Assignment `x = y`: `y → AssignmentExpression → x`. The assignment's own value flows on, so nested assignments
  chain (`y = (x = s)`).
- Compound and logical assignment (`+=`, `||=`, `&&=`, `??=`): both operands flow, and the target is read and written.
- `x++`/`--x`: read, write and flow, forming a cycle with the binding.
- Binding to every resolved read occurrence.
- Operators:
  - binary, logical and template operands
  - unary except `void` and `delete`
  - the last element of a sequence
  - both branches of `?:`, but **not the test**, so there is no implicit flow
  - TS value wrappers
- `return e` → ReturnStatement.
- A default value to its param (`function f(p = d)`) or destructured binding (`{a = 1}`).
- Interprocedural:
  - argument → param (ARGUMENT_TO)
  - ReturnStatement or concise body → call (RETURNS_TO)
  - call → consumer (FLOWS_TO)

**Verified paths:**

| Case | Result |
| --- | --- |
| `source → a → a-use → b → b-use → c` | found |
| `x = x + 1` cycle | queries with `ACYCLIC`/`TRAIL`/`SHORTEST` terminate. `TRAIL 1..30` over all e2e probes takes 24 ms. |
| `pass(x)` | `source -FLOWS-> a -FLOWS-> a-use -ARG-> x -FLOWS-> x-use -FLOWS-> return -RET-> pass(a) -FLOWS-> b -FLOWS-> sink arg` |
| `a(x){return b(x)}`, `b(y){return y}` | `source -ARG-> x … -ARG-> y … -RET-> b(x) -FLOWS-> return -RET-> a(source) -FLOWS-> z` |
| `location.search → eval(q)` | found, with the source and sink matched structurally |
| `location.search → el.innerHTML = q` | found, with the source and sink matched structurally |
| `location.search → fetch("/api?q=" + q)` | found, with the source and sink matched structurally |
| `render(q){ el.innerHTML = v }` | found |
| `fetch(build(location.search))` | found |

## 13. Unsupported flow forms (deliberately absent; verified absent)

- **Destructuring:** `const {search} = location`, `const [first] = values`, `[a, b] = values`. WRITES only, with no
  flow from the container.
- **Iteration:** `for (x of xs)` and `for (k in o)`. WRITES only.
- **Property reads and writes:** `obj.foo`, `obj[k]`, `obj.foo = x`. The member expression is a value source, but
  nothing flows into it, and nothing written to a property is read back.
- **Literal contents:** object and array elements, and spread. The literal flows out as a whole; its elements don't
  flow in.
- **`await`, `yield`, `new`, tagged templates.**
- **Unresolved calls:** arguments don't flow into the call result.
- **Async and generator returns:** no RETURNS_TO.
- **Destructured params:** no ARGUMENT_TO.
- **Arguments at or after a spread:** no ARGUMENT_TO.
- **`arguments[i]`:** no flow.
- **Cross-file or cross-module flow.**
- **Control and implicit flow:** conditional tests, `if` conditions, switch discriminants.

No whole-container FLOWS_TO shortcut exists. A mutation that adds one is caught (§8).

## 14. Known over-approximations

- **Flow-insensitive bindings.** Every write reaches every read, including dead code and writes that happen after the
  read.
- **Context-insensitive calls.** `id(s1)`/`id(s2)` share `id`'s param and return, so `s1` reaches `b` (tested).
- **May-call sets** (`candidates > 1`). Every candidate gets the arguments. This includes duplicate `function f`
  declarations in one scope (`candidates: 2`), although the last one wins at runtime.
- **Rest params** summarise every tail argument.
- **Script-mode top-level functions** are assumed not to be overwritten by other scripts.
- **Derived values that carry little of their operand:** `typeof x`, `!x`, `x === y`, `"a" in o`, `x instanceof C`
  all flow (BinaryExpression and UnaryExpression are uniform).
- **Static resolution ignores runtime rebinding:** `with` and direct `eval`.
- **Var shadowing in default params:** `function f(a = () => x) { var x }` resolves `x` to the body `var`, because
  there is no separate parameter scope.
- **Catch redeclaration:** `catch (e) { var e = 1 }` writes the function-level `e`.

## 15. Known under-approximations

- **Everything in §11 and §13.**
- **All-or-nothing CALLS.** One unknown definition (a param default, a destructured write, `f += …`) drops the whole
  call.
- **Annex B block functions** called outside their block.
- **TS:** `enum`/`namespace` bindings aren't declared, so `E.A` has an unresolved `E`. JSX element names
  (`JSXIdentifier`) aren't resolved; `{expr}` containers are.
- **Class inner-name binding** is merged with the outer one, which is usually harmless.
- **`MetaProperty.meta`** (`new`/`import` in `new.target` and `import.meta`) is treated as a reference position. It
  never resolves, because those names can't be bound, and stats tooling must exclude it, as `graph:stats` does.

## 16. Bundle-specific blockers

These patterns come from the corpus categorisation and from manual inspection:

1. **Webpack module factories.**
   - Modules are invoked as `a[e](t, t.exports, u)`, a member call.
   - Modules require each other through the factory param (`t(540)`, 686 calls), with `t.n`/`t.d`/`t.r` helpers and
     `t.e(id).then(t.bind(t, id))` chunk loading.
   - The runtime's own `u(434)` require function does resolve.
   - **Needed:** module-id → factory recovery, plus `exports` modelling.
2. **ESM chunk imports** (Vite, Rollup, esbuild, Angular): cross-chunk `import { a as b }` gives 1,578 unresolved
   calls. **Needed:** multi-file import/export linking.
3. **Namespace and interop calls:** `(0, i.useState)()`, `(0, x.jsx)()`, and `e.default`.
4. **Framework runtimes call app code through callbacks:** `useEffect(cb)`, Vue `setup`, Svelte component factories,
   Angular DI and zone.js patches. App functions are values passed to unresolved calls, so they are never CALLS
   targets.
5. **Reactive proxies and stores** route values through properties: Vue `reactive` and `ref().value`, Svelte stores,
   Angular signals.
6. **Next.js:** the runtime is webpack with `self.webpackChunk_N_E.push(...)` registration. Both chunks are blocked by
   item 1. `framework-*.js` (React) resolves 65 % of its internal calls; app chunks only 23 %.
7. **Minification is not a blocker.** Short names resolve fine. Re-use of the same short name in sibling scopes was
   verified to resolve by scope, never by name.

## 17. Performance observations

| Input | Bytes | AST nodes | Graph edges | Parse (cs-mast) | `flatten()` (all semantics) | Import (total) | Save | DB size |
| --- | --: | --: | --: | --: | --: | --: | --: | --: |
| tiny: `rich.js` | 1,113 | 247 + 18 Scope | 570 | ≈ 10 ms | ≈ 2 ms | ≈ 0.2 s | 0.7 s | 13.9 MB |
| tiny: webpack basic_app | 616 | 142 | 236 | 4 ms | 1 ms | 0.2 s | 0.7 s | 6.7 MB |
| medium: React webpack main | 22,223 | 7,032 | 15,357 | 86 ms | 35 ms | 1.2 s | 4.4 s | 66 MB |
| large: React 19 / Vite | 186,318 | 61,606 | ~143k | 541 ms | 256 ms | 7.2 s | 12.8 s | 139 MB |
| largest: Angular dev build + inline sourcemap | 3,822,022 | 139,036 | 318,198 | 1,245 ms | 605 ms | 14.0 s | 22.6 s | 226 MB |

- **The analysis is cheap.** `flatten()` takes about 4 % of import time. Ladybug `COPY` loading (one per node type and
  per (rel, from, to) pair) and `save()` dominate.
- **DB files are large:** at least about 6.7 MB each, and about 700 bytes per edge.
- **Measured `flatten()` scaling** (time per doubling of n):

| Shape | Per doubling | Assessment |
| --- | --- | --- |
| N params × N calls | ≈ 2× | linear |
| N returns × N/8 callsites | ≈ 3.5–4× | output-bound. Edges = returns × callsites, by construction of context-insensitive RETURNS_TO. |
| N/8 candidates × N/8 callsites | ≈ 3.5–4× | output-bound, for the same reason (CALLS and ARGUMENT_TO per candidate) |
| **N nested blocks, each reading a top-level binding** | ≈ 3.6× (57 ms → 1.9 s at depth 8,000) | **O(uses × scope depth)**. The REFERS_TO scope-chain walk isn't memoised. |

  Real code never nests that deep, and Babel's recursive parser overflows the default stack at about 1,000–2,000
  nesting levels before this matters. **Not optimised.** A per-scope name cache would fix it if it ever shows up.
- **Edge blow-up risk** when a function with many returns is called from many sites. Per-function summary nodes would
  cap it, but that's a design change, so it is listed as future work.

## 18. Save / reopen / determinism

**Save and reopen.** `save()` → `close()` → `TaintGraph.open()` preserves:

- every node with its `id`, `hash` and `props`
- all 12 relationship types, with all properties (`key`, `idx`, `access`, `access_signature`, `candidates`,
  `arg_index`, `callsite`)
- Scope rows and the Source text, so `code(id)` works after reopening

This was verified two ways:

- edge-by-edge, position-keyed with properties, on `rich.js` and the React webpack main bundle
- as count equality on all 32 corpus bundles

A reopened graph also accepts new files (existing tests).

**Determinism.** Two independent imports of the same source were compared:

| Aspect | Deterministic? |
| --- | --- |
| Merkle `hash` | **yes**: identical for every node |
| Node `id` | **no**: 0 of 7,032 ids shared between imports. Random by design. Stable across save/reopen. |
| Scope `id`, `kind`, `signature`, `owner_signature` | **yes**: identical. `signature` is also identical for the same code under another filename. |
| Edge set (position-keyed, with `access` and `callsite` mapped to positions) | **yes**: identical (570 and 15,357 edges) |
| Relationship metadata | `key`, `idx`, `arg_index`, `candidates` and `access_signature` are deterministic. `access` and `callsite` hold node ids, so they are deterministic *up to the id mapping*. |
| Parser parity | cs-mast and babel give the same semantic edges by position (existing tests). Babel 8 calls `import()` an `ImportExpression`. |

## 19. Bugs found during validation

1. **cs-mast subtrees under Babel-7-only child keys were dropped from the graph.**
   - **Cause:** Taintwire walked children using `@babel/types` **8** `VISITOR_KEYS`, but the default parser
     (cs-mast) produces a Babel **7.29** AST, and the child keys differ.
   - **Affected keys:**
     - `TSEnumDeclaration.members`
     - `typeParameters` on `CallExpression`, `NewExpression`, `OptionalCallExpression`, `TaggedTemplateExpression`,
       `JSXOpeningElement` and `TSTypeReference`
     - `ClassDeclaration`/`ClassExpression.superTypeParameters`
     - `TSExpressionWithTypeArguments` (it has no Babel 8 keys at all)
     - `parameters`/`typeAnnotation` on TS function and method signatures
     - `TSImportType.argument`
     - `TSMappedType.typeParameter`
     - legacy import `assertions`
   - **Effect:**
     - Those nodes never became graph nodes or SON targets.
     - Their raw Babel objects, including the 4.6 KB cs-mast signature each, were serialised into the parent's
       `props`. A two-member `enum` produced a 28.9 KB `props` string with no `TSEnumMember` nodes.
     - The `babel` parser was unaffected.
   - **Impact:** TypeScript and JSX-with-generics input, and the `component.tsx` fixture. **JavaScript bundles were
     not affected**, since the JS keys match, and corpus counts are unchanged.
   - **Semantic impact:** none. Everything under these keys is type-level, and it remains non-referencing after the
     fix (asserted).

No other implementation bugs were found. The remaining items in §14 and §15 are documented design limits, not defects.

**Measurement mistakes during this audit,** recorded for honesty:

- The first mutation run, started concurrently with a corpus inspection, misreported file-level timeouts as
  detections. It was discarded and re-run alone, with a corrected harness.
- One corpus target path was wrong (Nuxt 2).

## 20. Bugs fixed during validation (uncommitted)

| Bug | Fix | Test |
| --- | --- | --- |
| #1 dropped Babel 7 subtrees | `src/index.ts`: walk `CHILD_KEYS`, the union of Babel 8's and cs-mast's Babel 7 `VISITOR_KEYS` (7 lines) | `validation.test.ts`: "regression: cs-mast's Babel 7 child keys are walked…" and "no AST node is left inline in props…". Both failed before the fix. |

Other working-tree additions:

- `src/validation.test.ts` (6 tests)
- `scripts/graph-stats.mjs` and the `npm run graph:stats -- <file.lbug>` script in `package.json`
- `VALIDATION_REPORT.md` and `GRAPH_SCHEMA.md`

## 21. Remaining bugs

There are no known correctness bugs in what is emitted. These residual issues remain:

| Issue | Why it isn't fixed here |
| --- | --- |
| `Program.interpreter` (hashbang) stays inline in `props` | Neither Babel version visits it, so cs-mast doesn't hash it. Making it a node would give the graph its only unhashed node. Harmless. |
| `MetaProperty.meta` Identifiers count as reference positions | Never resolvable. Affects only unresolved-reference statistics. |
| Duplicate `function f` declarations give `candidates: 2` | The last one wins at runtime. This is a documented over-approximation, not a crash or invariant break. |
| Quadratic REFERS_TO lookup on pathologically deep nesting | Not reachable within Babel's parse depth on real code. |

## 22. Recommended next semantic layer

**First: cross-module linking, including bundler module recovery.** This is the largest *structural* blocker:

- ESM `import`/`export` between files in one graph (5.4 %)
- webpack and Next.js factory-param `require(id)` with module-id → factory mapping (2.4 % directly, plus most
  `e.exports.f()` member calls)

It turns "bound, unknown definition" into real CALLS, ARGUMENT_TO and RETURNS_TO, and it is purely lexical and
structural once module ids are mapped.

**Then: property and heap flow** (`docs/docs/implementation/property-design.md`). It is the largest bucket overall
(57.7 % member calls plus namespace calls), but it needs allocation-site points-to analysis to be sound.

**Then:** host and builtin summaries (`then`, `call`/`apply`/`bind`, `JSON.*`, `String.prototype.*`), followed by
source, sink and sanitizer rules over `FLOWS_TO|ARGUMENT_TO|RETURNS_TO`.

## Appendix: queries used for stats

These are also built into `npm run graph:stats -- file.lbug`:

```cypher
CALL show_tables() RETURN *;                         // node + rel tables
CALL table_info('Identifier') RETURN *;              // columns
CALL show_connection('FLOWS_TO') RETURN *;           // FROM/TO pairs
MATCH (x) RETURN label(x) AS t, count(*) ORDER BY 2 DESC;
MATCH ()-[e:CALLS]->() RETURN count(e);              // per relation, for each name in RELATIONS
MATCH (s:Scope) RETURN s.kind, count(*);
// unresolved references
MATCH (p)-[s:SON]->(i:Identifier)
WHERE NOT EXISTS { MATCH (i)-[:REFERS_TO]->() } AND NOT EXISTS { MATCH ()-[:DECLARES]->(i) }
  AND NOT (s.key IN ['property','key'] AND NOT p.props CONTAINS '"computed":true')
  AND NOT s.key IN ['label','imported','exported','meta'] AND NOT label(p) STARTS WITH 'TS' AND label(p) <> 'PrivateName'
RETURN i.name, count(*) ORDER BY 2 DESC;
// unresolved calls by callee type
MATCH (c)-[:SON {key:'callee'}]->(x)
WHERE label(c) IN ['CallExpression','OptionalCallExpression'] AND NOT EXISTS { MATCH (c)-[:CALLS]->() }
RETURN label(x), count(*);
```
