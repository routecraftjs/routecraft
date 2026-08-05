import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PACKAGES_ROOT = join(import.meta.dir, "../..");

/** Packages whose src trees are held to the optional-peer contract. */
const SCANNED_PACKAGES = ["routecraft", "ai", "os", "cli"];

/** Runtime-provided module namespaces that need no install and no peer contract. */
const BUILTIN_PREFIXES = ["node:", "bun:"];

/**
 * Sanctioned deviations from the contract, each with the reason it is
 * allowed to stay bespoke. Keyed by file suffix + specifier.
 */
const SANCTIONED_EXCEPTIONS: ReadonlyArray<{
  fileSuffix: string;
  specifier: string;
  reason: string;
}> = [
  {
    fileSuffix: "ai/src/mcp/server.ts",
    specifier: "@modelcontextprotocol/sdk/server/streamableHttp.js",
    reason:
      "distinguishes a missing sub-export on older SDK versions from a missing package and falls back silently; loadOptionalPeer would turn the wanted fallback into an RC5017 throw",
  },
];

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

/** Root package name of an import specifier (`@scope/pkg/sub` -> `@scope/pkg`). */
function rootPackage(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

describe("optional-peer contract (ci-cd.md section 6)", () => {
  /**
   * @case Every optional-peer dynamic import across the scanned packages goes through loadOptionalPeer
   * @preconditions All .ts sources under packages/{routecraft,ai,os,cli}/src are scanned (comments stripped) for runtime `import("...")` calls with a bare specifier; specifiers whose root package is a regular dependency of that package are exempt (they are always installed), as are runtime builtins and the sanctioned exceptions listed above
   * @expectedResult Each remaining call site sits inside a `loadOptionalPeer(() => import("..."))` thunk, so a missing optional peer always surfaces as RC5017 with an install hint instead of a raw module-not-found error
   */
  test("no bare optional-peer dynamic import outside loadOptionalPeer", () => {
    const violations: string[] = [];
    const wrappedPattern =
      /loadOptionalPeer\s*\(\s*(?:async\s*)?\(\)\s*=>\s*import\s*\(\s*["'`]/g;
    const importPattern = /import\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g;

    for (const pkg of SCANNED_PACKAGES) {
      const srcRoot = join(PACKAGES_ROOT, pkg, "src");
      if (!existsSync(srcRoot)) continue;
      const manifest = JSON.parse(
        readFileSync(join(PACKAGES_ROOT, pkg, "package.json"), "utf8"),
      ) as {
        dependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
        peerDependenciesMeta?: Record<string, { optional?: boolean }>;
      };
      // Regular dependencies and required (non-optional) peers are always
      // installed; only optional peers carry the loadOptionalPeer contract.
      const alwaysInstalled = new Set([
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.peerDependencies ?? {}).filter(
          (name) => manifest.peerDependenciesMeta?.[name]?.optional !== true,
        ),
      ]);

      for (const file of walk(srcRoot)) {
        const source = stripComments(readFileSync(file, "utf8"));

        const wrappedImportOffsets = new Set<number>();
        for (const m of source.matchAll(wrappedPattern)) {
          wrappedImportOffsets.add(m.index + m[0].lastIndexOf("import"));
        }

        for (const m of source.matchAll(importPattern)) {
          const specifier = m[1]!;
          if (specifier.startsWith(".")) continue;
          if (BUILTIN_PREFIXES.some((p) => specifier.startsWith(p))) continue;
          if (alwaysInstalled.has(rootPackage(specifier))) continue;
          // `typeof import("pkg")` is a type position and erased at runtime.
          const before = source.slice(Math.max(0, m.index - 20), m.index);
          if (/typeof\s*$/.test(before)) continue;
          if (
            SANCTIONED_EXCEPTIONS.some(
              (e) => file.endsWith(e.fileSuffix) && e.specifier === specifier,
            )
          ) {
            continue;
          }
          if (!wrappedImportOffsets.has(m.index)) {
            violations.push(
              `${file}:${lineOf(source, m.index)} imports "${specifier}"`,
            );
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
