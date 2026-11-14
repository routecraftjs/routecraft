import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import ts from "typescript";
import { repoRoot, typeProgram } from "./helpers/type-program.ts";
import * as entry from "../src/index.ts";

/** What the 0.8 defer contract took off the entry; each has a public replacement or none. */
const REMOVED = [
  "DEFER_HOST",
  "DeferSignal",
  "convertDeferSignal",
  "decodeOutcome",
  "decodePersistable",
  "deferAside",
  "deferralScope",
  "getExchangeContext",
  "getExchangeRoute",
  "isDeferCapable",
  "markDeferCapable",
  "peekResumeStepState",
  "reviveDeferral",
];

describe("the main entry's surface", () => {
  /**
   * @case Nothing tagged @internal is exported from the main entry
   * @preconditions `src/index.ts` type-checked as a program; every export resolved to its declaration
   * @expectedResult No export's declaration carries an `@internal` tag, so a sibling package or a third party importing from the entry can only reach public names
   */
  test("exports no @internal declaration", () => {
    const file = join(repoRoot, "packages/routecraft/src/index.ts");
    const program = typeProgram([file]);
    const checker = program.getTypeChecker();
    const module = checker.getSymbolAtLocation(program.getSourceFile(file)!)!;
    const exported = checker.getExportsOfModule(module);

    const internal = exported
      .filter((symbol) => {
        const target =
          symbol.flags & ts.SymbolFlags.Alias
            ? checker.getAliasedSymbol(symbol)
            : symbol;
        return target
          .getJsDocTags(checker)
          .some((tag) => tag.name === "internal");
      })
      .map((symbol) => symbol.name);

    expect(exported.length).toBeGreaterThan(100);
    expect(internal).toEqual([]);
  }, 120_000);

  /**
   * @case The names the defer contract removed stay removed
   * @preconditions The main entry's runtime exports
   * @expectedResult None of the removed names is exported: a step defers through `ctx.defer`, a plugin acts through `c.continuations`, and an adapter reads its plugin's state through `applicationState`
   */
  test("does not export what the defer contract removed", () => {
    expect(REMOVED.filter((name) => name in entry)).toEqual([]);
  });
});
