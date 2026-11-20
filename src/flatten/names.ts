import { isFunction, type Node } from "@babel/types";
import { hashOf } from "../parse.js";
import { pushTo } from "./util.js";
import type { Walk } from "./walk.js";

/** Resolve names once every binding is known: REFERS_TO, READS, WRITES, FLOWS_TO, and each binding's definitions. */
export function resolveNames(w: Walk) {
    const { idOf, edge, parentScope, bindings, declScope, selfNames, uses, notRef, f, declarer } = w;
    // REFERS_TO: the nearest enclosing scope that binds the name. Unresolved names (globals, host APIs) get no edge.
    const refers = new Map<Node, Node>();
    for (const [use, op, scope] of uses) {
        if (declScope.has(use) || notRef.has(use)) continue;
        const name = (use as Node & { name: string }).name;
        let decl: Node | undefined;
        for (let s = scope; s && !decl; s = parentScope.get(s)) decl = bindings.get(s)?.get(name);
        if (!decl) continue;
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
