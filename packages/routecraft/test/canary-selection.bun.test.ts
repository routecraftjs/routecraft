/**
 * Which packages a canary snapshot keeps.
 *
 * Lives beside `release-notes.bun.test.ts` for the same reason: it guards a
 * repository script under `scripts/lib`, which no package owns, and a canary
 * scaffold depends on it. A canary that shipped the scaffolder without the
 * pending `@routecraft/os` pinned the pre-0.8 stable, and a scaffold using
 * `shellPlugin()` could not boot.
 */

import { describe, expect, test } from "bun:test";

import {
  expandFixedGroups,
  foldPendingForScaffolder,
  SCAFFOLDER,
} from "../../../scripts/lib/canary-selection.mjs";

const TRAIN = [
  "@routecraft/routecraft",
  "@routecraft/cli",
  "@routecraft/testing",
  SCAFFOLDER,
];
const FIXED = [TRAIN];
const PUBLISHED = new Set([...TRAIN, "@routecraft/ai", "@routecraft/os"]);

describe("canary selection", () => {
  /**
   * @case A push that changed a core train member keeps the whole train
   * @preconditions Only @routecraft/routecraft is kept; the train is one fixed group
   * @expectedResult Every train member is kept, the scaffolder included, and no independent package is added
   */
  test("a train member pulls in the train", () => {
    const keep = expandFixedGroups(
      new Set(["@routecraft/routecraft"]),
      FIXED,
      PUBLISHED,
    );
    expect([...keep].sort()).toEqual([...TRAIN].sort());
  });

  /**
   * @case A canary that ships the scaffolder keeps every package with a pending bump
   * @preconditions The train is kept; @routecraft/os carries a pending minor and did not change
   * @expectedResult @routecraft/os is folded in and reported, so the scaffolder's pin points at a version carrying the pending change
   */
  test("pending packages join a canary that ships the scaffolder", () => {
    const keep = new Set(TRAIN);
    const folded = foldPendingForScaffolder(
      keep,
      new Map([["@routecraft/os", "minor"]]),
      PUBLISHED,
      FIXED,
    );
    expect(folded).toEqual(["@routecraft/os"]);
    expect(keep.has("@routecraft/os")).toBe(true);
  });

  /**
   * @case A canary without the scaffolder does not take on pending packages
   * @preconditions Only @routecraft/os changed and is kept; @routecraft/ai and the train carry pending bumps
   * @expectedResult Nothing is folded in, so an os-only push publishes os alone rather than the whole pending release
   */
  test("a canary without the scaffolder stays scoped to the push", () => {
    const keep = new Set(["@routecraft/os"]);
    const folded = foldPendingForScaffolder(
      keep,
      new Map([
        ["@routecraft/ai", "minor"],
        ["@routecraft/routecraft", "minor"],
      ]),
      PUBLISHED,
      FIXED,
    );
    expect(folded).toEqual([]);
    expect([...keep]).toEqual(["@routecraft/os"]);
  });

  /**
   * @case An empty snapshot is never started by pending bumps
   * @preconditions Nothing is kept; several packages carry pending bumps
   * @expectedResult Nothing is folded in, so a push that changed no package still skips the canary
   */
  test("pending bumps never start a canary", () => {
    const keep = new Set<string>();
    foldPendingForScaffolder(
      keep,
      new Map([
        ["@routecraft/os", "minor"],
        [SCAFFOLDER, "minor"],
      ]),
      PUBLISHED,
      FIXED,
    );
    expect(keep.size).toBe(0);
  });

  /**
   * @case A pending name that is not a public workspace package is ignored
   * @preconditions The scaffolder is kept; a changeset names a private app and a removed package
   * @expectedResult Neither is kept, so a canary never tries to publish something that is not a public package
   */
  test("ignores pending names that are not published packages", () => {
    const keep = new Set(TRAIN);
    const folded = foldPendingForScaffolder(
      keep,
      new Map([
        ["routecraft.dev", "patch"],
        ["@routecraft/gone", "minor"],
      ]),
      PUBLISHED,
      FIXED,
    );
    expect(folded).toEqual([]);
    expect(keep.has("routecraft.dev")).toBe(false);
  });
});
