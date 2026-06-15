import { afterEach, describe, expect, test } from "bun:test";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import {
  craft,
  direct,
  simple,
  SampleStep,
  RoutecraftError,
  type SampleOptions,
} from "@routecraft/routecraft";

/** Sleep for `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send through a direct route, tolerating the `RC5031` that a request/reply
 * caller sees when the route drops the exchange (a sampled-out exchange has
 * no response body). Any other failure propagates.
 */
async function send(
  t: TestContext,
  routeId: string,
  body: unknown,
): Promise<void> {
  try {
    await t.client.sendDirect(routeId, body);
  } catch (err) {
    if (err instanceof RoutecraftError && err.rc === "RC5031") return;
    throw err;
  }
}

describe("sample (.sample())", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case Count-based sampling passes every Nth exchange and drops the rest
   * @preconditions Route with .sample({ every: 2 }); five sequential sends of 1..5 through a direct route
   * @expectedResult Only the 2nd and 4th exchanges (counter % 2 === 0) reach the destination
   */
  test("every: passes every Nth exchange in count order", async () => {
    const s = spy();
    t = await testContext()
      .routes(
        craft().id("sample-count").from(direct()).sample({ every: 2 }).to(s),
      )
      .build();
    await t.startAndWaitReady();

    for (const v of [1, 2, 3, 4, 5]) {
      await send(t, "sample-count", v);
    }

    expect(t.errors).toHaveLength(0);
    expect(s.received.map((e) => e.body)).toEqual([2, 4]);
  });

  /**
   * @case Count-based sampling admits a deterministic fraction over a concurrent batch
   * @preconditions Route with .sample({ every: 3 }) over nine concurrent exchanges
   * @expectedResult Exactly three exchanges pass (floor(9 / 3)), regardless of arrival order
   */
  test("every: admits floor(N / every) over a batch", async () => {
    const s = spy();
    t = await testContext()
      .routes(
        craft()
          .id("sample-count-batch")
          .from(simple([0, 1, 2, 3, 4, 5, 6, 7, 8]))
          .sample({ every: 3 })
          .to(s),
      )
      .build();

    await t.test();

    expect(t.errors).toHaveLength(0);
    expect(s.received).toHaveLength(3);
  });

  /**
   * @case Time-based sampling passes the first exchange per window and drops the rest
   * @preconditions Route with .sample({ intervalMs: 60_000 }); three sequential sends inside one window
   * @expectedResult Only the first send passes; the other two are dropped while the window is open
   */
  test("intervalMs: passes the first exchange in a window", async () => {
    const s = spy();
    t = await testContext()
      .routes(
        craft()
          .id("sample-interval")
          .from(direct())
          .sample({ intervalMs: 60_000 })
          .to(s),
      )
      .build();
    await t.startAndWaitReady();

    await send(t, "sample-interval", "a");
    await send(t, "sample-interval", "b");
    await send(t, "sample-interval", "c");

    expect(t.errors).toHaveLength(0);
    expect(s.received.map((e) => e.body)).toEqual(["a"]);
  });

  /**
   * @case A new time window admits the next exchange once the interval elapses
   * @preconditions Route with .sample({ intervalMs: 30 }); two sends separated by a 50ms sleep
   * @expectedResult Both sends pass, one per window
   */
  test("intervalMs: admits again after the window elapses", async () => {
    const s = spy();
    t = await testContext()
      .routes(
        craft()
          .id("sample-interval-next")
          .from(direct())
          .sample({ intervalMs: 30 })
          .to(s),
      )
      .build();
    await t.startAndWaitReady();

    await send(t, "sample-interval-next", "a");
    await sleep(50);
    await send(t, "sample-interval-next", "b");

    expect(t.errors).toHaveLength(0);
    expect(s.received.map((e) => e.body)).toEqual(["a", "b"]);
  });

  /**
   * @case Sample emits passed/dropped operation events with the sampling mode
   * @preconditions Route with .sample({ every: 2 }) over a sequential pair; event subscribers registered
   * @expectedResult One route:operation:sample:passed and one :dropped, both mode "count"
   */
  test("emits route:operation:sample:passed and :dropped", async () => {
    const passed: { mode: string }[] = [];
    const dropped: { mode: string }[] = [];
    const s = spy();
    t = await testContext()
      .on("route:operation:sample:passed", (p) => {
        passed.push(p.details as { mode: string });
      })
      .on("route:operation:sample:dropped", (p) => {
        dropped.push(p.details as { mode: string });
      })
      .routes(
        craft().id("sample-events").from(direct()).sample({ every: 2 }).to(s),
      )
      .build();
    await t.startAndWaitReady();

    await send(t, "sample-events", 1);
    await send(t, "sample-events", 2);

    expect(dropped).toHaveLength(1);
    expect(passed).toHaveLength(1);
    expect(passed[0]!.mode).toBe("count");
    expect(dropped[0]!.mode).toBe("count");
  });

  /**
   * @case Sample emits passed/dropped operation events with the interval mode
   * @preconditions Route with .sample({ intervalMs }) over two sends in one window; event subscribers registered
   * @expectedResult One route:operation:sample:passed and one :dropped, both mode "interval"
   */
  test("emits route:operation:sample:passed and :dropped in interval mode", async () => {
    const passed: { mode: string }[] = [];
    const dropped: { mode: string }[] = [];
    const s = spy();
    t = await testContext()
      .on("route:operation:sample:passed", (p) => {
        passed.push(p.details as { mode: string });
      })
      .on("route:operation:sample:dropped", (p) => {
        dropped.push(p.details as { mode: string });
      })
      .routes(
        craft()
          .id("sample-interval-events")
          .from(direct())
          .sample({ intervalMs: 1000 })
          .to(s),
      )
      .build();
    await t.startAndWaitReady();

    // Two sends inside the same window: the first passes, the second drops.
    await send(t, "sample-interval-events", "a");
    await send(t, "sample-interval-events", "b");

    expect(passed).toHaveLength(1);
    expect(dropped).toHaveLength(1);
    expect(passed[0]!.mode).toBe("interval");
    expect(dropped[0]!.mode).toBe("interval");
  });

  /**
   * @case Mis-specified sampling is rejected at build time
   * @preconditions SampleStep constructed with neither, both, or out-of-range options
   * @expectedResult Each construction throws (RC5003), so the route never builds
   */
  test("rejects invalid options at build time", () => {
    // The XOR union rejects neither/both at compile time; cast to exercise the
    // runtime guard that protects JS callers who bypass the types.
    expect(() => new SampleStep({} as SampleOptions)).toThrow(
      /mutually exclusive/,
    );
    expect(
      () => new SampleStep({ every: 2, intervalMs: 5 } as SampleOptions),
    ).toThrow(/mutually exclusive/);
    expect(() => new SampleStep({ every: 0 })).toThrow(/every/);
    expect(() => new SampleStep({ every: 1.5 })).toThrow(/every/);
    expect(() => new SampleStep({ intervalMs: 0 })).toThrow(/intervalMs/);
    expect(() => new SampleStep({ intervalMs: -10 })).toThrow(/intervalMs/);
  });
});
