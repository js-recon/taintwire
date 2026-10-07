# Taintwire graph schema

The public schema of a Taintwire graph (LadybugDB / openCypher), as produced by `src/index.ts` at the time of the
validation in [VALIDATION_REPORT.md](VALIDATION_REPORT.md). Derived from the code and confirmed against a saved
`.lbug` with `CALL show_tables()`, `CALL table_info()` and `CALL show_connection()`.

Status tags: **stable**: structural, fully tested. **semantic**: tested and invariant-checked, with documented
approximations. **partial**: deliberately incomplete; absence of an edge is not evidence of absence of the behaviour.

## Nodes

There are three kinds of node table.

### AST nodes: one table per Babel node type

Each Babel node becomes one row in a table named after its type (`Identifier`, `CallExpression`,
`FunctionDeclaration`, `TSEnumMember`, `JSXElement`, ...). A table is created the first time that type is seen,
except `File`, `Program`, `Identifier`, `VariableDeclarator`, `CallExpression`, `FunctionDeclaration` and
`ReturnStatement`. Those always exist, because empty relationship tables are declared between them.

The parser is cs-mast (Babel 7.29 underneath, the default) or `@babel/parser` 8 (`{ parser: "babel" }`). Type names
follow whichever produced the AST. The one notable difference is that Babel 8 calls `import()` an
`ImportExpression`, while cs-mast calls it `CallExpression` with an `Import` callee.

Every AST table has the same columns:

| Property | Meaning | Unique? | Deterministic? | Origin |
| --- | --- | --- | --- | --- |
| `id` (PK) | `<Type>_<16 random hex>`: the concrete occurrence | yes, per graph | **no**: new on every import, preserved by `save()`/reopen | Taintwire |
| `type` | Babel node type (= table name) | no | yes | Babel |
| `file` | `filename` given to `add()` / `import()` | no | yes | Taintwire |
| `startOffset`, `endOffset` | UTF-16 offsets in the file | `(file, type, startOffset, endOffset)` is effectively unique | yes | Babel |
| `line`, `col`, `endLine`, `endCol` | 1-based line, 0-based column | no | yes | Babel |
| `name` | string `name` (Identifier, JSXIdentifier, ...) | no | yes | Babel |
| `value` | literal value as a string (`'1'`, not `1`); TemplateElement cooked/raw | no | yes | Babel |
| `operator` | `+`, `=`, `+=`, `typeof`, `++`, ... | no | yes | Babel |
| `props` | JSON of every other Babel field. Child nodes appear as `{type, slug_ref: <child id>}` | no | no (embeds child ids) | Babel + Taintwire |
| `hash` | CS-MAST-S digest (64 hex) of the node's subtree content. `null` with the babel parser | **no**: identical code shares a hash | yes | cs-mast |

`hash` identifies content and `id` identifies an occurrence. Every `x` in `x + x` has the same `hash` but a
different `id`. Anything that must point at one occurrence (`access`, `callsite`) stores an `id`.

Node categories that matter to the semantic layer:

