import { describe, expect, test } from "bun:test";
import { assertBetterSqliteRuns } from "../src/shared/sqlite/driver.ts";

describe("assertBetterSqliteRuns", () => {
  /**
   * @case better-sqlite3 13 on a Node without Node-API 10 (Node 22.0 to 22.13)
   * @preconditions version "13.0.3", nodeApi "9"
   * @expectedResult Throws RC5017 naming the consumer, the Node 22.14 floor and the better-sqlite3@12 fallback, instead of letting the addon segfault the process
   */
  test("refuses 13 below Node-API 10", () => {
    let caught: unknown;
    try {
      assertBetterSqliteRuns("deferral store (sqlite)", "13.0.3", "9");
    } catch (error) {
      caught = error;
    }
    expect((caught as { rc?: string }).rc).toBe("RC5017");
    const message = (caught as Error).message;
    expect(message).toContain("deferral store (sqlite)");
    expect(message).toContain("22.14");
    expect(message).toContain("better-sqlite3@12");
  });

  /**
   * @case better-sqlite3 13 on Node 22.14 or later
   * @preconditions version "13.0.3", nodeApi "10"
   * @expectedResult Does not throw
   */
  test("accepts 13 at Node-API 10", () => {
    expect(() =>
      assertBetterSqliteRuns("deferral store (sqlite)", "13.0.3", "10"),
    ).not.toThrow();
  });

  /**
   * @case better-sqlite3 11 or 12 on older Node, whose per-ABI binaries load there
   * @preconditions versions "11.10.0" and "12.11.1", nodeApi "9"
   * @expectedResult Does not throw
   */
  test("accepts 11 and 12 below Node-API 10", () => {
    for (const version of ["11.10.0", "12.11.1"]) {
      expect(() =>
        assertBetterSqliteRuns("deferral store (sqlite)", version, "9"),
      ).not.toThrow();
    }
  });
});
