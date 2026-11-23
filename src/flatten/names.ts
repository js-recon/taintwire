import { isFunction, type Node } from "@babel/types";
import { hashOf } from "../parse.js";
import { pushTo } from "./util.js";
import type { Walk } from "./walk.js";

// Window properties that already exist: assigning one (`location = u`, `onload = f`) sets the host property, it doesn't
// create a variable, so it must not feed later reads of that name.
const HOST_GLOBAL =
    /^(on.*|location|name|status|document|window|self|top|parent|opener|frames|origin|history|navigator|closed|length|event|globalThis|undefined|NaN|Infinity)$/;

/** Resolve names once every binding is known: REFERS_TO, READS, WRITES, FLOWS_TO, and each binding's definitions. */
export function resolveNames(w: Walk, files: string[] = []) {
    const { idOf, edge, parentScope, bindings, declScope, selfNames, uses, notRef, f, declarer, scopes } = w;
    // Classic scripts on one page share the global scope: a name no scope of its own file binds is the top-level binding
    // of another file, the last one in `files` order winning, as for var/function in a browser. An eval's virtual file isn't
    // in `files`: its top level is the eval's scope, not the page's.
    // shortcut: links top-level var/let/const/function only, not window.x = … property globals; add when a site needs it
    const order = new Map(files.map((file, i) => [file, i]));
    const globals = new Map<string, Node>();
    for (const s of scopes
        .filter((s) => s.kind === "global" && order.has(s.file!))
        .sort((a, b) => order.get(a.file!)! - order.get(b.file!)!))
        for (const [name, decl] of bindings.get(s.id!) ?? []) globals.set(name, decl);
    // REFERS_TO: the nearest enclosing scope that binds the name, else another file's global. Unresolved names (host APIs) get no edge.
    const refers = new Map<Node, Node>();
    const unboundReads = new Map<string, Node[]>();
    for (const [use, op, scope] of uses) {
        if (declScope.has(use) || notRef.has(use)) continue;
        const name = (use as Node & { name: string }).name;
        let decl: Node | undefined;
        for (let s = scope; s && !decl; s = parentScope.get(s)) decl = bindings.get(s)?.get(name);
        decl ??= globals.get(name);
        if (!decl) {
            if (!f.writeOnly.has(use)) pushTo(unboundReads, name, use);
            continue;
        }
        refers.set(use, decl);
        edge("REFERS_TO", use, decl);
        // An export specifier names the binding without reading it.
        if (f.writeOnly.has(use) || op.type === "ExportSpecifier") continue;
        edge("READS", op, decl, { access: idOf(use), access_signature: hashOf(use) });
        edge("FLOWS_TO", decl, use);
    }
    // A target's binding: the declaration summarising it, or the one it refers to.
    const binding = (t: Node) =>
        declScope.has(t) ? bindings.get(declScope.get(t)!)!.get((t as Node & { name: string }).name) : refers.get(t);
    for (const [op, t] of f.writes) {
        const d = binding(t);
        if (d) edge("WRITES", op, d, { access: idOf(t), access_signature: hashOf(t) });
    }
    for (const [a, b] of f.flows) edge("FLOWS_TO", a, b);
    for (const [v, t] of f.stores) {
        const d = binding(t);
        if (d) edge("FLOWS_TO", v, d);
        // Sloppy-mode `x = v` with no declaration anywhere creates a page global (common in inline event handlers):
        // flow v to every unbound read of x. No REFERS_TO, so a host global (no REFERS_TO) still reads as one.
        else if (t.type === "Identifier" && !HOST_GLOBAL.test(t.name))
            for (const r of unboundReads.get(t.name) ?? []) edge("FLOWS_TO", v, r);
    }

    // A binding's definitions: each value written to it (null if unknown), and what its declarations bind. A function
    // declaration or a named function expression binds that function; params, catch params, imports and classes bind
    // values this pass can't see.
    const defs = new Map<Node, (Node | null)[]>();
    const def = (d: Node | undefined, v: Node | null) => d && pushTo(defs, d, v);
    for (const [t, v] of f.defs) def(binding(t), v);
    for (const [t, by] of declarer) {
        if (by.type === "VariableDeclarator") continue; // an initializer is a write, above
        if (selfNames.has(t) && binding(t) !== t) continue; // a shadowed function-expression name: no use reaches it
        def(binding(t), isFunction(by) && t === (by as { id?: Node | null }).id ? by : null);
    }
    return { refers, binding, defs };
}
export type Names = ReturnType<typeof resolveNames>;
