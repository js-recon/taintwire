---
sidebar_position: 7
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

## CI

`.github/workflows/test.yml` runs `npm ci`, `npm run build` and `npm test` on every push to `main` and every pull request. The matrix is `ubuntu-latest` and `macos-latest`, with Node 22 and 24, and `fail-fast: false`. `@ladybugdb/core` ships native binaries, so testing both operating systems matters.

## Inspecting a graph by hand

`graph.save("x.lbug")` (or `dbPath`) writes a standard Ladybug 0.21 database. Any Ladybug tool of the same version can open it to browse the graph visually, for example Ladybug Explorer.
