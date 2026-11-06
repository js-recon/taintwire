import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import * as taintwire from "./index.js";
import type { PGCypher, PGRule, PGSelector } from "./index.js";

const AT = "n.file AS file, n.line AS line, n.col AS col";
const urlSource: PGSelector = {
    cypher: {
        query: `MATCH (n:MemberExpression)-[:SON {key: 'property'}]->(p:Identifier), (n)-[:SON {key: 'object'}]->(o)
WHERE p.name IN ['hash', 'search'] AND o.name = 'location' RETURN n.id AS id, p.name AS kind, ${AT}`,
    },
};
const htmlSink: PGCypher = {
    query: `MATCH (a:AssignmentExpression)-[:SON {key: 'left'}]->(:MemberExpression)-[:SON {key: 'property'}]->(p:Identifier), (a)-[:SON {key: 'right'}]->(n)
WHERE p.name = 'innerHTML' AND NOT n.type IN ['StringLiteral'] RETURN n.id AS id, ${AT}`,
};
const rule = (sink: Partial<PGSelector> = {}): PGRule => ({
    id: "url_html",
    name: "URL to innerHTML",
    severity: "high",
    message: "URL value reaches innerHTML",
    return: [{ cypher: htmlSink, from: urlSource, ...sink }],
});
const run = async (code: string, rules: PGRule[]) => {
    const g = await taintwire.import(code, { filename: "a.js", parser: "babel" });
    try {
        return await taintwire.runPgq(g, rules);
    } finally {
        await g.close();
    }
};
const TWO_OPAQUE = `const p = new URLSearchParams(location.search), t = p.get("q"); document.body.innerHTML = t;`;

describe("validatePgq", () => {
    test("accepts a valid rule", () => expect(taintwire.validatePgq(rule())).toEqual([]));

    test("reports bad fields", () => {
        const errs = taintwire.validatePgq({ ...rule(), id: "", severity: "urgent", return: [{ cypher: [] }] });
        expect(errs.join("\n")).toMatch(/\.id: expected a non-empty string/);
        expect(errs.join("\n")).toMatch(/severity: expected one of info, low, medium, high, critical/);
        expect(errs.join("\n")).toMatch(/cypher: expected a PGCypher or a non-empty list/);
    });

    test("every $param needs a uses entry; strings and comments don't count", () => {
        const sel = {
            cypher: { query: "MATCH (n:Identifier) WHERE n.id IN $L AND n.name <> '$fetch' // $x\nRETURN n.id AS id" },
        };
        expect(taintwire.validatePgq({ ...rule(), return: [sel] })).toEqual([
            "url_html.return[0].cypher: $L isn't supplied by uses",
        ]);
        expect(taintwire.validatePgq({ ...rule(), return: [{ ...sel, uses: { L: urlSource } }] })).toEqual([]);
    });

    test("cycles, duplicate ids and mode without from", () => {
        const a: PGSelector = { cypher: { query: "RETURN 1" } };
        a.from = a;
        expect(taintwire.validatePgq({ ...rule(), return: [a] }).join()).toMatch(/depends on itself/);
        expect(taintwire.validatePgq([rule(), rule()]).join()).toMatch(/duplicate rule id/);
        expect(taintwire.validatePgq({ ...rule(), return: [{ cypher: htmlSink, mode: "deep" }] }).join()).toMatch(
            /only apply with from/
        );
    });
});

