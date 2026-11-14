import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";
import * as entry from "../src/index.ts";
import * as internal from "../src/internal.ts";

const repoRoot = new URL("../../../", import.meta.url).pathname;

/** Runtime names only: the type-only exports leave no trace to assert on. */
const INTERNAL_NAMES = [
  "RC_ADAPTER_OVERRIDES",
  "SOURCE_FIXTURE",
  "clipText",
  "compareRuntimeVersion",
  "describeSteps",
  "getExchangeContext",
  "getExchangeRoute",
  "isDevelopmentRuntime",
  "isSourceFixture",
  "parseRuntimeVersion",
  "rejectStaleOptions",
];

/** An import, re-export, `import()` or `require()` of the subpath; a resolver map naming it is none of these. */
const IMPORTS_SUBPATH =
  /(from|import|require)\s*\(?\s*["']@routecraft\/routecraft\/internal["']/;
/** The sibling packages that may import the subpath. */
const ALLOWED_IMPORTERS = /^packages\/(ai|cli|os|testing)\/(src|test)\//;

describe("@routecraft/routecraft/internal", () => {
  /**
   * @case The subpath exports exactly the agreed first-party names
   * @preconditions `src/internal.ts` loaded as a module
   * @expectedResult Its runtime exports equal the list in this file, so a new name is a reviewed change to both
   */
  test("exports the listed names and nothing else", () => {
    expect(Object.keys(internal).sort()).toEqual(INTERNAL_NAMES);
  });

  /**
   * @case A first-party name is not also on the main entry
   * @preconditions `src/index.ts` loaded as a module
   * @expectedResult None of the subpath's names is exported from the main entry
   */
  test("keeps its names off the main entry", () => {
    const onEntry = new Set(Object.keys(entry));
    expect(INTERNAL_NAMES.filter((name) => onEntry.has(name))).toEqual([]);
  });

  /**
   * @case Only sibling packages import the subpath
   * @preconditions Every source, test, example, template, skill and docs file in the repository
   * @expectedResult An import of `@routecraft/routecraft/internal` appears only under the source or tests of ai, cli, os and testing
   */
  test("is imported only by sibling packages", async () => {
    const strays: string[] = [];
    const patterns = [
      "packages/**/*.{ts,tsx,mts,mjs,md,mdx,json}",
      "examples/**/*.{ts,tsx,md}",
      "apps/**/*.{ts,tsx,md,mdx}",
      "skills/**/*.{ts,md}",
      "tests/**/*.ts",
    ];
    for (const pattern of patterns) {
      for await (const file of new Glob(pattern).scan({ cwd: repoRoot })) {
        if (/(^|\/)(node_modules|dist|\.output|baseline)\//.test(file))
          continue;
        if (file.startsWith("packages/routecraft/")) continue;
        if (ALLOWED_IMPORTERS.test(file)) continue;
        const source = readFileSync(`${repoRoot}${file}`, "utf8");
        if (IMPORTS_SUBPATH.test(source)) {
          strays.push(file);
        }
      }
    }
    expect(strays).toEqual([]);
  });
});
