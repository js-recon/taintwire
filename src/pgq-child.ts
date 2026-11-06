// Evaluates .pgq files inside the sandbox loadPgq() starts (node --permission, read-only access to the pack root).
// argv: <root> <file>...; prints one JSON line: [{file, value?, error?}], with objects encoded as an identity graph.
import * as nodeModule from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { sep } from "node:path";

const [root, ...files] = process.argv.slice(2);
const inRoot = (path: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

nodeModule.registerHooks({
    resolve(specifier, context, next) {
        let url: URL | undefined;
        try {
            url = new URL(specifier, context.parentURL);
        } catch {
            // bare specifier (a package)
        }
        if (url?.protocol !== "file:" || !url.pathname.endsWith(".pgq") || !inRoot(fileURLToPath(url)))
            throw new Error(
                `pgq: can't import "${specifier}": a .pgq file may only import other .pgq files in ${root}` +
                    ` (use "import type" for taintwire types)`
            );
        return next(specifier, context);
    },
    load(url, context, next) {
        const { source } = next(url, { ...context, format: "module" });
        return { format: "module", source: nodeModule.stripTypeScriptTypes(String(source)), shortCircuit: true };
    },
});

// No I/O for query code: the permission model covers fs, child processes, workers and addons; these cover the rest.
const g = globalThis as Record<string, unknown>;
for (const k of ["fetch", "WebSocket", "EventSource", "XMLHttpRequest", "Request", "Response", "Headers", "navigator"])
    delete g[k];
for (const k of ["getBuiltinModule", "kill", "dlopen", "binding", "_linkedBinding"])
    Object.defineProperty(process, k, { value: undefined });
const out = process.stdout.write.bind(process.stdout);
console.log = console.info = console.debug = console.error; // query code's output goes to stderr, not the result line

/** JSON for any data value, keeping shared objects shared: objects become {"$o": i} into `objs`. */
const encode = (value: unknown) => {
    const ids = new Map<object, number>();
    const objs: unknown[] = [];
    const enc = (v: unknown, at: string): unknown => {
        if (v === null || ["string", "number", "boolean"].includes(typeof v)) return v;
        if (v === undefined) return { $u: 1 };
        if (typeof v !== "object")
            throw new Error(`${at}: a ${typeof v} isn't data (rules must be plain objects, arrays and strings)`);
        if (ids.has(v)) return { $o: ids.get(v) };
        const proto = Object.getPrototypeOf(v);
        if (!Array.isArray(v) && proto !== Object.prototype && proto !== null)
            throw new Error(`${at}: only plain objects and arrays are allowed`);
        const i = objs.push(null) - 1;
        ids.set(v, i);
        objs[i] = Array.isArray(v)
            ? v.map((x, j) => enc(x, `${at}[${j}]`))
            : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x, `${at}.${k}`)]));
        return { $o: i };
    };
    return { root: enc(value, "default"), objs };
};

const results = [];
for (const file of files) {
    try {
        const mod = await import(pathToFileURL(file).href);
        results.push({ file, ...("default" in mod && { value: encode(mod.default) }) });
    } catch (e) {
        results.push({ file, error: (e as Error).message });
    }
}
// Exit once the line is flushed: a pipe write is async, and exiting early truncates big results.
out(JSON.stringify(results) + "\n", () => process.exit(0));
