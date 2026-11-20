// What JS syntax means for the graph, per node: bindings, scopes, name references, value-flow facts.
import { isFunction, type Node } from "@babel/types";
import { sha256 } from "@shriyanss/cs-mast";
import { hashOf } from "./parse.js";
import { SCOPE, type ScopeKind, type ScopeRow } from "./schema.js";

// The Identifiers a binding pattern binds: pattern values (never object keys), defaults' left side only.
export function bindingIds(p: Node | null | undefined): Node[] {
    switch (p?.type) {
        case "Identifier":
            return p.name === "this" ? [] : [p]; // TS `this` parameter isn't a binding
        case "ObjectPattern":
            return p.properties.flatMap((q) => bindingIds(q.type === "RestElement" ? q.argument : (q.value as Node)));
        case "ArrayPattern":
            return p.elements.flatMap(bindingIds);
        case "AssignmentPattern":
            return bindingIds(p.left);
        case "RestElement":
            return bindingIds(p.argument);
        case "TSParameterProperty":
            return bindingIds(p.parameter);
        default:
            return [];
    }
}

/** Identifier nodes `node` introduces as JS bindings (its DECLARES targets). Wrappers, patterns and control flow declare nothing. */
export function declared(node: Node): Node[] {
    switch (node.type) {
        case "VariableDeclarator": // var / let / const / using / await using
            return bindingIds(node.id);
        case "FunctionDeclaration":
        case "FunctionExpression":
            return [node.id, ...node.params].flatMap(bindingIds);
        case "ArrowFunctionExpression":
        case "ObjectMethod":
        case "ClassMethod":
        case "ClassPrivateMethod": // params only: the key is a property name, not a binding
            return node.params.flatMap(bindingIds);
        case "ClassDeclaration":
        case "ClassExpression":
            return bindingIds(node.id);
        case "ImportSpecifier": // the local name, not the imported one
        case "ImportDefaultSpecifier":
        case "ImportNamespaceSpecifier":
            return [node.local];
        case "CatchClause":
            return bindingIds(node.param);
        default:
            return [];
    }
}

const isLexical = (d: Node | null | undefined) => d?.type === "VariableDeclaration" && d.kind !== "var";

/** The kind of scope `node` creates, or null. `parent` tells a function/catch body apart from a nested block. */
export function scopeKind(node: Node, parent?: Node): ScopeKind | null {
    if (isFunction(node)) return "function";
    switch (node.type) {
        case "Program":
            return node.sourceType === "module" ? "module" : "global";
        case "ClassDeclaration":
        case "ClassExpression":
            return "class";
        case "StaticBlock":
            return "static_block";
        case "CatchClause":
            return "catch";
        case "SwitchStatement": // one scope shared by every case
            return "block";
        case "BlockStatement": // a function or catch body is part of that scope
            return parent && (isFunction(parent) || parent.type === "CatchClause") ? null : "block";
        case "ForStatement":
            return isLexical(node.init) ? "block" : null;
        case "ForInStatement":
        case "ForOfStatement":
            return isLexical(node.left) ? "block" : null;
        default:
            return null;
    }
}
// Scopes `var` binds in; the rest only hold lexical bindings.
export const VAR_SCOPES = new Set<ScopeKind>(["global", "module", "function", "static_block"]);
// Children evaluated outside the scope their parent creates: method keys, decorators, the switch discriminant.
export const OUTER_KEYS = new Set(["key", "decorators", "discriminant"]);

// id: unique per graph (file + owner position). signature: content-derived like `hash`, so identical code in two places shares it.
export function scopeRow(kind: ScopeKind, owner: Node, file: string): ScopeRow {
    const ownerSig = hashOf(owner);
    return {
        id: `${SCOPE}_${sha256(`${file}\0${owner.type}\0${owner.start}\0${owner.end}`).slice(0, 16)}`,
        kind,
        file,
        signature: ownerSig && sha256(`scope:${kind}:${ownerSig}`),
        owner_signature: ownerSig,
    };
}

// Builtins whose result carries their input (arg 0 for functions, the receiver for methods), for value flow through
// unresolved calls. Encoders (encodeURIComponent, escape) are left out on purpose: their output is safe in HTML.
export const PASS_FNS = new Set(["decodeURIComponent", "decodeURI", "unescape", "String", "Object"]);
export const PASS_METHODS = new Set(["slice", "substring", "substr", "trim", "trimStart", "trimEnd", "toLowerCase", "toUpperCase", "padStart", "padEnd", "repeat", "normalize", "replace", "replaceAll", "toString", "valueOf", "at", "concat"]);

