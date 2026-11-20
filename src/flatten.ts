import { isFunction, type Node } from "@babel/types";
import { CHILD_KEYS, hashOf } from "./parse.js";
import { relMaps, SCOPE, SKIP_PROPS, type Edge, type Rel, type Row, type ScopeRow } from "./schema.js";
import { bindingIds, declared, ESM_DECLS, facts, isRef, OUTER_KEYS, PASS_FNS, PASS_METHODS, scopeKind, scopeRow, TS_VALUES, VAR_SCOPES, type Facts } from "./semantics.js";

const randomHex = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
type Ref = { type: string; slug_ref: string };

const scalar = (v: unknown): string | null => {
    if (["string", "number", "boolean", "bigint"].includes(typeof v)) return String(v);
    // TemplateElement.value is { raw, cooked }
    if (v && typeof v === "object" && "raw" in v) return String((v as { cooked?: string; raw: string }).cooked ?? (v as { raw: string }).raw);
    return null;
};

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
 */
export function flattenFiles(units: [Node, string][], { parse }: { parse?: (code: string) => Node } = {}) {
    const ids = new Map<Node, string>();
    const idOf = (n: Node) => {
        let id = ids.get(n);
        if (!id) ids.set(n, (id = `${n.type}_${randomHex()}`));
        return id;
    };
    const isNode = (v: unknown): v is Node => !!v && typeof (v as Node).type === "string";
    const ref = (v: unknown): Ref | unknown => (isNode(v) ? { type: v.type, slug_ref: idOf(v) } : v);

    const nodes = new Map<string, Row[]>();
    const scopes: ScopeRow[] = [];
    const rels = relMaps();
    const push = (rel: Rel, from: string, to: string, e: Edge) => {
        const pair = `${from}\0${to}`;
        if (!rels[rel].has(pair)) rels[rel].set(pair, []);
        rels[rel].get(pair)!.push(e);
    };
    const edge = (rel: Rel, a: Node, b: Node, e: Partial<Edge> = {}) => push(rel, a.type, b.type, { from: idOf(a), to: idOf(b), ...e });

    // Recorded during the walk, resolved after it: a use can come before its declaration, and later siblings are walked first.
    const parentScope = new Map<string, string>();
    const bindings = new Map<string, Map<string, Node>>(); // scope -> name -> its first declaration
    const declScope = new Map<Node, string>(); // DECLARES target -> its scope
    const selfNames = new Set<Node>(); // named function expressions' own names
    const uses: [Node, Node, string | undefined][] = []; // [Identifier, the operation it's an operand of, its scope]
    const notRef = new Set<Node>(); // `export { a } from "x"`: `a` is the other module's name
    const f: Facts = { flows: [], stores: [], writes: [], writeOnly: new Set(), defs: [] };
    const declarer = new Map<Node, Node>(); // DECLARES target -> its declarer
    const calls: Node[] = [];
    const members: Node[] = [];
    const assigns: Node[] = []; // `=` assignments, for CommonJS exports
    const evals: { filename: string; code: string }[] = [];
    const returns = new Map<Node, Node[]>(); // function -> the ReturnStatements it owns (not its nested functions')
    const esm: [Node, string][] = []; // import/export declarations and import() expressions, with their file

    // Iterative walk: minified bundles nest deep enough to blow the JS stack.
    // Each entry carries its parent, the scopes it sits in (`scope` for lexical bindings, `varScope` for var,
    // and `fn`, the function that owns any `return` in it) and its file.
    type Ctx = { scope?: string; varScope?: string; fn?: Node };
    const stack: [Node, Node | undefined, Ctx, string][] = units.map(([ast, file]) => [ast, undefined, {}, file]);
    while (stack.length) {
        const [node, parent, outer, file] = stack.pop()!;
        const id = idOf(node);

        const kind = scopeKind(node, parent);
        let inner = outer;
        if (kind) {
            const s = scopeRow(kind, node, file);
            scopes.push(s);
            push("CREATES_SCOPE", node.type, SCOPE, { from: id, to: s.id! });
            if (outer.scope) {
                push("PARENT_SCOPE", SCOPE, SCOPE, { from: s.id!, to: outer.scope });
                parentScope.set(s.id!, outer.scope);
            }
            inner = { scope: s.id!, varScope: VAR_SCOPES.has(kind) ? s.id! : outer.varScope, fn: isFunction(node) ? node : outer.fn };
        }

        const keys = CHILD_KEYS[node.type] ?? [];
        const props: Record<string, unknown> = {};

        for (const [k, v] of Object.entries(node)) {
            if (SKIP_PROPS.has(k)) continue;
            if (!keys.includes(k)) {
                props[k] = v;
                continue;
            }
            // Child nodes become SON edges; the property keeps a slug reference to the child.
            props[k] = Array.isArray(v) ? v.map(ref) : ref(v);
            (Array.isArray(v) ? v : [v]).forEach((child, i) => {
                if (!isNode(child)) return;
                push("SON", node.type, child.type, { from: id, to: idOf(child), key: k, idx: Array.isArray(v) ? i : -1 });
                const ctx = OUTER_KEYS.has(k) ? outer : inner;
                stack.push([child, node, ctx, file]);
                if (child.type === "Identifier" && isRef(node, k)) uses.push([child, node, ctx.scope]);
            });
        }
        if (node.type === "ExportNamedDeclaration" && node.source) for (const s of node.specifiers) if (s.type === "ExportSpecifier") notRef.add(s.local);
        facts(node, f);
        if (node.type === "CallExpression" || node.type === "OptionalCallExpression") calls.push(node);
        if (node.type === "MemberExpression") members.push(node);
        if (node.type === "AssignmentExpression" && node.operator === "=") assigns.push(node);
        // import(): an ImportExpression (babel parser) or a call whose callee is `Import` (cs-mast)
        if (ESM_DECLS.has(node.type) || node.type === "ImportExpression" || (node.type === "CallExpression" && node.callee.type === "Import")) esm.push([node, file]);
        const [src] = (node as Node & { arguments?: Node[] }).arguments ?? [];
        if (parse && node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "eval" && src?.type === "StringLiteral") {
            let evaluated: Node | undefined;
            try {
                evaluated = parse(src.value);
            } catch {
                // not valid code: stays a string
            }
            if (evaluated) {
                const filename = `${file}#eval@${node.start}`;
                evals.push({ filename, code: src.value });
                push("SON", node.type, evaluated.type, { from: id, to: idOf(evaluated), key: "evaluated", idx: -1 });
                stack.push([evaluated, node, inner, filename]);
            }
        }
        if (node.type === "ReturnStatement" && outer.fn) (returns.get(outer.fn) ?? returns.set(outer.fn, []).get(outer.fn)!).push(node);
        // Same idOf() as SON, so DECLARES targets are the existing Identifier nodes.
        // Every DECLARES target gets its IN_SCOPE from the same declared() call, so the two can't disagree.
        for (const t of declared(node)) {
            push("DECLARES", node.type, t.type, { from: id, to: idOf(t) });
            declarer.set(t, node);
            let s: string | undefined;
            if (node.type === "VariableDeclarator") s = (parent as Node & { kind?: string }).kind === "var" ? outer.varScope : outer.scope;
            // A function/class declaration's own name binds outside it; a named expression's name, params and catch params bind inside.
            else if (kind && !(t === (node as { id?: Node | null }).id && node.type.endsWith("Declaration"))) s = inner.scope;
            else s = outer.scope;
            if (!s) continue;
            push("IN_SCOPE", t.type, SCOPE, { from: idOf(t), to: s });
            declScope.set(t, s);
            // `var x; var x;` or a param redeclared by `var`: one binding, summarised by its first declaration.
            // A named function expression's own name is bound outside its params and body, so any of those shadows it.
            if (node.type === "FunctionExpression" && t === node.id) selfNames.add(t);
            if (!bindings.has(s)) bindings.set(s, new Map());
            const names = bindings.get(s)!;
            const first = names.get((t as Node & { name: string }).name);
            const rank = (d: Node) => (selfNames.has(d) ? 1 : 0);
            if (!first || rank(t) < rank(first) || (rank(t) === rank(first) && t.start! < first.start!))
                names.set((t as Node & { name: string }).name, t);
        }

        const n = node as Node & { name?: unknown; value?: unknown; operator?: unknown };
        if (!nodes.has(node.type)) nodes.set(node.type, []);
        nodes.get(node.type)!.push({
            id,
            type: node.type,
            file,
            startOffset: node.start ?? -1,
            endOffset: node.end ?? -1,
            line: node.loc?.start.line ?? -1,
            col: node.loc?.start.column ?? -1,
            endLine: node.loc?.end.line ?? -1,
            endCol: node.loc?.end.column ?? -1,
            name: typeof n.name === "string" ? n.name : null,
            value: scalar(n.value),
            operator: typeof n.operator === "string" ? n.operator : null,
            props: JSON.stringify(props, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
            hash: hashOf(node),
        });
    }

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
    const def = (d: Node | undefined, v: Node | null) => d && (defs.get(d) ?? defs.set(d, []).get(d)!).push(v);
    for (const [t, v] of f.defs) def(binding(t), v);
    for (const [t, by] of declarer) {
        if (by.type === "VariableDeclarator") continue; // an initializer is a write, above
        if (selfNames.has(t) && binding(t) !== t) continue; // a shadowed function-expression name: no use reaches it
        def(binding(t), isFunction(by) && t === (by as { id?: Node | null }).id ? by : null);
    }

    // Webpack's module registry (docs/bundlers/webpack.md), webpack 4 and 5. A chunk registers module factories
    // `{id(module, exports, require) {...}}` (webpack 4 also uses arrays, id = index) by pushing `[[chunkIds], factories]`;
    // the entry chunk keeps its own in `__webpack_modules__` or passes them to the bootstrap IIFE. ES modules export with
    // `require.d(exports, {key: getter})`, `require.d(exports, [key, 0, value, ...])` or `require.d(exports, "key", getter)`;
    // CommonJS ones assign `module.exports` / `exports.key`. An import is a namespace expression (`require(id)`,
    // `require.n(ns)()`, an `import()` callback's param, ...), and `ns.key` reads the exported value, in whichever file it
    // is: `imported()` resolves it for leaves() (so calls resolve) and FLOWS_TO.
    // ponytail: `require.n(ns)` of an ES module (which reads ns.default) is taken as `ns`, as for CommonJS; and nsOf()
    // re-walks alias chains per query, so memoise it if a bundle with long chains gets slow.
    type Any = Node & Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const lit = (n: Node | null | undefined) => (n?.type === "NumericLiteral" || n?.type === "StringLiteral" ? String(n.value) : undefined);
    // A member's static key: `o.k` or `o["k"]`.
    const keyOf = (m: Any) => (m.computed ? lit(m.property) : m.property.type === "Identifier" ? m.property.name : undefined);
    const factories = new Map<string, Node[]>(); // module id -> its factories (two builds in one graph can reuse an id)
    const requires = new Set<Node>(); // require-function bindings: each factory's third param, and the runtime's function
    const moduleOf = new Map<Node, Node>(); // a factory's `module` binding -> the factory
    const exportsOf = new Map<Node, Node>(); // a factory's `exports` binding -> the factory
    const ctxOf = new Map<Node, Node>(); // a Turbopack factory's context binding -> the factory
    // webpack factories take (module, exports, require), Turbopack's (context, module, exports).
    const addFactory = (id: string, fn: Any, turbo = false) => {
        (factories.get(id) ?? factories.set(id, []).get(id)!).push(fn);
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
            (keys.get(key) ?? keys.set(key, []).get(key)!).push(v);
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
                else (k === "v" ? (whole.get(fac) ?? whole.set(fac, []).get(fac)!) : (nsAlias.get(fac) ?? nsAlias.set(fac, []).get(fac)!)).push(e);
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
            (whole.get(fac) ?? whole.set(fac, []).get(fac)!).push(a.right);
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
        if (!esmFiles.has(file)) esmFiles.add(file), (factories.get(file) ?? factories.set(file, []).get(file)!).push(fac);
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
            if (target !== undefined) (star.get(fac) ?? star.set(fac, []).get(fac)!).push(target);
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
                (keys.get(y) ?? keys.set(y, []).get(y)!).push([target, nameOf(sp.local)]);
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
    // ponytail: by name only, with no idea of the receiver's type; a typed builtin model can replace it.
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
    // `cw@...` factories are inline CommonJS bodies, not registry ids another file can load.
    const defines = [...factories.keys()].filter((id) => !id.startsWith("cw@") && !id.startsWith("ns@"));
    return { rootIds: units.map(([ast]) => idOf(ast)), nodes, scopes, rels, evals, defines, needs: [...needs] };
}
