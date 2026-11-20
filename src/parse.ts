import { parse, type ParserOptions } from "@babel/parser";
import { VISITOR_KEYS, type Node } from "@babel/types";
import { cs_mast_init, CS_MAST_SIGNATURE_KEY, ParseError, type CsMastConfig } from "@shriyanss/cs-mast";

// Same options as js-recon, so both see the same AST for the same input.
export const PARSER_OPTIONS: ParserOptions = {
    sourceType: "unambiguous",
    plugins: ["jsx", "typescript"],
    errorRecovery: true,
};

/** `cs-mast` (default) is the Babel AST with a CS-MAST-S hash on every node; `babel` is the plain AST. */
export type Parser = "cs-mast" | "babel";

// Node types come from the @babel/types that cs-mast parses with (Babel 7), not ours (Babel 8).
import * as csMastBabelTypes from "@babel/types-7";

// Child keys per node type: ours and cs-mast's. They differ for some nodes (TS enum `members`, `typeParameters` on
// calls, `TSExpressionWithTypeArguments`, ...), and a key we don't walk would drop that subtree from the graph.
export const CHILD_KEYS: Record<string, readonly string[]> = {};
for (const keys of [VISITOR_KEYS, csMastBabelTypes.VISITOR_KEYS] as Record<string, readonly string[]>[])
    for (const [t, ks] of Object.entries(keys)) CHILD_KEYS[t] = [...new Set([...(CHILD_KEYS[t] ?? []), ...ks])];

// scat only covers 25 node types; every other type goes in sinc so every node is hashed.
// cs-mast drops sinc entries already covered by scat, so passing all types is fine.
export const CS_MAST_CONFIG: CsMastConfig = {
    hash: "sha256",
    lang: "js",
    prsr: "@babel/parser",
    scat: ["lit", "id", "op", "decl", "loop", "cond", "name", "val", "op_name"],
    sinc: Object.keys(csMastBabelTypes.VISITOR_KEYS),
    sourceType: "unambiguous",
};

export function parseAst(code: string, parser: Parser): Node {
    if (parser === "babel") return parse(code, PARSER_OPTIONS) as unknown as Node;
    try {
        // cs-mast attaches signatures to the raw Babel nodes, so the File node is a normal Babel AST.
        return cs_mast_init(code, CS_MAST_CONFIG).root._raw as Node;
    } catch (e) {
        // cs-mast parses without errorRecovery; the babel parser tolerates more.
        if (e instanceof ParseError) throw new Error(`taintwire: ${e.message} (try { parser: "babel" })`, { cause: e });
        throw e;
    }
}

export const hashOf = (n: Node): string | null => {
    const sig = (n as Node & { [CS_MAST_SIGNATURE_KEY]?: string })[CS_MAST_SIGNATURE_KEY];
    // Only the digest: the signature prefix lists every sinc type (~4.6 KB) and is identical on every node.
    return sig?.slice(sig.lastIndexOf("$") + 1) ?? null;
};
