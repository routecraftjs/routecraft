import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SqliteConnection } from "../../src/telemetry/sqlite-connection";

/**
 * Reference cross-runtime test: exercises the same telemetry code path
 * under both Bun and Node so a regression in either runtime fails CI.
 *
 * The `adapter-cross-runtime` matrix in `.github/workflows/ci.yml` runs
 * this file twice -- once under Bun via `bun run test:cross-runtime`,
 * once under Node via `node node_modules/vitest/vitest.mjs run
 * --include '**\/test/cross-runtime/**\/*.test.ts'`. New adapters with
 * runtime-specific code paths (e.g. `Bun.sql` vs `pg`, `Bun.s3` vs
 * `@aws-sdk/client-s3`) should drop a sibling file here.
 */
describe("telemetry sqlite cross-runtime", () => {
  let tmp: string;
  let dbPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "rc-cross-runtime-"));
    dbPath = join(tmp, "telemetry.db");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * @case A SqliteConnection opens against a fresh file, answers SQL, and closes cleanly under whichever runtime is invoking the test
   * @preconditions `better-sqlite3` is installable in dev (declared in routecraft devDependencies); a fresh tmpdir-scoped db file is allocated per test
   * @expectedResult open() resolves to a SqliteConnection instance; the underlying db answers a trivial pragma; close() runs without error
   */
  test("opens, runs a pragma, and closes cleanly", async () => {
    const conn = await SqliteConnection.open({ dbPath });
    expect(conn).not.toBeNull();
    if (!conn) return;

    // Sanity: the db handle is alive and answers SQL.
    const journalMode = conn.db.pragma("journal_mode") as Array<{
      journal_mode: string;
    }>;
    expect(Array.isArray(journalMode)).toBe(true);
    expect(journalMode[0]?.journal_mode).toBeTypeOf("string");

    expect(() => conn.close()).not.toThrow();
  });

  /**
   * @case The connection reports the active runtime via process.versions, so a future regression where one runtime is silently skipped is observable
   * @preconditions Test is run under either Node or Bun
   * @expectedResult Either process.versions.node or process.versions.bun is defined; the test asserts which one it ran under so the CI log carries the marker
   */
  test("identifies the runtime that ran the test", () => {
    const isBun = typeof process.versions["bun"] === "string";
    const isNode = typeof process.versions["node"] === "string" && !isBun;
    expect(isBun || isNode).toBe(true);
    // Surface the runtime in the test output so a CI log inspector can
    // confirm both arms actually executed (not just one duplicated).
    console.log(
      `[cross-runtime] ran under ${isBun ? "bun " + process.versions["bun"] : "node " + process.versions["node"]}`,
    );
  });
});
