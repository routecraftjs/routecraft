import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  MemorySuspensionStore,
  SUSPENSION_RUNTIME,
  craft,
  direct,
  noop,
  type CraftConfig,
  type CraftContext,
  type EventName,
  type NewSuspension,
  type SuspensionCasResult,
  type SuspensionStore,
} from "../src/index.ts";
import { SuspensionSweeper } from "../src/suspension/sweeper.ts";
import { asSuspended, storeWith } from "./helpers/suspension.ts";

const Approval = z.object({ approved: z.boolean() });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Directly driven sweepers in these tests never tick or purge on cadence. */
const sweeperOptions = { intervalMs: 60_000, leaseMs: 60 * 60 * 1000 };

/**
 * A config whose suspension runtime is a store the test holds a handle on.
 *
 * The handle is the point: the sweeper is driven by records, and a test that
 * cannot write a record whose deadline is already in the past can only test
 * expiry by sleeping through it.
 */
function suspendingWith(
  store: SuspensionStore,
  extra: Record<string, unknown> = {},
): CraftConfig {
  return { suspension: { store, ...extra } } as CraftConfig;
}

/**
 * A record that came due a second ago, written straight to the store.
 *
 * Synthetic rather than parked through a route because the sweeper never
 * reads the continuation: it marks the record and re-enters the route's
 * error channel with the rehydrated exchange. What matters here is the
 * deadline and the route id, and going through a real park would mean
 * sleeping out a real ttl once per record.
 */
function overdue(
  id: string,
  overrides: Partial<NewSuspension> = {},
): NewSuspension {
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
    suspendedAt: new Date(now - 60_000),
    expiresAt: new Date(now - 1_000),
    ...overrides,
  };
}

interface LogLine {
  readonly bindings: Record<string, unknown>;
  readonly message: string;
}

type CapturedLogs = Record<"info" | "warn" | "error", LogLine[]>;

/**
 * Record the context logger's output.
 *
 * The sweeper reports through `context.logger` rather than a route logger,
 * so the spy logger the harness installs for route-scoped assertions does
 * not see it.
 */
function captureLogs(context: CraftContext): CapturedLogs {
  const lines: CapturedLogs = { info: [], warn: [], error: [] };
  for (const level of ["info", "warn", "error"] as const) {
    context.logger[level] = ((
      bindings: Record<string, unknown>,
      message: string,
    ) => {
      lines[level].push({ bindings, message });
    }) as unknown as (typeof context.logger)[typeof level];
  }
  return lines;
}

const said = (lines: LogLine[], fragment: string): LogLine | undefined =>
  lines.find((line) => line.message.includes(fragment));

/**
 * The expiry sweeper.
 *
 * A `ttl` exists so a route can react when nobody answers, and nobody is
 * ever going to present a token for a suspension that timed out. Without
 * something firing on a schedule the deadline is decoration: the escalation
 * flow it exists for never runs. These pin the two properties that make the
 * sweep safe to run against a live store, which is that it never decides an
 * outcome another party has already decided, and that no single bad record
 * can stop it reaching the rest.
 */
