import { afterAll, afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteSuspensionStore, type Suspension } from "@routecraft/routecraft";

/**
 * Cross-runtime contract for the durable suspension store.
 *
 * The store has a genuine runtime-specific driver split (`bun:sqlite` under
 * Bun, `better-sqlite3` under Node, per the decision recorded in
 * `src/suspension/sqlite-driver.ts`), and the whole point of the feature is
 * that a parked exchange survives a restart. So the properties that make
 * durability real, a record that reads back after a reopen and a
 * compare-and-swap that produces exactly one winner, are proven on both
 * runtimes rather than on whichever one CI happens to run first.
 *
 * The suite itself is runtime-agnostic: it opens a store and asserts on
 * behaviour, and the driver resolution underneath is what differs. The
 * `adapter-cross-runtime` CI jobs run this file once per runtime.
 */

const scratch = mkdtempSync(join(tmpdir(), "rc-suspension-cross-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function record(overrides: Partial<Suspension> = {}): Suspension {
  return {
    id: "sus-1",
    routeId: "payout",
    position: 2,
    continuationHash: "c".repeat(64),
    actionFingerprint: "f".repeat(64),
    exchange: {
      body: { amountCents: 50_000 },
      headers: { "routecraft.id": "ex-1" },
    },
    expect: { hash: "e".repeat(64) },
    status: "suspended",
    suspendedAt: new Date("2026-08-10T09:00:00.000Z"),
    ...overrides,
  };
}

describe("suspension store (cross-runtime)", () => {
  let store: SqliteSuspensionStore | undefined;

  // Closing on the last line of each test leaks a handle whenever an
  // assertion fails first, and the afterAll rmSync then fails on top of the
  // real failure.
  afterEach(async () => {
    if (store) await store.close();
    store = undefined;
  });

  /**
   * @case The runtime resolves the driver its split prescribes
   * @preconditions A store opened on the current runtime
   * @expectedResult Bun reports bun:sqlite, Node reports better-sqlite3
   */
  test("resolves the driver for this runtime", async () => {
    store = await SqliteSuspensionStore.open({ path: ":memory:" });
    const expected =
      typeof process.versions["bun"] === "string"
        ? "bun:sqlite"
        : "better-sqlite3";
    expect(store.driver).toBe(expected);
  });

  /**
   * @case A parked exchange outlives the process that parked it
   * @preconditions A record written to an on-disk database, then reopened
   * @expectedResult Every persisted field reads back unchanged
   */
  test("a record survives a close and reopen", async () => {
    const path = join(scratch, "durability.db");
    const first = await SqliteSuspensionStore.open({ path });
    await first.create(
      record({ expiresAt: new Date("2026-08-13T09:00:00.000Z") }),
    );
    await first.close();

    store = await SqliteSuspensionStore.open({ path });
    const read = await store.get("sus-1");

    expect(read?.status).toBe("suspended");
    expect(read?.exchange.body).toEqual({ amountCents: 50_000 });
    expect(read?.expiresAt?.toISOString()).toBe("2026-08-13T09:00:00.000Z");
  });

  /**
   * @case Concurrent resumes produce exactly one winner on either driver
   * @preconditions One suspended record; two markResumed calls started together
   * @expectedResult One call reports won, and the store records a single resume
   */
  test("markResumed has exactly one winner", async () => {
    store = await SqliteSuspensionStore.open({ path: ":memory:" });
    await store.create(record());

    const results = await Promise.all([
      store.markResumed("sus-1", { at: new Date(), by: { subject: "a" } }),
      store.markResumed("sus-1", { at: new Date(), by: { subject: "b" } }),
    ]);

    expect(results.filter((result) => result.won)).toHaveLength(1);
    expect((await store.get("sus-1"))?.status).toBe("resumed");
  });

  /**
   * @case The sweep query behaves identically on both drivers
   * @preconditions One due record and one not yet due
   * @expectedResult Only the due record is returned
   */
  test("findExpired selects only due records", async () => {
    store = await SqliteSuspensionStore.open({ path: ":memory:" });
    await store.create(
      record({ id: "due", expiresAt: new Date("2026-08-11T09:00:00.000Z") }),
    );
    await store.create(
      record({ id: "later", expiresAt: new Date("2026-08-20T09:00:00.000Z") }),
    );

    const due = await store.findExpired(new Date("2026-08-12T09:00:00.000Z"));

    expect(due.map((entry) => entry.id)).toEqual(["due"]);
  });
});
