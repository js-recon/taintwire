import type { Backend } from "./core.js";

type Result = { toArray(): Result[]; getAllObjects(): Promise<Record<string, unknown>[]>; close(): Promise<void> };
// Its typings declare named exports, but every variant's runtime module is a default-exported object.
type WasmLbug = typeof import("@ladybugdb/wasm-core");

// The WASM build returns integers as boxed Number objects; unbox them so rows match the native build.
const unbox = (v: unknown): unknown =>
    v instanceof Number
        ? v.valueOf()
        : Array.isArray(v)
          ? v.map(unbox)
          : v && typeof v === "object"
            ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unbox(x)]))
            : v;

/** Backend over any `@ladybugdb/wasm-core` variant (browser, multithreaded or nodejs). */
export const wasmBackend = (lbug: WasmLbug): Backend => ({
    open(dbPath) {
        const db = new lbug.Database(dbPath);
        return { db, connection: new lbug.Connection(db) as never };
    },
    // WASM results live in the worker until closed; a multi-statement query chains one result per statement.
    async rows(res) {
        const all = (res as Result).toArray();
        const rows = (await all[all.length - 1].getAllObjects()).map(unbox) as Record<string, unknown>[];
        for (const r of all) await r.close();
        return rows;
    },
    async exists(path) {
        try {
            await lbug.FS.stat(path);
            return true;
        } catch {
            return false;
        }
    },
});
