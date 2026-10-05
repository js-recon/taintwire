---
sidebar_position: 11
title: Testing
---

# Testing

```bash
npm install
npm test        # vitest run, 30s per-test timeout
npm run build   # tsc into build/
```

## Fixtures (`test/`)

| File | What it exercises |
| --- | --- |
| `webpack-vue.js` | A real-world-shaped webpack 4 JSONP chunk with a Vue component: deep nesting, minified names, numeric module ids |
| `modern.js` | Modern syntax: classes, private fields, async generators, optional chaining, destructuring and so on |
| `component.tsx` | TypeScript and JSX together |

## Suites

### `src/index.test.ts`: the API and the graph shape

- **AST graph**: a `File -> Program -> ExpressionStatement -> CallExpression` path exists, `props.callee.slug_ref` points at the real `SON` target, webpack module ids are found as `NumericLiteral` keys, and line numbers are correct.
- **Persistence**: import to disk, reopen, `add()` a second file that reuses existing tables and pairs and adds new ones.
- **`save()`**: node and edge counts match after saving, the saved graph answers the same queries, and saving over an existing file is refused.
- **`code()`**: the right slice past a non-BMP character, a clear error for unknown ids, rejection of duplicate filenames, and it works after `save()` and reopening.
- **Hashing**: with `cs-mast`, every node has a 64-hex hash, different calls hash differently, the same identifier name hashes the same, different names hash differently, and the hash isn't duplicated inside `props`.
- **Parser parity**: `cs-mast` and `babel` give the same per-type node counts on the webpack fixture, and `babel` leaves every hash `null`.
- **Type coverage**: over `modern.js` and `component.tsx`, more than 100 distinct node types, with every node of every type hashed.
- **Parse errors**: a cs-mast parse error suggests `parser: "babel"`, and `babel` recovers from the same input.

### `src/declares.test.ts`: `DECLARES`

A table of 36 snippet and expected-edge pairs, plus invariants over the fixtures. See [DECLARES: Coverage](declares.md#coverage).

### `src/scopes.test.ts`: scopes

A table of 29 snippets, each mapping every bound name to its scope chain, plus provenance, idempotency, parser-parity and persistence tests. See [Scopes: Coverage](scopes.md#coverage).

### `src/flow.test.ts`: `REFERS_TO`, `READS`, `WRITES`, `FLOWS_TO`

There's one snippet per semantic case: the spec's numbered cases 1-21 plus 14 more. The `edges()` helper renders a case's edges as readable strings, labelling `Identifier`s as `x`, or `x:decl` for a `DECLARES` target, and other nodes as `Type(code)`. So each expectation reads like the code:

```ts
expect(await edges("readWrite", "FLOWS_TO")).toEqual(["x:decl -> x", "x -> BinaryExpression(x + 1)", ...]);
```

`flows()` checks reachability with an `ACYCLIC` variable-length path. Test 21 checks over the fixtures for duplicates, self-edges and `access` provenance, and checks that re-import and `babel` parity give identical edges.

The `A1`-`A20` tests are an acceptance suite for the semantic layer. Each relation should mean exactly one thing, with no property, control or call semantics mixed in. They add:

- static versus computed keys, with the property name declared so that a wrong resolution would show
- `obj[key] = x` writing no binding
- an initializer versus a bare `let x;`
- a variable chain, and expression operators
- compound and logical results flowing back into the target
- destructuring and for-in/for-of with no flow, and with undeclared iterables having nothing to `READ`
- shadowing across global, param, block and catch scopes, checked by `line:col`
- sibling blocks
- `access` versus `access_signature` (every `x` shares a hash)
- reopening and re-adding a file never duplicating edges
- global invariants: the `SON` tree intact, one `IN_SCOPE` per `DECLARES`, and no tables from later milestones

The spec cases already cover the rest, and the file says which test covers which item. See [References: Coverage](references.md#coverage) and [Value flow: Coverage](value-flow.md#coverage).

### `src/calls.test.ts`: `CALLS`, `ARGUMENT_TO`, `RETURNS_TO`

One snippet per call-resolution rule, both resolved and deliberately unresolved, then argument mapping, return ownership, interprocedural reachability (including recursion), the two end-to-end demos, determinism, `babel` parity, persistence and consistency invariants. It uses the shared `edgeList()` and `reaches()` helpers from `src/test-utils.ts`, which the build excludes. See [Calls: Coverage](calls.md#coverage).

## CI

`.github/workflows/test.yml` runs `npm ci`, `npm run build` and `npm test` on every push to `main` and every pull request. The matrix is `ubuntu-latest` and `macos-latest`, with Node 22 and 24, and `fail-fast: false`. `@ladybugdb/core` ships native binaries, so testing both operating systems matters.

## Inspecting a graph by hand

`graph.save("x.lbug")` (or `dbPath`) writes a standard Ladybug 0.21 database. Any Ladybug tool of the same version can open it to browse the graph visually, for example Ladybug Explorer.
