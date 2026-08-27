import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import { craft, type Source } from "@routecraft/routecraft";

type Change = { path: string; rev: number };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Emits each item in `list` as its own exchange, rapidly (no gaps). */
function items<T>(list: T[]): Source<T> {
  return {
    subscribe: async (sub) => {
      for (const item of list) {
        await sub.emit({ message: item });
      }
    },
  };
}

/**
 * Emits according to a script of items and quiet gaps, so a test can shape a
 * burst and let the debounce window elapse between bursts. Runs during the
 * source's subscribe, which `start()` awaits.
 */
function feed<T>(script: Array<{ item: T } | { gap: number }>): Source<T> {
  return {
    subscribe: async (sub) => {
      for (const step of script) {
        if ("gap" in step) await sleep(step.gap);
        else await sub.emit({ message: step.item });
      }
    },
  };
}

/** Poll until `predicate` holds or the timeout elapses. */
async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitUntil timed out");
    }
    await sleep(5);
  }
}

const change = (path: string, rev: number): Change => ({ path, rev });

describe("debounce operation", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) {
      await t.stop();
    }
  });

  /**
   * @case A burst collapses to the last exchange; earlier ones are dropped
   * @preconditions Three rapid arrivals through .debounce({ waitMs }) with a long window; drain flushes the pending hold
   * @expectedResult Only the last exchange reaches downstream; three held events, two dropped, one released
   */
  test("collapses a burst to the last exchange", async () => {
    const downstream = spy<Change>();
    const held: string[] = [];
    const dropped: string[] = [];
    const released: string[] = [];

    t = await testContext()
      .routes(
        craft()
          .id("debounce-collapse")
          // A long window so nothing releases on its own; drain flushes it.
          .from(items<Change>([change("a", 1), change("a", 2), change("a", 3)]))
          .debounce({ wait: 10_000 })
          .to(downstream),
      )
      .on("route:operation:debounce:held", (() => {
        held.push("h");
      }) as never)
      .on("route:operation:debounce:dropped", (() => {
        dropped.push("d");
      }) as never)
      .on("route:operation:debounce:released", (() => {
        released.push("r");
      }) as never)
      .build();

    await t.ctx.start();
    // Ensure all three arrivals are held before flushing, so the collapse is
    // deterministic (no timer/flush race).
    await waitUntil(() => held.length === 3);
    await t.drain();

    expect(downstream.received).toHaveLength(1);
    expect(downstream.received[0].body).toEqual({ path: "a", rev: 3 });
    expect(held).toHaveLength(3);
    expect(dropped).toHaveLength(2);
    expect(released).toHaveLength(1);
  });

  /**
   * @case The held exchange is released after the quiet window elapses
   * @preconditions A single arrival through .debounce({ waitMs: 40 }); no further activity
   * @expectedResult The exchange reaches downstream via a "quiet" release without needing drain
   */
  test("releases the trailing exchange after the quiet window", async () => {
    const downstream = spy<Change>();
    let releaseReason: string | undefined;

    t = await testContext()
      .routes(
        craft()
          .id("debounce-quiet")
          // A trailing gap keeps the source open past the quiet window, so the
          // timer (not the auto-stop flush) is what releases the exchange.
          .from(feed<Change>([{ item: change("a", 1) }, { gap: 200 }]))
          .debounce({ wait: 40 })
          .to(downstream),
      )
      .on("route:operation:debounce:released", ((payload: {
        details: { reason: string };
      }) => {
        releaseReason = payload.details.reason;
      }) as never)
      .build();

    await t.ctx.start();
    await waitUntil(() => downstream.received.length === 1);

    expect(downstream.received[0].body).toEqual({ path: "a", rev: 1 });
    expect(releaseReason).toBe("quiet");
  });

  /**
   * @case Separate bursts (a quiet gap between them) each release
   * @preconditions One arrival, a gap longer than waitMs, then another arrival
   * @expectedResult Both exchanges reach downstream, in order
   */
  test("separate bursts each release", async () => {
    const downstream = spy<Change>();

    t = await testContext()
      .routes(
        craft()
          .id("debounce-bursts")
          .from(
            feed<Change>([
              { item: change("a", 1) },
              { gap: 120 },
              { item: change("b", 1) },
            ]),
          )
          .debounce({ wait: 40 })
          .to(downstream),
      )
      .build();

    await t.ctx.start();
    await waitUntil(() => downstream.received.length === 2);

    expect(downstream.received.map((e) => e.body.path)).toEqual(["a", "b"]);
  });

  /**
   * @case `key` debounces independently per group
   * @preconditions Arrivals for paths a, b, a through a keyed debounce; drain flushes
   * @expectedResult a collapses to its last arrival and b passes through: downstream sees two exchanges
   */
  test("key debounces independently per group", async () => {
    const downstream = spy<Change>();
    const held: string[] = [];

    t = await testContext()
      .routes(
        craft()
          .id("debounce-keyed")
          .from(items<Change>([change("a", 1), change("b", 1), change("a", 2)]))
          .debounce({ wait: 10_000, key: (ex) => ex.body.path })
          .to(downstream),
      )
      .on("route:operation:debounce:held", (() => {
        held.push("h");
      }) as never)
      .build();

    await t.ctx.start();
    await waitUntil(() => held.length === 3);
    await t.drain();

    const byPath = downstream.received
      .map((e) => e.body)
      .sort((x, y) => x.path.localeCompare(y.path));
    expect(byPath).toEqual([
      { path: "a", rev: 2 },
      { path: "b", rev: 1 },
    ]);
  });

  /**
   * @case `maxWaitMs` forces a release under continuous activity
   * @preconditions Arrivals every 20ms for ~200ms with waitMs longer than the gap and a short maxWaitMs cap
   * @expectedResult At least one release fires with reason "maxWait" (the quiet window never closes during activity)
   */
  test("maxWaitMs releases under continuous activity", async () => {
    const downstream = spy<Change>();
    const reasons: string[] = [];

    const stream: Array<{ item: Change } | { gap: number }> = [];
    for (let i = 0; i < 12; i++) {
      stream.push({ item: change("a", i) });
      stream.push({ gap: 20 });
    }

    t = await testContext()
      .routes(
        craft()
          .id("debounce-maxwait")
          // Arrivals every 20ms keep resetting the 50ms quiet window so it
          // never closes during activity; only the 100ms maxWaitMs cap
          // (measured from the burst start, never reset) can release.
          .from(feed<Change>(stream))
          .debounce({ wait: 50, maxWait: 100 })
          .to(downstream),
      )
      .on("route:operation:debounce:released", ((payload: {
        details: { reason: string };
      }) => {
        reasons.push(payload.details.reason);
      }) as never)
      .build();

    await t.ctx.start();
    await waitUntil(() => reasons.includes("maxWait"));

    expect(reasons).toContain("maxWait");
    expect(downstream.received.length).toBeGreaterThanOrEqual(1);
  });

  /**
   * @case A pending exchange is flushed on drain()
   * @preconditions A single arrival held under a long window; drain() called before the window elapses
   * @expectedResult The held exchange is released with reason "flush" and reaches downstream
   */
  test("flushes a pending exchange on drain", async () => {
    const downstream = spy<Change>();
    let releaseReason: string | undefined;
    const held: string[] = [];

    t = await testContext()
      .routes(
        craft()
          .id("debounce-flush")
          .from(items<Change>([change("a", 1)]))
          .debounce({ wait: 10_000 })
          .to(downstream),
      )
      .on("route:operation:debounce:held", (() => {
        held.push("h");
      }) as never)
      .on("route:operation:debounce:released", ((payload: {
        details: { reason: string };
      }) => {
        releaseReason = payload.details.reason;
      }) as never)
      .build();

    await t.ctx.start();
    await waitUntil(() => held.length === 1);
    await t.drain();

    expect(downstream.received).toHaveLength(1);
    expect(downstream.received[0].body).toEqual({ path: "a", rev: 1 });
    expect(releaseReason).toBe("flush");
  });

  /**
   * @case The released exchange still runs the steps after debounce
   * @preconditions A .process() and a .to() follow .debounce(); a single arrival is flushed
   * @expectedResult The downstream sees the processed body, proving the release re-runs the downstream continuation
   */
  test("the released exchange runs the downstream steps", async () => {
    const downstream = spy<{ path: string; rev: number; reloaded: true }>();
    const held: string[] = [];

    t = await testContext()
      .routes(
        craft()
          .id("debounce-downstream")
          .from(items<Change>([change("a", 1)]))
          .debounce({ wait: 10_000 })
          .transform((body) => ({ ...body, reloaded: true as const }))
          .to(downstream),
      )
      .on("route:operation:debounce:held", (() => {
        held.push("h");
      }) as never)
      .build();

    await t.ctx.start();
    await waitUntil(() => held.length === 1);
    await t.drain();

    expect(downstream.received).toHaveLength(1);
    expect(downstream.received[0].body).toEqual({
      path: "a",
      rev: 1,
      reloaded: true,
    });
  });

  /**
   * @case Every arrival's exchange id gets a terminal event (balanced lifecycle)
   * @preconditions A burst of three arrivals held under a long window, then drained
   * @expectedResult Three route:exchange:dropped events fire with reason "debounced" (two superseded + the absorbed trailing arrival at release), so no arrival is left permanently in-flight
   */
  test("balances every arrival's lifecycle with a terminal dropped event", async () => {
    const downstream = spy<Change>();
    const held: string[] = [];
    const droppedReasons: string[] = [];

    t = await testContext()
      .routes(
        craft()
          .id("debounce-lifecycle-balance")
          .from(items<Change>([change("a", 1), change("a", 2), change("a", 3)]))
          .debounce({ wait: 10_000 })
          .to(downstream),
      )
      .on("route:operation:debounce:held", (() => {
        held.push("h");
      }) as never)
      .on("route:exchange:dropped", ((payload: {
        details: { reason: string };
      }) => {
        droppedReasons.push(payload.details.reason);
      }) as never)
      .build();

    await t.ctx.start();
    await waitUntil(() => held.length === 3);
    await t.drain();

    // All three arrivals terminate: two superseded plus the absorbed trailing
    // arrival, dropped at release time. The released clone (a fresh id)
    // completes separately, carried by the downstream delivery.
    expect(droppedReasons).toEqual(["debounced", "debounced", "debounced"]);
    expect(downstream.received).toHaveLength(1);
  });

  /**
   * @case The route-scope .error() handler covers a released exchange's downstream failure
   * @preconditions A route-scope .error() before .from(); the step after .debounce() throws; the hold is flushed by drain
   * @expectedResult The handler is invoked exactly once for the released run (the release is the route's primary flow, unlike a fan-out clone)
   */
  test("route-scope error handler covers the released exchange", async () => {
    let handled = 0;

    t = await testContext()
      .routes(
        craft()
          .id("debounce-error-handler")
          .error(() => {
            handled += 1;
            return "recovered";
          })
          .from(items<Change>([change("a", 1)]))
          .debounce({ wait: 10_000 })
          .to({
            send: async () => {
              throw new Error("downstream boom");
            },
          }),
      )
      .build();

    await t.ctx.start();
    await t.drain();

    expect(handled).toBe(1);
  });

  /**
   * @case .output() schemas are enforced on the released exchange
   * @preconditions Route declares .output({ body }); the post-debounce transform produces an invalid body; the hold is flushed by drain
   * @expectedResult The released exchange fails output validation (route:exchange:failed) instead of completing with an invalid body
   */
  test("output validation is enforced on the released exchange", async () => {
    const downstream = spy<{ ok: unknown }>();
    let failedCount = 0;
    let completedCount = 0;

    t = await testContext()
      .routes(
        craft()
          .id("debounce-output-validation")
          .output({ body: z.object({ ok: z.boolean() }) })
          .from(items<{ ok: boolean }>([{ ok: true }]))
          .debounce({ wait: 10_000 })
          .transform(() => ({ ok: "not-a-boolean" }))
          .to(downstream),
      )
      .on("route:exchange:failed", (() => {
        failedCount += 1;
      }) as never)
      .on("route:exchange:completed", (() => {
        completedCount += 1;
      }) as never)
      .build();

    await t.ctx.start();
    await t.drain();

    // The pipeline ran (the destination saw the invalid body), but the
    // released exchange failed output validation instead of completing.
    expect(downstream.received).toHaveLength(1);
    expect(failedCount).toBe(1);
    expect(completedCount).toBe(0);
  });

  /**
   * @case A non-cloneable held body fails the release cleanly instead of crashing
   * @preconditions The held body carries a function (not structured-cloneable); the hold is flushed by drain
   * @expectedResult route:exchange:failed fires for the held arrival, drain completes (no hang), and nothing reaches downstream
   */
  test("a non-cloneable body fails the release cleanly", async () => {
    type WithFn = { run: () => void };
    const downstream = spy<WithFn>();
    let failedCount = 0;
    const held: string[] = [];

    t = await testContext()
      .routes(
        craft()
          .id("debounce-nonclonable")
          .from(items<WithFn>([{ run: () => undefined }]))
          .debounce({ wait: 10_000 })
          .to(downstream),
      )
      .on("route:operation:debounce:held", (() => {
        held.push("h");
      }) as never)
      .on("route:exchange:failed", (() => {
        failedCount += 1;
      }) as never)
      .build();

    await t.ctx.start();
    await waitUntil(() => held.length === 1);
    // Must complete (settle is guaranteed) rather than hang on the tracked
    // promise; the clone failure surfaces as a failed exchange, not a crash.
    await t.drain();

    expect(failedCount).toBe(1);
    expect(downstream.received).toHaveLength(0);
  });

  /**
   * @case Step-scope wrappers refuse to wrap debounce at build time
   * @preconditions A route staging .retry() immediately before .debounce()
   * @expectedResult Building throws (RC5003): debounce holds exchanges outside the queue, so per-execution wrapper recovery cannot apply
   */
  test("rejects a step-scope wrapper around debounce at build time", () => {
    expect(() =>
      craft()
        .id("debounce-not-wrappable")
        .from(items<Change>([change("a", 1)]))
        .retry()
        .debounce({ wait: 100 })
        .build(),
    ).toThrow();
  });

  /**
   * @case debounce rejects a non-positive waitMs at build time
   * @preconditions A route built with .debounce({ waitMs: 0 })
   * @expectedResult Building throws (RC5003)
   */
  test("rejects a non-positive waitMs at build time", () => {
    expect(() =>
      craft()
        .id("debounce-bad-wait")
        .from(items<Change>([change("a", 1)]))
        .debounce({ wait: 0 })
        .build(),
    ).toThrow();
  });

  /**
   * @case debounce rejects a non-function key at build time
   * @preconditions A route built with .debounce({ waitMs: 100, key: "path" }) from a JS caller
   * @expectedResult Building throws (RC5003) instead of a per-exchange TypeError at runtime
   */
  test("rejects a non-function key at build time", () => {
    expect(() =>
      craft()
        .id("debounce-bad-key")
        .from(items<Change>([change("a", 1)]))
        .debounce({ wait: 100, key: "path" as never })
        .build(),
    ).toThrow(/must be a function/);
  });

  /**
   * @case debounce rejects a maxWaitMs smaller than waitMs
   * @preconditions A route built with .debounce({ waitMs: 500, maxWaitMs: 100 })
   * @expectedResult Building throws (RC5003): the cap must not fire before the window
   */
  test("rejects maxWaitMs smaller than waitMs", () => {
    expect(() =>
      craft()
        .id("debounce-bad-maxwait")
        .from(items<Change>([change("a", 1)]))
        .debounce({ wait: 500, maxWait: 100 })
        .build(),
    ).toThrow();
  });
});
