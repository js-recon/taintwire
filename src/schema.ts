// The graph's tables: AST node columns, Scope columns, and every rel table with its property columns.
import { CS_MAST_SIGNATURE_KEY } from "@shriyanss/cs-mast";

// Not Babel node types, so they can't collide with an AST table.
export const SOURCE = "Source";
export const SCOPE = "Scope";

// Columns shared by every AST node table. `end` is a Cypher keyword, hence *Offset.
export const COLUMNS = {
    id: "STRING PRIMARY KEY",
    type: "STRING",
    file: "STRING",
    startOffset: "INT64",
    endOffset: "INT64",
    line: "INT64",
    col: "INT64",
    endLine: "INT64",
    endCol: "INT64",
    name: "STRING",
    value: "STRING",
    operator: "STRING",
    props: "STRING",
    hash: "STRING", // hex digest of the CS-MAST-S signature; null for the babel parser
} as const;

// Node fields that are either columns already or noise for the graph.
export const SKIP_PROPS = new Set(["type", "start", "end", "loc", "range", "leadingComments", "trailingComments", "innerComments", "comments", "errors", "tokens", CS_MAST_SIGNATURE_KEY]);

// Rel tables and their property columns. SON is AST containment; the rest are semantic overlays.
// READS/WRITES carry the Identifier occurrence: `access` (its node id) and `access_signature` (its hash, which is content-only).
const ACCESS = ["access STRING", "access_signature STRING"] as const;
export const RELS = {
    SON: ["key STRING", "idx INT64"],
    DECLARES: [],
    CREATES_SCOPE: [],
    PARENT_SCOPE: [],
    IN_SCOPE: [],
    REFERS_TO: [],
    READS: ACCESS,
    WRITES: ACCESS,
    FLOWS_TO: [],
    CALLS: ["candidates INT64"], // how many functions this callsite may call
    ARGUMENT_TO: ["arg_index INT64", "callsite STRING"], // the argument's position, and its CallExpression's id (`index` and `call` are Cypher keywords)
    RETURNS_TO: [],
    IMPORTS: ["module_id STRING"], // a bundler require call -> the module factory it loads
    EXPORTS: ["name STRING"], // a module factory -> the value it exports under `name`
} as const;
export type Rel = keyof typeof RELS;
/** Every relationship (edge table) a graph has, in layer order: AST, declarations, scopes, resolution, access, flow, calls. */
export const RELATIONS = Object.keys(RELS) as Rel[];
// Ladybug rel tables need at least one FROM/TO pair. open() creates every rel table up front with one real pair
// (and that pair's node tables), so `MATCH ()-[:REFERS_TO]->()` on a graph with none is empty rather than a binder error.
export const DEFAULT_PAIRS: Record<Rel, [string, string]> = {
    SON: ["File", "Program"],
    DECLARES: ["VariableDeclarator", "Identifier"],
    CREATES_SCOPE: ["Program", "Scope"],
    PARENT_SCOPE: ["Scope", "Scope"],
    IN_SCOPE: ["Identifier", "Scope"],
    REFERS_TO: ["Identifier", "Identifier"],
    READS: ["CallExpression", "Identifier"],
    WRITES: ["VariableDeclarator", "Identifier"],
    FLOWS_TO: ["Identifier", "Identifier"],
    CALLS: ["CallExpression", "FunctionDeclaration"],
    ARGUMENT_TO: ["Identifier", "Identifier"],
    RETURNS_TO: ["ReturnStatement", "CallExpression"],
    IMPORTS: ["CallExpression", "ObjectMethod"],
    EXPORTS: ["ObjectMethod", "Identifier"],
};
export const relMaps = () => Object.fromEntries(Object.keys(RELS).map((r) => [r, new Map()])) as Record<Rel, Edges>;

// Scope nodes: semantic, not AST, so they get their own table. Ids are deterministic (see scopeRow()).
export const SCOPE_COLUMNS = { id: "STRING PRIMARY KEY", kind: "STRING", file: "STRING", signature: "STRING", owner_signature: "STRING" } as const;
export type ScopeKind = "global" | "module" | "function" | "block" | "catch" | "class" | "static_block";
export type ScopeRow = Record<keyof typeof SCOPE_COLUMNS, string | null>;

export type Row = Record<keyof typeof COLUMNS, string | number | null>;
export type Edge = {
    from: string;
    to: string;
    key?: string;
    idx?: number;
    access?: string;
    access_signature?: string | null;
    candidates?: number;
    arg_index?: number;
    callsite?: string;
    module_id?: string;
    name?: string;
};
export type Edges = Map<string, Edge[]>; // key: `${fromType}\0${toType}`
