import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

/** The kernel: what owns lifecycle, resolution, ordering, execution and continuation. */
const KERNEL = [
  "kernel",
  "pipeline",
  "context.ts",
  "route.ts",
  "builder.ts",
  "step-builder-base.ts",
  "exchange.ts",
];

/** Where plugins live; the kernel may reach them only through ports. */
const FORBIDDEN = ["plugins", "auth"];

function filesUnder(path: string): string[] {
  const full = join(SRC, path);
  if (!statSync(full).isDirectory()) return [full];
  return readdirSync(full).flatMap((entry) =>
    filesUnder(join(path, entry)).filter((file) => file.endsWith(".ts")),
  );
}

/** Every relative module a file imports or re-exports, type-only included. */
function edgesOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const specifiers = [
    ...source.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g),
  ].map((match) => match[1]!);
  return specifiers.map((specifier) =>
    relative(SRC, resolve(dirname(file), specifier)),
  );
}

/**
 * The kernel never imports a plugin. Every first-party feature reaches the
 * kernel the way a third party's does, through a port, a hook, a step or a
 * facet; an import edge would give ours a reach yours cannot have.
 */
describe("the kernel boundary", () => {
  /**
   * @case No kernel module imports from a plugin's folder or auth, by value or by type
   * @preconditions The kernel's files: kernel/, pipeline/, context.ts, route.ts, builder.ts, step-builder-base.ts, exchange.ts
   * @expectedResult No import or re-export specifier resolves under plugins/ or auth/
   */
  test("the kernel imports no plugin", () => {
    const crossings = KERNEL.flatMap(filesUnder).flatMap((file) =>
      edgesOf(file)
        .filter((target) =>
          FORBIDDEN.some(
            (folder) => target === folder || target.startsWith(`${folder}/`),
          ),
        )
        .map((target) => `${relative(SRC, file)} -> ${target}`),
    );

    expect(crossings).toEqual([]);
  });

  /**
   * @case The walk sees the edges it is meant to refuse
   * @preconditions A plugin module that is known to import auth/
   * @expectedResult The edge scanner reports that import, so an empty result above is a real absence rather than a scanner that finds nothing
   */
  test("the scanner finds real edges", () => {
    const edges = edgesOf(join(SRC, "plugins", "auth", "index.ts"));
    expect(edges).toContain(join("auth", "authorize.ts"));
  });
});
