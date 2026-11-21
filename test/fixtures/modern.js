#!/usr/bin/env node
// Test fixture: exercises modern JS syntax (classes, private members, generators, optional chaining, ...).
// Parsed only, never run.
"use strict";
import def, { a as b, c } from "./x.js";
import * as ns from "./y.js";
export * from "./z.js";
export { b as bee };
export default class Foo extends Bar {
    #priv = 1;
    static count = 0;
    static { Foo.count++; }
    constructor(...args) { super(...args); this.#priv = new.target; }
    get v() { return this.#priv; }
    set v(x) { this.#priv = x; }
    #m() { return #priv in this; }
    async *gen() { yield* [1, 2]; for await (const x of ns.it) yield x; }
}
const { p = 1, q: [r, , ...s], ...rest } = obj ?? {};
let t = a?.b?.[c]?.(d), u = 10n, v = /ab+c/gi, w = `x${t}y`, z = tag`hi ${u}`;
var o = { m() {}, get g() { return 1; }, [k]: 2, ...o2, sh };
label: for (let i = 0; i < 3; i++) { if (i) continue label; else break label; }
for (const k in o) {} for (const e of [1, 2]) {}
while (false) {} do { t &&= 1; t ||= 2; t ??= 3; u **= 2; } while (0);
switch (t) { case 1: break; default: throw new Error("x"); }
try { debugger; } catch { } finally { ; }
const f = async (x = 1) => await x, g = function* named() {}, h = typeof t === "x" ? void 0 : !t;
(function () { return this; }).call(null, delete o.m, t++, --u, -t, +u, ~u, a in o, a instanceof Object);
const im = import("./dyn.js"), meta = import.meta.url, seq = (1, 2, 3);