describe("runPgq", { timeout: 60000 }, () => {
    test("deep mode follows a value through two opaque calls, with the source", async () => {
        const { findings, errors } = await run(TWO_OPAQUE, [rule()]);
        expect(errors).toEqual([]);
        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            ruleId: "url_html",
            severity: "high",
            file: "a.js",
            source: { kind: "search" },
        });
        expect(findings[0].hops).toBeGreaterThan(0);
    });

    test("strict and lenient stop at the opaque calls; maxHops drops long flows", async () => {
        expect((await run(TWO_OPAQUE, [rule({ mode: "strict" })])).findings).toHaveLength(0);
        expect((await run(TWO_OPAQUE, [rule({ mode: "lenient" })])).findings).toHaveLength(0);
        expect((await run(TWO_OPAQUE, [rule({ maxHops: 0 })])).findings).toHaveLength(0);
        expect(
            (await run(`document.body.innerHTML = location.hash.slice(1);`, [rule({ mode: "lenient" })])).findings
        ).toHaveLength(1);
    });

    test("uses passes ids as parameters; an empty dependency empties the selector", async () => {
        const handlers: PGSelector = {
            cypher: {
                query: `MATCH (c:CallExpression)-[:SON {key: 'callee'}]->(:MemberExpression)-[:SON {key: 'property'}]->(ae:Identifier),
      (c)-[a0:SON {key: 'arguments'}]->(t:StringLiteral), (c)-[a1:SON {key: 'arguments'}]->(h)
WHERE ae.name = 'addEventListener' AND a0.idx = 0 AND a1.idx = 1 AND t.value = 'message' RETURN h.id AS id, h.file AS file, h.line AS line, h.col AS col`,
            },
        };
        const data: PGSelector = {
            uses: { L: handlers },
            cypher: {
                query: `MATCH (f)-[:SON {key: 'params', idx: 0}]->(d:Identifier)<-[:REFERS_TO]-(e:Identifier)<-[:SON {key: 'object'}]-(n:MemberExpression)-[:SON {key: 'property'}]->(p:Identifier)
WHERE f.id IN $L AND p.name = 'data' RETURN n.id AS id, ${AT}`,
            },
        };
        const evalSink = `MATCH (c:CallExpression)-[:SON {key: 'callee'}]->(f:Identifier), (c)-[a:SON {key: 'arguments'}]->(n)
WHERE f.name = 'eval' AND a.idx = 0 RETURN n.id AS id, ${AT}`;
        const msg: PGRule = { ...rule(), id: "msg", return: [{ cypher: { query: evalSink }, from: data }] };
        const code = `function run(x) { eval(x); } window.addEventListener("message", (e) => run(e.data.expr));`;
        expect((await run(code, [msg])).findings).toHaveLength(1);
        expect((await run(`function run(x) { eval(x); } run(window.foo);`, [msg])).findings).toHaveLength(0);
    });

    test("a bare PGCypher in return is a finding per row; a failing rule doesn't stop the others", async () => {
        const plain: PGRule = { ...rule(), id: "plain", return: [htmlSink] };
        const broken: PGRule = {
            ...rule(),
            id: "broken",
            return: [{ cypher: { query: "MATCH (n:Identifier) RETURN n.id AS id" } }],
        };
        const { findings, errors } = await run(`el.innerHTML = x; el.innerHTML = y;`, [broken, plain]);
        expect(findings.map((f) => f.ruleId)).toEqual(["plain", "plain"]);
        expect(errors).toEqual([
            { ruleId: "broken", message: "a selector in return or from must RETURN id, file, line and col" },
        ]);
    });

    test("checkPgqCypher reports syntax errors, not missing labels", async () => {
        const g = await taintwire.PookieGraph.open();
        try {
            const bad: PGRule = {
                ...rule(),
                return: [{ cypher: { query: "MATCH (n:Identifier RETURN n" } }, htmlSink],
            };
            const errs = await taintwire.checkPgqCypher(g, [bad]);
            expect(errs).toHaveLength(1);
            expect(errs[0]).toMatch(/^url_html\.return\[0\]: /);
        } finally {
            await g.close();
        }
    });
});

