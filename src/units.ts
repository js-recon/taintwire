import { pushTo } from "./flatten/util.js";
import { flattenFiles } from "./flatten/index.js";
import { parseAst, type Parser } from "./parse.js";

/** Which bundler module ids a file registers (`defines`) and which it loads (`needs`), from one file alone. */
export type ModuleLinks = { defines: string[]; needs: string[] };

/** Scan one file for planUnits(). Parses and flattens it, and keeps only the module ids, so its rows are garbage at once. */
export function moduleLinks(code: string, filename: string, parser: Parser = "cs-mast"): ModuleLinks {
    const parse = (c: string) => parseAst(c, parser);
    const { defines, needs } = flattenFiles([[parse(code), filename]], { parse });
    return { defines, needs };
}

/**
 * Split files into units that can each be loaded as its own graph: a file plus every file that defines a module it
 * loads, transitively. A unit contained in another one is dropped, so each file is still loaded with everything it
 * links to and the units cover every file. Files with no module registry (plain ES modules) are a unit each. Returned
 * in input order of each unit's first file, each unit's files in input order.
 * shortcut: links follow imports only, so a value passed between two importers of a shared module (A -> store -> B)
 * is only found by one linked graph of every file; and each file is parsed twice (scan, then build), cache if time matters.
 */
export function planUnits(links: Map<string, ModuleLinks>): string[][] {
    const files = [...links.keys()];
    const definedBy = new Map<string, string[]>();
    for (const [f, l] of links) for (const id of l.defines) pushTo(definedBy, id, f);
    const order = new Map(files.map((f, i) => [f, i]));
    const closures = files.map((root) => {
        const seen = new Set([root]);
        const st = [root];
        while (st.length)
            for (const id of links.get(st.pop()!)!.needs)
                for (const g of definedBy.get(id) ?? []) if (!seen.has(g)) seen.add(g), st.push(g);
        return [...seen].sort((a, b) => order.get(a)! - order.get(b)!);
    });
    // Biggest first, so a unit only has to be checked against the ones already kept; equal sets keep the first.
    const bySize = closures.map((c, i) => [c, i] as const).sort((a, b) => b[0].length - a[0].length || a[1] - b[1]);
    const kept: [string[], Set<string>, number][] = [];
    for (const [c, i] of bySize) if (!kept.some(([, k]) => c.every((f) => k.has(f)))) kept.push([c, new Set(c), i]);
    return kept.sort((a, b) => a[2] - b[2]).map(([c]) => c);
}
