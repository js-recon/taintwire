---
sidebar_position: 1
title: Motivation
---

# Motivation

taintwire is the planned replacement for JS Recon's taint engine. The idea is to put a JavaScript AST into a graph database, add semantic edges on top of it (declarations, scopes, references, data flow, calls), and then express taint tracking as graph queries.

## Deterministic, not AI

Recent work on JavaScript taint analysis leans on machine learning or LLMs, for example *JScamd: An Automated Static Taint Analysis Framework for Detecting Cryptographic API Misuses in JavaScript*. That works, but it's:

- **Computationally expensive**: a model call per file or per flow doesn't scale to the size of modern bundles.
- **Not deterministic**: the same input can give different findings from run to run, which is a problem for regression testing and for reporting.

*Practical Blended Taint Analysis for JavaScript* (2013) is closer in spirit, but it predates today's bundler-heavy, minified front ends.

taintwire takes the deterministic route. The AST is the ground truth, every edge is computed by plain code, and a finding can always be traced back to the source text it came from.

## Why a graph database

Taint questions are path questions: "is there a path from a source to a sink?" A graph query language states those directly:

```cypher
MATCH (c:CallExpression)-[:SON {key: 'callee'}]->(:Identifier {name: 'eval'})
RETURN c.id
```

New analyses then become new queries rather than new traversal code, and every intermediate edge can be inspected.

[LadybugDB](https://ladybugdb.com/) (a fork of Kùzu) fits this well:

- **Embedded**: it runs in-process through `@ladybugdb/core`, with no server to run. A graph is either in memory or a single file.
- **openCypher**: the same query language as Neo4j, so queries and tooling carry over.
- **Typed, columnar node tables**: one table per AST node type keeps label scans cheap. See [Storage](storage.md).

## Matching JS Recon's parser

Since taintwire will run inside JS Recon, both need to see the same AST for the same input. The `babel` parser uses JS Recon's exact `@babel/parser` setup (`PARSER_OPTIONS`). The default `cs-mast` parser yields the same tree, plus a structural hash on every node. See [Parsing and hashing](parsing-and-hashing.md).

## Library shape

The design notes called for a one-call entry point:

```text
taint_graph = taintwire.import(javascript)
```

That's `taintwire.import(code)`. Everything else, such as adding files, querying, saving and resolving source, hangs off the returned `TaintGraph`.
