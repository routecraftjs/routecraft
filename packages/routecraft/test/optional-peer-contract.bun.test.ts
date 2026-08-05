import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC_ROOT = join(import.meta.dir, "../src");

/** Runtime-provided module namespaces that need no install and no peer contract. */
const BUILTIN_PREFIXES = ["node:", "bun:"];

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

describe("optional-peer contract (ci-cd.md section 6)", () => {
  /**
   * @case Every external dynamic import in core src goes through loadOptionalPeer
   * @preconditions All .ts sources under packages/routecraft/src are scanned for runtime `import("...")` calls with a bare (non-relative, non-builtin) specifier
   * @expectedResult Each such call site is a `loadOptionalPeer(() => import("..."))` thunk, so a missing optional peer always surfaces as RC5017 with an install hint instead of a raw module-not-found error
   */
  test("no bare external dynamic import outside loadOptionalPeer", () => {
    const violations: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        const trimmed = line.trimStart();
        // Comment lines (JSDoc examples) and `typeof import("pkg")` type
        // positions are not runtime imports.
        if (trimmed.startsWith("*") || trimmed.startsWith("//")) return;
        if (line.includes("typeof import(")) return;
        const match = line.match(/import\(\s*["']([^"']+)["']\s*\)/);
        if (!match) return;
        const specifier = match[1]!;
        if (specifier.startsWith(".")) return;
        if (BUILTIN_PREFIXES.some((p) => specifier.startsWith(p))) return;
        // The wrapping call is either on the same line or, for multi-line
        // formatting, within the two preceding lines.
        const context = lines.slice(Math.max(0, i - 2), i + 1).join("\n");
        if (!context.includes("loadOptionalPeer")) {
          violations.push(`${file}:${i + 1} imports "${specifier}"`);
        }
      });
    }
    expect(violations).toEqual([]);
  });
});