// TS nodes whose `expression` is a runtime value; every other Identifier under a TS node is type-level.
export const TS_VALUES = new Set(["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "TSTypeAssertion", "TSInstantiationExpression", "TSExportAssignment"]);
// The declarations of ES-module syntax, walked for the ESM pass in flattenFiles().
export const ESM_DECLS = new Set(["ImportDeclaration", "ExportNamedDeclaration", "ExportDefaultDeclaration", "ExportAllDeclaration"]);

/** Whether the Identifier at `parent[key]` is a lexical name lookup, not a property name, label, import/export name or type. */
export function isRef(parent: Node, key: string): boolean {
    if (key === "label" || key === "imported" || key === "exported") return false;
    if ((key === "key" || key === "property") && !(parent as { computed?: boolean }).computed) return false;
    if (parent.type === "PrivateName") return false;
    return !parent.type.startsWith("TS") || (TS_VALUES.has(parent.type) && key === "expression");
}

// Value-flow and binding-write facts, in AST nodes; flatten() resolves targets to declarations once every binding is known.
export type Facts = {
    flows: [Node, Node][]; // value -> the expression/statement it contributes to
    stores: [Node, Node][]; // value -> the binding of a target Identifier
    writes: [Node, Node][]; // operation -> target Identifier
    writeOnly: Set<Node>; // target Identifiers that aren't also read
    defs: [Node, Node | null][]; // target Identifier -> the value it's given, or null when that isn't one expression
};

// Calls, member access, object/array literals, destructuring, iteration and await/yield add no flow yet (see docs/value-flow).
export function facts(node: Node, f: Facts) {
    const into = (...xs: (Node | null | undefined)[]) => xs.forEach((x) => x && f.flows.push([x, node]));
    const write = (ts: Node[], only = false, value: Node | null = null) =>
        ts.forEach((t) => (f.writes.push([node, t]), f.defs.push([t, value]), only && f.writeOnly.add(t)));
    switch (node.type) {
        case "BinaryExpression":
        case "LogicalExpression":
            return into(node.left as Node, node.right);
        case "ConditionalExpression": // the test picks a value but isn't one: control, not data
            return into(node.consequent, node.alternate);
        case "UnaryExpression": // void is always undefined; delete's result says whether a property went away
            if (node.operator !== "void" && node.operator !== "delete") into(node.argument);
            return;
        case "TemplateLiteral":
            return into(...(node.expressions as Node[]));
        case "SequenceExpression": // only the last expression is the result
            return into(node.expressions.at(-1));
        case "ReturnStatement":
            return into(node.argument);
        case "UpdateExpression": // prefix and postfix both depend on the old value
            into(node.argument);
            write(bindingIds(node.argument));
            if (node.argument.type === "Identifier") f.stores.push([node, node.argument]);
            return;
        case "AssignmentExpression": // the expression's value is the right side (combined with the old value if compound)
            into(node.right, node.operator === "=" ? null : (node.left as Node));
            write(bindingIds(node.left as Node), node.operator === "=", node.operator === "=" && node.left.type === "Identifier" ? node.right : null);
            if (node.left.type === "Identifier") f.stores.push([node, node.left]);
            return;
        case "VariableDeclarator":
            if (!node.init) return;
            write(bindingIds(node.id), false, node.id.type === "Identifier" ? node.init : null);
            if (node.id.type === "Identifier") f.stores.push([node.init, node.id]);
            return;
        case "AssignmentPattern": // a default value
            write(bindingIds(node.left));
            if (node.left.type === "Identifier") f.stores.push([node.right, node.left]);
            return;
        case "ForInStatement":
        case "ForOfStatement": {
            const decl = node.left.type === "VariableDeclaration";
            return write(decl ? (node.left as Node & { declarations: { id: Node }[] }).declarations.flatMap((d) => bindingIds(d.id)) : bindingIds(node.left), !decl);
        }
        default:
            if (TS_VALUES.has(node.type) && node.type !== "TSExportAssignment") into((node as Node & { expression: Node }).expression);
    }
}
