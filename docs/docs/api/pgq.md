---
sidebar_position: 4.5
title: Query files (pgq)
---

# Query files (pgq)

A `.pgq` file is a TypeScript module of Cypher queries, built up from two kinds of object:

- A **selector** (`PGSelector`) is a set of nodes, such as "every URL read" or "every `innerHTML` write". On its own a selector isn't a finding, so query packs keep their selectors in library files and share them between rules.
- A **rule** (`PGRule`) adds a severity and a message, and lists the selectors whose rows are its findings.

taintwire loads `.pgq` files in a sandbox, validates them and runs them against a PookieGraph (`.pg`). [js-recon](https://js-recon.io) runs them with `js-recon taintwire analyze`, and [taintwire-queries](https://github.com/js-recon/taintwire-queries) is the public query pack.

## Example

A library file (`lib/sources.pgq`) has named exports only:

```ts
import type { PGSelector } from "@js-recon/taintwire";

const AT = "n.file AS file, n.line AS line, n.col AS col";

export const urlRead: PGSelector = {
    cypher: {
        query: `MATCH (n:MemberExpression)-[:SON {key: 'property'}]->(p:Identifier), (n)-[:SON {key: 'object'}]->(o)
WHERE p.name IN ['hash', 'search', 'href'] AND o.name = 'location'
RETURN n.id AS id, p.name AS kind, ${AT}`,
    },
};
```

A rule file (`rules/dom_xss_url.pgq`) default-exports a rule, or a list of rules:

```ts
import type { PGRule } from "@js-recon/taintwire";
import { urlRead } from "../lib/sources.pgq";
import { htmlAssign, htmlCall } from "../lib/sinks.pgq";

export default {
    id: "dom_xss_url",
    name: "DOM XSS: URL value written as HTML",
    severity: "high",
    message: "URL value reaches an HTML sink",
    return: [{ cypher: [htmlAssign, htmlCall], from: urlRead, mode: "deep", maxHops: 8 }],
} satisfies PGRule;
```

## Types

```ts
type PGSeverity = "info" | "low" | "medium" | "high" | "critical";

interface PGCypher {
    query: string; // must RETURN id, file, line, col; may RETURN kind
}

interface PGSelector {
    cypher: PGCypher | PGCypher[];
    uses?: Record<string, PGSelector>;
    from?: PGSelector | PGSelector[];
    mode?: "strict" | "lenient" | "deep";
    maxHops?: number;
}

interface PGRule {
    id: string;
    name: string;
    severity: PGSeverity;
    message: string;
    description?: string;
    author?: string;
    tags?: string[];
    return: (PGSelector | PGCypher)[];
}
```

| Field | Meaning |
| --- | --- |
| `cypher` | The queries. A list runs every variant, concatenates the rows and drops duplicate `id`s. Lists are useful because every start pattern should be labelled: a string constant, for example, needs a `StringLiteral` variant and a `TemplateLiteral` variant. |
| `uses` | `$name` in a query is the list of `id`s of that selector's rows. This is how you chain selectors: message handlers to listener functions to `event.data` reads. If any selector in `uses` has no rows, this selector has none either, and its queries don't run. |
| `from` | Keep only the rows that a value from one of these selectors flows into. Each finding then carries the `source` row and the number of `hops`. |
| `mode` | How `from` flows are followed. `strict` follows `FLOWS_TO`, `ARGUMENT_TO` and `RETURNS_TO` from the source node to the sink node. `lenient` also widens both ends through up to 3 wrapping expressions, such as `location.hash.slice(1)` or `el.innerHTML = tpl(x)`. `deep` (the default) repeats `lenient` for 4 rounds, which gets past opaque calls such as `new URLSearchParams(location.search).get("q")`. |
| `maxHops` | The longest flow kept. Defaults to 8. |
| `return` | A rule's findings: the union of these selectors' rows, without duplicates. A bare `PGCypher` counts as a selector of one query. |

Every query must `RETURN id, file, line, col`. A query that doesn't is a runtime error for its rule. A label with no table in the graph (an AST type that never occurs in it) gives no rows, not an error.

## Writing pgq files

- A `.pgq` file is TypeScript. Its types are stripped as in Node's [type stripping](https://nodejs.org/api/typescript.html#type-stripping), so the TypeScript-only features that would need code generation (`enum`, `namespace`, parameter properties) aren't allowed.
- A `.pgq` file may import only other `.pgq` files from the same query pack. A pack is the nearest folder above the files that has a `package.json`. Import taintwire's types with `import type`, which is erased; a plain `import` of `@js-recon/taintwire` is rejected.
- Helper functions are fine, for example one that builds the `StringLiteral` and `TemplateLiteral` variants of a query. What a file *exports* must be data, though: plain objects, arrays, strings, numbers and booleans. A function in an exported rule is an error. A selector object shared between rules stays one object, so it's evaluated once per run.
- `console.log` output from a pgq file goes to stderr.
- To have editors treat `.pgq` as TypeScript, add `"files.associations": { "*.pgq": "typescript" }` to `.vscode/settings.json`.

## Sandbox

A `.pgq` file is code, so `loadPgq()` evaluates it in a separate Node process:

- The process runs under Node's [permission model](https://nodejs.org/api/permissions.html) with read access to the query pack only. That denies file writes, child processes, worker threads and native addons.
- An import hook allows only `.pgq` files inside the pack. `node:` builtins and npm packages are rejected, including through dynamic `import()`.
- `fetch`, `WebSocket`, `EventSource`, `process.getBuiltinModule`, `process.kill` and `process.binding` are removed before any query code runs.
- The process gets 256 MB of heap and 30 seconds by default.

On Node 22 and 24 the permission model doesn't restrict the network. There, the import hook and the removed globals are the network barrier. On Node 25 and later, the permission model blocks the network too.

Loading `.pgq` files needs Node 22.15 or newer. On Node 22.18 or newer, TypeScript type stripping is enabled by default.

## API

These are exported from `@js-recon/taintwire`. `loadPgq()` is Node-only; the rest also work from `@js-recon/taintwire/browser`.

### `loadPgq()`

```ts
loadPgq(files: string[], opts?: { root?: string; timeoutMs?: number }): Promise<{ rules: PGRule[]; errors: string[] }>;
```

Evaluates the files in the sandbox and validates each file's default export. A file without a default export is a library: it contributes no rules, but its errors are still reported. Rules from a file with any error are left out. Every message in `errors` starts with the file path. A rule id that two files share is an error. `root` overrides the query pack folder.

### `validatePgq()`

```ts
validatePgq(input: unknown): string[];
```

Checks a rule, or a list of rules, that you built yourself. An empty array means the input is valid. It checks:

- the field types and the severity
- that queries are non-empty
- that `maxHops` is a non-negative integer, and that `mode` and `maxHops` only appear with `from`
- that every `$name` in a query has an entry in `uses` (names inside strings and comments don't count)
- that no selector depends on itself through `uses` or `from`
- that rule ids are unique

### `checkPgqCypher()`

```ts
checkPgqCypher(graph: PookieGraph, rules: PGRule[]): Promise<string[]>;
```

Prepares every query against `graph` and returns the ones that don't compile, for example syntax errors. An error about a table that doesn't exist in `graph` is ignored, because that label may exist in another graph.

### `runPgq()`

```ts
runPgq(graph: PookieGraph, rules: PGRule[]): Promise<{ findings: PgqFinding[]; errors: { ruleId: string; message: string }[] }>;

interface PgqFinding {
    ruleId: string;
    severity: PGSeverity;
    message: string;
    id: string;
    file: string;
    line: number;
    col: number;
    kind?: string;
    source?: { id: string; file: string; line: number; col: number; kind?: string };
    hops?: number;
}
```

Runs `rules` on `graph`. Each selector is evaluated once per call, however many rules use it. A rule that fails goes into `errors`, and the remaining rules still run. `graph.code(finding.id)` returns the finding's source text.

For a big graph, open the saved file read-only: `PookieGraph.open("app.pg", { readOnly: true })`.
