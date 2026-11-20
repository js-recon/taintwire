import { isFunction, type Node } from "@babel/types";
import { CHILD_KEYS, hashOf } from "../parse.js";
import { relMaps, SCOPE, SKIP_PROPS, type Edge, type Rel, type Row, type ScopeRow } from "../schema.js";
import { pushTo } from "./util.js";
import { declared, ESM_DECLS, facts, isRef, OUTER_KEYS, scopeKind, scopeRow, VAR_SCOPES, type Facts } from "../semantics.js";

const randomHex = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
type Ref = { type: string; slug_ref: string };

const scalar = (v: unknown): string | null => {
    if (["string", "number", "boolean", "bigint"].includes(typeof v)) return String(v);
    // TemplateElement.value is { raw, cooked }
    if (v && typeof v === "object" && "raw" in v) return String((v as { cooked?: string; raw: string }).cooked ?? (v as { raw: string }).raw);
    return null;
};

/**
 * Walk every file's AST once: node rows, SON edges, scopes and DECLARES / IN_SCOPE, plus what the later passes resolve
 * (uses, value-flow facts, calls, members, assignments, returns, ESM syntax). With `parse`, `eval("<literal>")` is walked too.
 */
export function walk(units: [Node, string][], parse?: (code: string) => Node) {
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
    const push = (rel: Rel, from: string, to: string, e: Edge) => pushTo(rels[rel], `${from}\0${to}`, e);
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
        if (node.type === "ReturnStatement" && outer.fn) pushTo(returns, outer.fn, node);
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
    return { idOf, edge, nodes, scopes, rels, parentScope, bindings, declScope, selfNames, uses, notRef, f, declarer, calls, members, assigns, evals, returns, esm };
}
export type Walk = ReturnType<typeof walk>;
