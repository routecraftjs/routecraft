import { afterEach, describe, expect, test } from "bun:test";
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
          .debounce({ waitMs: 10_000 })
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
          .debounce({ waitMs: 40 })
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
          .debounce({ waitMs: 40 })
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
          .debounce({ waitMs: 10_000, key: (ex) => ex.body.path })
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
          .debounce({ waitMs: 50, maxWaitMs: 100 })
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
          .debounce({ waitMs: 10_000 })
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
          .debounce({ waitMs: 10_000 })
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
   * @case debounce rejects a non-positive waitMs at build time
   * @preconditions A route built with .debounce({ waitMs: 0 })
   * @expectedResult Building throws (RC5003)
   */
  test("rejects a non-positive waitMs at build time", () => {
    expect(() =>
      craft()
        .id("debounce-bad-wait")
        .from(items<Change>([change("a", 1)]))
        .debounce({ waitMs: 0 })
        .build(),
    ).toThrow();
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
        .debounce({ waitMs: 500, maxWaitMs: 100 })
        .build(),
    ).toThrow();
  });
});