describe("the suspension sweeper", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case A suspension answered at the same moment the sweep retires it
   * @preconditions One parked exchange; the sweep is handed a `now` past its deadline while the answer arrives before it, so both transitions are live at once
   * @expectedResult Exactly one of them wins, and the loser reports the winner's outcome rather than its own. Two winners would mean an approver told their answer was accepted while the route was told to re-ask, and the notification the transition gates would be sent twice
   */
  test("a resume racing the sweep produces exactly one outcome", async () => {
    const store = new MemorySuspensionStore();
    const continued: unknown[] = [];
    const reasked: unknown[] = [];
    const expiredEvents: unknown[] = [];

    t = await testContext()
      .with(suspendingWith(store))
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
          .suspend({ schema: Approval, ttl: "1h" })
          .tap((ex) => {
            continued.push(ex.body);
          })
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(
      await t.client.sendDirect("payout", { amountCents: 1, payee: "acme" }),
    );

    // The sweep is told it is two hours from now, so it sees the record as
    // due while the resume, running on the real clock, sees it as live. Both
    // transitions are therefore in flight against one record, which is the
    // race a deadline reached mid-answer produces in production.
    const sweeper = new SuspensionSweeper(t.ctx, store, sweeperOptions);
    const [swept, resumed] = await Promise.allSettled([
      sweeper.sweep(new Date(Date.now() + 2 * 60 * 60 * 1000)),
      t.client.sendDirect("answers", {
        token: parked.token,
        result: { approved: true },
      }),
    ]);

    const record = await store.get(parked.suspensionId);
    expect(swept.status).toBe("fulfilled");

    // Asserted symmetrically rather than against the winner this ordering
    // happens to produce. Which of the two transitions lands first is a
    // scheduling detail; that exactly one of them lands, and that the other
    // reports it, is the contract. The resume-wins side is forced
    // deterministically by the test below.
    if (record?.status === "resumed") {
      expect(swept.status === "fulfilled" && swept.value).toBe(0);
      expect(expiredEvents).toHaveLength(0);
      expect(reasked).toHaveLength(0);
      expect(continued).toHaveLength(1);
      expect(resumed.status).toBe("fulfilled");
      expect(record.terminal?.status).toBe("completed");
    } else {
      expect(record?.status).toBe("expired");
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
   * @case An answer that claims the suspension while the sweep is mid-transition
   * @preconditions A store that holds the sweep inside its expiry claim until the resume has won markResumed
   * @expectedResult The sweep retires nothing, emits no expiry and does not re-ask, while the continuation runs once. The sweeper losing must be silent: telling the route to re-ask for an approval that was accepted would notify an approver about work already in flight, and the route would raise a second suspension for an operation that is being carried out
   */
  test("a sweep that loses to an answer neither expires nor re-asks", async () => {
    const backing = new MemorySuspensionStore();
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
      ): Promise<SuspensionCasResult> => {
        sweepIsAtTheTransition();
        await answered;
        return backing.claimExpiry(id, at);
      },
    });

    t = await testContext()
      .with(suspendingWith(store))
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
          .suspend({ schema: Approval, ttl: "1h" })
          .tap((ex) => {
            continued.push(ex.body);
          })
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(
      await t.client.sendDirect("payout", { amountCents: 1, payee: "acme" }),
    );

    const sweeper = new SuspensionSweeper(t.ctx, store, sweeperOptions);
    const sweeping = sweeper.sweep(new Date(Date.now() + 2 * 60 * 60 * 1000));
    await reachedTransition;

    const acknowledgment = (await t.client.sendDirect("answers", {
      token: parked.token,
      result: { approved: true },
    })) as { status: string; outcome: { status: string } };
    releaseSweep();

    expect(await sweeping).toBe(0);
    expect(acknowledgment.status).toBe("resumed");
    expect(acknowledgment.outcome.status).toBe("completed");
    expect(continued).toHaveLength(1);
    expect(expiredEvents).toHaveLength(0);
    expect(reasked).toHaveLength(0);
    expect((await store.get(parked.suspensionId))?.status).toBe("resumed");
  });

  /**
   * @case More overdue records than one page holds
   * @preconditions 150 records past their deadline, against a batch size of 100
   * @expectedResult All 150 retire across multiple pages, and progress is logged between them. The backlog after an outage is unbounded and each retirement runs a route's error handler, so a sweep that loaded it in one query would be the one query that fails on the deployment that most needs it
   */
  test("pages through a backlog larger than one batch", async () => {
    const store = new MemorySuspensionStore();
    const reasked: unknown[] = [];

    t = await testContext()
      .with(suspendingWith(store))
      .routes([
        craft()
          .id("payout")
          .error((err) => {
            reasked.push(err);
            return { reasked: true };
          })
          .from(direct())
          .suspend({ schema: Approval })
          .to(noop()),
      ])
      .build();
    const logs = captureLogs(t.ctx);
    await t.startAndWaitReady();

    for (let index = 0; index < 150; index++) {
      await store.create(overdue(`sus-${index}`));
    }

    const sweeper = new SuspensionSweeper(t.ctx, store, sweeperOptions);
    expect(await sweeper.sweep()).toBe(150);

    expect(reasked).toHaveLength(150);
    expect(said(logs.info, "Still retiring expired suspensions")).toBeDefined();
    expect(await store.findExpired(new Date(), 100)).toHaveLength(0);
  });

  /**
   * @case A route whose error handler throws while the sweep is retiring its suspension
   * @preconditions Three overdue records on a route whose .error() throws
   * @expectedResult All three still retire, and each re-ask is reported failed. The sweep is the only thing that will ever visit these records, so one route's broken handler stranding the rest would leave them parked with nothing left to notice them
   */
  test("a throwing error handler does not strand the rest of the batch", async () => {
    const store = new MemorySuspensionStore();
    const attempted: string[] = [];
    const failures: unknown[] = [];

    t = await testContext()
      .with(suspendingWith(store))
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
          .suspend({ schema: Approval })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    for (const id of ["sus-a", "sus-b", "sus-c"]) {
      await store.create(overdue(id));
    }

    const sweeper = new SuspensionSweeper(t.ctx, store, sweeperOptions);
    expect(await sweeper.sweep()).toBe(3);

    for (const id of ["sus-a", "sus-b", "sus-c"]) {
      expect((await store.get(id))?.status).toBe("expired");
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
    const backing = new MemorySuspensionStore();
    const store = storeWith(backing, {
      claimExpiry: (id: string, at: Date): Promise<SuspensionCasResult> =>
        id === "sus-b"
          ? Promise.reject(new Error("the database went away"))
          : backing.claimExpiry(id, at),
    });

    t = await testContext()
      .with(suspendingWith(store))
      .routes([
        craft()
          .id("payout")
          .error(() => ({ reasked: true }))
          .from(direct())
          .suspend({ schema: Approval })
          .to(noop()),
      ])
      .build();
    const logs = captureLogs(t.ctx);
    await t.startAndWaitReady();

    for (const id of ["sus-a", "sus-b", "sus-c"]) {
      await store.create(overdue(id));
    }

    const sweeper = new SuspensionSweeper(t.ctx, store, sweeperOptions);
    expect(await sweeper.sweep()).toBe(2);

    expect((await store.get("sus-a"))?.status).toBe("expired");
    expect((await store.get("sus-b"))?.status).toBe("suspended");
    expect((await store.get("sus-c"))?.status).toBe("expired");
    expect(said(logs.error, "Failed to retire")?.bindings).toMatchObject({
      suspensionId: "sus-b",
    });
  });

  /**
   * @case An overdue record belonging to a route this context does not have
   * @preconditions One record for a route id no route in the context declares
   * @expectedResult It is left suspended, and the warning names both likely causes. Retiring it here would consume the record with nobody able to run its error channel, so the deployment that owns the route could never notify
   */
  test("leaves a record whose route this context does not have", async () => {
    const store = new MemorySuspensionStore();

    t = await testContext()
      .with(suspendingWith(store))
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .suspend({ schema: Approval })
          .to(noop()),
      ])
      .build();
    const logs = captureLogs(t.ctx);
    await t.startAndWaitReady();

    await store.create(overdue("sus-ghost", { routeId: "retired-route" }));

    const sweeper = new SuspensionSweeper(t.ctx, store, sweeperOptions);
    expect(await sweeper.sweep()).toBe(0);

    expect((await store.get("sus-ghost"))?.status).toBe("suspended");
    expect(
      said(logs.warn, "which this context does not have")?.bindings,
    ).toMatchObject({ routeId: "retired-route" });
  });

  /**
   * @case A full page of records the sweep cannot retire, with retirable work behind them
   * @preconditions 100 records for an absent route, all older than one record for a route the context does have
   * @expectedResult The sweep terminates and still retires the one it can. Records it cannot retire stay suspended and therefore return at the head of every page, so a sweep that asked for the same page each round would re-read them forever and never reach what sits behind them
   */
  test("does not spin on a page of records it cannot retire", async () => {
    const store = new MemorySuspensionStore();

    t = await testContext()
      .with(suspendingWith(store))
      .routes([
        craft()
          .id("payout")
          .error(() => ({ reasked: true }))
          .from(direct())
          .suspend({ schema: Approval })
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
      overdue("sus-live", { expiresAt: new Date(now - 1_000) }),
    );

    // Raced against a timer rather than left to the runner's timeout: the
    // failure mode is a sweep that never returns, and a test that hangs
    // stalls the suite instead of reporting which assertion broke.
    const sweeper = new SuspensionSweeper(t.ctx, store, sweeperOptions);
    const outcome = await Promise.race([
      sweeper.sweep(),
      sleep(5_000).then(() => "did not terminate" as const),
    ]);

    expect(outcome).toBe(1);
    expect((await store.get("sus-live"))?.status).toBe("expired");
    expect((await store.get("ghost-0"))?.status).toBe("suspended");
  }, 10_000);

  /**
   * @case A restart with suspensions that came due while the process was down
   * @preconditions Two overdue records already in the store when the context starts
   * @expectedResult They have retired by the time the context reports ready, with no sleep in the test. The scan is awaited by the plugin's start hook precisely so an operator gets the escalations before the new traffic, in the order they would have arrived had the process stayed up
   */
  test("retires downtime expiries before the context is ready", async () => {
    const store = new MemorySuspensionStore();
    const reasked: unknown[] = [];
    await store.create(overdue("sus-a"));
    await store.create(overdue("sus-b"));

    t = await testContext()
      .with(suspendingWith(store))
      .routes([
        craft()
          .id("payout")
          .error((err) => {
            reasked.push(err);
            return { reasked: true };
          })
          .from(direct())
          .suspend({ schema: Approval })
          .to(noop()),
      ])
      .build();
    const logs = captureLogs(t.ctx);
    await t.startAndWaitReady();

    expect((await store.get("sus-a"))?.status).toBe("expired");
    expect((await store.get("sus-b"))?.status).toBe("expired");
    expect(reasked).toHaveLength(2);
    expect(said(logs.info, "Suspension store scanned")?.bindings).toMatchObject(
      { retiredOnStart: 2 },
    );
  });

  /**
   * @case A record left resumed with no terminal outcome by a crash
   * @preconditions A suspension marked resumed, with no terminal recorded, present at startup
   * @expectedResult The boot summary counts it and the warning says nothing will retry it. A resume wins its transition before the continuation runs, so this record has spent its approval and half applied its side effects: reporting it is the only safe response, and it is the first moment anyone could learn it exists
   */
  test("reports crash residue in the startup summary", async () => {
    const store = new MemorySuspensionStore();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure to omit
    const { expiresAt, ...noDeadline } = overdue("sus-stranded");
    await store.create(noDeadline);
    await store.markResumed("sus-stranded", { at: new Date() });

    t = await testContext()
      .with(suspendingWith(store))
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .suspend({ schema: Approval })
          .to(noop()),
      ])
      .build();
    const logs = captureLogs(t.ctx);
    await t.startAndWaitReady();

    expect(said(logs.info, "Suspension store scanned")?.bindings).toMatchObject(
      { stranded: 1 },
    );
    expect(said(logs.warn, "nothing will retry them")).toBeDefined();
    expect((await store.get("sus-stranded"))?.status).toBe("resumed");
  });

  /**
   * @case A suspend that names no ttl, in a context configuring one
   * @preconditions suspension: { defaultTtl: "30m" } and .suspend() with no ttl
   * @expectedResult The record carries a deadline half an hour out. Without a default, omitting ttl parks an exchange nothing will ever retire, which is the state the sweeper exists to prevent accumulating
   */
  test("applies the configured default ttl to a suspend that names none", async () => {
    const store = new MemorySuspensionStore();

    t = await testContext()
      .with(suspendingWith(store, { defaultTtl: "30m" }))
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .suspend({ schema: Approval })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(
      await t.client.sendDirect("payout", { amountCents: 1, payee: "acme" }),
    );
    const record = await store.get(parked.suspensionId);
    const expiresAt = record?.expiresAt?.getTime() ?? 0;

    expect(expiresAt - Date.now()).toBeGreaterThan(29 * 60_000);
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(30 * 60_000);
  });

  /**
   * @case A context opting out of default expiry
   * @preconditions suspension: { defaultTtl: "never" } and .suspend() with no ttl
   * @expectedResult The record has no deadline and the sweep will not see it. This is the escape hatch for a deployment whose approvals legitimately have no horizon, and it has to be explicit because the default now expires
   */
  test("parks with no deadline when the default ttl is never", async () => {
    const store = new MemorySuspensionStore();

    t = await testContext()
      .with(suspendingWith(store, { defaultTtl: "never" }))
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .suspend({ schema: Approval })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(
      await t.client.sendDirect("payout", { amountCents: 1, payee: "acme" }),
    );

    expect(parked.expiresAt).toBeUndefined();
    expect((await store.get(parked.suspensionId))?.expiresAt).toBeUndefined();
    expect(
      await store.findExpired(new Date(Date.now() + 365 * 86_400_000), 100),
    ).toHaveLength(0);
  });

  /**
   * @case A record coming due while the context is running
   * @preconditions suspension: { sweepInterval: "20ms" } and an overdue record written after startup
   * @expectedResult It retires without anything driving the sweep by hand. The interval is the only thing that notices a deadline reached mid-run, since nobody presents a token for a suspension that timed out
   */
  test("retires a record that comes due while the context runs", async () => {
    const store = new MemorySuspensionStore();

    t = await testContext()
      .with(suspendingWith(store, { sweepInterval: "20ms" }))
      .routes([
        craft()
          .id("payout")
          .error(() => ({ reasked: true }))
          .from(direct())
          .suspend({ schema: Approval })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    await store.create(overdue("sus-late"));
    for (let attempt = 0; attempt < 40; attempt++) {
      if ((await store.get("sus-late"))?.status === "expired") break;
      await sleep(10);
    }

    expect((await store.get("sus-late"))?.status).toBe("expired");
  });

  /**
   * @case Shutdown arriving while a sweep is mid-batch
   * @preconditions A store whose close() records when it ran, and a sweep held open inside markExpired until after teardown has begun
   * @expectedResult The store closes only after the sweep finishes. A sweep outliving teardown meets a closed handle, and a retirement that already won its transition re-enters a drained route: the record settles expired with its approver never told, and nothing revisits it
   */
  test("teardown waits for a sweep already in flight", async () => {
    const backing = new MemorySuspensionStore();
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
      markExpired: async (id: string) => {
        sweepReached();
        await held;
        order.push("sweep finished");
        return backing.markExpired(id);
      },
      close: async () => {
        order.push("store closed");
        await backing.close();
      },
    });

    const context = (t = await testContext()
      .with(suspendingWith(store, { sweepInterval: "20ms" }))
      .routes([
        craft()
          .id("payout")
          .error(() => ({ reasked: true }))
          .from(direct())
          .suspend({ schema: Approval })
          .to(noop()),
      ])
      .build());
    await context.startAndWaitReady();

    // The store is supplied, so the plugin does not own it and would not
    // close it. Owning it is what makes the ordering observable, and it is
    // the shape a real deployment has.
    const runtime = context.ctx.getStore(SUSPENSION_RUNTIME);
    (runtime as { ownsStore: boolean }).ownsStore = true;

    await store.create(overdue("sus-mid-sweep"));
    await reachedTransition;
    const stopping = context.stop();
    releaseSweep();
    await stopping;

    expect(order).toEqual(["sweep finished", "store closed"]);
  });

  /**
   * @case Shutdown beginning while a record is due
   * @preconditions A short sweep interval and an overdue record, with stop() called after the record is written
   * @expectedResult No retirement lands once shutdown has begun. Routes are aborted and drained before plugins are torn down, so a claim taken in that window settles the record expired while the route that should notify the approver can no longer run
   */
  test("claims nothing once shutdown has begun", async () => {
    const store = new MemorySuspensionStore();
    const reasked: unknown[] = [];

    const context = (t = await testContext()
      .with(suspendingWith(store, { sweepInterval: "20ms" }))
      .routes([
        craft()
          .id("payout")
          .error((err) => {
            reasked.push(err);
            return { reasked: true };
          })
          .from(direct())
          .suspend({ schema: Approval })
          .to(noop()),
      ])
      .build());
    await context.startAndWaitReady();

    // Written only after shutdown has begun, so no interval tick can race
    // the record before the stopping guard is what this test observes.
    const stopping = context.stop();
    await store.create(overdue("sus-at-shutdown"));
    await stopping;
    // Well past several sweep intervals: nothing may claim it after this.
    await sleep(100);

    expect((await store.get("sus-at-shutdown"))?.status).toBe("suspended");
    expect(reasked).toHaveLength(0);
    await store.close();
  });

  /**
   * @case A context that has been stopped
   * @preconditions A short sweep interval, and an overdue record written after teardown
   * @expectedResult No sweep runs. An interval outliving its context would sweep against a store whose handle is closed, and would re-enter the error channel of routes that are no longer running
   */
  test("stops sweeping once the context is torn down", async () => {
    const store = new MemorySuspensionStore();

    const context = (t = await testContext()
      .with(suspendingWith(store, { sweepInterval: "20ms" }))
      .routes([
        craft()
          .id("payout")
          .error(() => ({ reasked: true }))
          .from(direct())
          .suspend({ schema: Approval })
          .to(noop()),
      ])
      .build());
    await context.startAndWaitReady();
    await context.stop();

    await store.create(overdue("sus-after-stop"));
    await sleep(100);

    expect((await store.get("sus-after-stop"))?.status).toBe("suspended");
    await store.close();
  });

  /**
   * @case A claim whose holder died is redelivered after its lease
   * @preconditions A record left expiring with a stale claim, in a context whose route can re-ask
   * @expectedResult The sweep releases it back to suspended and the same pass retires it, so the approver hears about the expiry despite the crash. Without the lease the record would sit in a state nothing looks at, stranded with zero operator signal
   */
  test("redelivers a claim whose deliverer died", async () => {
    const store = new MemorySuspensionStore();
    const reasked: unknown[] = [];

    t = await testContext()
      .with(suspendingWith(store))
      .routes([
        craft()
          .id("payout")
          .error((err) => {
            reasked.push(err);
            return { reasked: true };
          })
          .from(direct())
          .suspend({ schema: Approval })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    // A crash mid-delivery: claimed two hours ago, never finalized.
    await store.create(overdue("sus-crashed"));
    await store.claimExpiry(
      "sus-crashed",
      new Date(Date.now() - 2 * 60 * 60 * 1000),
    );

    const sweeper = new SuspensionSweeper(t.ctx, store, sweeperOptions);
    expect(await sweeper.sweep()).toBe(1);

    expect((await store.get("sus-crashed"))?.status).toBe("expired");
    expect(reasked).toHaveLength(1);
  });

  /**
   * @case A fresh claim is honoured, not stolen
   * @preconditions A record claimed a moment ago, within the lease
   * @expectedResult The sweep leaves it expiring and retires nothing. A lease shorter than a slow error handler would make one healthy process double-deliver by itself, which is why the release only takes stale claims
   */
  test("leaves a claim still within its lease alone", async () => {
    const store = new MemorySuspensionStore();

    t = await testContext()
      .with(suspendingWith(store))
      .routes([
        craft()
          .id("payout")
          .error(() => ({ reasked: true }))
          .from(direct())
          .suspend({ schema: Approval })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    await store.create(overdue("sus-claimed"));
    await store.claimExpiry("sus-claimed", new Date());

    const sweeper = new SuspensionSweeper(t.ctx, store, sweeperOptions);
    expect(await sweeper.sweep()).toBe(0);

    expect((await store.get("sus-claimed"))?.status).toBe("expiring");
  });

  /**
   * @case The load-bearing joint: an answer meeting a claimed or released record
   * @preconditions One parked exchange whose record is put through claim, then release, with answers presented at each stage
   * @expectedResult A token presented while the record is expiring reads RC5047, and after the flip-back the answer is still refused because the record is past its deadline. The flip-back is only safe because both reads refuse; if either accepted, a crash window would let a dead approval run
   */
  test("an answer is refused while expiring and after the flip-back", async () => {
    const store = new MemorySuspensionStore();
    const continued: unknown[] = [];

    t = await testContext()
      .with(suspendingWith(store))
      .routes([
        craft()
          .id("payout")
          .error(() => ({ reasked: true }))
          .from(direct())
          .suspend({ schema: Approval, ttl: "1ms" })
          .tap((ex) => {
            continued.push(ex.body);
          })
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(
      await t.client.sendDirect("payout", { amountCents: 1, payee: "acme" }),
    );
    await sleep(5);

    // Stage one: mid-delivery. The claim is held elsewhere.
    await store.claimExpiry(parked.suspensionId, new Date());
    await expect(
      t.client.sendDirect("answers", {
        token: parked.token,
        result: { approved: true },
      }),
    ).rejects.toMatchObject({ rc: "RC5047" });

    // Stage two: the deliverer died and the lease released the claim. The
    // record is suspended again, but past its deadline, so the lazy check
    // refuses the answer rather than reviving dead work.
    await store.releaseExpiring(new Date(Date.now() + 1));
    expect((await store.get(parked.suspensionId))?.status).toBe("suspended");
    await expect(
      t.client.sendDirect("answers", {
        token: parked.token,
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
    const store = new MemorySuspensionStore();

    t = await testContext()
      .with(suspendingWith(store))
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .suspend({ schema: Approval, ttl: "1h" })
          .to(noop()),
        craft().id("answers").from(direct()).resume(),
      ])
      .build();
    await t.startAndWaitReady();

    const parked = asSuspended(
      await t.client.sendDirect("payout", { amountCents: 1, payee: "acme" }),
    );
    await store.claimExpiry(parked.suspensionId, new Date());

    await expect(
      t.client.sendDirect("answers", {
        token: parked.token,
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
    const store = new MemorySuspensionStore();
    const day = 24 * 60 * 60 * 1000;
    await store.create(
      overdue("sus-ancient", { suspendedAt: new Date(Date.now() - 100 * day) }),
    );
    await store.claimExpiry("sus-ancient", new Date());
    await store.markExpired("sus-ancient");
    await store.create(
      overdue("sus-recent", {
        suspendedAt: new Date(Date.now() - day),
        expiresAt: new Date(Date.now() + day),
      }),
    );
    await store.claimExpiry("sus-recent", new Date());
    await store.markExpired("sus-recent");

    t = await testContext()
      .with(suspendingWith(store))
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .suspend({ schema: Approval })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    expect(await store.get("sus-ancient")).toBeUndefined();
    expect(await store.get("sus-recent")).toBeDefined();
  });

  /**
   * @case An audit deployment opts out of retention
   * @preconditions retention: "never" and a record settled 100 days ago
   * @expectedResult The boot scan leaves it in place. Keep-everything is a legitimate configuration and has to be explicit now that the default purges
   */
  test("retention never keeps settled records forever", async () => {
    const store = new MemorySuspensionStore();
    const day = 24 * 60 * 60 * 1000;
    await store.create(
      overdue("sus-ancient", { suspendedAt: new Date(Date.now() - 100 * day) }),
    );
    await store.claimExpiry("sus-ancient", new Date());
    await store.markExpired("sus-ancient");

    t = await testContext()
      .with(suspendingWith(store, { retention: "never" }))
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .suspend({ schema: Approval })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    expect(await store.get("sus-ancient")).toBeDefined();
  });
});
