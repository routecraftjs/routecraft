import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testContext } from "@routecraft/testing";
import { createDeferralRuntime } from "../src/deferral/config.ts";
import { claimDatabasePath } from "../src/shared/sqlite/claims.ts";
import {
  DEFAULT_DEFERRAL_DB_PATH,
  MemoryDeferralStore,
  SqliteDeferralStore,
  stepStateFingerprint,
  type SerializedOutcome,
  type NewDeferral,
  type DeferralStore,
} from "../src/index.ts";

const scratch = mkdtempSync(join(tmpdir(), "rc-deferral-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * Build a deferral record with sensible defaults. Every field the store
 * round-trips is populated by default so a backend that silently drops one
 * fails the shared suite rather than passing on a thin record.
 */
function record(overrides: Partial<NewDeferral> = {}): NewDeferral {
  return {
    id: "def-1",
    routeId: "payout",
    position: 3,
    continuationHash: "c".repeat(64),
    actionFingerprint: "f".repeat(64),
    exchange: {
      body: { amountCents: 75_000, memo: "quarterly" },
      headers: { "routecraft.id": "ex-1", "routecraft.route": "payout" },
    },
    schema: { hash: "e".repeat(64), jsonSchema: { type: "object" } },
    meta: { channel: "email", reviewers: ["alice"] },
    callBinding: "call-1",
    waitingFor: "resume",
    deferredAt: new Date("2026-08-10T09:00:00.000Z"),
    ...overrides,
  };
}

/** A self-referential value, which the plain-JSON rule must refuse. */
function circular(): Record<string, unknown> {
  const node: Record<string, unknown> = {};
  node["self"] = node;
  return node;
}

const continuation: SerializedOutcome = {
  status: "completed",
  body: { paid: true },
  at: new Date("2026-08-11T09:00:00.000Z"),
};

/**
 * The shared contract suite. Every backend must satisfy it identically:
 * that is what makes the sqlite default and the in-memory fallback
 * interchangeable, and what a future postgres backend will be held to.
 */
function contractSuite(name: string, open: () => Promise<DeferralStore>): void {
  describe(`DeferralStore contract: ${name}`, () => {
    let store: DeferralStore | undefined;

    afterEach(async () => {
      if (store) await store.close();
      store = undefined;
    });

    /**
     * @case A meta the plain-JSON rule refuses is refused by every backend
     * @preconditions An open store; meta carrying a value encodePersistable rejects
     * @expectedResult RC5042 naming the meta path, so the rule lives at the same boundary on both backends rather than only in whichever caller happened to encode first
     */
    test("refuses a meta that breaks the plain-JSON rule", async () => {
      store = await open();
      await expect(
        store.create(record({ meta: { cycle: circular() } })),
      ).rejects.toMatchObject({ rc: "RC5042" });
    });

    /**
     * @case A stored deferral reads back field for field
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

      const read = await store.get("def-1");
      expect(read).toBeDefined();
      expect(read?.routeId).toBe("payout");
      expect(read?.position).toBe(3);
      expect(read?.continuationHash).toBe(written.continuationHash);
      expect(read?.actionFingerprint).toBe(written.actionFingerprint);
      expect(read?.exchange).toEqual(written.exchange);
      expect(read?.schema).toEqual(written.schema);
      expect(read?.stepState).toEqual(written.stepState);
      expect(read?.meta).toEqual(written.meta);
      expect(read?.callBinding).toBe(written.callBinding);
      expect(read?.state).toBe("waiting");
      expect(read?.waitingFor).toBe(written.waitingFor);
      expect(read?.deferredAt.getTime()).toBe(written.deferredAt.getTime());
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
     * @case A deferral id is minted per defer, so a collision is a bug
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

      const read = await store.get("def-1");
      expect((read?.exchange.body as { amountCents: number }).amountCents).toBe(
        75_000,
      );
    });

    /**
     * @case Resuming a deferred exchange records the receipt
     * @preconditions A deferred record; markResumed with a principal ref
     * @expectedResult The caller won, and status / resumedAt / resumedBy are set
     */
    test("markResumed transitions and records who answered", async () => {
      store = await open();
      await store.create(record());
      const at = new Date("2026-08-11T08:00:00.000Z");

      const result = await store.markResumed("def-1", {
        at,
        by: { subject: "user:jaco", issuer: "https://idp.example" },
      });

      expect(result.won).toBe(true);
      expect(result.deferral?.outcome?.kind).toBe("resumed");
      expect(result.deferral?.outcome?.at?.getTime()).toBe(at.getTime());
      expect(result.deferral?.outcome?.by?.subject).toBe("user:jaco");
      expect(result.deferral?.outcome?.by?.issuer).toBe("https://idp.example");
    });

    /**
     * @case Exactly one of two concurrent resumes wins
     * @preconditions One deferred record; two markResumed calls started together
     * @expectedResult One result has won: true, the other won: false, and the
     *   record shows a single resume
     */
    test("markResumed is an atomic compare-and-swap with one winner", async () => {
      store = await open();
      await store.create(record());

      const [first, second] = await Promise.all([
        store.markResumed("def-1", {
          at: new Date("2026-08-11T08:00:00.000Z"),
          by: { subject: "first" },
        }),
        store.markResumed("def-1", {
          at: new Date("2026-08-11T08:00:01.000Z"),
          by: { subject: "second" },
        }),
      ]);

      expect([first.won, second.won].filter(Boolean)).toHaveLength(1);
      const winner = first.won ? first : second;
      const loser = first.won ? second : first;
      // The loser is told what happened instead, without a second read.
      expect(loser.deferral?.outcome?.kind).toBe("resumed");
      expect((await store.get("def-1"))?.outcome?.by?.subject).toBe(
        winner.deferral?.outcome?.by?.subject,
      );
    });

    /**
     * @case A resume racing the sweeper resolves to one outcome
     * @preconditions One deferred record; markResumed and claimExpiry started together
     * @expectedResult Exactly one wins, and the stored status matches the winner
     */
    test("a resume and an expiry cannot both win", async () => {
      store = await open();
      await store.create(
        record({ expiresAt: new Date("2026-08-10T09:00:01Z") }),
      );

      const [resumed, claimed] = await Promise.all([
        store.markResumed("def-1", { at: new Date() }),
        store.claimExpiry("def-1", new Date()),
      ]);

      expect([resumed.won, claimed.won].filter(Boolean)).toHaveLength(1);
      const stored = await store.get("def-1");
      expect(stored).toBeDefined();
      if (resumed.won) {
        expect(stored?.state).toBe("settled");
        expect(stored?.outcome?.kind).toBe("resumed");
      } else {
        // A won claim leaves the record waiting, which is the whole point of
        // the claim not being an outcome. Asserted rather than inferred from
        // `claimedAt` alone, because a settled record keeps that field.
        expect(stored?.state).toBe("waiting");
        expect(stored?.claimedAt).toBeDefined();
        expect(stored?.outcome).toBeUndefined();
      }
    });

    /**
     * @case A new deferral never carries settled state from its input
     * @preconditions A creation record polluted with the fields only a
     *   transition may write, as a caller re-deferring a record read back out
     *   of the store would produce
     * @expectedResult The stored record is deferred and clean. Keeping a
     *   continuation result alive on a record that reports itself waiting
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
        state: "settled",
        outcome: {
          kind: "resumed",
          at: new Date("2026-08-10T10:00:00.000Z"),
          by: { subject: "someone-else" },
          reason: "stale",
        },
        continuation,
        claimedAt: new Date("2026-08-10T09:30:00.000Z"),
      } as unknown as Parameters<DeferralStore["create"]>[0]);

      const stored = await store.get("def-1");

      expect(stored?.state).toBe("waiting");
      expect(stored?.continuation).toBeUndefined();
      expect(stored?.claimedAt).toBeUndefined();
      // The whole field, not its members: a surviving `{ kind: "resumed" }`
      // with nothing else in it is exactly the shape a member-by-member
      // assertion would wave through.
      expect(stored?.outcome).toBeUndefined();
    });

    /**
     * @case Settling writes the state and the outcome together, on every
     *   transition that settles
     * @preconditions One record resumed, one expired, one denied
     * @expectedResult Each reads back `settled` WITH an outcome, and no
     *   waiting record carries one
     *
     *   The pairing is an invariant rather than two independent fields, and
     *   this is the one place it is asserted. Every other test in the tree
     *   reads `outcome.kind` alone, which is sound only because a backend
     *   cannot write one half here: that is what makes this the guard for an
     *   out-of-tree store, where a read-then-write implementation could
     *   plausibly land one column and not the other.
     */
    test("a settling transition writes state and outcome together", async () => {
      store = await open();
      await store.create(record({ id: "r" }));
      await store.create(record({ id: "e" }));
      await store.create(record({ id: "d" }));
      await store.create(record({ id: "w" }));

      await store.markResumed("r", { at: new Date() });
      await store.claimExpiry("e", new Date());
      await store.markExpired("e");
      await store.claimExpiry("d", new Date());
      await store.markDenied("d", "cancelled");

      for (const [id, kind] of [
        ["r", "resumed"],
        ["e", "expired"],
        ["d", "denied"],
      ] as const) {
        const settled = await store.get(id);
        expect(settled?.state).toBe("settled");
        expect(settled?.outcome?.kind).toBe(kind);
        expect(settled?.outcome?.at).toBeInstanceOf(Date);
      }

      const waiting = await store.get("w");
      expect(waiting?.state).toBe("waiting");
      expect(waiting?.outcome).toBeUndefined();
    });

    /**
     * @case A settled record is not resumable
     * @preconditions A record already marked expired
     * @expectedResult markResumed reports it lost and leaves the state alone
     */
    test("refuses to resume a deferral that already settled", async () => {
      store = await open();
      await store.create(record());
      await store.claimExpiry("def-1", new Date());
      await store.markExpired("def-1");

      const result = await store.markResumed("def-1", { at: new Date() });

      expect(result.won).toBe(false);
      expect(result.deferral?.outcome?.kind).toBe("expired");
    });

    /**
     * @case A record with a delivery claim outstanding is not resumable,
     *   even though it is still waiting
     * @preconditions One record whose expiry claim was taken and not settled
     * @expectedResult markResumed reports it lost, and the record is
     *   unchanged: still waiting, still claimed, with no outcome
     *
     *   The claim is a second axis rather than a state of its own, so
     *   "waiting" alone does not mean resumable. This is the case that
     *   distinguishes the two, and without it a later reader could compare
     *   on `state` and reintroduce a second notification for one expiry:
     *   the claim holder owns telling the route, and a resume let in behind
     *   it would tell the approver their answer was accepted while the
     *   sweeper tells the route to re-ask.
     */
    test("refuses to resume a deferral whose delivery is claimed", async () => {
      store = await open();
      await store.create(record());
      await store.claimExpiry("def-1", new Date("2026-08-11T08:00:00.000Z"));

      const result = await store.markResumed("def-1", { at: new Date() });

      expect(result.won).toBe(false);
      expect(result.deferral?.state).toBe("waiting");
      expect(result.deferral?.claimedAt?.toISOString()).toBe(
        "2026-08-11T08:00:00.000Z",
      );
      expect(result.deferral?.outcome).toBeUndefined();
    });

    /**
     * @case Releasing a stale claim makes the record resumable again
     * @preconditions A claimed record whose claim is released by the lease
     * @expectedResult The resume that lost while the claim stood now wins
     *
     *   The other half of the claim's healing contract. `releaseClaims`
     *   asserts the fields it clears below; this asserts what clearing them
     *   is FOR, which is the behaviour a crashed deliverer must not cost.
     */
    test("a released claim is resumable again", async () => {
      store = await open();
      await store.create(record());
      await store.claimExpiry("def-1", new Date("2026-08-11T08:00:00.000Z"));
      expect((await store.markResumed("def-1", { at: new Date() })).won).toBe(
        false,
      );

      await store.releaseClaims(new Date("2026-08-11T09:00:00.000Z"));

      const result = await store.markResumed("def-1", { at: new Date() });
      expect(result.won).toBe(true);
      expect(result.deferral?.outcome?.kind).toBe("resumed");
    });

    /**
     * @case Denial is a claim first, an outcome second
     * @preconditions A deferred record; claimExpiry then markDenied
     * @expectedResult The claim records when it was taken, and the finalize stores the reason. markDenied from a bare deferred record loses, because finalizing an unclaimed record would skip the delivery step the claim exists to make crash-safe
     */
    test("markDenied finalizes a claim and records the reason", async () => {
      store = await open();
      await store.create(record());

      const unclaimed = await store.markDenied("def-1", "too eager");
      expect(unclaimed.won).toBe(false);

      const claimedAt = new Date("2026-08-11T09:00:00.000Z");
      const claim = await store.claimExpiry("def-1", claimedAt);
      expect(claim.won).toBe(true);
      expect(claim.deferral?.state).toBe("waiting");
      expect(claim.deferral?.claimedAt).toBeDefined();
      expect(claim.deferral?.claimedAt?.toISOString()).toBe(
        claimedAt.toISOString(),
      );

      const result = await store.markDenied("def-1", "run cancelled");
      expect(result.won).toBe(true);
      expect(result.deferral?.outcome?.kind).toBe("denied");
      expect(result.deferral?.outcome?.reason).toBe("run cancelled");
    });

    /**
     * @case A stale claim is released for redelivery, a fresh one honoured
     * @preconditions Two expiring records, one claimed before the cutoff and one after
     * @expectedResult Only the stale claim flips back to deferred with its claimedAt cleared, so the next sweep redelivers exactly the work whose deliverer died
     */
    test("releaseClaims flips back only stale claims", async () => {
      store = await open();
      await store.create(record({ id: "stale" }));
      await store.create(record({ id: "fresh" }));
      await store.claimExpiry("stale", new Date("2026-08-11T08:00:00.000Z"));
      await store.claimExpiry("fresh", new Date("2026-08-11T09:30:00.000Z"));

      const released = await store.releaseClaims(
        new Date("2026-08-11T09:00:00.000Z"),
      );

      expect(released).toBe(1);
      const stale = await store.get("stale");
      expect(stale?.state).toBe("waiting");
      expect(stale?.claimedAt).toBeUndefined();
      const fresh = await store.get("fresh");
      expect(fresh?.state).toBe("waiting");
      expect(fresh?.claimedAt).toBeDefined();
    });

    /**
     * @case The expiry scan pages on a keyset cursor
     * @preconditions Four due records sharing deadlines so the id tiebreak matters
     * @expectedResult Pages come back in (expiresAt, id) order, each page strictly after the cursor, and a record the caller left deferred is not re-read by a later page. That is what makes an unretirable prefix unable to starve the records behind it
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

      // Nothing was retired: the first page's records are still deferred.
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
      expect(result.deferral).toBeUndefined();
    });

    /**
     * @case A duplicate resume can be answered from the cached outcome
     * @preconditions A resumed record with a recorded continuation result
     * @expectedResult The outcome reads back with its timestamp intact
     */
    test("caches the continuation result of execution two", async () => {
      store = await open();
      await store.create(record());
      await store.markResumed("def-1", { at: new Date() });
      await store.recordContinuation("def-1", continuation);

      const read = await store.get("def-1");
      expect(read?.continuation?.status).toBe("completed");
      expect(read?.continuation?.body).toEqual({ paid: true });
      expect(read?.continuation?.at.getTime()).toBe(continuation.at.getTime());
    });

    /**
     * @case Recording a continuation result for an unknown id is a no-op
     * @preconditions Empty store
     * @expectedResult The call resolves without throwing
     */
    test("ignores a continuation result for an unknown id", async () => {
      store = await open();
      await expect(
        store.recordContinuation("ghost", continuation),
      ).resolves.toBeUndefined();
    });

    /**
     * @case The sweeper sees only deferrals that are actually due
     * @preconditions Three records: due, not yet due, and due but already resumed
     * @expectedResult Only the due deferred one is returned
     */
    test("findExpired returns due, still-deferred records only", async () => {
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
          deferredAt: new Date("2026-08-10T10:00:00.000Z"),
          expiresAt: due,
        }),
      );
      await store.create(
        record({
          id: "a",
          deferredAt: new Date("2026-08-10T08:00:00.000Z"),
          expiresAt: due,
        }),
      );
      await store.create(
        record({
          id: "c",
          deferredAt: new Date("2026-08-10T12:00:00.000Z"),
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
     * @preconditions Three records: one still waiting, one resumed and settled, one resumed with no continuation
     * @expectedResult Only the resumed-with-no-continuation record is returned. It is invisible to findExpired (it is no longer deferred) and its approval is already spent, so the boot summary is the only place it can ever surface
     */
    test("reports resumes that never recorded an outcome", async () => {
      store = await open();
      await store.create(record({ id: "still-deferred" }));
      await store.create(record({ id: "settled" }));
      await store.create(record({ id: "stranded" }));

      await store.markResumed("settled", { at: new Date() });
      await store.recordContinuation("settled", continuation);
      await store.markResumed("stranded", { at: new Date() });

      const crashResidue = await store.resumedWithoutContinuation();

      expect(crashResidue.map((entry) => entry.id)).toEqual(["stranded"]);
    });

    /**
     * @case Stranded resumes come back oldest first and honour a limit
     * @preconditions Two stranded records deferred at different times, read back with a limit of one
     * @expectedResult The older one. The boot summary reports the oldest age, so the ordering is what makes that figure mean anything
     */
    test("orders stranded resumes oldest first", async () => {
      store = await open();
      await store.create(
        record({
          id: "older",
          deferredAt: new Date("2026-08-01T09:00:00.000Z"),
        }),
      );
      await store.create(
        record({
          id: "newer",
          deferredAt: new Date("2026-08-09T09:00:00.000Z"),
        }),
      );
      await store.markResumed("older", { at: new Date() });
      await store.markResumed("newer", { at: new Date() });

      const bounded = await store.resumedWithoutContinuation(1);

      expect(bounded.map((entry) => entry.id)).toEqual(["older"]);
    });

    /**
     * @case The listing is oldest first and pages strictly forward
     * @preconditions Four records deferred at distinct times, read a page
     *   at a time
     * @expectedResult Oldest first, and each page resumes strictly past
     *   the last row of the one before, so no record is seen twice or
     *   skipped. Ordered by time rather than by id because a deferral id
     *   is `{uuid}#{sequence}` and says nothing about when it was made
     */
    test("list pages oldest first", async () => {
      store = await open();
      const ids = ["d-a", "d-b", "d-c", "d-d"];
      for (const [index, id] of ids.entries()) {
        await store.create(
          record({
            id,
            deferredAt: new Date(Date.UTC(2026, 7, index + 1, 9)),
          }),
        );
      }

      const first = await store.list({ limit: 2 });
      const second = await store.list({
        limit: 2,
        after: { deferredAt: first[1]!.deferredAt, id: first[1]!.id },
      });
      const third = await store.list({
        limit: 2,
        after: { deferredAt: second[1]!.deferredAt, id: second[1]!.id },
      });

      expect(first.map((row) => row.id)).toEqual(["d-a", "d-b"]);
      expect(second.map((row) => row.id)).toEqual(["d-c", "d-d"]);
      expect(third).toEqual([]);
    });

    /**
     * @case Two records deferred in the same millisecond still page
     * @preconditions Three records sharing one deferredAt, read one at a time
     * @expectedResult Each page advances by the id tiebreak, so a cursor
     *   over a tied timestamp cannot loop on the same row or skip its
     *   neighbour. A millisecond is coarse enough that a batch of parallel
     *   defers lands inside one
     */
    test("list breaks a tied deferredAt by id", async () => {
      store = await open();
      const tied = new Date("2026-08-04T09:00:00.000Z");
      for (const id of ["t-1", "t-2", "t-3"]) {
        await store.create(record({ id, deferredAt: tied }));
      }

      const seen: string[] = [];
      let after: { deferredAt: Date; id: string } | undefined;
      for (let page = 0; page < 4; page++) {
        const rows = await store.list({
          limit: 1,
          ...(after !== undefined ? { after } : {}),
        });
        if (rows.length === 0) break;
        seen.push(rows[0]!.id);
        after = { deferredAt: rows[0]!.deferredAt, id: rows[0]!.id };
      }

      expect(seen).toEqual(["t-1", "t-2", "t-3"]);
    });

    /**
     * @case The listing filters by state and by route
     * @preconditions One waiting record on one route, one settled on another
     * @expectedResult Each filter narrows to its own record and both
     *   together narrow to none, so a management surface can ask "what is
     *   still waiting on this route" in one read
     */
    test("list filters by state and route", async () => {
      store = await open();
      await store.create(record({ id: "waiting-1", routeId: "payout" }));
      await store.create(
        record({
          id: "settled-1",
          routeId: "refund",
          deferredAt: new Date("2026-08-11T09:00:00.000Z"),
        }),
      );
      await store.markResumed("settled-1", { at: new Date() });

      expect(
        (await store.list({ limit: 10, state: "waiting" })).map((r) => r.id),
      ).toEqual(["waiting-1"]);
      expect(
        (await store.list({ limit: 10, state: "settled" })).map((r) => r.id),
      ).toEqual(["settled-1"]);
      expect(
        (await store.list({ limit: 10, routeId: "refund" })).map((r) => r.id),
      ).toEqual(["settled-1"]);
      expect(
        await store.list({ limit: 10, state: "waiting", routeId: "refund" }),
      ).toEqual([]);
      expect((await store.list({ limit: 10 })).map((r) => r.id)).toEqual([
        "waiting-1",
        "settled-1",
      ]);
    });

    /**
     * @case A summary carries the reason and never the payload
     * @preconditions A record with meta, a stored exchange, a schema, a
     *   step state and a TTL, then a second one denied with a reason
     * @expectedResult The summary carries what a reader needs and nothing
     *   the listing may not show: no exchange, no schema, no step state,
     *   no meta. The claim is a boolean rather than its timestamp, because
     *   the question is whether anything already owns telling the route
     */
    test("list summarises without the stored exchange", async () => {
      store = await open();
      await store.create(
        record({
          id: "waiting-1",
          expiresAt: new Date("2026-09-01T09:00:00.000Z"),
          stepState: { thread: ["hello"] },
        }),
      );
      await store.create(
        record({
          id: "denied-1",
          deferredAt: new Date("2026-08-12T09:00:00.000Z"),
        }),
      );
      await store.claimExpiry("denied-1", new Date());
      await store.markDenied("denied-1", "cancelled by the operator");

      const [waiting, denied] = await store.list({ limit: 10 });

      expect(waiting).toEqual({
        id: "waiting-1",
        routeId: "payout",
        state: "waiting",
        waitingFor: "resume",
        claimed: false,
        deferredAt: new Date("2026-08-10T09:00:00.000Z"),
        expiresAt: new Date("2026-09-01T09:00:00.000Z"),
      });
      expect(denied?.state).toBe("settled");
      expect(denied?.outcome?.kind).toBe("denied");
      expect(denied?.outcome?.reason).toBe("cancelled by the operator");
    });

    /**
     * @case A claimed record says so without saying when
     * @preconditions One waiting record with an expiry-delivery claim taken
     * @expectedResult Still waiting, and `claimed` is true. A claimed
     *   record is not resumable, so a reader that saw only the state would
     *   read it as available
     */
    test("list reports an outstanding delivery claim", async () => {
      store = await open();
      await store.create(record({ id: "claimed-1" }));
      await store.claimExpiry("claimed-1", new Date());

      const [row] = await store.list({ limit: 10 });

      expect(row).toMatchObject({ state: "waiting", claimed: true });
    });

    /**
     * @case A summary cannot be mutated back into the store
     * @preconditions A record read through the listing, then its
     *   timestamps and outcome mutated in place by the caller
     * @expectedResult The stored record is unmoved. Both backends must
     *   behave as if the summary round-tripped through storage: the
     *   in-memory one holds the same `Date` objects the sweeper's expiry
     *   ordering and the retention purge read, so handing a caller a live
     *   reference is a corruption path rather than an aliasing detail
     */
    test("list returns a summary detached from the record", async () => {
      store = await open();
      await store.create(
        record({ id: "d-1", expiresAt: new Date("2026-09-01T09:00:00.000Z") }),
      );
      await store.claimExpiry("d-1", new Date());
      await store.markDenied("d-1", "cancelled");

      const [summary] = await store.list({ limit: 1 });
      summary!.deferredAt.setUTCFullYear(1999);
      summary!.expiresAt!.setUTCFullYear(1999);
      summary!.outcome!.at.setUTCFullYear(1999);

      const [again] = await store.list({ limit: 1 });
      expect(again!.deferredAt.getUTCFullYear()).toBe(2026);
      expect(again!.expiresAt!.getUTCFullYear()).toBe(2026);
      expect(again!.outcome!.at.getUTCFullYear()).not.toBe(1999);
    });

    /**
     * @case The listing refuses a limit the two backends would read differently
     * @preconditions A fresh store; zero, a negative value and a fraction
     * @expectedResult Each rejects with RC5044, the same rule the sweep scan applies
     */
    test("list refuses a non-positive or non-integer limit", async () => {
      store = await open();
      for (const limit of [0, -1, 1.5]) {
        await expect(store.list({ limit })).rejects.toThrow(
          expect.objectContaining({ rc: "RC5044" }),
        );
      }
    });

    /**
     * @case The listing refuses a cursor it would have to guess at
     * @preconditions Cursors carrying an invalid date and an empty id
     * @expectedResult Each rejects with RC5044 rather than being
     *   interpreted, so a malformed cursor cannot silently restart the
     *   listing from the beginning
     */
    test("list refuses a malformed cursor", async () => {
      store = await open();
      const bad = [
        { deferredAt: new Date("nonsense"), id: "d-1" },
        { deferredAt: new Date(), id: "" },
      ];
      for (const after of bad) {
        await expect(store.list({ limit: 10, after })).rejects.toThrow(
          expect.objectContaining({ rc: "RC5044" }),
        );
      }
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
     * @case The startup scan reports what is still deferred
     * @preconditions Two deferred records and one resumed
     * @expectedResult Count covers only the deferred ones, oldest is the earliest deferredAt
     */
    test("pending summarises count and oldest", async () => {
      store = await open();
      await store.create(
        record({
          id: "old",
          deferredAt: new Date("2026-08-01T09:00:00.000Z"),
        }),
      );
      await store.create(
        record({
          id: "new",
          deferredAt: new Date("2026-08-09T09:00:00.000Z"),
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
     *   not accumulate every exchange that ever deferred
     * @preconditions One record settled before the cutoff, one old
     *   still-deferred record, and one record settled after the cutoff
     * @expectedResult Only the one settled before the cutoff is purged
     */
    test("purgeSettled reclaims settled records past the cutoff", async () => {
      store = await open();
      const old = new Date("2026-07-01T09:00:00.000Z");
      const recent = new Date("2026-08-09T09:00:00.000Z");
      await store.create(record({ id: "old-settled", deferredAt: old }));
      await store.create(record({ id: "old-deferred", deferredAt: old }));
      await store.create(record({ id: "recent-settled", deferredAt: recent }));
      await store.markResumed("old-settled", {
        at: new Date("2026-07-02T09:00:00.000Z"),
      });
      await store.claimExpiry("recent-settled", new Date());
      await store.markDenied("recent-settled", "cancelled");

      const purged = await store.purgeSettled(
        new Date("2026-08-01T00:00:00.000Z"),
      );

      expect(purged).toBe(1);
      expect(await store.get("old-settled")).toBeUndefined();
      expect(await store.get("old-deferred")).toBeDefined();
      expect(await store.get("recent-settled")).toBeDefined();
    });

    /**
     * @case Retention is measured from settlement, not from the deferral
     * @preconditions A record deferred long before the cutoff that settled
     *   after it (the day-89 shape: deferred for months, resolved recently)
     * @expectedResult The record survives the purge; measuring from
     *   deferredAt would have deleted it the day after it settled
     */
    test("purgeSettled keeps a long-deferred, recently settled record", async () => {
      store = await open();
      await store.create(
        record({
          id: "deferred-in-may",
          deferredAt: new Date("2026-05-01T09:00:00.000Z"),
        }),
      );
      await store.markResumed("deferred-in-may", {
        at: new Date("2026-08-09T09:00:00.000Z"),
      });

      const purged = await store.purgeSettled(
        new Date("2026-08-01T00:00:00.000Z"),
      );

      expect(purged).toBe(0);
      const kept = await store.get("deferred-in-may");
      expect(kept?.outcome?.kind).toBe("resumed");
      expect(kept?.outcome?.at?.toISOString()).toBe("2026-08-09T09:00:00.000Z");
    });

    /**
     * @case Every settling transition stamps the retention clock
     * @preconditions One record resumed, one expired, one denied
     * @expectedResult All three read back with an `outcome.at`; the resumed
     *   one equals the resumption time, the claim-settled ones are stamped
     *   at the write
     */
    test("markExpired and markDenied stamp outcome.at at the write", async () => {
      store = await open();
      const floor = Date.now();
      await store.create(record({ id: "r" }));
      await store.create(record({ id: "e" }));
      await store.create(record({ id: "d" }));
      await store.markResumed("r", {
        at: new Date("2026-08-11T09:00:00.000Z"),
      });
      await store.claimExpiry("e", new Date());
      await store.markExpired("e");
      await store.claimExpiry("d", new Date());
      await store.markDenied("d", "cancelled");

      expect((await store.get("r"))?.outcome?.at?.toISOString()).toBe(
        "2026-08-11T09:00:00.000Z",
      );
      const expired = (await store.get("e"))?.outcome?.at;
      const denied = (await store.get("d"))?.outcome?.at;
      expect(expired?.getTime()).toBeGreaterThanOrEqual(floor);
      expect(denied?.getTime()).toBeGreaterThanOrEqual(floor);
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
      await store.create(record({ id: "claimed", deferredAt: old }));
      await store.claimExpiry("claimed", new Date());

      const purged = await store.purgeSettled(
        new Date("2026-08-01T00:00:00.000Z"),
      );

      expect(purged).toBe(0);
      const held = await store.get("claimed");
      expect(held?.state).toBe("waiting");
      expect(held?.claimedAt).toBeDefined();
    });

    /**
     * @case A deferred exchange is never reclaimed by retention, however old
     * @preconditions One long-deferred, still-deferred record
     * @expectedResult purgeSettled leaves it alone; only the sweeper may
     *   move it out of the deferred state
     */
    test("purgeSettled never touches a still-deferred record", async () => {
      store = await open();
      await store.create(
        record({ deferredAt: new Date("2020-01-01T00:00:00.000Z") }),
      );

      expect(await store.purgeSettled(new Date())).toBe(0);
      expect((await store.get("def-1"))?.state).toBe("waiting");
    });

    /**
     * @case replaceStepState swaps the slot of a still-deferred record
     * @preconditions A deferred record carrying a step state, replaced under its own fingerprint
     * @expectedResult The caller wins, the new state is stored, and nothing else on the record moved
     */
    test("replaceStepState swaps the slot of a deferred record", async () => {
      store = await open();
      const written = record({
        stepState: { messages: [{ role: "user" }], turnsUsed: 2 },
      });
      await store.create(written);

      const next = {
        messages: [{ role: "user" }, { role: "assistant" }],
        turnsUsed: 2,
      };
      const result = await store.replaceStepState(
        "def-1",
        stepStateFingerprint(written.stepState),
        next,
      );

      expect(result.won).toBe(true);
      expect(result.deferral?.stepState).toEqual(next);
      expect(result.deferral?.state).toBe("waiting");
      expect(result.deferral?.exchange).toEqual(written.exchange);
      expect(result.deferral?.meta).toEqual(written.meta);
      expect((await store.get("def-1"))?.stepState).toEqual(next);
    });

    /**
     * @case A stale fingerprint loses the compare-and-swap
     * @preconditions Two replacements race off the same read; the first has already landed
     * @expectedResult The second reports won: false and hands back the state that actually landed, leaving it untouched
     */
    test("replaceStepState refuses a stale fingerprint", async () => {
      store = await open();
      const written = record({ stepState: { messages: [], turnsUsed: 0 } });
      await store.create(written);
      const stale = stepStateFingerprint(written.stepState);

      const first = await store.replaceStepState("def-1", stale, {
        messages: [],
        turnsUsed: 1,
      });
      const second = await store.replaceStepState("def-1", stale, {
        messages: [],
        turnsUsed: 99,
      });

      expect(first.won).toBe(true);

      expect(second.won).toBe(false);
      expect(second.deferral?.stepState).toEqual({
        messages: [],
        turnsUsed: 1,
      });
    });

    /**
     * @case replaceStepState never edits a record that left the deferred state
     * @preconditions A record already resumed, then a replacement under the fingerprint it was deferred with
     * @expectedResult The swap is refused, so a compaction cannot rewrite the thread of a run already executing its continuation
     */
    test("replaceStepState refuses a record that is no longer deferred", async () => {
      store = await open();
      const written = record({ stepState: { messages: [], turnsUsed: 0 } });
      await store.create(written);
      await store.markResumed("def-1", { at: new Date() });

      const result = await store.replaceStepState(
        "def-1",
        stepStateFingerprint(written.stepState),
        { messages: [], turnsUsed: 5 },
      );

      expect(result.won).toBe(false);
      expect(result.deferral?.outcome?.kind).toBe("resumed");
      expect(result.deferral?.stepState).toEqual(written.stepState);
    });

    /**
     * @case replaceStepState reports a loss for an unknown id
     * @preconditions An empty store
     * @expectedResult won: false with no record, matching every other compare-and-swap on the contract
     */
    test("replaceStepState reports a loss for an unknown id", async () => {
      store = await open();
      const result = await store.replaceStepState("nope", "whatever", {});
      expect(result).toEqual({ won: false, deferral: undefined });
    });

    /**
     * @case A replacement that breaks the plain-JSON rule is refused
     * @preconditions A deferred record and a replacement holding a circular reference
     * @expectedResult RC5042 on both backends, so an unpersistable value cannot be written on one and refused on the other
     */
    test("replaceStepState refuses a replacement the store cannot persist", async () => {
      store = await open();
      const written = record({ stepState: { messages: [], turnsUsed: 0 } });
      await store.create(written);

      await expect(
        store.replaceStepState(
          "def-1",
          stepStateFingerprint(written.stepState),
          { cycle: circular() },
        ),
      ).rejects.toMatchObject({ rc: "RC5042" });
      expect((await store.get("def-1"))?.stepState).toEqual(written.stepState);
    });
  });
}

contractSuite("memory", async () => new MemoryDeferralStore());
contractSuite("sqlite (in-process)", () =>
  SqliteDeferralStore.open({ path: ":memory:" }),
);
contractSuite("sqlite (on disk)", () =>
  SqliteDeferralStore.open({
    path: join(scratch, `${Math.random().toString(36).slice(2)}.db`),
  }),
);

describe("SqliteDeferralStore durability", () => {
  /**
   * @case A deferred exchange outlives the store object that wrote it
   * @preconditions A record written to an on-disk database, then the store closed
   *   and reopened at the same path
   * @expectedResult The record reads back from the reopened store
   */
  test("a record survives closing and reopening the database", async () => {
    const path = join(scratch, "reopen.db");
    const first = await SqliteDeferralStore.open({ path });
    await first.create(record());
    await first.close();

    const second = await SqliteDeferralStore.open({ path });
    const read = await second.get("def-1");
    await second.close();

    expect(read?.routeId).toBe("payout");
    expect(read?.state).toBe("waiting");
  });

  /**
   * @case Opening an existing database must not re-run its migrations
   * @preconditions A database opened, closed, and opened again
   * @expectedResult The second open succeeds and existing rows are intact
   */
  test("migration is idempotent across opens", async () => {
    const path = join(scratch, "migrate.db");
    const first = await SqliteDeferralStore.open({ path });
    await first.create(record({ id: "kept" }));
    await first.close();

    const second = await SqliteDeferralStore.open({ path });
    const summary = await second.pending();
    await second.close();

    expect(summary.count).toBe(1);
  });

  /**
   * @case A settled record that cannot be dated is skipped, not purged
   * @preconditions A resumed record whose outcome_at was nulled by hand,
   *   which no public transition can produce
   * @expectedResult purgeSettled leaves it in place, however generous the
   *   cutoff: SQL NULL never compares below it. It reads back as settled
   *   with no outcome, which is the same shape the memory backend produces
   *   for the same injection in its own case below
   */
  test("purgeSettled skips a settled row with no outcome_at", async () => {
    const path = join(scratch, "undated.db");
    const seed = await SqliteDeferralStore.open({ path });
    await seed.create(record({ id: "undated" }));
    await seed.markResumed("undated", { at: new Date() });
    await seed.close();

    const { Database } = await import("bun:sqlite");
    const db = new Database(path);
    db.exec("UPDATE deferrals SET outcome_at = NULL WHERE id = 'undated'");
    db.close();

    const store = await SqliteDeferralStore.open({ path });
    expect(await store.purgeSettled(new Date("2999-01-01"))).toBe(0);
    const undated = await store.get("undated");
    expect(undated?.state).toBe("settled");
    expect(undated?.outcome).toBeUndefined();
    await store.close();
  });
});

describe("DeferralStore compare-and-swap under real concurrency", () => {
  /**
   * @case Four processes resuming one deferral at once produce one winner
   * @preconditions A deferred record in a shared on-disk database and four
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
    const seed = await SqliteDeferralStore.open({ path });
    await seed.create(record());
    await seed.close();

    const worker = join(import.meta.dir, "deferral-race-worker.ts");
    // Enough runway for four processes to boot and reach the barrier.
    const startAt = Date.now() + 2_000;
    const results = await Promise.all(
      ["a", "b", "c", "d"].map(
        (subject) =>
          new Promise<{ subject: string; won: boolean }>((resolve, reject) => {
            const child = spawn(
              process.execPath,
              [worker, path, "def-1", String(startAt), subject],
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

    const store = await SqliteDeferralStore.open({ path });
    const read = await store.get("def-1");
    await store.close();
    expect(read?.outcome?.kind).toBe("resumed");
    expect(read?.outcome?.by?.subject).toBe(winners[0]?.subject);
  }, 30_000);
});

describe("MemoryDeferralStore injected states", () => {
  /**
   * @case The memory backend honours the same undated-record contract
   * @preconditions A settled record whose outcome was deleted through the
   *   store's test seam, a shape no public transition can produce
   * @expectedResult purgeSettled leaves it in place, matching sqlite's NULL
   *   comparison in the durability block's twin case. Refusing to delete a
   *   record you cannot date is the contract both backends share, and this
   *   case is what keeps the memory store's skip from silently regressing
   *   into a fallback on the clock #634 removed
   */
  test("memory purgeSettled skips a settled record with no outcome", async () => {
    const store = new MemoryDeferralStore();
    await store.create(record({ id: "undated" }));
    await store.markResumed("undated", { at: new Date("2026-08-11") });
    const live = MemoryDeferralStore.unsafeRecords(store).get("undated")!;
    delete (live as { outcome?: unknown }).outcome;

    expect(await store.purgeSettled(new Date("2999-01-01"))).toBe(0);
    const undated = await store.get("undated");
    expect(undated?.state).toBe("settled");
    expect(undated?.outcome).toBeUndefined();
    await store.close();
  });
});

describe("deferral store path claims", () => {
  /** Loaders for a runtime that has no sqlite driver at all. */
  const absentDriver = {
    bun: () => Promise.reject(new Error("no bun:sqlite here")),
    node: () => Promise.reject(new Error("no better-sqlite3 here")),
  };

  /**
   * @case A deferral store that degrades to memory does not keep holding its path
   * @preconditions An unconfigured deferral store with no sqlite driver available, so it falls back to memory
   * @expectedResult The path it never opened is free for another store to claim. Holding it turned a deliberate degradation into a boot error, refusing a store over a file nothing had open
   */
  test("a deferral store that falls back to memory releases its path", async () => {
    const t = await testContext().build();
    const runtime = await createDeferralRuntime(t.ctx, {
      loaders: absentDriver,
      allowEphemeralSecret: true,
    });
    expect(runtime.backend).toBe("memory");

    expect(() =>
      claimDatabasePath({
        scope: t.ctx,
        path: DEFAULT_DEFERRAL_DB_PATH,
        claimant: "sessions: { store }",
        onConflict: (conflict) =>
          new Error(`refused, held by ${conflict.held}`),
      }),
    ).not.toThrow();
    await t.stop?.();
  });
});
