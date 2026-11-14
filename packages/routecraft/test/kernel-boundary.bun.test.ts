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
  "project.ts",
  "config-applier.ts",
];

/**
 * Where plugins and their adapters live; the kernel reaches them only
 * through ports. Direct edges are what is checked: a kernel module may use a
 * shared module that itself serves a plugin.
 */
const FORBIDDEN = ["plugins", "auth", "adapters/direct"];

/**
 * The files outside the kernel that still read the application off an
 * exchange, through the `/internal` subpath. Entries leave this list; none
 * is added.
 */
const ACCESSOR_DEBT = [
  "ai/src/agent/enricher.ts",
  "ai/src/mcp/adapters/mcp/enricher.ts",
];

function filesUnder(path: string): string[] {
  const full = join(SRC, path);
  if (!statSync(full).isDirectory()) return [full];
  return readdirSync(full).flatMap((entry) =>
    filesUnder(join(path, entry)).filter((file) => file.endsWith(".ts")),
  );
}

/** The file a resolved specifier names, or none for a module outside the tree. */
function moduleFile(path: string): string | undefined {
  for (const candidate of [path, `${path}.ts`, join(path, "index.ts")]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not this spelling.
    }
  }
  return undefined;
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
   * @case No kernel module reaches a plugin's folder or auth through any chain of imports, by value or by type
   * @preconditions The kernel's files: kernel/, pipeline/, context.ts, route.ts, builder.ts, step-builder-base.ts, exchange.ts, project.ts, config-applier.ts, and every module they import, transitively
   * @expectedResult No import or re-export specifier on any such chain resolves under plugins/, auth/ or adapters/direct/
   */
  test("the kernel reaches no plugin, transitively", () => {
    const forbidden = (target: string): boolean =>
      FORBIDDEN.some(
        (folder) => target === folder || target.startsWith(`${folder}/`),
      );
    const crossings: string[] = [];
    const seen = new Set<string>();
    const pending = KERNEL.flatMap(filesUnder).map((file) => ({
      file,
      via: [relative(SRC, file)],
    }));
    for (let next = pending.pop(); next; next = pending.pop()) {
      if (seen.has(next.file)) continue;
      seen.add(next.file);
      for (const target of edgesOf(next.file)) {
        if (forbidden(target)) {
          crossings.push([...next.via, target].join(" -> "));
          continue;
        }
        const file = moduleFile(join(SRC, target));
        if (file !== undefined) {
          pending.push({ file, via: [...next.via, target] });
        }
      }
    }

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

  /**
   * @case Adapters, plugins and sibling packages do not read the application off an exchange
   * @preconditions Every source file under adapters/, plugins/ and the sibling packages
   * @expectedResult None names getExchangeContext or getExchangeRoute, except the listed agent-tier files, which still run with no plugin to hold their state
   */
  test("only the kernel reads an exchange's context and route", () => {
    const packages = join(SRC, "..", "..");
    const sources = [
      ...filesUnder("adapters"),
      ...filesUnder("plugins"),
      ...["ai", "os", "cli", "testing"].flatMap((name) =>
        filesUnder(join("..", "..", name, "src")),
      ),
    ];
    const readers = sources
      .filter((file) =>
        /\bgetExchange(Context|Route)\b/.test(readFileSync(file, "utf8")),
      )
      .map((file) => relative(packages, file))
      .sort();
    expect(readers).toEqual(ACCESSOR_DEBT);
  });
});
