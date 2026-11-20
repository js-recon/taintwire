import type { Node } from "@babel/types";

// Bundler code reads node fields by shape (callee, arguments, properties, ...) on nodes of any type.
export type Any = Node & Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export const lit = (n: Node | null | undefined) => (n?.type === "NumericLiteral" || n?.type === "StringLiteral" ? String(n.value) : undefined);
// A member's static key: `o.k` or `o["k"]`.
export const keyOf = (m: Any) => (m.computed ? lit(m.property) : m.property.type === "Identifier" ? m.property.name : undefined);
/** Append `v` to the list `m` holds under `k`, creating the list on first use. */
export const pushTo = <K, V>(m: Map<K, V[]>, k: K, v: V) => {
    const list = m.get(k);
    if (list) list.push(v);
    else m.set(k, [v]);
};
