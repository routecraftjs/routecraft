/**
 * The CLI's dependencies are what every deployed image carries, because
 * `craft start` is the production runtime. See `.standards/ci-cd.md` § 6.
 */

import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** Loaded by name as core's pretty-print transport for the CLI's own output. */
const LOADED_BY_NAME = new Set(["pino-pretty"]);

const SPECIFIER = /(?:from\s+|import\s*\(\s*)["']([^"'./][^"']*)["']/g;

/**
 * The source as it runs: comments and type-only imports removed, so a JSDoc
 * example or an `import type` cannot vouch for a runtime dependency.
 */
function runtimeSource(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\b(?:import|export)\s+type\s[^;]*?;/g, "");
}

function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

describe("@routecraft/cli dependencies", () => {
  /**
   * @case Every entry in the CLI's dependencies against the packages its source imports
   * @preconditions The manifest and packages/cli/src as committed
   * @expectedResult Each dependency is imported by the CLI or loaded by name (pino-pretty), so no adapter runtime rides along into a project that does not use the adapter
   */
  test("declare only what the CLI imports", async () => {
    const manifest = JSON.parse(
      await readFile(join(ROOT, "package.json"), "utf-8"),
    ) as { dependencies?: Record<string, string> };
    const imported = new Set<string>();
    const files = await readdir(join(ROOT, "src"), { recursive: true });
    for (const file of files.filter((name) => /\.tsx?$/.test(name))) {
      const source = await readFile(join(ROOT, "src", file), "utf-8");
      for (const [, specifier] of runtimeSource(source).matchAll(SPECIFIER)) {
        if (!specifier!.startsWith("node:") && !specifier!.startsWith("bun:")) {
          imported.add(packageOf(specifier!));
        }
      }
    }

    const unused = Object.keys(manifest.dependencies ?? {}).filter(
      (dep) => !imported.has(dep) && !LOADED_BY_NAME.has(dep),
    );

    expect(unused).toEqual([]);
  });
});
