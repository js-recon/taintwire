// Node-only: evaluate .pgq files (TypeScript modules) in a sandboxed child process and validate their rules.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import * as nodeModule from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { validatePgq, type PGRule } from "./pgq.js";

// pgq-child.ts when run from source (tests), which Node >= 22.18 strips natively.
const CHILD = fileURLToPath(
    new URL(import.meta.url.endsWith(".ts") ? "pgq-child.ts" : "pgq-child.js", import.meta.url)
);

/** Nearest ancestor of `dir` with a package.json (a query pack), else `dir` itself. */
const packRoot = (dir: string) => {
    for (let d = dir; ; d = dirname(d)) {
        if (existsSync(join(d, "package.json"))) return d;
        if (dirname(d) === d) return dir;
    }
};
const commonDir = (paths: string[]) =>
    paths.map(dirname).reduce((a, b) => {
        while (a !== b && !b.startsWith(a.endsWith(sep) ? a : a + sep)) a = dirname(a);
        return a;
    });

type Encoded = { root: unknown; objs: unknown[] };
const decode = ({ root, objs }: Encoded): unknown => {
    const built = new Map<number, unknown>();
    const dec = (v: unknown): unknown => {
        if (!v || typeof v !== "object") return v;
        if ("$u" in v) return undefined;
        const i = (v as { $o: number }).$o;
        if (built.has(i)) return built.get(i);
        const raw = objs[i];
        if (Array.isArray(raw)) {
            const a: unknown[] = [];
            built.set(i, a);
            for (const x of raw) a.push(dec(x));
            return a;
        }
        const o: Record<string, unknown> = {};
        built.set(i, o);
        for (const [k, x] of Object.entries(raw as object))
            if (!(x && typeof x === "object" && "$u" in x)) o[k] = dec(x);
        return o;
    };
    return dec(root);
};

/**
 * Evaluate `.pgq` files and return their rules (each file's `export default`: a PGRule or a list of them). Files
 * without a default export are selector libraries and contribute no rules. Evaluation runs in a child Node process
 * under the permission model: it can read only `root` (default: the nearest ancestor of the files with a
 * package.json), and a .pgq file can import only other .pgq files there. Rules from a file with any error are dropped.
 */
export async function loadPgq(
    files: string[],
    { root, timeoutMs = 30_000 }: { root?: string; timeoutMs?: number } = {}
): Promise<{ rules: PGRule[]; errors: string[] }> {
    if (typeof nodeModule.registerHooks !== "function" || typeof nodeModule.stripTypeScriptTypes !== "function")
        throw new Error(`taintwire: loading .pgq files needs Node 22.15 or newer (this is ${process.version})`);
    if (!files.length) return { rules: [], errors: [] };
    const abs = files.map((f) => resolve(f));
    const base = resolve(root ?? packRoot(commonDir(abs)));
    const args = [
        "--permission",
        `--allow-fs-read=${base}`,
        `--allow-fs-read=${CHILD}`,
        "--max-old-space-size=256",
        "--disable-warning=ExperimentalWarning",
        CHILD,
        base,
        ...abs,
    ];
    // ponytail: on Node 22/24 the permission model doesn't cover the network; the child removes fetch & co and the
    // import hook blocks node: builtins. On Node >= 25, --permission without --allow-net blocks it outright.
    const stdout = await new Promise<string>((ok, fail) =>
        execFile(process.execPath, args, { timeout: timeoutMs, maxBuffer: 256 * 2 ** 20 }, (err, out, errOut) =>
            err ? fail(new Error(`taintwire: .pgq evaluation failed: ${err.message}\n${errOut}`.trim())) : ok(out)
        )
    );
    const results = JSON.parse(stdout.trim().split("\n").pop()!) as { file: string; value?: Encoded; error?: string }[];

    const rules: PGRule[] = [];
    const errors: string[] = [];
    const owner = new Map<string, string>();
    for (const { file, value, error } of results) {
        if (error) {
            errors.push(`${file}: ${error}`);
            continue;
        }
        if (!value) continue;
        const decoded = decode(value);
        const fileRules = (Array.isArray(decoded) ? decoded : [decoded]) as PGRule[];
        const problems = validatePgq(fileRules);
        for (const r of fileRules) {
            if (typeof r?.id !== "string") continue;
            if (owner.has(r.id)) problems.push(`${r.id}: rule id already used in ${owner.get(r.id)}`);
            else owner.set(r.id, file);
        }
        if (problems.length) errors.push(...problems.map((p) => `${file}: ${p}`));
        else rules.push(...fileRules);
    }
    return { rules, errors };
}
