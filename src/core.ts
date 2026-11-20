// The library's public API (index.ts and browser.ts re-export it), from the modules that implement it:
// parse (Babel / CS-MAST), schema (graph tables), semantics (what JS syntax binds and flows), flatten (AST -> rows and
// edges, with cross-file bundler linking), units (splitting bundles into linkable units) and graph (PookieGraph on Ladybug).
export { CS_MAST_CONFIG, PARSER_OPTIONS, type Parser } from "./parse.js";
export { RELATIONS, type ScopeKind } from "./schema.js";
export { declared, isRef, scopeKind } from "./semantics.js";
export { flatten, flattenFiles } from "./flatten.js";
export { moduleLinks, planUnits, type ModuleLinks } from "./units.js";
export {
    DEFAULT_THREADS,
    import,
    PookieGraph,
    setBackend,
    TaintGraph,
    type AddFilesProgress,
    type Backend,
    type Limits,
    type LbugConnection,
} from "./graph.js";
