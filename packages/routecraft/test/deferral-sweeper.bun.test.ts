import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  MemoryDeferralStore,
  craft,
  direct,
  noop,
  type CraftConfig,
  type EventName,
  type NewDeferral,
  type DeferralCasResult,
  type DeferralClaimId,
  type DeferralClaimResult,
  type DeferralStore,
} from "../src/index.ts";
import { ContinuationSweeper } from "../src/kernel/continuation/sweep.ts";
import { asDeferred, storeWith } from "./helpers/deferral.ts";

const Approval = z.object({ approved: z.boolean() });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A promise the test opens by hand, so a delivery stalls until told to go on. */
function gate(): { opened: Promise<void>; open: () => void } {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/** Poll until `condition` holds, failing loudly rather than hanging the suite. */
async function waitFor(condition: () => boolean, timeoutMs = 2_000) {
  const until = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > until) throw new Error("condition never held");
    await sleep(5);
  }
}

/** Directly driven sweepers in these tests never tick or purge on cadence. */
const sweeperOptions = { intervalMs: 60_000, leaseMs: 60 * 60 * 1000 };

/**
 * A config whose deferral runtime is a store the test holds a handle on.
 *
 * The handle is the point: the sweeper is driven by records, and a test that
 * cannot write a record whose deadline is already in the past can only test
 * expiry by sleeping through it.
 */
function deferringWith(
  store: DeferralStore,
  extra: Record<string, unknown> = {},
): CraftConfig {
  return { deferral: { store, ...extra } } as CraftConfig;
}

/**
 * A record that came due a second ago, written straight to the store.
 *
 * Synthetic rather than deferred through a route because the sweeper never
 * reads the continuation: it marks the record and re-enters the route's
 * error channel with the rehydrated exchange. What matters here is the
 * deadline and the route id, and going through a real deferral would mean
 * sleeping out a real ttl once per record.
 */
function overdue(
  id: string,
  overrides: Partial<NewDeferral> = {},
): NewDeferral {
  const now = Date.now();
  return {
    id,
    routeId: "payout",
    position: 1,
    continuationHash: "c".repeat(64),
    actionFingerprint: "f".repeat(64),
    exchange: {
      body: { amountCents: 1, payee: "acme" },
      headers: { "routecraft.id": id, "routecraft.route": "payout" },
    },
    schema: { hash: "e".repeat(64) },
    waitingFor: "resume",
    deferredAt: new Date(now - 60_000),
    expiresAt: new Date(now - 1_000),
    ...overrides,
  };
}

type LogCall = readonly unknown[];

const said = (
  calls: readonly LogCall[],
  fragment: string,
): LogCall | undefined =>
  calls.find(
    ([, message]) => typeof message === "string" && message.includes(fragment),
  );

/**
 * The expiry sweeper.
 *
 * A `ttl` exists so a route can react when nobody answers, and nobody is
 * ever going to present a token for a deferral that timed out. Without
 * something firing on a schedule the deadline is decoration: the escalation
 * flow it exists for never runs. These pin the two properties that make the
 * sweep safe to run against a live store, which is that it never decides an
 * outcome another party has already decided, and that no single bad record
 * can stop it reaching the rest.
 */