| Category | Node types | Role |
| --- | --- | --- |
| Binding Identifier | `Identifier` that is a `DECLARES` target | a declaration; target of `REFERS_TO`/`READS`/`WRITES`, `IN_SCOPE` source, and the summary node for its variable in `FLOWS_TO` |
| Reference Identifier | `Identifier` in value position | a use; `REFERS_TO` source when resolved |
| Non-reference Identifier | static property names and keys, labels, import/export names, meta properties, TS type names | never a `REFERS_TO` source |
| Declaration producers | `VariableDeclarator`, `FunctionDeclaration`, `FunctionExpression`, `ArrowFunctionExpression`, `ObjectMethod`, `ClassMethod`, `ClassPrivateMethod`, `ClassDeclaration`, `ClassExpression`, `ImportSpecifier`, `ImportDefaultSpecifier`, `ImportNamespaceSpecifier`, `CatchClause` | `DECLARES` sources |
| Scope owners | `Program`, functions (the six function types), `ClassDeclaration`, `ClassExpression`, `StaticBlock`, `CatchClause`, `SwitchStatement`, `BlockStatement` (except a function or catch body), `For`/`ForIn`/`ForOfStatement` with a `let`/`const`/`using` head | `CREATES_SCOPE` sources |
| Callables | `FunctionDeclaration`, `FunctionExpression`, `ArrowFunctionExpression` | `CALLS` targets (methods and classes are never targets) |
| Calls | `CallExpression`, `OptionalCallExpression` | `CALLS` sources, `RETURNS_TO` targets (`NewExpression` and tagged templates aren't calls here) |

### `Scope`: synthetic, semantic

One per scope owner. Columns:

| Property | Meaning | Deterministic? |
| --- | --- | --- |
| `id` (PK) | `Scope_` + first 16 hex chars of `sha256(file, ownerType, start, end)`: unique per file position | **yes**: the same file and source give the same id |
| `kind` | `global` (script Program), `module`, `function`, `block`, `catch`, `class`, `static_block` | yes |
| `file` | file | yes |
| `owner_signature` | the owner's `hash` | yes (null with the babel parser) |
| `signature` | `sha256("scope:<kind>:<owner_signature>")`: content-based, shared by identical code | yes (null with the babel parser) |

`var` binds in `global`, `module`, `function` and `static_block` scopes. `let`, `const`, `class` and `using` bind in the nearest scope.

### `Source`: storage, not graph

`Source(file PK, code)` stores each file's text, which `TaintGraph.code(id)` slices. It has no `type` column and no
edges.

## Relationships

Every relationship table exists from `TaintGraph.open()`, so `MATCH ()-[r:CALLS]->() RETURN r` on a graph with no calls
returns zero rows. The names are exported as `RELATIONS`. There is no `CHILD` relationship.

### Structural (stable)

```text
ASTNode -[:SON {key, idx}]-> ASTNode
```

- **SON**: AST containment, parent to child. `key` is the Babel field name (`body`, `callee`, `arguments`, ...).
  `idx` is the array position, or `-1` for a scalar field.
- Every AST node except `File` has exactly one `SON` parent, and `(parent, key, idx)` is unique.
- Children are walked under both Babel 7's and Babel 8's child keys.
- Hashbangs (`Program.interpreter`) aren't visited by either Babel version, so they stay as data in `Program.props`.

### Declarations and scopes (stable)

```text
DeclarationProducer -[:DECLARES]->      Identifier(binding)
ScopeOwner          -[:CREATES_SCOPE]-> Scope
Scope               -[:PARENT_SCOPE]->  Scope        (child to parent; never crosses files)
Identifier(binding) -[:IN_SCOPE]->      Scope
```

- **DECLARES** goes from the node that introduces a binding to the existing binding `Identifier`. That covers
  declarator ids (including patterns), function and class names, params, import locals and catch params. Object
  keys, method names, exports and control flow never declare. It has no properties.
- **CREATES_SCOPE**: exactly one per owner and per `Scope`.
- **PARENT_SCOPE**: exactly one per non-root `Scope`. There is one root per file, owned by `Program`.
- **IN_SCOPE**: exactly one per `DECLARES` target. A function or class declaration's own name binds in the
  enclosing scope. A named function or class expression's own name binds in its own scope. `var` binds in the var
  scope.

### Name resolution (semantic)

```text
Identifier(use) -[:REFERS_TO]-> Identifier(binding)
```

- Lexical lookup through `PARENT_SCOPE`: the nearest scope that binds the name wins.
- When `var` and params share a name, they share one binding, summarised by the earliest declaration.
- A named function expression's own name loses to its params and vars.
- Unresolved names (globals, host APIs, `arguments`) get no edge, and no declaration is invented for them.
- It has no properties.

### Access (semantic)

```text
Operation -[:READS  {access, access_signature}]-> Identifier(binding)
Operation -[:WRITES {access, access_signature}]-> Identifier(binding)
```

- `access` is the `id` of the Identifier occurrence. `access_signature` is that occurrence's `hash`, which is content
  only.
- **READS** comes from the occurrence's direct AST parent. It covers every resolved use except a pure assignment target and an
  `export { x }` specifier.
- **WRITES** comes from a `VariableDeclarator` with an initialiser, an `AssignmentExpression` (also compound and
  logical), an `UpdateExpression`, a `ForIn`/`ForOfStatement`, or an `AssignmentPattern` default.
- Compound and update operations both read and write.
- Property writes (`obj.p = v`) write no binding. They read `obj`.

### Value flow (semantic, flow-insensitive)

```text
ValueNode -[:FLOWS_TO]-> ValueNode
```

These edges have no properties. Kinds of edge:

| Edge | Meaning |
| --- | --- |
| binding to each resolved read occurrence | `x:decl -> x` |
| operand to expression | `BinaryExpression`, `LogicalExpression`, `UnaryExpression` except `void`/`delete`, `TemplateLiteral`, the last element of a `SequenceExpression`, both branches of `ConditionalExpression` (never the test), the `expression` of TS value wrappers |
| value to `ReturnStatement` | its argument |
| right side to `AssignmentExpression` | the left side too, if compound |
| an `AssignmentExpression` or `UpdateExpression` to its Identifier target's binding | |
| initialiser or default to the binding | only for a plain-Identifier target |

The model is flow-insensitive: every write of a binding reaches every read, so cycles (`x = x + 1`) are expected.
Use `ACYCLIC`, `TRAIL` or `SHORTEST` with a bound.

**Partial.** There is no flow through property reads, destructuring, for-of/for-in elements, object or array literal
contents, spread, `await`, `yield`, `new`, tagged templates, or unresolved calls.

### Calls and interprocedural flow (semantic, context-insensitive)

```text
CallExpression -[:CALLS {candidates}]->         Callable
ArgumentValue  -[:ARGUMENT_TO {arg_index, callsite}]-> Identifier(param binding)
ReturnStatement | concise arrow body -[:RETURNS_TO]-> CallExpression
```

- **CALLS** resolves the callee as a value: `REFERS_TO`, then every definition of the binding, through aliases,
  `(0, f)`, `?:`, `||`/`&&`/`??`, `=` and TS wrappers. IIFEs and `f?.()` are covered.
  - It's all or nothing: if any definition is unknown (a param, import, member, call result, destructuring, compound
    write, ...), the call gets no edge.
  - `candidates` is the number of callables. It's `> 1` for may-call sets.
  - Member calls, `.call`/`.apply`/`.bind`, `new`, globals and cross-file calls are never resolved. **Partial.**
