import { isFunction, type Node } from "@babel/types";
import { bindingIds } from "../semantics.js";
import type { Names } from "./names.js";
import type { Walk } from "./walk.js";
import type { Registry } from "./registry.js";
import { pushTo, type Any } from "./util.js";

/** ES-module chunks (Vite/Rollup/esbuild): each file with import/export syntax becomes a registry module. */
export function linkEsm(units: [Node, string][], w: Walk, n: Names, m: Registry) {
    const { edge, esm } = w;
    const { refers, binding } = n;
    const { factories, add } = m;
    // ES modules (docs/bundlers/esm.md): Vite/Rollup/esbuild chunks import each other with `import {k as x} from "./c.js"`.
    // Each file with import/export syntax is a module whose id is its filename, with the File node as its factory, so
    // `exported`, `valuesOf()`, `nsOf()` and `leaves()` treat it like a registry module. Specifiers resolve like a browser
    // does from the chunk's own path: relative to the importing file, or (absolute or a full URL) to the one file whose
    // path ends with it.
    const roots = new Map(units.map(([ast, file]) => [file, ast]));
    const esmFiles = new Set<string>();
    const esmNeeds: string[] = [];
    const reexp = new Map<Node, Map<string, [string, string][]>>(); // export {x as y} from "./m": fac -> y -> [m, x]
    const star = new Map<Node, string[]>(); // export * from "./m"
    const namedImports: [Node, string, string][] = []; // [import binding, module id, imported name]
    const nsImports: [Node, string][] = []; // import * as ns from "./m"
    const dynTarget = new Map<Node, string>(); // import("./m") -> m
    const resolveSpec = (from: string, spec: string): string | undefined => {
        let s = spec.replace(/[?#].*$/, "");
        const url = /^[a-z][\w+.-]*:\/\/[^/]*(\/.*)$/i.exec(s);
        if (url) s = url[1];
        if (!s.startsWith(".") && !s.startsWith("/")) return; // a bare package name: not in these files
        const parts: string[] = [];
        for (const p of (s.startsWith("/") ? s : from.split("/").slice(0, -1).join("/") + "/" + s).split("/"))
            if (p === "..") parts.pop();
            else if (p && p !== ".") parts.push(p);
        const joined = parts.join("/");
        if (roots.has(joined) || !s.startsWith("/")) return joined;
        const hits = [...roots.keys()].filter((f) => joined.endsWith("/" + f) || f.endsWith("/" + joined));
        return hits.length === 1 ? hits[0] : joined;
    };
    const nameOf = (n: Any) => (n.type === "Identifier" ? n.name : String(n.value));
    for (const [n, file] of esm as [Any, string][]) {
        const fac = roots.get(file);
        if (!fac) continue; // an eval's virtual file
        const dynamic = n.type === "ImportExpression" || n.type === "CallExpression";
        const src = n.type === "CallExpression" ? n.arguments[0] : n.source;
        // Rolldown writes import(`./c.js`): a template literal with no expressions is a plain string too
        const spec = src?.type === "StringLiteral" ? src.value : src?.type === "TemplateLiteral" && !src.expressions.length ? src.quasis[0].value.cooked : undefined;
        const target = typeof spec === "string" ? resolveSpec(file, spec) : undefined;
        if (target !== undefined) esmNeeds.push(target);
        if (dynamic) {
            if (target !== undefined) dynTarget.set(n, target);
            continue;
        }
        if (!esmFiles.has(file)) esmFiles.add(file), pushTo(factories, file, fac);
        if (n.type === "ImportDeclaration") {
            if (target === undefined) continue;
            if (roots.has(target)) edge("IMPORTS", n, roots.get(target)!, { module_id: target });
            for (const sp of n.specifiers as Any[]) {
                const local = binding(sp.local);
                if (!local) continue;
                if (sp.type === "ImportNamespaceSpecifier") nsImports.push([local, target]);
                else namedImports.push([local, target, sp.type === "ImportDefaultSpecifier" ? "default" : nameOf(sp.imported)]);
            }
        } else if (n.type === "ExportAllDeclaration") {
            if (target !== undefined) pushTo(star, fac, target);
        } else if (n.type === "ExportDefaultDeclaration") {
            const d = n.declaration;
            const id = (d as Any).id as Node | undefined;
            add(fac, "default", [isFunction(d) || !id ? d : (binding(id) ?? d)]);
        } else if (n.source) {
            // export {x as y} from "./m"; `export * as ns from` is left out (a namespace object, needs property flow)
            for (const sp of n.specifiers as Any[]) {
                if (sp.type !== "ExportSpecifier" || target === undefined) continue;
                const keys = reexp.get(fac) ?? reexp.set(fac, new Map()).get(fac)!;
                const y = nameOf(sp.exported);
                pushTo(keys, y, [target, nameOf(sp.local)]);
            }
        } else {
            for (const sp of n.specifiers as Any[]) {
                const d = sp.type === "ExportSpecifier" ? refers.get(sp.local) : undefined;
                if (d) add(fac, nameOf(sp.exported), [d]);
            }
            const decl = n.declaration;
            const ids = !decl ? [] : decl.type === "VariableDeclaration" ? decl.declarations.flatMap((v: Any) => bindingIds(v.id)) : decl.id ? [decl.id] : [];
            for (const id of ids as Any[]) add(fac, id.name, [binding(id) ?? id]);
        }
    }

    return { esmFiles, esmNeeds, reexp, star, namedImports, nsImports, dynTarget };
}
export type Esm = ReturnType<typeof linkEsm>;
