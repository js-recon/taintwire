import { existsSync } from "node:fs";
import lbug from "@ladybugdb/core";
import { setBackend } from "./core.js";

// Ladybug's default (8 TiB) mmap reservation is only released on GC, not close(), so a process ran out of
// address space after ~9 opens. 1 TiB is far beyond any AST graph.
const MAX_DB_SIZE = 2 ** 40;

setBackend({
    open(dbPath) {
        const db = new lbug.Database(dbPath, 0, true, false, MAX_DB_SIZE);
        return { db, connection: new lbug.Connection(db) as never };
    },
    // A multi-statement query returns one result per statement.
    rows: (res) => (Array.isArray(res) ? res[res.length - 1] : (res as lbug.QueryResult)).getAll(),
    exists: existsSync,
});

export * from "./core.js";
export { wasmBackend } from "./wasm.js";
