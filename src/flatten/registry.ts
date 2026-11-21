import { isFunction, type Node } from "@babel/types";
import type { Names } from "./names.js";
import type { Walk } from "./walk.js";
import { keyOf, lit, pushTo, type Any } from "./util.js";

/** webpack 4/5 and Turbopack module registries: each module id's factories, and what each factory exports. */
export function linkRegistries(w: Walk, n: Names) {
    const { idOf, edge, declarer, calls, assigns, returns } = w;
    const { refers, binding } = n;
    // Webpack's module registry (docs/bundlers/webpack.md), webpack 4 and 5. A chunk registers module factories
    // `{id(module, exports, require) {...}}` (webpack 4 also uses arrays, id = index) by pushing `[[chunkIds], factories]`;
    // the entry chunk keeps its own in `__webpack_modules__` or passes them to the bootstrap IIFE. ES modules export with
    // `require.d(exports, {key: getter})`, `require.d(exports, [key, 0, value, ...])` or `require.d(exports, "key", getter)`;
    // CommonJS ones assign `module.exports` / `exports.key`. An import is a namespace expression (`require(id)`,
    // `require.n(ns)()`, an `import()` callback's param, ...), and `ns.key` reads the exported value, in whichever file it
    // is: `imported()` resolves it for leaves() (so calls resolve) and FLOWS_TO.
    // shortcut: `require.n(ns)` of an ES module (which reads ns.default) is taken as `ns`, as for CommonJS; and nsOf()
    const factories = new Map<string, Node[]>(); // module id -> its factories (two builds in one graph can reuse an id)
    const requires = new Set<Node>(); // require-function bindings: each factory's third param, and the runtime's function
    const moduleOf = new Map<Node, Node>(); // a factory's `module` binding -> the factory
    const exportsOf = new Map<Node, Node>(); // a factory's `exports` binding -> the factory
    const ctxOf = new Map<Node, Node>(); // a Turbopack factory's context binding -> the factory
    // webpack factories take (module, exports, require), Turbopack's (context, module, exports).
    const addFactory = (id: string, fn: Any, turbo = false) => {
        pushTo(factories, id, fn);
        const ps = (fn.params as Node[]).map((p) => (p?.type === "Identifier" ? binding(p) : undefined));
        if (turbo && ps[0]) ctxOf.set(ps[0], fn);
        const [mod, exp, req] = turbo ? [ps[1], ps[2]] : ps;
        if (mod) moduleOf.set(mod, fn);
        if (exp) exportsOf.set(exp, fn);
        if (req) requires.add(req);
    };
    const register = (o: Any | null | undefined, turbo = false) => {
        const found: [string, Any][] = [];
        if (o?.type === "ObjectExpression")
            for (const p of o.properties as Any[]) {
                const fn = p.type === "ObjectMethod" ? p : p.value;
                const id = p.computed ? undefined : lit(p.key);
                if (p.type === "SpreadElement" || !isFunction(fn) || id === undefined) return;
                found.push([id, fn]);
            }
        else if (o?.type === "ArrayExpression")
            for (const [i, fn] of (o.elements as Any[]).entries()) {
                if (fn === null) continue; // a hole: no module with that id in this chunk
                if (!isFunction(fn)) return;
                found.push([String(i), fn]);
            }
        found.forEach(([id, fn]) => addFactory(id, fn, turbo));
    };
    // Turbopack (docs/bundlers/turbopack.md): `push([script, [group]?, id, id..., factory, ...])`, where a group is the
    // same list, and each factory is installed under the ids before it. False (nothing registered) for any other array.
    const turboModules = (els: Any[], at: number, out: [string, Any][]): boolean => {
        if (els[at]?.type === "ArrayExpression") {
            if (!turboModules(els[at].elements, 0, out)) return false;
            at++;
        }
        let pending: string[] = [];
        for (const e of els.slice(at)) {
            if (isFunction(e) && pending.length) pending.forEach((id) => out.push([id, e])), (pending = []);
            else if (lit(e) !== undefined) pending.push(lit(e)!);
            else return false;
        }
        return !pending.length;
    };
    const isReq = (e: Any | null | undefined) => e?.type === "Identifier" && requires.has(refers.get(e)!);
    const isHelper = (e: Any | null | undefined, name: string) => e?.type === "MemberExpression" && keyOf(e) === name && isReq(e.object);
    // `ctx.name` on a Turbopack factory's context: `ctx.i(id)` imports, `ctx.s([...])` exports, ...
    const isCtx = (e: Any | null | undefined, name: string) =>
        e?.type === "MemberExpression" && keyOf(e) === name && e.object.type === "Identifier" && ctxOf.has(refers.get(e.object)!);
    const cs = calls as Any[];
    const cw = new Map<Node, string>(); // `require.cw(body)` call -> the module id given to its body
    for (const c of cs) {
        const { callee: f, arguments: args } = c;
        // (self.webpackChunk_x ||= []).push([[chunkIds], factories, runtime?])
        if (f.type === "MemberExpression" && !f.computed && f.property.name === "push" && args[0]?.type === "ArrayExpression") {
            const found: [string, Any][] = [];
            if (args[0].elements[0]?.type === "ArrayExpression") register(args[0].elements[1]);
            // Turbopack before Next.js 15.5: push([script, {id: factory}])
            else if (args[0].elements[1]?.type === "ObjectExpression") register(args[0].elements[1], true);
            else if (turboModules(args[0].elements, 1, found)) found.forEach(([id, fn]) => addFactory(id, fn, true));
        }
        if (isFunction(f)) register(args[0]); // webpack 4's bootstrap: (function (modules) {...})([...])
        // The runtime's `function __webpack_require__(id)` runs `modules[id](module, module.exports, __webpack_require__)`,
        // or `modules[id].call(module.exports, module, module.exports, __webpack_require__)` in webpack 4.
        const viaCall = f.type === "MemberExpression" && !f.computed && f.property.name === "call";
        const target = viaCall ? f.object : f;
        const req = viaCall ? (args.length === 4 ? args[3] : undefined) : args.length === 3 ? args[2] : undefined;
        const fn = req?.type === "Identifier" ? (declarer.get(refers.get(req)!) as Any | undefined) : undefined;
        if (fn?.type === "FunctionDeclaration" && fn.params.length === 1 && target.type === "MemberExpression" && target.computed && refers.get(target.property) === binding(fn.params[0]))
            requires.add(refers.get(req)!);
    }
    for (const [t, by] of declarer) if (by.type === "VariableDeclarator" && by.id === t) register(by.init); // __webpack_modules__
    // webpack 5.112 wraps a CommonJS module inlined into an ES module as `require.cw((module, exports) => {...})`. Runs
    // after the anchors above, so `requires` already holds every factory's require.
    for (const c of cs) if (isHelper(c.callee, "cw") && isFunction(c.arguments[0])) addFactory(`cw@${idOf(c)}`, c.arguments[0]), cw.set(c, `cw@${idOf(c)}`);
    // Turbopack before Next.js 15.5 passes a single context object, and a factory reads its module and exports from
    // it: `var {g: e, __dirname: a, m: t, e: i} = ctx`.
    for (const [t, by] of declarer as Map<Node, Any>) {
        const fac = by.type === "VariableDeclarator" && by.id.type === "ObjectPattern" && by.init?.type === "Identifier" ? ctxOf.get(refers.get(by.init)!) : undefined;
        const key = fac && (by.id.properties as Any[]).find((p) => p.value === t && !p.computed)?.key.name;
        if (key === "m") moduleOf.set(binding(t)!, fac!);
        if (key === "e") exportsOf.set(binding(t)!, fac!);
    }

    // Exports: each factory's keys and the value(s) behind each. `module.exports = X` is also the namespace's own value.
    const exported = new Map<Node, Map<string, Node[]>>();
    const whole = new Map<Node, Node[]>();
    const getterValues = (g: Any | null | undefined): Node[] =>
        !g || !isFunction(g) ? [] : g.body.type === "BlockStatement" ? (returns.get(g) ?? []).flatMap((r: Any) => r.argument ?? []) : [g.body];
    const add = (fac: Node, key: string | undefined, vs: Node[]) => {
        if (key === undefined) return;
        const keys = exported.get(fac) ?? exported.set(fac, new Map()).get(fac)!;
        for (const v of vs) {
            pushTo(keys, key, v);
            edge("EXPORTS", fac, v, { name: key });
        }
    };
    const bound = (e: Any | null | undefined, to: Map<Node, Node>) => (e?.type === "Identifier" ? to.get(refers.get(e)!) : undefined);
    // `module.exports` of a factory, or its `exports` param: the factory.
    const exportsObj = (e: Any | null | undefined) =>
        bound(e, exportsOf) ?? (e?.type === "MemberExpression" && keyOf(e) === "exports" ? bound(e.object, moduleOf) : undefined);
    // `{key: getter}`, or `[key, 0, value | key, getter, setter?, ...]` (webpack 5.112's require.d and Turbopack's ctx.s)
    const exportsFrom = (fac: Node, defn: Any | null | undefined) => {
        if (defn?.type === "ObjectExpression")
            for (const p of defn.properties as Any[]) {
                // Turbopack before 15.5: `{key: getter | [getter, setter]}`
                const g = p.type === "ObjectMethod" ? p : p.value?.type === "ArrayExpression" ? p.value.elements[0] : p.value;
                if (p.type !== "SpreadElement" && !p.computed) add(fac, p.key.type === "Identifier" ? p.key.name : lit(p.key), getterValues(g));
            }
        else if (defn?.type === "ArrayExpression") {
            const els = defn.elements as (Any | null)[];
            for (let i = 0; i < els.length; ) {
                const key = lit(els[i++]);
                const b = els[i++];
                add(fac, key, b?.type === "NumericLiteral" && b.value === 0 ? [els[i++]].filter((v): v is Any => !!v) : getterValues(b));
                if (isFunction(els[i])) i++; // Turbopack: a setter after the getter
            }
        }
    };
    const nsAlias = new Map<Node, Node[]>(); // Turbopack `ctx.n(ns)`: the factory's namespace is ns
    for (const c of cs) {
        const { callee: f, arguments: [e, defn, getter] } = c;
        if (isHelper(f, "d")) {
            const fac = bound(e, exportsOf);
            if (!fac) continue;
            if (defn?.type === "ObjectExpression" || defn?.type === "ArrayExpression") exportsFrom(fac, defn);
            else add(fac, lit(defn), getterValues(getter)); // webpack 4: require.d(exports, "key", getter)
        }
        // Turbopack: ctx.s(bindings, id?), ctx.v(value, id?) (module.exports = value), ctx.n(ns, id?). `id` is
        // another module's when the code of several is merged into one factory.
        if (isCtx(f, "s") || isCtx(f, "v") || isCtx(f, "n")) {
            const k = keyOf(f);
            const facs = lit(defn) !== undefined ? (factories.get(lit(defn)!) ?? []) : [ctxOf.get(refers.get(f.object)!)!];
            for (const fac of e ? facs : []) {
                if (k === "s") exportsFrom(fac, e);
                else pushTo(k === "v" ? whole : nsAlias, fac, e);
            }
        }
        // Object.defineProperty(exports, "key", { value } | { get }), as TypeScript and Babel emit for CommonJS
        if (f.type === "MemberExpression" && keyOf(f) === "defineProperty" && f.object.name === "Object" && !refers.has(f.object) && defn && defn.value !== "__esModule") {
            const fac = exportsObj(e);
            for (const p of fac && getter?.type === "ObjectExpression" ? (getter.properties as Any[]) : []) {
                const k = p.type === "SpreadElement" || p.computed ? undefined : p.key.name ?? lit(p.key);
                if (k === "value") add(fac!, lit(defn), [p.value]);
                if (k === "get") add(fac!, lit(defn), getterValues(p.type === "ObjectMethod" ? p : p.value));
            }
        }
    }
    for (const a of assigns as Any[]) {
        const l = a.left;
        if (l.type !== "MemberExpression") continue;
        const fac = keyOf(l) === "exports" ? bound(l.object, moduleOf) : undefined;
        if (fac) {
            // module.exports = X; an object literal's own keys are named exports too
            pushTo(whole, fac, a.right);
            for (const p of a.right.type === "ObjectExpression" ? (a.right.properties as Any[]) : [])
                if (p.type !== "SpreadElement" && !p.computed) add(fac, p.key.name ?? lit(p.key), [p.type === "ObjectMethod" ? p : p.value]);
            continue;
        }
        const target = exportsObj(l.object); // exports.key = v, module.exports.key = v
        if (target) add(target, keyOf(l), [a.right]);
    }
    for (const [fac, vs] of whole) if (!exported.get(fac)?.has("default")) add(fac, "default", vs); // what require.n / require.t read
    // Turbopack's import(): `ctx.A(id)`, or `ctx.r(id)(ctx.i)` before Next.js 15.5, calls module id's exported loader
    // with the import function, as in `ctx.v(i => Promise.all([...chunk loads]).then(() => i(target)))`, so the
    // loader's param is a require.
    const loaderOf = (c: Any) =>
        isCtx(c.callee, "A") ? lit(c.arguments[0])
        : c.callee.type === "CallExpression" && isCtx(c.callee.callee, "r") && isCtx(c.arguments[0], "i") ? lit(c.callee.arguments[0])
        : undefined;
    for (const c of cs)
        for (const fac of factories.get(loaderOf(c)!) ?? [])
            for (const v of whole.get(fac) ?? []) if (isFunction(v) && v.params[0]?.type === "Identifier") requires.add(binding(v.params[0])!);
    return { factories, requires, ctxOf, cw, exported, whole, nsAlias, getterValues, add, isReq, isHelper, isCtx, loaderOf };
}
export type Registry = ReturnType<typeof linkRegistries>;
