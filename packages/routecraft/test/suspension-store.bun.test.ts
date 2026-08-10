import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemorySuspensionStore,
  SqliteSuspensionStore,
  type SerializedOutcome,
  type Suspension,
  type SuspensionStore,
} from "../src/index.ts";

const scratch = mkdtempSync(join(tmpdir(), "rc-suspension-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * Build a suspension record with sensible defaults. Every field the store
 * round-trips is populated by default so a backend that silently drops one
 * fails the shared suite rather than passing on a thin record.
 */
function record(overrides: Partial<Suspension> = {}): Suspension {
  return {
    id: "sus-1",
    routeId: "payout",
    position: 3,
    continuationHash: "c".repeat(64),
    actionFingerprint: "f".repeat(64),
    exchange: {
      body: { amountCents: 75_000, memo: "quarterly" },
      headers: { "routecraft.id": "ex-1", "routecraft.route": "payout" },
    },
    expect: { hash: "e".repeat(64), jsonSchema: { type: "object" } },
    status: "suspended",
    suspendedAt: new Date("2026-08-10T09:00:00.000Z"),
    ...overrides,
  };
}

const terminal: SerializedOutcome = {
  status: "completed",
  body: { paid: true },
  at: new Date("2026-08-11T09:00:00.000Z"),
};

/**
 * The shared contract suite. Every backend must satisfy it identically:
 * that is what makes the sqlite default and the in-memory fallback
 * interchangeable, and what a future postgres backend will be held to.
 */
function contractSuite(
  name: string,
  open: () => Promise<SuspensionStore>,
): void {
  describe(`SuspensionStore contract: ${name}`, () => {
    let store: SuspensionStore | undefined;

    afterEach(async () => {
      if (store) await store.close();
      store = undefined;
    });

    /**
     * @case A stored suspension reads back field for field
     * @preconditions A fully populated record is written to a fresh store
     * @expectedResult get() returns every field, with Date fields still Dates
     */
    test("round-trips a full record", async () => {
      store = await open();
      const written = record({
        expiresAt: new Date("2026-08-13T09:00:00.000Z"),
        stepState: { messages: [{ role: "user" }], toolCallId: "call-1" },
      });
      await store.create(written);

      const read = await store.get("sus-1");
      expect(read).toBeDefined();
      expect(read?.routeId).toBe("payout");
      expect(read?.position).toBe(3);
      expect(read?.continuationHash).toBe(written.continuationHash);
      expect(read?.actionFingerprint).toBe(written.actionFingerprint);
      expect(read?.exchange).toEqual(written.exchange);
      expect(read?.expect).toEqual(written.expect);
      expect(read?.stepState).toEqual(written.stepState);
      expect(read?.status).toBe("suspended");
      expect(read?.suspendedAt.getTime()).toBe(written.suspendedAt.getTime());
      expect(read?.expiresAt?.getTime()).toBe(written.expiresAt!.getTime());
    });

    /**
     * @case An unknown id is a miss, not an error
     * @preconditions Empty store
     * @expectedResult get() resolves undefined
     */
    test("returns undefined for an unknown id", async () => {
      store = await open();
      expect(await store.get("nope")).toBeUndefined();
    });

    /**
     * @case A suspension id is minted per suspend, so a collision is a bug
     * @preconditions The same id is written twice
     * @expectedResult The second create rejects
     */
    test("refuses a duplicate id", async () => {
      store = await open();
      await store.create(record());
      await expect(store.create(record())).rejects.toThrow();
    });

    /**
     * @case The store never hands out a reference into its own state
     * @preconditions A record is written, then the caller mutates what it wrote
     * @expectedResult The stored copy is unchanged
     */
    test("detaches stored records from the caller", async () => {
      store = await open();
      const written = record();
      await store.create(written);
      (written.exchange.body as { amountCents: number }).amountCents = 1;

      const read = await store.get("sus-1");
      expect((read?.exchange.body as { amountCents: number }).amountCents).toBe(
        75_000,
      );
    });

    /**
     * @case Resuming a parked exchange records the receipt
     * @preconditions A suspended record; markResumed with a principal ref
     * @expectedResult The caller won, and status / resumedAt / resumedBy are set
     */
    test("markResumed transitions and records who answered", async () => {
      store = await open();
      await store.create(record());
      const at = new Date("2026-08-11T08:00:00.000Z");

      const result = await store.markResumed("sus-1", {
        at,
        by: { subject: "user:jaco", issuer: "https://idp.example" },
      });

      expect(result.won).toBe(true);
      expect(result.suspension?.status).toBe("resumed");
      expect(result.suspension?.resumedAt?.getTime()).toBe(at.getTime());
      expect(result.suspension?.resumedBy?.subject).toBe("user:jaco");
      expect(result.suspension?.resumedBy?.issuer).toBe("https://idp.example");
    });

    /**
     * @case Exactly one of two concurrent resumes wins
     * @preconditions One suspended record; two markResumed calls started together
     * @expectedResult One result has won: true, the other won: false, and the
     *   record shows a single resume
     */
    test("markResumed is an atomic compare-and-swap with one winner", async () => {
      store = await open();
      await store.create(record());

      const [first, second] = await Promise.all([
        store.markResumed("sus-1", {
          at: new Date("2026-08-11T08:00:00.000Z"),
          by: { subject: "first" },
        }),
        store.markResumed("sus-1", {
          at: new Date("2026-08-11T08:00:01.000Z"),
          by: { subject: "second" },
        }),
      ]);

      expect([first.won, second.won].filter(Boolean)).toHaveLength(1);
      const winner = first.won ? first : second;
      const loser = first.won ? second : first;
      // The loser is told what happened instead, without a second read.
      expect(loser.suspension?.status).toBe("resumed");
      expect((await store.get("sus-1"))?.resumedBy?.subject).toBe(
        winner.suspension?.resumedBy?.subject,
      );
    });

    /**
     * @case A resume racing the sweeper resolves to one outcome
     * @preconditions One suspended record; markResumed and markExpired started together
     * @expectedResult Exactly one wins, and the stored status matches the winner
     */
    test("a resume and an expiry cannot both win", async () => {
      store = await open();
      await store.create(
        record({ expiresAt: new Date("2026-08-10T09:00:01Z") }),
      );

      const [resumed, expired] = await Promise.all([
        store.markResumed("sus-1", { at: new Date() }),
        store.markExpired("sus-1"),
      ]);

      expect([resumed.won, expired.won].filter(Boolean)).toHaveLength(1);
      const stored = await store.get("sus-1");
      expect(stored?.status).toBe(resumed.won ? "resumed" : "expired");
    });

    /**
     * @case A terminal state is not resumable
     * @preconditions A record already marked expired
     * @expectedResult markResumed reports it lost and leaves the state alone
     */
    test("refuses to resume a suspension that already left the suspended state", async () => {
      store = await open();
      await store.create(record());
      await store.markExpired("sus-1");

      const result = await store.markResumed("sus-1", { at: new Date() });

      expect(result.won).toBe(false);
      expect(result.suspension?.status).toBe("expired");
    });

    /**
     * @case Cancelling a run denies its parked exchange
     * @preconditions A suspended record; markDenied with a reason
     * @expectedResult Status is denied and the reason is stored
     */
    test("markDenied records the reason", async () => {
      store = await open();
      await store.create(record());

      const result = await store.markDenied("sus-1", "run cancelled");

      expect(result.won).toBe(true);
      expect(result.suspension?.status).toBe("denied");
      expect(result.suspension?.deniedReason).toBe("run cancelled");
    });

    /**
     * @case A transition against an unknown id is a loss, not a throw
     * @preconditions Empty store
     * @expectedResult won is false and no record is reported
     */
    test("reports a loss for an unknown id", async () => {
      store = await open();
      const result = await store.markResumed("ghost", { at: new Date() });
      expect(result.won).toBe(false);
      expect(result.suspension).toBeUndefined();
    });

    /**
     * @case A duplicate resume can be answered from the cached outcome
     * @preconditions A resumed record with a recorded terminal outcome
     * @expectedResult The outcome reads back with its timestamp intact
     */
    test("caches the terminal outcome of execution two", async () => {
      store = await open();
      await store.create(record());
      await store.markResumed("sus-1", { at: new Date() });
      await store.recordTerminal("sus-1", terminal);

      const read = await store.get("sus-1");
      expect(read?.terminal?.status).toBe("completed");
      expect(read?.terminal?.body).toEqual({ paid: true });
      expect(read?.terminal?.at.getTime()).toBe(terminal.at.getTime());
    });

    /**
     * @case Recording a terminal outcome for an unknown id is a no-op
     * @preconditions Empty store
     * @expectedResult The call resolves without throwing
     */
    test("ignores a terminal outcome for an unknown id", async () => {
      store = await open();
      await expect(
        store.recordTerminal("ghost", terminal),
      ).resolves.toBeUndefined();
    });

    /**
     * @case The sweeper sees only suspensions that are actually due
     * @preconditions Three records: due, not yet due, and due but already resumed
     * @expectedResult Only the due suspended one is returned
     */
    test("findExpired returns due, still-suspended records only", async () => {
      store = await open();
      const now = new Date("2026-08-13T09:00:00.000Z");
      await store.create(
        record({ id: "due", expiresAt: new Date("2026-08-12T09:00:00.000Z") }),
      );
      await store.create(
        record({
          id: "later",
          expiresAt: new Date("2026-08-14T09:00:00.000Z"),
        }),
      );
      await store.create(record({ id: "no-ttl" }));
      await store.create(
        record({
          id: "already-resumed",
          expiresAt: new Date("2026-08-12T09:00:00.000Z"),
        }),
      );
      await store.markResumed("already-resumed", { at: new Date() });

      const due = await store.findExpired(now);

      expect(due.map((entry) => entry.id)).toEqual(["due"]);
    });

    /**
     * @case One sweep pass can be bounded after a long downtime
     * @preconditions Three due records; findExpired called with limit 2
     * @expectedResult Two records come back, oldest first
     */
    test("findExpired honours the limit, oldest first", async () => {
      store = await open();
      const due = new Date("2026-08-12T09:00:00.000Z");
      await store.create(
        record({
          id: "b",
          suspendedAt: new Date("2026-08-10T10:00:00.000Z"),
          expiresAt: due,
        }),
      );
      await store.create(
        record({
          id: "a",
          suspendedAt: new Date("2026-08-10T08:00:00.000Z"),
          expiresAt: due,
        }),
      );
      await store.create(
        record({
          id: "c",
          suspendedAt: new Date("2026-08-10T12:00:00.000Z"),
          expiresAt: due,
        }),
      );

      const swept = await store.findExpired(
        new Date("2026-08-13T09:00:00.000Z"),
        2,
      );

      expect(swept.map((entry) => entry.id)).toEqual(["a", "b"]);
    });

    /**
     * @case The startup scan reports what is still parked
     * @preconditions Two suspended records and one resumed
     * @expectedResult Count covers only the suspended ones, oldest is the earliest suspendedAt
     */
    test("pending summarises count and oldest", async () => {
      store = await open();
      await store.create(
        record({
          id: "old",
          suspendedAt: new Date("2026-08-01T09:00:00.000Z"),
        }),
      );
      await store.create(
        record({
          id: "new",
          suspendedAt: new Date("2026-08-09T09:00:00.000Z"),
        }),
      );
      await store.create(record({ id: "gone" }));
      await store.markResumed("gone", { at: new Date() });

      const summary = await store.pending();

      expect(summary.count).toBe(2);
      expect(summary.oldest?.toISOString()).toBe("2026-08-01T09:00:00.000Z");
    });

    /**
     * @case An empty store reports nothing pending
     * @preconditions Fresh store
     * @expectedResult Count is zero and no oldest timestamp is reported
     */
    test("pending on an empty store reports zero", async () => {
      store = await open();
      const summary = await store.pending();
      expect(summary.count).toBe(0);
      expect(summary.oldest).toBeUndefined();
    });

    /**
     * @case Closing twice during teardown must not throw
     * @preconditions An open store closed once already
     * @expectedResult The second close resolves
     */
    test("close is idempotent", async () => {
      const local = await open();
      await local.close();
      await expect(local.close()).resolves.toBeUndefined();
    });
  });
}

contractSuite("memory", async () => new MemorySuspensionStore());
contractSuite("sqlite (in-process)", () =>
  SqliteSuspensionStore.open({ path: ":memory:" }),
);
contractSuite("sqlite (on disk)", () =>
  SqliteSuspensionStore.open({
    path: join(scratch, `${Math.random().toString(36).slice(2)}.db`),
  }),
);

describe("SqliteSuspensionStore durability", () => {
  /**
   * @case A parked exchange outlives the store object that wrote it
   * @preconditions A record written to an on-disk database, then the store closed
   *   and reopened at the same path
   * @expectedResult The record reads back from the reopened store
   */
  test("a record survives closing and reopening the database", async () => {
    const path = join(scratch, "reopen.db");
    const first = await SqliteSuspensionStore.open({ path });
    await first.create(record());
    await first.close();

    const second = await SqliteSuspensionStore.open({ path });
    const read = await second.get("sus-1");
    await second.close();

    expect(read?.routeId).toBe("payout");
    expect(read?.status).toBe("suspended");
  });

  /**
   * @case Opening an existing database must not re-run its migrations
   * @preconditions A database opened, closed, and opened again
   * @expectedResult The second open succeeds and existing rows are intact
   */
  test("migration is idempotent across opens", async () => {
    const path = join(scratch, "migrate.db");
    const first = await SqliteSuspensionStore.open({ path });
    await first.create(record({ id: "kept" }));
    await first.close();

    const second = await SqliteSuspensionStore.open({ path });
    const summary = await second.pending();
    await second.close();

    expect(summary.count).toBe(1);
  });
});
