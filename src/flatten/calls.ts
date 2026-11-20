import { type Node } from "@babel/types";
import { PASS_FNS, PASS_METHODS, TS_VALUES } from "../semantics.js";
import type { Names } from "./names.js";
import type { Walk } from "./walk.js";
import type { Namespaces } from "./namespaces.js";
import { keyOf, type Any } from "./util.js";

/** Resolve each callsite to the functions it may call: CALLS, ARGUMENT_TO, RETURNS_TO; FLOWS_TO through builtins otherwise. */
export function linkCalls(w: Walk, n: Names, ns: Namespaces) {
    const { idOf, edge, declScope, calls, returns } = w;
    const { refers, binding, defs } = n;
    const { imported, nsValue } = ns;
    // The functions a value may be, or null if any part of it is unknown. Flow-insensitive like FLOWS_TO: every
    // definition of a binding counts, in any order. `leaves()` reads one value: the functions it is directly, whether
    // any part is unknown, and the bindings it aliases. Explicit stacks throughout: alias chains in bundles can be long.
    type Leaves = { fns: Set<Node>; unknown: boolean; deps: Node[] };
    const leaves = (roots: (Node | null | undefined)[]): Leaves => {
        const out: Leaves = { fns: new Set(), unknown: false, deps: [] };
        const st = [...roots];
        const seen = new Set<Node>(); // re-exports can form a cycle
        while (st.length) {
            const v = st.pop();
            switch (v?.type) {
                case "MemberExpression":
                case "CallExpression":
                case "AwaitExpression": {
                    if (seen.has(v)) break;
                    seen.add(v);
                    // `ns.key`, a namespace's own value (`require(1)()`, `require.n(ns)()`), or webpack 4's `Object(ns.key)`
                    const obj = v.type === "CallExpression" && v.callee.type === "Identifier" && v.callee.name === "Object" && !refers.has(v.callee) && v.arguments.length === 1;
                    const vs = obj ? [v.arguments[0] as Node] : (v.type === "MemberExpression" && imported(v)) || nsValue(v);
                    if (vs?.length) st.push(...vs);
                    else out.unknown = true;
                    break;
                }
                case "FunctionDeclaration":
                case "FunctionExpression":
                case "ArrowFunctionExpression":
                    out.fns.add(v);
                    break;
                case "Identifier": {
                    // a use, or a declaration standing for its binding (an ES module's export)
                    const d = refers.get(v) ?? (declScope.has(v) ? binding(v) : undefined);
                    if (d) out.deps.push(d);
                    else out.unknown = true;
                    break;
                }
                case "SequenceExpression":
                    st.push(v.expressions.at(-1));
                    break;
                case "AssignmentExpression":
                    if (v.operator === "=") st.push(v.right);
                    else out.unknown = true;
                    break;
                case "ConditionalExpression":
                    st.push(v.consequent, v.alternate);
                    break;
                case "LogicalExpression":
                    st.push(v.left, v.right);
                    break;
                default:
                    if (v && TS_VALUES.has(v.type)) st.push((v as Node & { expression: Node }).expression);
                    else out.unknown = true;
            }
        }
        return out;
    };
    // Each binding's functions over the alias graph, solved once with an iterative Tarjan: the bindings on an alias
    // cycle (`f = g; g = f`) share one result, and a binding's result includes every binding it aliases. Linear overall.
    const info = new Map<Node, Leaves>();
    const leafOf = (d: Node) => info.get(d) ?? info.set(d, leaves(defs.get(d) ?? [])).get(d)!;
    const solved = new Map<Node, Set<Node> | null>();
    const index = new Map<Node, number>();
    const low = new Map<Node, number>();
    const sccStack: Node[] = [];
    const onStack = new Set<Node>();
    const solve = (root: Node) => {
        if (index.has(root)) return;
        const work: [Node, number][] = [[root, 0]];
        while (work.length) {
            const top = work[work.length - 1];
            const d = top[0];
            if (!index.has(d)) {
                index.set(d, index.size);
                low.set(d, index.get(d)!);
                sccStack.push(d);
                onStack.add(d);
            }
            const deps = leafOf(d).deps;
            if (top[1] < deps.length) {
                const w = deps[top[1]++];
                if (!index.has(w)) work.push([w, 0]);
                else if (onStack.has(w)) low.set(d, Math.min(low.get(d)!, index.get(w)!));
                continue;
            }
            work.pop();
            if (work.length) {
                const p = work[work.length - 1][0];
                low.set(p, Math.min(low.get(p)!, low.get(d)!));
            }
            if (low.get(d) !== index.get(d)) continue;
            const members = new Set<Node>();
            for (let w: Node | undefined; w !== d; ) {
                w = sccStack.pop()!;
                onStack.delete(w);
                members.add(w);
            }
            let r: Set<Node> | null = new Set();
            for (const m of members) {
                const l = leafOf(m);
                if (l.unknown) r = null;
                l.fns.forEach((fn) => r?.add(fn));
                for (const x of l.deps) {
                    if (members.has(x)) continue;
                    const rx = solved.get(x)!; // another SCC, already solved
                    if (rx === null) r = null;
                    rx?.forEach((fn) => r?.add(fn));
                }
            }
            for (const m of members) solved.set(m, r);
        }
    };
    const callables = (v: Node): Set<Node> | null => {
        const l = leaves([v]);
        if (l.unknown) return null;
        const r = new Set(l.fns);
        for (const d of l.deps) {
            solve(d);
            const rd = solved.get(d);
            if (rd === null) return null;
            rd?.forEach((fn) => r.add(fn));
        }
        return r;
    };
    // An unresolved builtin that returns (part of) its input: decodeURIComponent(x) and x.slice(1) get FLOWS_TO into the call.
    // shortcut: by name only, with no idea of the receiver's type; a typed builtin model can replace it.
    const passThrough = (c: Any) => {
        const f = c.callee;
        if (f.type === "Identifier" && PASS_FNS.has(f.name) && !refers.has(f) && c.arguments[0]) edge("FLOWS_TO", c.arguments[0], c);
        if (f.type === "MemberExpression" && PASS_METHODS.has(keyOf(f)!)) {
            edge("FLOWS_TO", f.object, c);
            if (keyOf(f) === "concat") for (const a of c.arguments) if (a.type !== "SpreadElement") edge("FLOWS_TO", a, c);
        }
    };
    // The binding a formal parameter declares, if it's a plain name (destructured params need element/property flow).
    const paramName = (p: Node): Node | undefined =>
        p.type === "Identifier" ? p : p.type === "AssignmentPattern" ? paramName(p.left) : p.type === "TSParameterProperty" ? paramName(p.parameter) : p.type === "RestElement" ? paramName(p.argument) : undefined;
    for (const c of calls as (Node & { callee: Node; arguments: Node[] })[]) {
        const targets = callables(c.callee);
        if (!targets?.size) {
            passThrough(c); // unresolved: a global, a param, a member, a call result, ...
            continue;
        }
        for (const fn of targets as Set<Node & { params: Node[]; body: Node; async?: boolean; generator?: boolean }>) {
            edge("CALLS", c, fn, { candidates: targets.size });
            // Arguments by position; a rest param takes every argument from its position on. After a spread, positions are unknown.
            const params = fn.params.filter((p) => !(p.type === "Identifier" && p.name === "this")); // TS `this` isn't a param
            const rest = params.findIndex((p) => p.type === "RestElement");
            for (const [i, a] of c.arguments.entries()) {
                if (a.type === "SpreadElement" || a.type === "ArgumentPlaceholder") break;
                const p = rest >= 0 && i >= rest ? params[rest] : params[i];
                const d = p && paramName(p) && binding(paramName(p)!);
                if (d) edge("ARGUMENT_TO", a, d, { arg_index: i, callsite: idOf(c) });
            }
            // An async function returns a promise and a generator an iterator, not the returned value.
            if (fn.async || fn.generator) continue;
            for (const r of returns.get(fn) ?? []) if ((r as Node & { argument?: Node | null }).argument) edge("RETURNS_TO", r, c);
            if (fn.type === "ArrowFunctionExpression" && fn.body.type !== "BlockStatement") edge("RETURNS_TO", fn.body, c); // concise body
        }
    }
}
