import { existsSync } from "node:fs";
import { totalmem } from "node:os";
import lbug from "@ladybugdb/core";
import { setBackend } from "./core.js";

// Ladybug's default (8 TiB) mmap reservation is only released on GC, not close(), so a process ran out of
// address space after ~9 opens. 1 TiB is far beyond any AST graph.
const MAX_DB_SIZE = 2 ** 40;

// Ladybug sizes its default buffer pool from the host's RAM, also inside a container, and the pool grows until the
// container's memory limit kills the process. Half of what this process may use (the cgroup limit, if any) leaves the
// other half for the JS heap; past it, a load or query fails with "buffer pool is full" instead.
const DEFAULT_POOL_MB = Math.floor(Math.min(totalmem(), process.constrainedMemory?.() || Infinity) / 2 / 2 ** 20);

setBackend({
    open(dbPath, readOnly = false, { bufferPoolMB = DEFAULT_POOL_MB, threads } = {}) {
        const db = new lbug.Database(dbPath, bufferPoolMB * 2 ** 20, true, readOnly, MAX_DB_SIZE);
        return { db, connection: new lbug.Connection(db, threads) as never };
    },
    // A multi-statement query returns one result per statement. Each is closed once read: an open result keeps native
    // memory until it is garbage collected, which outlives the graph's close() when graphs are opened one after another.
    async rows(res) {
        const all = (Array.isArray(res) ? res : [res]) as lbug.QueryResult[];
        try {
            return await all[all.length - 1].getAll();
        } finally {
            for (const r of all) r.close();
        }
    },
    exists: existsSync,
});

export * from "./core.js";
export * from "./pgq.js";
export { loadPgq } from "./pgq-load.js";
export { wasmBackend } from "./wasm.js";