describe("the deferral sweeper", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case A deferral answered at the same moment the sweep retires it
   * @preconditions One deferred exchange; the sweep is handed a `now` past its deadline while the answer arrives before it, so both transitions are live at once
   * @expectedResult Exactly one of them wins, and the loser reports the winner's outcome rather than its own. Two winners would mean an approver told their answer was accepted while the route was told to re-ask, and the notification the transition gates would be sent twice
   */
  test("a resume racing the sweep produces exactly one outcome", async () => {
    const store = new MemoryDeferralStore();
    const continued: unknown[] = [];
    const reasked: unknown[] = [];
    const expiredEvents: unknown[] = [];

    t = await testContext()
      .with(deferringWith(store))
      .on(
        "route:exchange:expired" as EventName,
        ((payload: { details: unknown }) => {
          expiredEvents.push(payload.details);
        }) as never,
      )
      .routes([
        craft()
          .id("payout")
          .error((err) => {
            reasked.push(err);
            return { reasked: true };
          })
          .from(direct())
          .defer({ schema: Approval, ttl: "1h" })
          .tap((ex) => {
            continued.push(ex.body);
          })
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const deferred = asDeferred(
      await t.client.sendDirect("payout", { amountCents: 1, payee: "acme" }),
    );

    // The sweep is told it is two hours from now, so it sees the record as
    // due while the resume, running on the real clock, sees it as live. Both
    // transitions are therefore in flight against one record, which is the
    // race a deadline reached mid-answer produces in production.
    const sweeper = new ContinuationSweeper(t.ctx, store, sweeperOptions);
    const [swept, resumed] = await Promise.allSettled([
      sweeper.sweep(new Date(Date.now() + 2 * 60 * 60 * 1000)),
      t.client.sendDirect("answers", {
        token: deferred.token,
        result: { approved: true },
      }),
    ]);

    const record = await store.get(deferred.deferralId);
    expect(swept.status).toBe("fulfilled");

    // Asserted symmetrically rather than against the winner this ordering
    // happens to produce. Which of the two transitions lands first is a
    // scheduling detail; that exactly one of them lands, and that the other
    // reports it, is the contract. The resume-wins side is forced
    // deterministically by the test below.
    if (record?.outcome?.kind === "resumed") {
      expect(swept.status === "fulfilled" && swept.value).toBe(0);
      expect(expiredEvents).toHaveLength(0);
      expect(reasked).toHaveLength(0);
      expect(continued).toHaveLength(1);
      expect(resumed.status).toBe("fulfilled");
      expect(record.continuation?.status).toBe("completed");
    } else {
      expect(record?.outcome?.kind).toBe("expired");
      expect(swept.status === "fulfilled" && swept.value).toBe(1);
      expect(expiredEvents).toHaveLength(1);
      expect(reasked).toHaveLength(1);
      expect(continued).toHaveLength(0);
      expect(resumed.status).toBe("rejected");
      expect(
        resumed.status === "rejected" && (resumed.reason as { rc?: string }).rc,
      ).toBe("RC5047");
    }
  });

  /**
   * @case An answer that claims the deferral while the sweep is mid-transition
   * @preconditions A store that holds the sweep inside its expiry claim until the resume has won markResumed
   * @expectedResult The sweep retires nothing, emits no expiry and does not re-ask, while the continuation runs once. The sweeper losing must be silent: telling the route to re-ask for an approval that was accepted would notify an approver about work already in flight, and the route would raise a second deferral for an operation that is being carried out
   */
  test("a sweep that loses to an answer neither expires nor re-asks", async () => {
    const backing = new MemoryDeferralStore();
    const continued: unknown[] = [];
    const reasked: unknown[] = [];
    const expiredEvents: unknown[] = [];

    let sweepIsAtTheTransition: () => void = () => {};
    const reachedTransition = new Promise<void>((resolve) => {
      sweepIsAtTheTransition = resolve;
    });
    let releaseSweep: () => void = () => {};
    const answered = new Promise<void>((resolve) => {
      releaseSweep = resolve;
    });

    const store = storeWith(backing, {
      claimExpiry: async (
        id: string,
        at: Date,
      ): Promise<DeferralClaimResult> => {
        sweepIsAtTheTransition();
        await answered;
        return backing.claimExpiry(id, at);
      },
    });

    t = await testContext()
      .with(deferringWith(store))
      .on(
        "route:exchange:expired" as EventName,
        ((payload: { details: unknown }) => {
          expiredEvents.push(payload.details);
        }) as never,
      )
      .routes([
        craft()
          .id("payout")
          .error((err) => {
            reasked.push(err);
            return { reasked: true };
          })
          .from(direct())
          .defer({ schema: Approval, ttl: "1h" })
          .tap((ex) => {
            continued.push(ex.body);
          })
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const deferred = asDeferred(
      await t.client.sendDirect("payout", { amountCents: 1, payee: "acme" }),
    );

    const sweeper = new ContinuationSweeper(t.ctx, store, sweeperOptions);
    const sweeping = sweeper.sweep(new Date(Date.now() + 2 * 60 * 60 * 1000));
    await reachedTransition;

    const acknowledgment = (await t.client.sendDirect("answers", {
      token: deferred.token,
      result: { approved: true },
    })) as { status: string; continuation: { status: string } };
    releaseSweep();

    expect(await sweeping).toBe(0);
    expect(acknowledgment.status).toBe("resumed");
    expect(acknowledgment.continuation.status).toBe("completed");
    expect(continued).toHaveLength(1);
    expect(expiredEvents).toHaveLength(0);
    expect(reasked).toHaveLength(0);
    expect((await store.get(deferred.deferralId))?.outcome?.kind).toBe(
      "resumed",
    );
  });

  /**
   * @case More overdue records than one page holds
   * @preconditions 150 records past their deadline, against a batch size of 100
   * @expectedResult All 150 retire across multiple pages, and progress is logged between them. The backlog after an outage is unbounded and each retirement runs a route's error handler, so a sweep that loaded it in one query would be the one query that fails on the deployment that most needs it
   */
  test("pages through a backlog larger than one batch", async () => {
    const store = new MemoryDeferralStore();
    const reasked: unknown[] = [];

    t = await testContext()
      .with(deferringWith(store))
      .routes([
        craft()
          .id("payout")
          .error((err) => {
            reasked.push(err);
            return { reasked: true };
          })
          .from(direct())
          .defer({ schema: Approval })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    for (let index = 0; index < 150; index++) {
      await store.create(overdue(`def-${index}`));
    }

    const sweeper = new ContinuationSweeper(t.ctx, store, sweeperOptions);
    expect(await sweeper.sweep()).toBe(150);

    expect(reasked).toHaveLength(150);
    expect(
      said(t.contextLogger.info.mock.calls, "Still retiring expired deferrals"),
    ).toBeDefined();
    expect(await store.findExpired(new Date(), 100)).toHaveLength(0);
  });

  /**
   * @case A route whose error handler throws while the sweep is retiring its deferral
   * @preconditions Three overdue records on a route whose .error() throws
   * @expectedResult All three still retire, and each re-ask is reported failed. The sweep is the only thing that will ever visit these records, so one route's broken handler stranding the rest would leave them deferred with nothing left to notice them
   */
  test("a throwing error handler does not strand the rest of the batch", async () => {
    const store = new MemoryDeferralStore();
    const attempted: string[] = [];
    const failures: unknown[] = [];

    t = await testContext()
      .with(deferringWith(store))
      .on(
        "route:exchange:failed" as EventName,
        ((payload: { details: { routeId: string } }) => {
          if (payload.details.routeId === "payout") failures.push(payload);
        }) as never,
      )
      .routes([
        craft()
          .id("payout")
          .error((_err, ex) => {
            attempted.push(String(ex.body));
            throw new Error("the escalation webhook is down");
          })
          .from(direct())
          .defer({ schema: Approval })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    for (const id of ["def-a", "def-b", "def-c"]) {
      await store.create(overdue(id));
    }

    const sweeper = new ContinuationSweeper(t.ctx, store, sweeperOptions);
    expect(await sweeper.sweep()).toBe(3);

    for (const id of ["def-a", "def-b", "def-c"]) {
      expect((await store.get(id))?.outcome?.kind).toBe("expired");
    }
    // Non-vacuous: the handler ran for all three and threw every time, so
    // the batch survived a failing re-ask rather than never reaching one.
    expect(attempted).toHaveLength(3);
    expect(failures).toHaveLength(3);
  });

  /**
   * @case A store that refuses the transition for one record
   * @preconditions Three overdue records, against a store whose markExpired throws for the middle one
   * @expectedResult The other two retire and the failure is logged against the record that caused it. A backend hiccup on one row must cost one row, not the pass
   */
  test("a store error on one record does not stop the pass", async () => {
    const backing = new MemoryDeferralStore();
    const store = storeWith(backing, {
      claimExpiry: (id: string, at: Date): Promise<DeferralClaimResult> =>
        id === "def-b"
          ? Promise.reject(new Error("the database went away"))
          : backing.claimExpiry(id, at),
    });

    t = await testContext()
      .with(deferringWith(store))
      .routes([
        craft()
          .id("payout")
          .error(() => ({ reasked: true }))
          .from(direct())
          .defer({ schema: Approval })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    for (const id of ["def-a", "def-b", "def-c"]) {
      await store.create(overdue(id));
    }

    const sweeper = new ContinuationSweeper(t.ctx, store, sweeperOptions);
    expect(await sweeper.sweep()).toBe(2);

    expect((await store.get("def-a"))?.outcome?.kind).toBe("expired");
    expect((await store.get("def-b"))?.state).toBe("waiting");
    expect((await store.get("def-c"))?.outcome?.kind).toBe("expired");
    const failedRetirement = said(
      t.contextLogger.error.mock.calls,
      "Failed to retire",
    );
    expect(failedRetirement?.[0]).toMatchObject({ deferralId: "def-b" });
  });

  /**
   * @case An overdue record belonging to a route this context does not have
   * @preconditions One record for a route id no route in the context declares
   * @expectedResult It is left deferred, and the warning names both likely causes. Retiring it here would consume the record with nobody able to run its error channel, so the deployment that owns the route could never notify
   */
  test("leaves a record whose route this context does not have", async () => {
    const store = new MemoryDeferralStore();

    t = await testContext()
      .with(deferringWith(store))
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .defer({ schema: Approval })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    await store.create(overdue("def-ghost", { routeId: "retired-route" }));

    const sweeper = new ContinuationSweeper(t.ctx, store, sweeperOptions);
    expect(await sweeper.sweep()).toBe(0);

    expect((await store.get("def-ghost"))?.state).toBe("waiting");
    const missingRoute = said(
      t.contextLogger.warn.mock.calls,
      "which this context does not have",
    );
    expect(missingRoute?.[0]).toMatchObject({ routeId: "retired-route" });
  });

  /**
   * @case A full page of records the sweep cannot retire, with retirable work behind them
   * @preconditions 100 records for an absent route, all older than one record for a route the context does have
   * @expectedResult The sweep terminates and still retires the one it can. Records it cannot retire stay deferred and therefore return at the head of every page, so a sweep that asked for the same page each round would re-read them forever and never reach what sits behind them
   */
  test("does not spin on a page of records it cannot retire", async () => {
    const store = new MemoryDeferralStore();

    t = await testContext()
      .with(deferringWith(store))
      .routes([
        craft()
          .id("payout")
          .error(() => ({ reasked: true }))
          .from(direct())
          .defer({ schema: Approval })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    const now = Date.now();
    for (let index = 0; index < 100; index++) {
      await store.create(
        overdue(`ghost-${index}`, {
          routeId: "retired-route",
          expiresAt: new Date(now - 60_000),
        }),
      );
    }
    await store.create(
      overdue("def-live", { expiresAt: new Date(now - 1_000) }),
    );

    // Raced against a timer rather than left to the runner's timeout: the
    // failure mode is a sweep that never returns, and a test that hangs
    // stalls the suite instead of reporting which assertion broke.
    const sweeper = new ContinuationSweeper(t.ctx, store, sweeperOptions);
    const outcome = await Promise.race([
      sweeper.sweep(),
      sleep(5_000).then(() => "did not terminate" as const),
    ]);

    expect(outcome).toBe(1);
    expect((await store.get("def-live"))?.outcome?.kind).toBe("expired");
    expect((await store.get("ghost-0"))?.state).toBe("waiting");
  }, 10_000);

  /**
   * @case A restart with deferrals that came due while the process was down
   * @preconditions Two overdue records already in the store when the context starts
   * @expectedResult They have retired by the time the context reports ready, with no sleep in the test. The scan is awaited by the plugin's start hook precisely so an operator gets the escalations before the new traffic, in the order they would have arrived had the process stayed up
   */
  test("retires downtime expiries before the context is ready", async () => {
    const store = new MemoryDeferralStore();
    const reasked: unknown[] = [];
    await store.create(overdue("def-a"));
    await store.create(overdue("def-b"));

    t = await testContext()
      .with(deferringWith(store))
      .routes([
        craft()
          .id("payout")
          .error((err) => {
            reasked.push(err);
            return { reasked: true };
          })
          .from(direct())
          .defer({ schema: Approval })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    expect((await store.get("def-a"))?.outcome?.kind).toBe("expired");
    expect((await store.get("def-b"))?.outcome?.kind).toBe("expired");
    expect(reasked).toHaveLength(2);
    const startupScan = said(
      t.contextLogger.info.mock.calls,
      "Deferral store scanned",
    );
    expect(startupScan?.[0]).toMatchObject({ retiredOnStart: 2 });
  });

  /**
   * @case A record left resumed with no continuation result by a crash
   * @preconditions A deferral marked resumed, with no continuation recorded, present at startup
   * @expectedResult The boot summary counts it and the warning says nothing will retry it. A resume wins its transition before the continuation runs, so this record has spent its approval and half applied its side effects: reporting it is the only safe response, and it is the first moment anyone could learn it exists
   */
  test("reports crash residue in the startup summary", async () => {
    const store = new MemoryDeferralStore();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure to omit
    const { expiresAt, ...noDeadline } = overdue("def-stranded");
    await store.create(noDeadline);
    await store.markResumed("def-stranded", { at: new Date() });

    t = await testContext()
      .with(deferringWith(store))
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .defer({ schema: Approval })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    const startupScan = said(
      t.contextLogger.info.mock.calls,
      "Deferral store scanned",
    );
    expect(startupScan?.[0]).toMatchObject({ stranded: 1 });
    expect(
      said(t.contextLogger.warn.mock.calls, "nothing will retry them"),
    ).toBeDefined();
    expect((await store.get("def-stranded"))?.outcome?.kind).toBe("resumed");
  });

  /**
   * @case A defer that names no ttl, in a context configuring one
   * @preconditions deferral: { defaultTtl: "30m" } and .defer() with no ttl
   * @expectedResult The record carries a deadline half an hour out. Without a default, omitting ttl defers an exchange nothing will ever retire, which is the state the sweeper exists to prevent accumulating
   */
  test("applies the configured default ttl to a defer that names none", async () => {
    const store = new MemoryDeferralStore();

    t = await testContext()
      .with(deferringWith(store, { defaultTtl: "30m" }))
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .defer({ schema: Approval })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    const deferred = asDeferred(
      await t.client.sendDirect("payout", { amountCents: 1, payee: "acme" }),
    );
    const record = await store.get(deferred.deferralId);
    const expiresAt = record?.expiresAt?.getTime() ?? 0;

    expect(expiresAt - Date.now()).toBeGreaterThan(29 * 60_000);
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(30 * 60_000);
  });

  /**
   * @case A context opting out of default expiry
   * @preconditions deferral: { defaultTtl: "never" } and .defer() with no ttl
   * @expectedResult The record has no deadline and the sweep will not see it. This is the escape hatch for a deployment whose approvals legitimately have no horizon, and it has to be explicit because the default now expires
   */
  test("defers with no deadline when the default ttl is never", async () => {
    const store = new MemoryDeferralStore();

    t = await testContext()
      .with(deferringWith(store, { defaultTtl: "never" }))
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .defer({ schema: Approval })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    const deferred = asDeferred(
      await t.client.sendDirect("payout", { amountCents: 1, payee: "acme" }),
    );

    expect(deferred.expiresAt).toBeUndefined();
    expect((await store.get(deferred.deferralId))?.expiresAt).toBeUndefined();
    expect(
      await store.findExpired(new Date(Date.now() + 365 * 86_400_000), 100),
    ).toHaveLength(0);
  });

  /**
   * @case A record coming due while the context is running
   * @preconditions deferral: { sweepInterval: "20ms" } and an overdue record written after startup
   * @expectedResult It retires without anything driving the sweep by hand. The interval is the only thing that notices a deadline reached mid-run, since nobody presents a token for a deferral that timed out
   */
  test("retires a record that comes due while the context runs", async () => {
    const store = new MemoryDeferralStore();

    t = await testContext()
      .with(deferringWith(store, { sweepInterval: "20ms" }))
      .routes([
        craft()
          .id("payout")
          .error(() => ({ reasked: true }))
          .from(direct())
          .defer({ schema: Approval })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    await store.create(overdue("def-late"));
    for (let attempt = 0; attempt < 40; attempt++) {
      if ((await store.get("def-late"))?.outcome?.kind === "expired") break;
      await sleep(10);
    }

    expect((await store.get("def-late"))?.outcome?.kind).toBe("expired");
  });

  /**
   * @case Shutdown arriving while a sweep is mid-batch
   * @preconditions A store whose close() records when it ran, and a sweep held open inside markExpired until after teardown has begun
   * @expectedResult stop() resolves only after the sweep finishes, so a store the plugin opened closes after it. A sweep outliving teardown meets a closed handle, and a retirement that already won its transition re-enters a drained route: the record settles expired with its approver never told, and nothing revisits it
   */
  test("teardown waits for a sweep already in flight", async () => {
    const backing = new MemoryDeferralStore();
    const order: string[] = [];
    let releaseSweep: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      releaseSweep = resolve;
    });
    let sweepReached: () => void = () => {};
    const reachedTransition = new Promise<void>((resolve) => {
      sweepReached = resolve;
    });

    const store = storeWith(backing, {
      markExpired: async (
        id: string,
        claimId: DeferralClaimId,
      ): Promise<DeferralCasResult> => {
        sweepReached();
        await held;
        order.push("sweep finished");
        return backing.markExpired(id, claimId);
      },
      close: async () => {
        order.push("store closed");
        await backing.close();
      },
    });

    const context = (t = await testContext()
      .with(deferringWith(store, { sweepInterval: "20ms" }))
      .routes([
        craft()
          .id("payout")
          .error(() => ({ reasked: true }))
          .from(direct())
          .defer({ schema: Approval })
          .to(noop()),
      ])
      .build());
    await context.startAndWaitReady();

    // The store is supplied, so the plugin leaves closing it to the test:
    // stop() resolving is where the awaited sweep becomes observable, and
    // the plugin closes a store it opened only after that same await.
    await store.create(overdue("def-mid-sweep"));
    await reachedTransition;
    const stopping = context.stop();
    releaseSweep();
    await stopping;
    order.push("stop resolved");
    await store.close();

    expect(order).toEqual(["sweep finished", "stop resolved", "store closed"]);
  });

  /**
   * @case Shutdown beginning while a record is due
   * @preconditions A short sweep interval and an overdue record, with stop() called after the record is written
   * @expectedResult No retirement lands once shutdown has begun. Routes are aborted and drained before plugins are torn down, so a claim taken in that window settles the record expired while the route that should notify the approver can no longer run
   */
  test("claims nothing once shutdown has begun", async () => {
    const store = new MemoryDeferralStore();
    const reasked: unknown[] = [];

    const context = (t = await testContext()
      .with(deferringWith(store, { sweepInterval: "20ms" }))
      .routes([
        craft()
          .id("payout")
          .error((err) => {
            reasked.push(err);
            return { reasked: true };
          })
          .from(direct())
          .defer({ schema: Approval })
          .to(noop()),
      ])
      .build());
    await context.startAndWaitReady();

    // Written only after shutdown has begun, so no interval tick can race
    // the record before the stopping guard is what this test observes.
    const stopping = context.stop();
    await store.create(overdue("def-at-shutdown"));
    await stopping;
    // Well past several sweep intervals: nothing may claim it after this.
    await sleep(100);

    expect((await store.get("def-at-shutdown"))?.state).toBe("waiting");
    expect(reasked).toHaveLength(0);
    await store.close();
  });

  /**
   * @case A context that has been stopped
   * @preconditions A short sweep interval, and an overdue record written after teardown
   * @expectedResult No sweep runs. An interval outliving its context would sweep against a store whose handle is closed, and would re-enter the error channel of routes that are no longer running
   */
  test("stops sweeping once the context is torn down", async () => {
    const store = new MemoryDeferralStore();

    const context = (t = await testContext()
      .with(deferringWith(store, { sweepInterval: "20ms" }))
      .routes([
        craft()
          .id("payout")
          .error(() => ({ reasked: true }))
          .from(direct())
          .defer({ schema: Approval })
          .to(noop()),
      ])
      .build());
    await context.startAndWaitReady();
    await context.stop();

    await store.create(overdue("def-after-stop"));
    await sleep(100);

    expect((await store.get("def-after-stop"))?.state).toBe("waiting");
    await store.close();
  });

  /**
   * @case A claim whose holder died is redelivered after its lease
   * @preconditions A record left expiring with a stale claim, in a context whose route can re-ask
   * @expectedResult The sweep releases it back to deferred and the same pass retires it, so the approver hears about the expiry despite the crash. Without the lease the record would sit in a state nothing looks at, stranded with zero operator signal
   */
  test("redelivers a claim whose deliverer died", async () => {
    const store = new MemoryDeferralStore();
    const reasked: unknown[] = [];

    t = await testContext()
      .with(deferringWith(store))
      .routes([
        craft()
          .id("payout")
          .error((err) => {
            reasked.push(err);
            return { reasked: true };
          })
          .from(direct())
          .defer({ schema: Approval })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    // A crash mid-delivery: claimed two hours ago, never finalized.
    await store.create(overdue("def-crashed"));
    await store.claimExpiry(
      "def-crashed",
      new Date(Date.now() - 2 * 60 * 60 * 1000),
    );

    const sweeper = new ContinuationSweeper(t.ctx, store, sweeperOptions);
    expect(await sweeper.sweep()).toBe(1);

    expect((await store.get("def-crashed"))?.outcome?.kind).toBe("expired");
    expect(reasked).toHaveLength(1);
  });

  /**
   * @case A fresh claim is honoured, not stolen
   * @preconditions A record claimed a moment ago, within the lease
   * @expectedResult The sweep leaves it expiring and retires nothing. A lease shorter than a slow error handler would make one healthy process double-deliver by itself, which is why the release only takes stale claims
   */
  test("leaves a claim still within its lease alone", async () => {
    const store = new MemoryDeferralStore();

    t = await testContext()
      .with(deferringWith(store))
      .routes([
        craft()
          .id("payout")
          .error(() => ({ reasked: true }))
          .from(direct())
          .defer({ schema: Approval })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    await store.create(overdue("def-claimed"));
    await store.claimExpiry("def-claimed", new Date());

    const sweeper = new ContinuationSweeper(t.ctx, store, sweeperOptions);
    expect(await sweeper.sweep()).toBe(0);

    const claimed = await store.get("def-claimed");
    expect(claimed?.state).toBe("waiting");
    expect(claimed?.claim).toBeDefined();
    expect(claimed?.outcome).toBeUndefined();
  });

  /**
   * @case A delivery that outlives the lease, with its claimant alive
   * @preconditions A record whose re-ask stalls inside the route's error handler for several leases, under a sweeper with a 120ms lease; a second sweeper over the same store passes while the stall holds
   * @expectedResult The second pass releases nothing and retires nothing, the stalled delivery finalizes as the live claim when it ends, and the route heard exactly one re-ask. The claimant renews its claim while the handler runs, so a slow handler is not mistaken for a dead process; before the heartbeat the only defence was a lease longer than the slowest handler, which is a guess
   */
  test("a live delivery past the lease is not redelivered", async () => {
    const store = new MemoryDeferralStore();
    const reasked: unknown[] = [];
    const stall = gate();

    t = await testContext()
      .with(deferringWith(store))
      .routes([
        craft()
          .id("payout")
          .error(async (err) => {
            reasked.push(err);
            // Only the first delivery stalls, so a regression shows up as a
            // second re-ask rather than as a hung suite.
            if (reasked.length === 1) await stall.opened;
            return { reasked: true };
          })
          .from(direct())
          .defer({ schema: Approval })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    await store.create(overdue("def-slow"));
    const lease = { intervalMs: 60_000, leaseMs: 120 };
    const slow = new ContinuationSweeper(t.ctx, store, lease);
    const delivering = slow.sweep();
    await waitFor(() => reasked.length === 1);
    const claim = (await store.get("def-slow"))?.claim;
    expect(claim).toBeDefined();

    // Two and a half leases: without renewal the claim is long gone.
    await sleep(300);
    const other = new ContinuationSweeper(t.ctx, store, lease);
    expect(await other.sweep()).toBe(0);
    const held = await store.get("def-slow");
    expect(held?.state).toBe("waiting");
    expect(held?.claim?.id).toBe(claim?.id);
    expect(held?.claim?.renewedAt.getTime()).toBeGreaterThan(
      claim!.at.getTime(),
    );
    expect(reasked).toHaveLength(1);

    stall.open();
    expect(await delivering).toBe(1);
    expect((await store.get("def-slow"))?.outcome?.kind).toBe("expired");
    expect(reasked).toHaveLength(1);
    expect(
      said(t.contextLogger.warn.mock.calls, "claim was released"),
    ).toBeUndefined();
    expect(
      said(t.contextLogger.warn.mock.calls, "claim was lost"),
    ).toBeUndefined();
  });

  /**
   * @case A renewal still in flight when its delivery settles
   * @preconditions A 30ms lease whose first renewal reaches the store only after the test releases it; the re-ask returns as soon as that renewal has started, the delivery finalizes, and the held renewal then runs against the settled record and loses
   * @expectedResult The record settles as expired through the live claim, and no "claim was lost" warning is logged: the renewal's loss is the finalize that just won, not a lost claim, and warning about it after a correct finalize sends an operator looking for a duplicate re-ask that never happened
   */
  test("a renewal that loses after the delivery settled does not warn", async () => {
    const backing = new MemoryDeferralStore();
    const renewalStarted = gate();
    const renewalReleased = gate();
    let renewalSettled = false;

    const store = storeWith(backing, {
      renewClaim: async (id, claimId, at) => {
        renewalStarted.open();
        await renewalReleased.opened;
        const result = await backing.renewClaim(id, claimId, at);
        renewalSettled = true;
        return result;
      },
    });

    t = await testContext()
      .with(deferringWith(backing))
      .routes([
        craft()
          .id("payout")
          .error(async () => {
            await renewalStarted.opened;
            return { reasked: true };
          })
          .from(direct())
          .defer({ schema: Approval })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    await backing.create(overdue("def-late"));
    const sweeper = new ContinuationSweeper(t.ctx, store, { leaseMs: 30 });
    expect(await sweeper.sweep()).toBe(1);
    expect((await backing.get("def-late"))?.outcome?.kind).toBe("expired");

    renewalReleased.open();
    await waitFor(() => renewalSettled);
    await sleep(5);
    expect(
      said(t.contextLogger.warn.mock.calls, "claim was lost"),
    ).toBeUndefined();
  });

  /**
   * @case A claimant that died mid-delivery
   * @preconditions A record claimed now and never renewed, as a process that crashed after claiming leaves it; sweeps driven at half a lease, one lease, and two leases later
   * @expectedResult Nothing happens inside the lease; at the lease the claim is released and the record redelivered and settled; after that nothing happens again. One repeat per lease period for a dead claimant is the at-least-once trade the lease exists for, and the second idle pass pins that the repeat is one, not one per pass
   */
  test("a dead claimant is redelivered exactly once, at the lease", async () => {
    const store = new MemoryDeferralStore();
    const reasked: unknown[] = [];

    t = await testContext()
      .with(deferringWith(store))
      .routes([
        craft()
          .id("payout")
          .error((err) => {
            reasked.push(err);
            return { reasked: true };
          })
          .from(direct())
          .defer({ schema: Approval })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    await store.create(overdue("def-dead"));
    const now = Date.now();
    const dead = await store.claimExpiry("def-dead", new Date(now));
    expect(dead.won).toBe(true);

    const lease = sweeperOptions.leaseMs;
    const sweeper = new ContinuationSweeper(t.ctx, store, sweeperOptions);

    expect(await sweeper.sweep(new Date(now + lease / 2))).toBe(0);
    expect(reasked).toHaveLength(0);
    expect((await store.get("def-dead"))?.claim?.id).toBe(dead.claim?.id);

    expect(await sweeper.sweep(new Date(now + lease + 1))).toBe(1);
    expect(reasked).toHaveLength(1);
    const settled = await store.get("def-dead");
    expect(settled?.outcome?.kind).toBe("expired");
    expect(settled?.claim?.id).not.toBe(dead.claim?.id);

    expect(await sweeper.sweep(new Date(now + 2 * lease + 1))).toBe(0);
    expect(reasked).toHaveLength(1);
  });

  /**
   * @case A claimant whose heartbeats stop and that wakes while its replacement is still delivering
   * @preconditions Claimant A's renewals never reach the store (a paused process, a partition) while its re-ask stalls; its lease elapses and claimant B releases the claim, reclaims the record and starts its own re-ask, which also stalls; A's re-ask then completes and A finalizes with the claim it won while B is mid-delivery
   * @expectedResult A's finalize is refused and logged, and the record stays waiting under B's claim, which B then settles. From where A stands the record looks exactly as it left it, waiting and claimed, so only the claim's identity can refuse it; without the fence A would settle a delivery B is still making, and a crash of B after that would be a lost re-ask nothing revisits. The route heard two re-asks, the accepted duplicate for a claimant the store had to presume dead, and never a third
   */
  test("a stale claimant cannot finalize the delivery that replaced it", async () => {
    const backing = new MemoryDeferralStore();
    const reasked: unknown[] = [];
    const stalls = [gate(), gate()];

    t = await testContext()
      .with(deferringWith(backing))
      .routes([
        craft()
          .id("payout")
          .error(async (err) => {
            reasked.push(err);
            await stalls[reasked.length - 1]?.opened;
            return { reasked: true };
          })
          .from(direct())
          .defer({ schema: Approval })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    await backing.create(overdue("def-aba"));
    const lease = { intervalMs: 60_000, leaseMs: 120 };
    // A's heartbeats hang forever; everything else reaches the store.
    const partitioned = storeWith(backing, {
      renewClaim: () => new Promise<DeferralCasResult>(() => {}),
    });
    const a = new ContinuationSweeper(t.ctx, partitioned, lease);
    const deliveringA = a.sweep();
    await waitFor(() => reasked.length === 1);
    const claimOfA = (await backing.get("def-aba"))?.claim;
    expect(claimOfA).toBeDefined();

    await sleep(300);
    const b = new ContinuationSweeper(t.ctx, backing, lease);
    const deliveringB = b.sweep();
    await waitFor(() => reasked.length === 2);
    const claimOfB = (await backing.get("def-aba"))?.claim;
    expect(claimOfB?.id).not.toBe(claimOfA?.id);

    // A wakes while B is mid-delivery: the record is waiting and claimed,
    // exactly as A left it.
    stalls[0]!.open();
    await deliveringA;
    const underB = await backing.get("def-aba");
    expect(underB?.state).toBe("waiting");
    expect(underB?.outcome).toBeUndefined();
    expect(underB?.claim?.id).toBe(claimOfB?.id);
    expect(
      said(
        t.contextLogger.warn.mock.calls,
        "released before its delivery finalized",
      ),
    ).toBeDefined();

    stalls[1]!.open();
    expect(await deliveringB).toBe(1);
    const settled = await backing.get("def-aba");
    expect(settled?.outcome?.kind).toBe("expired");
    expect(settled?.claim?.id).toBe(claimOfB?.id);

    expect(await b.sweep()).toBe(0);
    expect(reasked).toHaveLength(2);
  });

  /**
   * @case The load-bearing joint: an answer meeting a claimed or released record
   * @preconditions One deferred exchange whose record is put through claim, then release, with answers presented at each stage
   * @expectedResult A token presented while the record is expiring reads RC5047, and after the flip-back the answer is still refused because the record is past its deadline. The flip-back is only safe because both reads refuse; if either accepted, a crash window would let a dead approval run
   */
  test("an answer is refused while expiring and after the flip-back", async () => {
    const store = new MemoryDeferralStore();
    const continued: unknown[] = [];

    t = await testContext()
      .with(deferringWith(store))
      .routes([
        craft()
          .id("payout")
          .error(() => ({ reasked: true }))
          .from(direct())
          .defer({ schema: Approval, ttl: "1ms" })
          .tap((ex) => {
            continued.push(ex.body);
          })
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const deferred = asDeferred(
      await t.client.sendDirect("payout", { amountCents: 1, payee: "acme" }),
    );
    await sleep(5);

    // Stage one: mid-delivery. The claim is held elsewhere.
    await store.claimExpiry(deferred.deferralId, new Date());
    await expect(
      t.client.sendDirect("answers", {
        token: deferred.token,
        result: { approved: true },
      }),
    ).rejects.toMatchObject({ rc: "RC5047" });

    // Stage two: the deliverer died and the lease released the claim. The
    // record is deferred again, but past its deadline, so the lazy check
    // refuses the answer rather than reviving dead work.
    await store.releaseClaims(new Date(Date.now() + 1));
    expect((await store.get(deferred.deferralId))?.state).toBe("waiting");
    await expect(
      t.client.sendDirect("answers", {
        token: deferred.token,
        result: { approved: true },
      }),
    ).rejects.toMatchObject({ rc: "RC5047" });

    expect(continued).toHaveLength(0);
  });

  /**
   * @case An answer meeting a denial claim mid-delivery
   * @preconditions A record with a far-future deadline moved to expiring, as refuseContinuation does while its re-ask is in flight
   * @expectedResult RC5050, not RC5047. An expiry claim is only ever taken on an overdue record, so a claim on a live deadline is a denial being delivered, and telling the answerer their approval timed out would misreport a route change as their lateness
   */
  test("a claim on a live deadline reads as denied, not expired", async () => {
    const store = new MemoryDeferralStore();

    t = await testContext()
      .with(deferringWith(store))
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .defer({ schema: Approval, ttl: "1h" })
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const deferred = asDeferred(
      await t.client.sendDirect("payout", { amountCents: 1, payee: "acme" }),
    );
    await store.claimExpiry(deferred.deferralId, new Date());

    await expect(
      t.client.sendDirect("answers", {
        token: deferred.token,
        result: { approved: true },
      }),
    ).rejects.toMatchObject({ rc: "RC5050" });
  });

  /**
   * @case Settled records past retention are purged by the boot scan
   * @preconditions A record settled 100 days ago and one settled yesterday, with the default retention
   * @expectedResult Only the old one is purged, at startup, with nothing else driving it. Settled records hold a full serialized exchange each and nothing else ever removes one
   */
  test("purges settled records past retention at boot", async () => {
    const store = new MemoryDeferralStore();
    const day = 24 * 60 * 60 * 1000;
    // Settled via markResumed because its resumption time is the one
    // controllable settlement clock; retention measures the outcome, so a
    // record merely DEFERRED 100 days ago would rightly be kept.
    await store.create(
      overdue("def-ancient", { deferredAt: new Date(Date.now() - 100 * day) }),
    );
    await store.markResumed("def-ancient", {
      at: new Date(Date.now() - 100 * day),
    });
    await store.create(
      overdue("def-recent", {
        deferredAt: new Date(Date.now() - day),
        expiresAt: new Date(Date.now() + day),
      }),
    );
    const recent = await store.claimExpiry("def-recent", new Date());
    if (!recent.won) throw new Error("the test's own claim lost");
    await store.markExpired("def-recent", recent.claim.id);

    t = await testContext()
      .with(deferringWith(store))
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .defer({ schema: Approval })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    expect(await store.get("def-ancient")).toBeUndefined();
    expect(await store.get("def-recent")).toBeDefined();
  });

  /**
   * @case An audit deployment opts out of retention
   * @preconditions retention: "never" and a record settled 100 days ago
   * @expectedResult The boot scan leaves it in place. Keep-everything is a legitimate configuration and has to be explicit now that the default purges
   */
  test("retention never keeps settled records forever", async () => {
    const store = new MemoryDeferralStore();
    const day = 24 * 60 * 60 * 1000;
    await store.create(
      overdue("def-ancient", { deferredAt: new Date(Date.now() - 100 * day) }),
    );
    await store.markResumed("def-ancient", {
      at: new Date(Date.now() - 100 * day),
    });

    t = await testContext()
      .with(deferringWith(store, { retention: "never" }))
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .defer({ schema: Approval })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    expect(await store.get("def-ancient")).toBeDefined();
  });
});
