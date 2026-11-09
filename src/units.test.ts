import { expect, test } from "vitest";
import { planUnits, type ModuleLinks } from "./index.js";

const plan = (links: Record<string, Partial<ModuleLinks>>) =>
    planUnits(new Map(Object.entries(links).map(([f, l]) => [f, { defines: l.defines ?? [], needs: l.needs ?? [] }])));

test("a chain: each file joins the unit of the file that loads it", () => {
    expect(plan({ a: { needs: ["1"] }, b: { defines: ["1"], needs: ["2"] }, c: { defines: ["2"] } })).toEqual([["a", "b", "c"]]);
});

test("a shared vendor file goes in every importer's unit; equal units are kept once", () => {
    expect(plan({ v: { defines: ["9"] }, p: { needs: ["9"] }, q: { needs: ["9"] }, r: { defines: ["9"] } })).toEqual([
        ["v", "p", "r"],
        ["v", "q", "r"],
    ]);
});

test("a cycle is one unit; files with no registry are a unit each", () => {
    expect(plan({ a: { defines: ["1"], needs: ["2"] }, b: { defines: ["2"], needs: ["1"] }, x: {}, y: {} })).toEqual([["a", "b"], ["x"], ["y"]]);
});

test("a need no file defines links nothing", () => {
    expect(plan({ a: { needs: ["404"] } })).toEqual([["a"]]);
});
