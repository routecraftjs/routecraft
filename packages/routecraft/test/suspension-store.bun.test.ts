import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemorySuspensionStore,
  SqliteSuspensionStore,
  type SerializedOutcome,
  type NewSuspension,
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
function record(overrides: Partial<NewSuspension> = {}): NewSuspension {
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
    schema: { hash: "e".repeat(64), jsonSchema: { type: "object" } },
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
      expect(read?.schema).toEqual(written.schema);
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
     * @expectedResult The second create rejects with RC5044, which is not
     *   retryable, so a .retry() wrapper cannot spend its budget re-running
     *   an insert that can never succeed
     */
    test("refuses a duplicate id", async () => {
      store = await open();
      await store.create(record());
      await expect(store.create(record())).rejects.toThrow(
        expect.objectContaining({ rc: "RC5044", retryable: false }),
      );
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
     * @preconditions One suspended record; markResumed and claimExpiry started together
     * @expectedResult Exactly one wins, and the stored status matches the winner
     */
    test("a resume and an expiry cannot both win", async () => {
      store = await open();
      await store.create(
        record({ expiresAt: new Date("2026-08-10T09:00:01Z") }),
      );

      const [resumed, claimed] = await Promise.all([
        store.markResumed("sus-1", { at: new Date() }),
        store.claimExpiry("sus-1", new Date()),
      ]);

      expect([resumed.won, claimed.won].filter(Boolean)).toHaveLength(1);
      const stored = await store.get("sus-1");
      expect(stored?.status).toBe(resumed.won ? "resumed" : "expiring");
    });

    /**
     * @case A new suspension never carries settled state from its input
     * @preconditions A creation record polluted with the fields only a
     *   transition may write, as a caller re-parking a record read back out
     *   of the store would produce
     * @expectedResult The stored record is suspended and clean. Keeping a
     *   terminal outcome alive on a record that reports itself suspended
     *   would let a resume answer from a cached result of a run that is not
     *   this one, and the two backends would stop being substitutable.
     */
    test("strips transition-only fields on create", async () => {
      store = await open();
      await store.create({
        ...record(),
        // The type forbids these; a store is a persistence boundary and
        // enforces its own invariants rather than trusting the caller's
        // compiler, which is what this asserts.
        status: "resumed",
        terminal,
        resumedAt: new Date("2026-08-10T10:00:00.000Z"),
        resumedBy: { subject: "someone-else" },
        deniedReason: "stale",
      } as unknown as Parameters<SuspensionStore["create"]>[0]);

      const stored = await store.get("sus-1");

      expect(stored?.status).toBe("suspended");
      expect(stored?.terminal).toBeUndefined();
      expect(stored?.resumedAt).toBeUndefined();
      expect(stored?.resumedBy).toBeUndefined();
      expect(stored?.deniedReason).toBeUndefined();
    });

    /**
     * @case A terminal state is not resumable
     * @preconditions A record already marked expired
     * @expectedResult markResumed reports it lost and leaves the state alone
     */
    test("refuses to resume a suspension that already left the suspended state", async () => {
      store = await open();
      await store.create(record());
      await store.claimExpiry("sus-1", new Date());
      await store.markExpired("sus-1");

      const result = await store.markResumed("sus-1", { at: new Date() });

      expect(result.won).toBe(false);
      expect(result.suspension?.status).toBe("expired");
    });

    /**
     * @case Denial is a claim first, an outcome second
     * @preconditions A suspended record; claimExpiry then markDenied
     * @expectedResult The claim records when it was taken, and the finalize stores the reason. markDenied from a bare suspended record loses, because finalizing an unclaimed record would skip the delivery step the claim exists to make crash-safe
     */
    test("markDenied finalizes a claim and records the reason", async () => {
      store = await open();
      await store.create(record());

      const unclaimed = await store.markDenied("sus-1", "too eager");
      expect(unclaimed.won).toBe(false);

      const claimedAt = new Date("2026-08-11T09:00:00.000Z");
      const claim = await store.claimExpiry("sus-1", claimedAt);
      expect(claim.won).toBe(true);
      expect(claim.suspension?.status).toBe("expiring");
      expect(claim.suspension?.claimedAt?.toISOString()).toBe(
        claimedAt.toISOString(),
      );

      const result = await store.markDenied("sus-1", "run cancelled");
      expect(result.won).toBe(true);
      expect(result.suspension?.status).toBe("denied");
      expect(result.suspension?.deniedReason).toBe("run cancelled");
    });

    /**
     * @case A stale claim is released for redelivery, a fresh one honoured
     * @preconditions Two expiring records, one claimed before the cutoff and one after
     * @expectedResult Only the stale claim flips back to suspended with its claimedAt cleared, so the next sweep redelivers exactly the work whose deliverer died
     */
    test("releaseExpiring flips back only stale claims", async () => {
      store = await open();
      await store.create(record({ id: "stale" }));
      await store.create(record({ id: "fresh" }));
      await store.claimExpiry("stale", new Date("2026-08-11T08:00:00.000Z"));
      await store.claimExpiry("fresh", new Date("2026-08-11T09:30:00.000Z"));

      const released = await store.releaseExpiring(
        new Date("2026-08-11T09:00:00.000Z"),
      );

      expect(released).toBe(1);
      const stale = await store.get("stale");
      expect(stale?.status).toBe("suspended");
      expect(stale?.claimedAt).toBeUndefined();
      expect((await store.get("fresh"))?.status).toBe("expiring");
    });

    /**
     * @case The expiry scan pages on a keyset cursor
     * @preconditions Four due records sharing deadlines so the id tiebreak matters
     * @expectedResult Pages come back in (expiresAt, id) order, each page strictly after the cursor, and a record the caller left suspended is not re-read by a later page. That is what makes an unretirable prefix unable to starve the records behind it
     */
    test("findExpired pages strictly past a cursor", async () => {
      store = await open();
      const early = new Date("2026-08-11T08:00:00.000Z");
      const late = new Date("2026-08-11T09:00:00.000Z");
      await store.create(record({ id: "b", expiresAt: early }));
      await store.create(record({ id: "a", expiresAt: early }));
      await store.create(record({ id: "d", expiresAt: late }));
      await store.create(record({ id: "c", expiresAt: late }));
      const now = new Date("2026-08-12T09:00:00.000Z");

      const first = await store.findExpired(now, 2);
      expect(first.map((entry) => entry.id)).toEqual(["a", "b"]);

      // Nothing was retired: the first page's records are still suspended.
      // The cursor, not their state, is what keeps them off the next page.
      const last = first[first.length - 1]!;
      const second = await store.findExpired(now, 2, {
        expiresAt: last.expiresAt!,
        id: last.id,
      });
      expect(second.map((entry) => entry.id)).toEqual(["c", "d"]);

      const rest = await store.findExpired(now, 2, {
        expiresAt: second[1]!.expiresAt!,
        id: second[1]!.id,
      });
      expect(rest).toEqual([]);
    });

    /**
     * @case A cursor a backend would have to guess at is refused
     * @preconditions An invalid Date and an empty id
     * @expectedResult Both reject rather than being interpreted
     */
    test("findExpired refuses a malformed cursor", async () => {
      store = await open();
      await expect(
        store.findExpired(new Date(), 10, {
          expiresAt: new Date(Number.NaN),
          id: "x",
        }),
      ).rejects.toThrow(expect.objectContaining({ rc: "RC5044" }));
      await expect(
        store.findExpired(new Date(), 10, { expiresAt: new Date(), id: "" }),
      ).rejects.toThrow(expect.objectContaining({ rc: "RC5044" }));
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

      const due = await store.findExpired(now, 100);

      expect(due.map((entry) => entry.id)).toEqual(["due"]);
    });

    /**
     * @case One sweep pass can be bounded after a long downtime
     * @preconditions Three due records sharing a deadline; findExpired called with limit 2
     * @expectedResult Two records come back in (expiresAt, id) order, which is the strict total order the cursor pages on
     */
    test("findExpired honours the limit in cursor order", async () => {
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
     * @case A resume that never recorded an outcome is reported as crash residue
     * @preconditions Three records: one still parked, one resumed and settled, one resumed with no terminal
     * @expectedResult Only the resumed-with-no-terminal record is returned. It is invisible to findExpired (it is no longer suspended) and its approval is already spent, so the boot summary is the only place it can ever surface
     */
    test("reports resumes that never recorded an outcome", async () => {
      store = await open();
      await store.create(record({ id: "still-parked" }));
      await store.create(record({ id: "settled" }));
      await store.create(record({ id: "stranded" }));

      await store.markResumed("settled", { at: new Date() });
      await store.recordTerminal("settled", terminal);
      await store.markResumed("stranded", { at: new Date() });

      const crashResidue = await store.resumedWithoutTerminal();

      expect(crashResidue.map((entry) => entry.id)).toEqual(["stranded"]);
    });

    /**
     * @case Stranded resumes come back oldest first and honour a limit
     * @preconditions Two stranded records parked at different times, read back with a limit of one
     * @expectedResult The older one. The boot summary reports the oldest age, so the ordering is what makes that figure mean anything
     */
    test("orders stranded resumes oldest first", async () => {
      store = await open();
      await store.create(
        record({
          id: "older",
          suspendedAt: new Date("2026-08-01T09:00:00.000Z"),
        }),
      );
      await store.create(
        record({
          id: "newer",
          suspendedAt: new Date("2026-08-09T09:00:00.000Z"),
        }),
      );
      await store.markResumed("older", { at: new Date() });
      await store.markResumed("newer", { at: new Date() });

      const bounded = await store.resumedWithoutTerminal(1);

      expect(bounded.map((entry) => entry.id)).toEqual(["older"]);
    });

    /**
     * @case A limit the two backends would read differently is refused
     * @preconditions A fresh store; zero, a negative value and a fraction
     * @expectedResult Each rejects, so a sweep cannot silently become
     *   unbounded on sqlite while dropping records in memory
     */
    test("findExpired refuses a non-positive or non-integer limit", async () => {
      store = await open();
      for (const limit of [0, -1, 1.5]) {
        await expect(store.findExpired(new Date(), limit)).rejects.toThrow(
          expect.objectContaining({ rc: "RC5044" }),
        );
      }
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

    /**
     * @case Settled records are reclaimable, so a long-running process does
     *   not accumulate every exchange that ever suspended
     * @preconditions One old settled record, one old still-parked record,
     *   and one recently settled record
     * @expectedResult Only the old settled one is purged
     */
    test("purgeSettled reclaims settled records past the cutoff", async () => {
      store = await open();
      const old = new Date("2026-07-01T09:00:00.000Z");
      const recent = new Date("2026-08-09T09:00:00.000Z");
      await store.create(record({ id: "old-settled", suspendedAt: old }));
      await store.create(record({ id: "old-parked", suspendedAt: old }));
      await store.create(record({ id: "recent-settled", suspendedAt: recent }));
      await store.markResumed("old-settled", { at: new Date() });
      await store.claimExpiry("recent-settled", new Date());
      await store.markDenied("recent-settled", "cancelled");

      const purged = await store.purgeSettled(
        new Date("2026-08-01T00:00:00.000Z"),
      );

      expect(purged).toBe(1);
      expect(await store.get("old-settled")).toBeUndefined();
      expect(await store.get("old-parked")).toBeDefined();
      expect(await store.get("recent-settled")).toBeDefined();
    });

    /**
     * @case A live delivery claim is never reclaimed by retention
     * @preconditions One old record moved to expiring, its claim still held
     * @expectedResult purgeSettled leaves it alone. Purging a claim
     *   mid-delivery would strand the finalize against a row that no longer
     *   exists, and the sweeper would report a redelivery for a record that
     *   is gone
     */
    test("purgeSettled never touches an expiring claim", async () => {
      store = await open();
      const old = new Date("2026-07-01T09:00:00.000Z");
      await store.create(record({ id: "claimed", suspendedAt: old }));
      await store.claimExpiry("claimed", new Date());

      const purged = await store.purgeSettled(
        new Date("2026-08-01T00:00:00.000Z"),
      );

      expect(purged).toBe(0);
      expect((await store.get("claimed"))?.status).toBe("expiring");
    });

    /**
     * @case A parked exchange is never reclaimed by retention, however old
     * @preconditions One long-parked, still-suspended record
     * @expectedResult purgeSettled leaves it alone; only the sweeper may
     *   move it out of the suspended state
     */
    test("purgeSettled never touches a still-parked record", async () => {
      store = await open();
      await store.create(
        record({ suspendedAt: new Date("2020-01-01T00:00:00.000Z") }),
      );

      expect(await store.purgeSettled(new Date())).toBe(0);
      expect((await store.get("sus-1"))?.status).toBe("suspended");
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

describe("SuspensionStore compare-and-swap under real concurrency", () => {
  /**
   * @case Four processes resuming one suspension at once produce one winner
   * @preconditions A suspended record in a shared on-disk database and four
   *   child processes each opening their own connection, released together
   *   by a wall-clock barrier
   * @expectedResult Exactly one process reports won, and the record resumes
   *   once. This is the property the whole feature rests on: two approvers
   *   clicking the same link must not run the payout twice.
   *
   *   Child processes rather than concurrent calls in this one: both sqlite
   *   drivers are synchronous, so two in-process markResumed calls cannot
   *   interleave and would pass even against a read-then-write that has no
   *   atomicity at all.
   */
  test("markResumed has exactly one winner across processes", async () => {
    const path = join(scratch, "race.db");
    const seed = await SqliteSuspensionStore.open({ path });
    await seed.create(record());
    await seed.close();

    const worker = join(import.meta.dir, "suspension-race-worker.ts");
    // Enough runway for four processes to boot and reach the barrier.
    const startAt = Date.now() + 2_000;
    const results = await Promise.all(
      ["a", "b", "c", "d"].map(
        (subject) =>
          new Promise<{ subject: string; won: boolean }>((resolve, reject) => {
            const child = spawn(
              process.execPath,
              [worker, path, "sus-1", String(startAt), subject],
              { stdio: ["ignore", "pipe", "pipe"] },
            );
            let stdout = "";
            let stderr = "";
            child.stdout.on("data", (chunk) => (stdout += chunk));
            child.stderr.on("data", (chunk) => (stderr += chunk));
            child.on("error", reject);
            child.on("close", (code) => {
              if (code !== 0)
                reject(new Error(`worker failed (${code}): ${stderr}`));
              else resolve(JSON.parse(stdout));
            });
          }),
      ),
    );

    const winners = results.filter((result) => result.won);
    expect(winners).toHaveLength(1);

    const store = await SqliteSuspensionStore.open({ path });
    const read = await store.get("sus-1");
    await store.close();
    expect(read?.status).toBe("resumed");
    expect(read?.resumedBy?.subject).toBe(winners[0]?.subject);
  }, 30_000);
});
