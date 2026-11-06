---
sidebar_position: 4.6
title: PookieGraph aliases (pga)
---

# PookieGraph aliases (pga)

Cypher queries over a PookieGraph repeat the same fragments: every call matches `-[:SON {key: 'callee'}]->`, and every taint sink has a literal-type guard and the same `RETURN` columns. **pga** (PookieGraph aliases) gives those fragments short names. Each alias is a string, or a function that returns one, so it goes into a query with `${...}`. Many sinks are also shared between rules, such as every `innerHTML`-like write. **Sink sets** hold those queries once.

Both live in the [taintwire-queries](https://github.com/js-recon/taintwire-queries) pack, not in the taintwire package:

- [`lib/pga.pgq`](https://github.com/js-recon/taintwire-queries/blob/main/lib/pga.pgq) has the aliases.
- [`lib/sinks.pgq`](https://github.com/js-recon/taintwire-queries/blob/main/lib/sinks.pgq) has the sink sets.

```ts
import { pga } from "../lib/pga.pgq";

// MATCH (c:CallExpression)-[:SON {key: 'callee'}]->(cm:MemberExpression)-[:SON {key: 'property'}]->(p:Identifier), (c)-[a:SON {key: 'arguments'}]->(n)
// WHERE p.name = 'setItem' AND a.idx = 1 AND NOT n.type IN ['StringLiteral', 'NumericLiteral', 'NullLiteral', 'BooleanLiteral', 'RegExpLiteral']
// RETURN n.id AS id, p.name AS kind, n.file AS file, n.line AS line, n.col AS col
const setItem = {
    query: `MATCH ${pga.methodCall()}, (c)${pga.arguments("a")}(n)
WHERE p.name = 'setItem' AND a.idx = 1 AND NOT n.type IN ${pga.literals}
${pga.ret("p.name")}`,
};
```

An alias is only text. taintwire never sees the aliases, only the expanded query string, which it compiles and runs like any other.

## Using pga in your own pack

The [sandbox](./pgq.md#sandbox) lets a `.pgq` file import only `.pgq` files inside its own query pack: the nearest folder above it with a `package.json`. A rule outside taintwire-queries therefore can't import `pga.pgq` from it. You have two options:

- Write your rules inside a clone of taintwire-queries, where `../lib/pga.pgq` resolves.
- Copy `lib/pga.pgq`, and `lib/sinks.pgq` if you want the sink sets, into your own pack's `lib/`. Neither file imports anything outside its own folder.

## Edges

An edge alias is named after its SON key. `(parent)${pga.callee}(child)` is `(parent)-[:SON {key: 'callee'}]->(child)`.

| Alias                                                                                                                                                                 | Expands to                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `pga.callee`, `pga.property`, `pga.object`, `pga.left`, `pga.right`, `pga.key`, `pga.value`, `pga.quasis`, `pga.properties`, `pga.source`, `pga.argument`, `pga.init` | `-[:SON {key: '<name>'}]->`                   |
| `pga.arguments(v)`                                                                                                                                                    | `-[v:SON {key: 'arguments'}]->`               |
| `pga.arguments()`                                                                                                                                                     | `-[:SON {key: 'arguments'}]->`                |
| `pga.of.object`, `pga.of.left`, `pga.of.value`, `pga.of.id`                                                                                                           | `<-[:SON {key: '<name>'}]-` (child to parent) |
| `pga.refersTo`                                                                                                                                                        | `-[:REFERS_TO]->` (identifier to declaration) |
| `pga.referencedBy`                                                                                                                                                    | `<-[:REFERS_TO]-`                             |
| `pga.flowsTo(min, max)`                                                                                                                                               | `-[:FLOWS_TO* ACYCLIC <min>..<max>]->`        |

`arguments` is a function because a query usually names the edge to test the argument's position: `(c)${pga.arguments("a")}(n) WHERE a.idx = 1`.

## Call shapes

These bind node variables that the `WHERE` clause then uses. The defaults are the names the taintwire-queries rules use. Pass other names as arguments, or `""` to leave a node unbound.

| Alias                      | Expands to                                                                                                  | Binds                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `pga.methodCall(c, cm, p)` | `(c:CallExpression)-[:SON {key: 'callee'}]->(cm:MemberExpression)-[:SON {key: 'property'}]->(p:Identifier)` | the call, the callee `x.m`, the method name `m` |
| `pga.call(c, f)`           | `(c:CallExpression)-[:SON {key: 'callee'}]->(f:Identifier)`                                                 | `fn(...)` and the function name                 |
| `pga.newCall(c, f)`        | `(c:NewExpression)-[:SON {key: 'callee'}]->(f:Identifier)`                                                  | `new Fn(...)` and the constructor name          |

`pga.methodCall()` is `pga.methodCall("c", "cm", "p")`. `pga.methodCall("c", "", "ae")` gives `(c:CallExpression)…(:MemberExpression)…(ae:Identifier)`.

## Lists and conditions

| Alias                        | Expands to                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `pga.literals`               | `['StringLiteral', 'NumericLiteral', 'NullLiteral', 'BooleanLiteral', 'RegExpLiteral']`                            |
| `pga.literalsNoRegExp`       | `['StringLiteral', 'NumericLiteral', 'NullLiteral', 'BooleanLiteral']`                                             |
| `pga.functions`              | `['FunctionExpression', 'ArrowFunctionExpression', 'FunctionDeclaration']`                                         |
| `pga.list(["a", "b"])`       | `['a', 'b']`                                                                                                       |
| `pga.isGlobal("f")`          | `NOT EXISTS { MATCH (f)-[:REFERS_TO]->() }`                                                                        |
| `pga.named("o", "location")` | `(o.name = 'location' OR EXISTS { MATCH (o)-[:SON {key: 'property'}]->(q:Identifier) WHERE q.name = 'location' })` |
| `pga.named("o", ["a", "b"])` | the same with `IN ['a', 'b']`                                                                                      |

- `NOT n.type IN ${pga.literals}` drops sink values that are constants and so can't carry taint.
- `pga.literalsNoRegExp` is the shorter list that some rules were written with. It is kept as a separate alias so those rules still match exactly what they matched before.
- `pga.isGlobal("f")` holds when `f` has no declaration in the graph. That makes `fetch(...)` a global call and not a local function named `fetch`.
- `pga.named("o", "location")` matches `location`, and also any member expression that ends in it, such as `window.location` and `document.location`. A third argument renames the inner `q`.

## RETURN columns

| Alias              | Expands to                                                                        |
| ------------------ | --------------------------------------------------------------------------------- |
| `pga.ret(kind, n)` | `RETURN n.id AS id, <kind> AS kind, n.file AS file, n.line AS line, n.col AS col` |
| `pga.loc(n)`       | `n.file AS file, n.line AS line, n.col AS col`                                    |

`kind` is a Cypher expression: `pga.ret("p.name")` or `pga.ret("'cookie'")`. `n` defaults to `n`. Use `pga.loc()` when the `RETURN` needs something else, such as `RETURN DISTINCT n.id AS id, 'x' AS kind, ${pga.loc()}`.

## Sink sets

`lib/sinks.pgq` exports the sink queries that two or more rules share, as `PGCypher[]`. Spread them into a selector's `cypher`. Every query returns the sink value as `n`, with `kind`, `file`, `line` and `col`.

| Set                       | Matches                                                                                                                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `htmlSinks`               | `el.innerHTML/outerHTML/srcdoc/cssText = v`, `document.write/writeln(v)`, `{ __html: v }` and `{ innerHTML: v }` props, setter calls `f(..., 'innerHTML', v)`                                                                                                |
| `frameworkHtmlSinks`      | `$(v)`/`jQuery(v)`, `.wrap/.wrapAll/.wrapInner/.parseHTML/.parseFromString/.parseHTMLUnsafe(v)`, Angular `bypassSecurityTrust*(v)`, `execCommand('insertHTML', _, v)`                                                                                        |
| `jsExecSinks`             | `eval(v)`, `Function(v)`/`new Function(v)`, `setTimeout/setInterval(v)` with a string                                                                                                                                                                        |
| `scriptSinks`             | `new Worker/SharedWorker(v)`, `importScripts/setImmediate/execScript(v)`, `navigator.serviceWorker.register(v)`, `$.getScript/globalEval(v)`, `import(v)`, `setAttribute('on*', v)`, `src/text/textContent/innerText` of a `createElement('script')` element |
| `navigationSinks`         | `location = v`, `x.location/x.href = v`, `location.assign/replace(v)`, `window.open(v)`, `setAttribute('href'/'src'/'action'/'formaction'/'srcdoc', v)`                                                                                                      |
| `linkSinks`               | `el.src/action/formAction/data/poster/srcset/background/ping/codebase/cite = v`, `setAttribute`/`setAttributeNS` of those names and `xlink:href`, jQuery `.attr/.prop(name, v)`                                                                              |
| `storageSinks`            | `document.cookie = v`, `localStorage/sessionStorage.setItem(k, v)`                                                                                                                                                                                           |
| `documentDomainSinks`     | `document.domain = v`                                                                                                                                                                                                                                        |
| `requestUrlSinks`         | `fetch/$fetch/axios(v)`, `window/globalThis/self.fetch(v)`, `axios.get/post/put/delete/patch/request(v)`, `xhr.open(method, v)`, `new WebSocket(v)`, `new EventSource(v)`                                                                                    |
| `requestExtendedSinks`    | `$.ajax/get/post/getJSON/load(v)`, `navigator.sendBeacon(v)`, `new Request(v)`, the `url`/`baseURL` of a request config object passed to a call or constructor                                                                                               |
| `requestHeaderSinks`      | `setRequestHeader(k, v)`, `{ headers: { k: v } }`, `new Headers({ k: v })`, `x.headers.k = v`, `x.headers.set/append(k, v)`                                                                                                                                  |
| `templateSinks`           | `.template/.compile/.precompile(v)`, Angular `$compile/$interpolate/$parse/$eval/$evalAsync/$apply/$watch(v)`, `{ template: v }` component options                                                                                                           |
| `prototypePollutionSinks` | `o[k1][k2] = v`, deep merges (`merge`, `mergeWith`, `defaultsDeep`, `setWith`, `deepmerge`, `deepExtend`), `zipObjectDeep(v)`, `$.extend(true, _, v)`                                                                                                        |

## Example

This is the `storage_url` rule before the aliases:

```ts
export const sink: PGSelector = {
    from: urlReadNoHref,
    mode: "deep",
    maxHops: 8,
    cypher: [
        {
            query: `MATCH (a:AssignmentExpression)-[:SON {key: 'left'}]->(l:MemberExpression)-[:SON {key: 'property'}]->(p:Identifier), (l)-[:SON {key: 'object'}]->(o:Identifier), (a)-[:SON {key: 'right'}]->(n)
WHERE p.name = 'cookie' AND o.name = 'document' AND NOT n.type IN ['StringLiteral', 'NumericLiteral', 'NullLiteral', 'BooleanLiteral']
RETURN n.id AS id, 'cookie' AS kind, n.file AS file, n.line AS line, n.col AS col`,
        },
        {
            query: `MATCH (c:CallExpression)-[:SON {key: 'callee'}]->(cm:MemberExpression)-[:SON {key: 'property'}]->(p:Identifier), (c)-[a:SON {key: 'arguments'}]->(n), (cm)-[:SON {key: 'object'}]->(o)
WHERE p.name = 'setItem' AND a.idx = 1 AND NOT n.type IN ['StringLiteral', 'NumericLiteral', 'NullLiteral', 'BooleanLiteral']
  AND (o.name IN ['localStorage', 'sessionStorage'] OR EXISTS { MATCH (o)-[:SON {key: 'property'}]->(q:Identifier) WHERE q.name IN ['localStorage', 'sessionStorage'] })
RETURN n.id AS id, 'setItem' AS kind, n.file AS file, n.line AS line, n.col AS col`,
        },
    ],
};
```

Three other rules carried the same two queries. Now `lib/sinks.pgq` holds them once, written with pga:

```ts
export const storageSinks: PGCypher[] = [
    {
        query: `MATCH (a:AssignmentExpression)${pga.left}(l:MemberExpression)${pga.property}(p:Identifier), (l)${pga.object}(o:Identifier), (a)${pga.right}(n)
WHERE p.name = 'cookie' AND o.name = 'document' AND NOT n.type IN ${pga.literalsNoRegExp}
${pga.ret("'cookie'")}`,
    },
    {
        query: `MATCH ${pga.methodCall()}, (c)${pga.arguments("a")}(n), (cm)${pga.object}(o)
WHERE p.name = 'setItem' AND a.idx = 1 AND NOT n.type IN ${pga.literalsNoRegExp}
  AND ${pga.named("o", ["localStorage", "sessionStorage"])}
${pga.ret("'setItem'")}`,
    },
];
```

The rule keeps only what makes it different:

```ts
import { urlReadNoHref } from "../lib/sources.pgq";
import { storageSinks } from "../lib/sinks.pgq";

export const sink: PGSelector = {
    from: urlReadNoHref,
    mode: "deep",
    maxHops: 8,
    cypher: storageSinks,
};
```

A rule that needs several sets spreads them: `cypher: [...htmlSinks, ...jsExecSinks, { query: ... }]`.
