// Test fixture: exercises TypeScript and JSX node types. Parsed only, never type-checked or run.
import React, { useState } from "react";
enum Color { Red = 1, Green }
interface Props<T> extends Base { name: string; items?: T[]; onClick(e: MouseEvent): void }
type U = string | number | [boolean, ...unknown[]] | { readonly [k: string]: U } | keyof typeof x;
declare module "m" { export const v: number; }
namespace N { export abstract class A<T = any> extends B implements I { private constructor(public readonly x?: T) { super(); } abstract m(): void; } }
function assertIsString(v: unknown): asserts v is string {}
export function App<T>({ name, items = [] as T[] }: Props<T>) {
    const [n, setN] = useState<number>(0);
    const el = document.getElementById("x")!;
    const cast = (el as any) satisfies object;
    return (
        <>
            <div className="a" {...rest} data-x={n} onClick={() => setN(n + 1)}>
                {items.map((i) => <Item key={String(i)} />)}
                text &amp; {name}
                <ns:tag />
                <a.b.C />
            </div>
        </>
    );
}
