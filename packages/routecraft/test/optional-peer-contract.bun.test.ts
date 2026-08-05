import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC_ROOT = join(import.meta.dir, "../src");

/** Runtime-provided module namespaces that need no install and no peer contract. */
const BUILTIN_PREFIXES = ["node:", "bun:"];

/** Recursively collect all .ts files under a directory. */
function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

/**
 * Strip block and line comments so JSDoc examples containing `import("pkg")`
 * are not flagged. Replaces comment bodies with spaces to preserve offsets
 * and line numbers.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
}

/** 1-indexed line number of a character offset. */
function lineOf(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}

describe("optional-peer contract (ci-cd.md section 6)", () => {
  /**
   * @case Every external dynamic import in core src goes through loadOptionalPeer
   * @preconditions All .ts sources under packages/routecraft/src are scanned (comments stripped) for runtime `import("...")` calls with a bare (non-relative, non-builtin) specifier, in any quote style and across line breaks
   * @expectedResult Each such call site sits inside a `loadOptionalPeer(() => import("..."))` thunk, so a missing optional peer always surfaces as RC5017 with an install hint instead of a raw module-not-found error
   */
  test("no bare external dynamic import outside loadOptionalPeer", () => {
    const violations: string[] = [];
    // A dynamic import wrapped in the loadOptionalPeer thunk, tolerating
    // line breaks between the tokens (prettier splits long calls).
    const wrappedPattern =
      /loadOptionalPeer\s*\(\s*(?:async\s*)?\(\)\s*=>\s*import\s*\(\s*["'`]/g;
    const importPattern = /import\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g;

    for (const file of walk(SRC_ROOT)) {
      const source = stripComments(readFileSync(file, "utf8"));

      // Offsets of every import( that is the thunk body of loadOptionalPeer.
      const wrappedImportOffsets = new Set<number>();
      for (const m of source.matchAll(wrappedPattern)) {
        wrappedImportOffsets.add(m.index + m[0].lastIndexOf("import"));
      }

      for (const m of source.matchAll(importPattern)) {
        const specifier = m[1]!;
        if (specifier.startsWith(".")) continue;
        if (BUILTIN_PREFIXES.some((p) => specifier.startsWith(p))) continue;
        // `typeof import("pkg")` is a type position and erased at runtime.
        const before = source.slice(Math.max(0, m.index - 20), m.index);
        if (/typeof\s*$/.test(before)) continue;
        if (!wrappedImportOffsets.has(m.index)) {
          violations.push(
            `${file}:${lineOf(source, m.index)} imports "${specifier}"`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
