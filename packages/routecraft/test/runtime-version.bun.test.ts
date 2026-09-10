import { describe, expect, test } from "bun:test";
import {
  compareRuntimeVersion,
  parseRuntimeVersion,
} from "../src/shared/runtime-version.ts";

/**
 * Reading a runtime's own version string.
 *
 * Two callers depend on it and must not answer differently: the CLI gate
 * refuses a Bun below the supported floor, and the ops client decides
 * whether this Bun re-sends a dropped non-idempotent request by itself.
 * Written twice, the two copies disagreed on the same input, which is why
 * the parse lives here.
 */
describe("parseRuntimeVersion", () => {
  /**
   * @case A full version parses to its three parts
   * @preconditions An ordinary three-segment version
   * @expectedResult The core, unchanged
   */
  test("reads a three-segment version", () => {
    expect(parseRuntimeVersion("1.3.14")).toEqual({
      major: 1,
      minor: 3,
      patch: 14,
    });
  });

  /**
   * @case A short version means zero, not unparseable
   * @preconditions Two-segment and one-segment versions
   * @expectedResult The missing segments read as zero. This is the input the two copies disagreed on: one read "1.4" as 1.4.0 and the other as unparseable, which charged a fresh connection per dispatch on a runtime that did not need one
   */
  test("treats a missing segment as zero", () => {
    expect(parseRuntimeVersion("1.4")).toEqual({
      major: 1,
      minor: 4,
      patch: 0,
    });
    expect(parseRuntimeVersion("2")).toEqual({ major: 2, minor: 0, patch: 0 });
  });

  /**
   * @case Prerelease and build metadata are dropped before comparing
   * @preconditions A canary and a build-metadata rendering
   * @expectedResult The SemVer core alone, so a canary of a release compares as that release
   */
  test("strips prerelease and build metadata", () => {
    expect(parseRuntimeVersion("1.3.14-canary.20260910.1")).toEqual({
      major: 1,
      minor: 3,
      patch: 14,
    });
    expect(parseRuntimeVersion("1.4.2+build.9")).toEqual({
      major: 1,
      minor: 4,
      patch: 2,
    });
  });

  /**
   * @case Anything that is not a version is refused rather than guessed at
   * @preconditions Empty, non-numeric, and partially non-numeric strings
   * @expectedResult Undefined, so each caller decides what to do about it rather than acting on a NaN that compares false against everything
   */
  test("refuses a string that is not a version", () => {
    for (const raw of ["", "not-a-version", "1.x.0", "1..0", "v1.3.14"]) {
      expect(parseRuntimeVersion(raw)).toBeUndefined();
    }
  });
});

describe("compareRuntimeVersion", () => {
  /**
   * @case Ordering runs major, then minor, then patch
   * @preconditions Pairs differing at each position, and one equal pair
   * @expectedResult Negative when older, positive when newer, zero when the same. A patch difference must not outrank a major one, which is the comparison both callers gate on
   */
  test("orders by major, then minor, then patch", () => {
    const at = (major: number, minor: number, patch: number) => ({
      major,
      minor,
      patch,
    });

    expect(compareRuntimeVersion(at(1, 3, 13), at(1, 3, 14))).toBeLessThan(0);
    expect(compareRuntimeVersion(at(1, 3, 14), at(1, 3, 14))).toBe(0);
    expect(compareRuntimeVersion(at(1, 4, 0), at(1, 3, 14))).toBeGreaterThan(0);
    expect(compareRuntimeVersion(at(2, 0, 0), at(1, 9, 99))).toBeGreaterThan(0);
    expect(compareRuntimeVersion(at(1, 99, 99), at(2, 0, 0))).toBeLessThan(0);
  });
});
