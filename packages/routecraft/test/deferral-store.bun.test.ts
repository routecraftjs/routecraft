import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deferralStoreConformance, testContext } from "@routecraft/testing";
import { createDeferralRuntime } from "../src/plugins/deferral/index.ts";
import { claimDatabasePath } from "../src/shared/sqlite/claims.ts";
import {
  DEFAULT_DEFERRAL_DB_PATH,
  MemoryDeferralStore,
  SqliteDeferralStore,
  type NewDeferral,
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
    errorPath: {
      origin: "step",
      handler: "acme.step-up/park",
      refusedScopes: ["payouts:approve"],
    },
    ...overrides,
  };
}

const runner = { describe, test, afterEach, expect };

deferralStoreConformance("memory", () => new MemoryDeferralStore(), runner);
deferralStoreConformance(
  "sqlite (in-process)",
  () => SqliteDeferralStore.open({ path: ":memory:" }),
  runner,
);
deferralStoreConformance(
  "sqlite (on disk)",
  () =>
    SqliteDeferralStore.open({
      path: join(scratch, `${Math.random().toString(36).slice(2)}.db`),
    }),
  runner,
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
   * @case A database a version 2 build left with a claim outstanding
   * @preconditions A file whose deferrals table has no claim identity or renewal column and whose user_version says 2, holding a row claimed by the process that wrote it, which no longer exists
   * @expectedResult Opening it migrates to version 3 and the row reads back as claimed, with an identity and a renewal time equal to its claim time, so the lease releases it on schedule and a holder presenting the read-back claim can finalize it. A migration that added the columns without backfilling would leave a claimed row no claim can ever match, which is a record nothing can settle
   */
  test("a version 2 claim is given an identity by the migration", async () => {
    const path = join(scratch, "claim-v2.db");
    const seed = await SqliteDeferralStore.open({ path });
    await seed.create(record({ id: "held" }));
    const at = new Date("2026-08-11T08:00:00.000Z");
    expect((await seed.claimExpiry("held", at)).won).toBe(true);
    await seed.close();

    const { Database } = await import("bun:sqlite");
    const db = new Database(path);
    db.exec("ALTER TABLE deferrals DROP COLUMN claim_id");
    db.exec("ALTER TABLE deferrals DROP COLUMN claim_renewed_at");
    db.exec("PRAGMA user_version = 2");
    db.close();

    const store = await SqliteDeferralStore.open({ path });
    const held = await store.get("held");
    expect(held?.state).toBe("waiting");
    expect(held?.claim?.id).toBeString();
    expect(held?.claim?.id).not.toHaveLength(0);
    expect(held?.claim?.at).toEqual(at);
    expect(held?.claim?.renewedAt).toEqual(at);

    expect(await store.releaseClaims(new Date(at.getTime() - 1))).toBe(0);
    const finalized = await store.markExpired("held", held!.claim!.id);
    expect(finalized.won).toBe(true);
    await store.close();
  });

  /**
   * @case A claim a 0.7 build wrote into a file a 0.8 build already migrated
   * @preconditions A version 3 file holding a waiting row whose claimed_at was set by raw SQL with claim_id and claim_renewed_at left NULL, as a 0.7 process still holding the file open writes a claim
   * @expectedResult The row reads back as claimed, with a synthesised identity starting "legacy:" and a renewal time equal to its claim time; no holder can renew or settle it, not even one presenting the identity it reads back; a release before the claim time leaves it and one at the claim time releases it, after which a 0.8 claim on it wins. Refusing the read, or comparing the lease on claim_renewed_at alone, would leave a waiting row nothing could ever read or release
   */
  test("a claim written without an identity heals by its lease", async () => {
    const path = join(scratch, "claim-legacy.db");
    const seed = await SqliteDeferralStore.open({ path });
    await seed.create(record({ id: "legacy" }));
    await seed.close();

    const at = new Date("2026-08-11T08:00:00.000Z");
    const { Database } = await import("bun:sqlite");
    const db = new Database(path);
    db.prepare(
      "UPDATE deferrals SET claimed_at = ?, claim_id = NULL, claim_renewed_at = NULL WHERE id = 'legacy'",
    ).run(at.getTime());
    db.close();

    const store = await SqliteDeferralStore.open({ path });
    const held = await store.get("legacy");
    expect(held?.state).toBe("waiting");
    expect(held?.claim?.id.startsWith("legacy:")).toBe(true);
    expect(held?.claim?.at).toEqual(at);
    expect(held?.claim?.renewedAt).toEqual(at);

    const presented = held!.claim!.id;
    expect((await store.renewClaim("legacy", presented, new Date())).won).toBe(
      false,
    );
    expect((await store.markExpired("legacy", presented)).won).toBe(false);
    expect((await store.markDenied("legacy", presented)).won).toBe(false);

    expect(await store.releaseClaims(new Date(at.getTime() - 1))).toBe(0);
    expect(await store.releaseClaims(at)).toBe(1);
    expect((await store.get("legacy"))?.claim).toBeUndefined();
    expect((await store.claimExpiry("legacy", new Date())).won).toBe(true);
    await store.close();
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