describe("read-only open", { timeout: 60000 }, () => {
    test("reads a saved PookieGraph without writing to it", async () => {
        const dir = mkdtempSync(join(tmpdir(), "tw-ro-"));
        try {
            const path = join(dir, "g.pg");
            const g = await taintwire.import(TWO_OPAQUE, { filename: "a.js", parser: "babel" });
            await g.save(path);
            await g.close();
            const before = readdirSync(dir).sort();
            const ro = await taintwire.PookieGraph.open(path, { readOnly: true });
            expect((await taintwire.runPgq(ro, [rule()])).findings).toHaveLength(1);
            await expect(ro.add("x", "b.js")).rejects.toThrow();
            await ro.close();
            expect(readdirSync(dir).sort()).toEqual(before);
            await expect(taintwire.PookieGraph.open(join(dir, "missing.pg"), { readOnly: true })).rejects.toThrow(
                /no PookieGraph/
            );
            expect(existsSync(join(dir, "missing.pg"))).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("loadPgq", { timeout: 60000 }, () => {
    const pack = (files: Record<string, string>) => {
        const dir = mkdtempSync(join(tmpdir(), "tw-pgq-"));
        for (const [name, src] of Object.entries(files)) writeFileSync(join(dir, name), src);
        return dir;
    };

    test("evaluates TypeScript, relative imports and shared selectors", async () => {
        const dir = pack({
            "lib.pgq": `import type { PGSelector } from "@js-recon/taintwire";
const at: string = "n.file AS file, n.line AS line, n.col AS col";
export const ids = (label: string): PGSelector => ({ cypher: { query: \`MATCH (n:\${label}) RETURN n.id AS id, \${at}\` } });
export const shared: PGSelector = ids("Identifier");`,
            "rule.pgq": `import type { PGRule } from "@js-recon/taintwire";
import { shared, ids } from "./lib.pgq";
console.log("debug output goes to stderr");
export default [
    { id: "a", name: "A", severity: "info", message: "m", return: [shared] },
    { id: "b", name: "B", severity: "low", message: "m", return: [shared, ids("StringLiteral")] },
] satisfies PGRule[];`,
        });
        try {
            const { rules, errors } = await taintwire.loadPgq([join(dir, "lib.pgq"), join(dir, "rule.pgq")]);
            expect(errors).toEqual([]);
            expect(rules.map((r) => r.id)).toEqual(["a", "b"]);
            expect(rules[0].return[0]).toBe(rules[1].return[0]); // one DAG node, evaluated once
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("sandbox: no builtins, packages, network, fs writes, or files outside the pack", async () => {
        const outside = mkdtempSync(join(tmpdir(), "tw-out-"));
        writeFileSync(join(outside, "x.pgq"), "export const x = 1;");
        const dir = pack({
            "fs.pgq": `import { readFileSync } from "node:fs"; export default readFileSync;`,
            "pkg.pgq": `import { PookieGraph } from "@js-recon/taintwire"; export default PookieGraph;`,
            "dyn.pgq": `await import("node:child_process"); export default 1;`,
            "builtin.pgq": `export default process.getBuiltinModule("node:fs");`,
            "fetch.pgq": `await fetch("http://127.0.0.1:1/"); export default 1;`,
            "outside.pgq": `import { x } from "${join(outside, "x.pgq")}"; export default x;`,
            "func.pgq": `export default { id: "f", name: "f", severity: "info", message: "m", return: [() => 1] };`,
            "kill.pgq": `process.kill(process.ppid); export default 1;`,
        });
        try {
            const files = readdirSync(dir).map((f) => join(dir, f));
            const { rules, errors } = await taintwire.loadPgq(files);
            expect(rules).toEqual([]);
            const by = (name: string) => errors.find((e) => e.startsWith(join(dir, name))) ?? "";
            for (const f of ["fs.pgq", "pkg.pgq", "dyn.pgq", "outside.pgq"])
                expect(by(f)).toMatch(/may only import other \.pgq files/);
            expect(by("builtin.pgq")).toMatch(/not a function/);
            expect(by("fetch.pgq")).toMatch(/fetch is not defined/);
            expect(by("kill.pgq")).toMatch(/not a function/);
            expect(by("func.pgq")).toMatch(/isn't data/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
            rmSync(outside, { recursive: true, force: true });
        }
    });

    test("a result bigger than a pipe buffer arrives whole", async () => {
        const dir = pack({
            "big.pgq": `export default Array.from({ length: 400 }, (_, i) => ({
    id: "r" + i, name: "r", severity: "info", message: "m",
    return: [{ query: "MATCH (n:Identifier) WHERE n.name <> '" + "x".repeat(1000) + "' RETURN n.id AS id" }],
}));`,
        });
        try {
            const { rules, errors } = await taintwire.loadPgq([join(dir, "big.pgq")]);
            expect(errors).toEqual([]);
            expect(rules).toHaveLength(400);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("validation errors carry the file", async () => {
        const dir = pack({
            "bad.pgq": `export default { id: "x", name: "x", severity: "urgent", message: "m", return: [] };`,
        });
        try {
            const { rules, errors } = await taintwire.loadPgq([join(dir, "bad.pgq")]);
            expect(rules).toEqual([]);
            expect(errors.join("\n")).toMatch(/bad\.pgq: x\.severity/);
            expect(errors.join("\n")).toMatch(/bad\.pgq: x\.return/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
