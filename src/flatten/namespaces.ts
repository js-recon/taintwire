import { isFunction, type Node } from "@babel/types";
import type { Names } from "./names.js";
import type { Walk } from "./walk.js";
import type { Esm } from "./esm.js";
import type { Registry } from "./registry.js";
import { keyOf, lit, type Any } from "./util.js";

/** Which module namespace each expression is, IMPORTS, every module id loaded (`needs`), and FLOWS_TO from exports to reads. */
export function linkNamespaces(w: Walk, n: Names, m: Registry, e: Esm) {
    const { idOf, edge, declScope, calls, members } = w;
    const { refers, binding, defs } = n;
    const { factories, requires, ctxOf, cw, exported, whole, nsAlias, getterValues, add, isReq, isHelper, isCtx, loaderOf } = m;
    const { esmFiles, esmNeeds, reexp, star, namedImports, nsImports, dynTarget } = e;
    const cs = calls as Any[];
    // Declared before nsOf(), which can reach it (through nsObjectOf) while the import() params are being set.
    // A factory's own exports, or those of the namespace(s) Turbopack's `ctx.n(ns)` made its namespace.
    const valuesOf = (id: string | undefined, key: string, seen = new Set<string>()): Node[] => {
        if (id === undefined || seen.has(id)) return [];
        seen.add(id);
        return (factories.get(id) ?? []).flatMap(
            (fac) =>
                exported.get(fac)?.get(key) ?? [
                    ...(nsAlias.get(fac) ?? []).flatMap((ns) => valuesOf(nsOf(ns), key, seen)),
                    ...(reexp.get(fac)?.get(key) ?? []).flatMap(([m, k]) => valuesOf(m, k, new Set(seen))),
                    ...(key === "default" ? [] : (star.get(fac) ?? []).flatMap((m) => valuesOf(m, key, new Set(seen)))),
                ]
        );
    };
    // Namespaces. `nsOf(e)` is the module id whose namespace `e` is: `require(id)`, `require.t(id, mode)`, a binding whose
    // one definition is one, `require.n(ns)()` (webpack 5) or `require.n(ns).a` (webpack 4), a call of a function that
    // returns one (`a = () => require(1)`, `require.cw(body)`), `await` of an import() promise, or an import() callback's param.
    const paramNs = new Map<Node, string>();
    for (const [local, id] of nsImports) paramNs.set(local, id);
    const single = (e: Any) => {
        const d = refers.get(e);
        const vs = d && defs.get(d);
        return vs?.length === 1 ? vs[0] : undefined;
    };
    // Through aliases (`b = a`) and sequences to the expression that gives a value, iteratively: alias chains in bundles
    // can be long. Stops at a namespace param, which has no definition to follow.
    const follow = (e: Any | null | undefined, seen: Set<Node>): Any | null | undefined => {
        while (e && !seen.has(e) && (e.type === "SequenceExpression" || (e.type === "Identifier" && !paramNs.has(refers.get(e)!)))) {
            seen.add(e);
            e = e.type === "SequenceExpression" ? e.expressions.at(-1) : single(e);
        }
        return e;
    };
    const nsOf = (e0: Any | null | undefined, seen = new Set<Node>()): string | undefined => {
        if (!requires.size && !ctxOf.size && !esmFiles.size && !dynTarget.size) return; // no module system in these files
        const e = follow(e0, seen);
        if (!e || seen.has(e)) return;
        seen.add(e);
        switch (e.type) {
            case "Identifier":
                return paramNs.get(refers.get(e)!);
            case "AwaitExpression":
                return promiseNs(e.argument, seen);
            case "CallExpression":
                if (isReq(e.callee) && e.arguments.length === 1) return lit(e.arguments[0]);
                if (isCtx(e.callee, "i") || isCtx(e.callee, "r")) return lit(e.arguments[0]); // Turbopack import / require
                if (isHelper(e.callee, "t") && Number(lit(e.arguments[1])) & 1) return lit(e.arguments[0]); // mode & 1: require it
                return returnedNs(e.callee, seen);
            case "MemberExpression": {
                const before = new Set(seen); // interopNs marks e.object as seen
                if (keyOf(e) === "a") {
                    const id = interopNs(e.object, seen);
                    if (id !== undefined) return id;
                }
                const obj = nsObjectOf(e, before);
                if (obj !== undefined) return obj;
                if (keyOf(e) !== "default") return;
                // `ns.default` of a CommonJS module is module.exports, read like the namespace itself (Turbopack's
                // `ctx.i(cjs).default.k`); left to `imported()` for an ES module's own default.
                const id = nsOf(e.object, seen);
                return id !== undefined && (factories.get(id) ?? []).some((fac) => whole.has(fac)) ? id : undefined;
            }
        }
    };
    // Rolldown (Vite 8) gives an import() of a module a namespace object built by a helper and exported like any
    // value: `t = helper({NAME: () => r, getName: () => n})`, `export {t as a}`, read as `import("./m.js").then(e => e.a)`.
    // `ns.k` of such an exported getter object is a namespace of its own, `ns@<call>`, whose keys are the getters' values.
    const nsObjects = new Map<Node, string>();
    const isNsObject = (c: Any) =>
        c?.type === "CallExpression" &&
        c.arguments[0]?.type === "ObjectExpression" &&
        c.arguments[0].properties.length > 0 &&
        (c.arguments[0].properties as Any[]).every(
            (p) => p.type === "ObjectProperty" && !p.computed && p.value.type === "ArrowFunctionExpression" && !p.value.params.length && p.value.body.type !== "BlockStatement"
        );
    const nsObjectOf = (m: Any, seen: Set<Node>): string | undefined => {
        const key = keyOf(m);
        if (key === undefined) return;
        for (const v of valuesOf(nsOf(m.object, seen), key) as Any[])
            for (const c of (declScope.has(v) ? defs.get(binding(v)!) ?? [] : [v]) as Any[]) {
                if (!isNsObject(c)) continue;
                if (!nsObjects.has(c)) {
                    const id = `ns@${idOf(c)}`;
                    nsObjects.set(c, id);
                    factories.set(id, [c]);
                    for (const p of c.arguments[0].properties as Any[]) add(c, p.key.type === "Identifier" ? p.key.name : lit(p.key), [p.value.body]);
                }
                return nsObjects.get(c);
            }
    };
    // The namespace calling `g` returns.
    const returnedNs = (g0: Any | null | undefined, seen: Set<Node>): string | undefined => {
        const g = follow(g0, seen);
        if (!g || seen.has(g)) return;
        seen.add(g);
        if (g.type === "CallExpression") return cw.get(g) ?? interopNs(g, seen);
        const ids = new Set(getterValues(g).map((v) => nsOf(v, seen)));
        return ids.size === 1 ? [...ids][0] : undefined;
    };
    // `require.n(ns)`'s getter, which returns `ns` for a CommonJS module.
    const interopNs = (g0: Any | null | undefined, seen: Set<Node>): string | undefined => {
        const g = follow(g0, seen);
        return g?.type === "CallExpression" && isHelper(g.callee, "n") ? nsOf(g.arguments[0], seen) : undefined;
    };
    // The namespace an import() promise resolves to: `p.then(require.bind(_, id))`, `p.then(require.t.bind(_, id, mode))`
    // or `p.then(() => require(id))`.
    const promiseNs = (p0: Any | null | undefined, seen = new Set<Node>()): string | undefined => {
        const p = follow(p0, seen);
        if (p && dynTarget.has(p)) return dynTarget.get(p);
        if (p?.type === "CallExpression" && loaderOf(p) !== undefined) {
            const loaders = (factories.get(loaderOf(p)!) ?? []).flatMap((fac) => whole.get(fac) ?? []);
            const ids = new Set(loaders.flatMap((l) => getterValues(l)).map((r) => promiseNs(r, seen)));
            return ids.size === 1 ? [...ids][0] : undefined;
        }
        if (p?.type !== "CallExpression") return;
        // Vite's `__vitePreload(() => import("./m.js"), deps)`: a call whose first argument returns an import()
        if ((p.callee.type !== "MemberExpression" || keyOf(p.callee) !== "then") && isFunction(p.arguments[0])) {
            const ids = new Set(getterValues(p.arguments[0]).map((r) => promiseNs(r, seen)));
            return ids.size === 1 ? [...ids][0] : undefined;
        }
        if (p.callee.type !== "MemberExpression" || keyOf(p.callee) !== "then") return;
        const cb = p.arguments[0] as Any | undefined;
        if (cb?.type === "CallExpression" && cb.callee.type === "MemberExpression" && keyOf(cb.callee) === "bind") {
            const o = cb.callee.object;
            if (isReq(o) || (isHelper(o, "t") && Number(lit(cb.arguments[2])) & 1)) return lit(cb.arguments[1]);
            return;
        }
        return returnedNs(cb, seen);
    };
    // An import() callback's first param is the namespace, unless something else is assigned to it. Repeated until
    // nothing changes: a callback's promise can depend on another callback's param (`p(() => import(m).then(e => e.a))
    // .then(ns => ...)`), and calls aren't visited in dependency order.
    const thens = (cs as Any[]).flatMap((c) => {
        const cb = c.callee.type === "MemberExpression" && keyOf(c.callee) === "then" ? (c.arguments[0] as Any | undefined) : undefined;
        const p = cb && isFunction(cb) && cb.params[0]?.type === "Identifier" ? binding(cb.params[0]) : undefined;
        return p && defs.get(p)?.length === 1 ? [[c, p] as const] : [];
    });
    for (let changed = true, round = 0; changed && round < 8; round++) {
        changed = false;
        for (const [c, p] of thens) {
            if (paramNs.has(p)) continue;
            const id = promiseNs(c.callee.object);
            if (id !== undefined) paramNs.set(p, id), (changed = true);
        }
    }
    // IMPORTS: each call that loads a module, synchronously or for an import(). `needs` keeps every module id loaded,
    // also those no factory in these files defines (another file's), for moduleLinks().
    const needs = new Set<string>(esmNeeds);
    for (const c of cs) {
        const { callee: f, arguments: args } = c;
        const id = isReq(f) && args.length === 1 ? lit(args[0])
            : isCtx(f, "i") || isCtx(f, "r") || isCtx(f, "A") ? lit(args[0])
            : isHelper(f, "t") ? lit(args[0])
            : f.type === "MemberExpression" && keyOf(f) === "bind" && (isReq(f.object) || isHelper(f.object, "t")) ? lit(args[1])
            : undefined;
        if (id !== undefined) needs.add(id);
        for (const fac of id === undefined ? [] : factories.get(id) ?? []) edge("IMPORTS", c, fac, { module_id: id });
    }
    // A Turbopack loader module (`ctx.v(i => ... i(target))`) imports its target through its param, which is only known
    // to be a require when the `ctx.A(id)` call that runs it is in the same files. moduleLinks() scans one file at a
    // time, so it counts `p(id)` on any loader-shaped export's param as a need (a superset: an extra file, never a lost link).
    const turboFacs = new Set(ctxOf.values());
    const loaderParams = new Set<Node>();
    for (const [fac, vs] of whole)
        if (turboFacs.has(fac)) for (const v of vs as Any[]) if (isFunction(v) && v.params[0]?.type === "Identifier") loaderParams.add(binding(v.params[0])!);
    for (const c of cs) if (c.callee.type === "Identifier" && loaderParams.has(refers.get(c.callee)!) && lit(c.arguments[0]) !== undefined) needs.add(lit(c.arguments[0])!);
    // The value(s) `ns.key` / `ns["key"]` reads, or undefined if `ns` isn't a namespace or doesn't export `key`.
    const imported = (m: Any): Node[] | undefined => {
        const key = keyOf(m);
        const vs = key === undefined ? [] : valuesOf(nsOf(m.object), key);
        return vs.length ? vs : undefined;
    };
    // A namespace expression's own value: a CommonJS module's `module.exports`.
    const nsValue = (e: Node) => {
        const id = nsOf(e);
        return id === undefined ? undefined : (factories.get(id) ?? []).flatMap((fac) => whole.get(fac) ?? []);
    };
    // A named/default import binding is the exported value(s): its definitions (replacing the unknown one an import
    // declaration gives it) and FLOWS_TO into it. Left unknown when the module or the name isn't in these files.
    for (const [local, id, key] of namedImports) {
        const vs = valuesOf(id, key);
        if (!vs.length) continue;
        defs.set(local, vs);
        for (const v of vs) edge("FLOWS_TO", v, local);
    }
    for (const m of members) {
        for (const v of imported(m) ?? []) edge("FLOWS_TO", v, m);
        if (keyOf(m) === "a") for (const v of nsValue(m) ?? []) edge("FLOWS_TO", v, m);
    }
    for (const c of cs) for (const v of nsValue(c) ?? []) edge("FLOWS_TO", v, c);
    return { imported, nsValue, needs };
}
export type Namespaces = ReturnType<typeof linkNamespaces>;
