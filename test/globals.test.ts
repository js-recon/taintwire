import { expect, test } from "vitest";
import { PookieGraph } from "../src/index.js";
import { sinks } from "./test-utils.js";

// Classic (non-module) scripts on one page: top-level declarations are globals every other script sees.
const FILES: Record<string, string> = {
    "lib.js": `var parseQuery = function(p){ a.innerHTML = p }; function render(p){ b.innerHTML = p } let shown = 1; function wrap(){ function inner(p){ c.innerHTML = p } }`,
    "page.js": `parseQuery(window.name); render(window.name); inner(window.name);`,
    // a module reads a classic script's global too
    "mod.js": `import "./x.js"; render(window.name + shown);`,
};

const hitsOf = async (groups: string[][]) => {
    const hit = new Set<string>();
    for (const names of groups) {
        const g = await PookieGraph.open();
        await g.addFiles(names.map((filename) => ({ filename, code: FILES[filename] })));
        // a file with no assignment has no AssignmentExpression table: no sink
        const s = await sinks(g).catch((e: Error) =>
            /does not exist/.test(e.message) ? { hit: [] } : Promise.reject(e)
        );
        s.hit.forEach((h) => hit.add(h));
        await g.close();
    }
    return [...hit].sort();
};

test("a call into another classic script's top-level function reaches its sink", async () => {
    expect(await hitsOf([Object.keys(FILES)])).toEqual(["p"]);
    const g = await PookieGraph.open();
    await g.addFiles(Object.entries(FILES).map(([filename, code]) => ({ filename, code })));
    const calls = await g.query(
        "MATCH (c:CallExpression)-[:CALLS]->(f) WHERE c.file <> f.file RETURN c.file AS from, f.file AS to, f.startOffset AS at"
    );
    await g.close();
    const at = (s: string) => FILES["lib.js"].indexOf(s);
    // parseQuery (var = function) and render (function declaration) link, from a script and from a module; a function
    // nested in another function is not a global, so inner() doesn't
    expect(calls.map((r) => `${r.from}->${r.to}@${r.at}`).sort()).toEqual(
        [
            `mod.js->lib.js@${at("function render")}`,
            `page.js->lib.js@${at("function(p){ a")}`,
            `page.js->lib.js@${at("function render")}`,
        ].sort()
    );
});

test("files loaded one by one don't link", async () => {
    expect(await hitsOf(Object.keys(FILES).map((f) => [f]))).toEqual([]);
});

test("the later script's declaration wins", async () => {
    const g = await PookieGraph.open();
    await g.addFiles([
        { filename: "a.js", code: `function f(p){ x.innerHTML = p }` },
        { filename: "b.js", code: `function f(p){ y.textContent = p }` },
        { filename: "c.js", code: `f(window.name)` },
    ]);
    const to = await g.query("MATCH (c:CallExpression)-[:CALLS]->(f) RETURN f.file AS file");
    await g.close();
    expect(to.map((r) => r.file)).toEqual(["b.js"]);
});

test("an undeclared assignment (sloppy-mode implicit global) flows to reads of that name", async () => {
    const g = await PookieGraph.open();
    await g.addFiles([
        { filename: "h.js", code: `r = window.name; a.innerHTML = r + "a"; function f(){ b.innerHTML = r + "b" } f()` },
        { filename: "i.js", code: `c.innerHTML = r + "c"; function g(r){ d.innerHTML = r + "d" } g(1)` },
        // assigning a host property isn't a new variable: name/location reads stay host reads
        { filename: "j.js", code: `location = window.name; e.innerHTML = location` },
    ]);
    const s = await sinks(g);
    const isGlobal = await g.query(
        "MATCH (i:Identifier {name: 'location'}) WHERE NOT EXISTS { MATCH (i)-[:REFERS_TO]->() } RETURN count(i) AS n"
    );
    await g.close();
    // a, b (other scope) and c (other script) get it; d is g's own parameter r, e is the host location
    expect(s.hit).toEqual(['r + "a"', 'r + "b"', 'r + "c"']);
    expect(s.clean).toEqual(["location", 'r + "d"']);
    expect(Number(isGlobal[0].n)).toBe(2);
});
