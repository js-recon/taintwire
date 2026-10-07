// Browser entry: same API as index.ts, backed by Ladybug's WASM build. Call setWorkerPath() before the first open().
import * as wasm from "@ladybugdb/wasm-core";
import { setBackend } from "./core.js";
import { wasmBackend } from "./wasm.js";

const lbug = ((wasm as unknown as { default?: typeof wasm }).default ?? wasm) as typeof wasm; // see wasm.ts
setBackend(wasmBackend(lbug));

export const setWorkerPath = lbug.setWorkerPath;
export * from "./core.js";
