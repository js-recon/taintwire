import type { Node } from "@babel/types";
import { linkCalls } from "./calls.js";
import { linkEsm } from "./esm.js";
import { resolveNames } from "./names.js";
import { linkNamespaces } from "./namespaces.js";
import { linkRegistries } from "./registry.js";
import { walk } from "./walk.js";

/** Flatten a Babel AST into per-type node rows, Scope rows and per-(from,to)-type edges. */
export function flatten(ast: Node, file: string) {
    const { rootIds, ...rest } = flattenFiles([[ast, file]]);
    return { rootId: rootIds[0], ...rest };
}

/**
 * Flatten several files into one set of rows and edges. Names resolve per file as in flatten(); what links the files
 * is the bundler's module registry (webpack 4/5 or Turbopack chunks), so a call into another chunk gets CALLS, ARGUMENT_TO and RETURNS_TO.
 * With `parse`, each `eval("<string literal>")` is parsed and walked as code in the eval's scope, as a virtual file
 * `<file>#eval@<offset>` listed in `evals` (webpack's `devtool: "eval"` builds put every module body in one).
 * Also linked: ES-module chunks (Vite/Rollup/esbuild) through import/export. Passes, in order: walk, names,
 * registries, ESM, namespaces, calls (see each module).
 */
export function flattenFiles(units: [Node, string][], { parse }: { parse?: (code: string) => Node } = {}) {
    const w = walk(units, parse);
    const n = resolveNames(w);
    const m = linkRegistries(w, n);
    const ns = linkNamespaces(w, n, m, linkEsm(units, w, n, m));
    linkCalls(w, n, ns);
    // `cw@...` factories are inline CommonJS bodies, not registry ids another file can load.
    const defines = [...m.factories.keys()].filter((id) => !id.startsWith("cw@") && !id.startsWith("ns@"));
    const { idOf, nodes, scopes, rels, evals } = w;
    return { rootIds: units.map(([ast]) => idOf(ast)), nodes, scopes, rels, evals, defines, needs: [...ns.needs] };
}
