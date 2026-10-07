import { createRequire } from "node:module";
import { afterAll, expect, test } from "vitest";
import * as taintwire from "./index.js";
const { wasmBackend } = taintwire;

// The nodejs variant of @ladybugdb/wasm-core has the browser build's API, so this exercises the browser backend.
const lbug = createRequire(import.meta.url)("@ladybugdb/wasm-core/nodejs");
const backend = wasmBackend(lbug);
afterAll(() => lbug.close());

const SRC = "function f(x) {\n    return x;\n}\nconst a = source();\nconst b = f(a);\nsink(b);\nlet c = 1, d;\nd = c;";
const COUNTS = "MATCH ()-[e]->() RETURN label(e) AS rel, count(*) AS n ORDER BY rel";

test("the WASM backend builds the same graph as the native one", async () => {
    const native = await taintwire.import(SRC);
    const graph = await taintwire.TaintGraph.open(":memory:", { backend });
    await graph.add(SRC);
    const norm = (rows: Record<string, unknown>[]) => rows.map((r) => ({ rel: r.rel, n: Number(r.n) }));
    const counts = norm(await graph.query(COUNTS));
    expect(counts.map((r) => r.rel)).toEqual(expect.arrayContaining(["SON", "REFERS_TO", "CALLS", "FLOWS_TO"]));
    expect(counts).toEqual(norm(await native.query(COUNTS)));
    // params, multi-statement queries and code() go through the same backend
    const [{ id }] = await graph.query("MATCH (i:Identifier {name: $n}) RETURN i.id AS id LIMIT 1", { n: "sink" });
    expect(await graph.code(id as string)).toBe("sink");
    expect(await graph.query("RETURN 1 AS a; RETURN 2 AS b")).toEqual([{ b: 2 }]);
    await graph.close();
    await native.close();
});