- **ARGUMENT_TO** goes from the argument expression to the param's binding Identifier.
  - `arg_index` is the argument position, and `callsite` is the `id` of the `CallExpression`, so edges from
    different calls never mix.
  - A rest param takes every argument from its position on. Nothing is mapped at or after a spread.
  - Destructured params get nothing, and a TS `this` param doesn't count as a position.
- **RETURNS_TO** goes from each valued `ReturnStatement` whose nearest enclosing function is a `CALLS` target of the
  call, or from a concise arrow body.
  - It has no properties.
  - Async functions and generators get none.

## Layer dependencies

```text
SON
 ├─> DECLARES ──> IN_SCOPE <── CREATES_SCOPE / PARENT_SCOPE
 │                    │
 │                    v
 └────────────> REFERS_TO  (uses + scope chain + bindings)
                      │
                      v
               READS / WRITES  (+ AST operator facts)
                      │
                      v
                  FLOWS_TO
                      │
                      v
     CALLS  (REFERS_TO + binding definitions) ──> ARGUMENT_TO, RETURNS_TO
```

A value path is a traversal over `FLOWS_TO|ARGUMENT_TO|RETURNS_TO`:

```cypher
MATCH p = (src)-[:FLOWS_TO|ARGUMENT_TO|RETURNS_TO* SHORTEST 1..30]->(dst) RETURN p
```

## Not in the schema

None of these exist:

- `CHILD`, `READS_PROPERTY`, `WRITES_PROPERTY`, `ALIASES`, `CAPTURES`
- `IMPORTS`, `EXPORTS`, `LOADS_MODULE`
- `CONTROL_DEPENDS_ON`, CFG or SSA nodes
- source, sink or sanitizer labels
