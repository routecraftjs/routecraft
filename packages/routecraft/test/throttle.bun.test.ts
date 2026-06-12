import { afterEach, describe, expect, test } from "bun:test";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import { craft, simple } from "@routecraft/routecraft";

/** Poll until `predicate` returns true or `timeoutMs` elapses. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("Throttle wrapper (.throttle())", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case Throttle admits a burst up to the rate, then paces the rest without dropping any exchange
   * @preconditions Route with .throttle({ requestsPerSecond: 5 }) over seven concurrent exchanges
   * @expectedResult All seven are delivered; the two beyond the burst are paced, so total wall time is at least one refill interval
   */
  test("paces exchanges beyond the burst, none dropped", async () => {
    const s = spy();
    const start = Date.now();

    t = await testContext()
      .routes(
        craft()
          .id("throttle-pace")
          .from(simple([0, 1, 2, 3, 4, 5, 6]))
          .throttle({ requestsPerSecond: 5 })
          .to(s),
      )
      .build();

    await t.test();
    const elapsed = Date.now() - start;

    expect(t.errors).toHaveLength(0);
    // Every exchange is admitted; throttle delays, never drops.
    expect(s.received).toHaveLength(7);
    expect(
      s.received.map((e) => e.body).sort((a, b) => Number(a) - Number(b)),
    ).toEqual([0, 1, 2, 3, 4, 5, 6]);
    // Capacity is 5 (the rate), so two exchanges pace at ~200ms each.
    // Allow generous scheduling tolerance below the ideal ~400ms.
    expect(elapsed).toBeGreaterThanOrEqual(300);
  });

  /**
   * @case Throttle emits passed for every admission and delayed only for paced exchanges
   * @preconditions Route with .throttle({ requestsPerSecond: 5 }) over six concurrent exchanges; event subscribers registered
   * @expectedResult Six route:throttle:passed events (five immediate, one waited) and one route:throttle:delayed, all scope "step"
   */
  test("emits route:throttle:passed and route:throttle:delayed", async () => {
    const passed: { waited: boolean; scope: string; stepLabel: string }[] = [];
    const delayed: { waitMs: number; scope: string }[] = [];

    t = await testContext()
      .on("route:throttle:passed", (payload) => {
        passed.push(
          payload.details as {
            waited: boolean;
            scope: string;
            stepLabel: string;
          },
        );
      })
      .on("route:throttle:delayed", (payload) => {
        delayed.push(payload.details as { waitMs: number; scope: string });
      })
      .routes(
        craft()
          .id("throttle-events")
          .from(simple([0, 1, 2, 3, 4, 5]))
          .throttle({ requestsPerSecond: 5 })
          .to(spy()),
      )
      .build();

    await t.test();

    expect(passed).toHaveLength(6);
    expect(passed.every((p) => p.scope === "step")).toBe(true);
    expect(passed.filter((p) => p.waited === false)).toHaveLength(5);
    expect(passed.filter((p) => p.waited === true)).toHaveLength(1);

    expect(delayed).toHaveLength(1);
    expect(delayed[0]).toMatchObject({ scope: "step" });
    expect(delayed[0].waitMs).toBeGreaterThan(0);
  });

  /**
   * @case Route-scope throttle (before .from()) paces the whole pipeline with scope "route"
   * @preconditions Route with .throttle({ requestsPerSecond: 5 }) staged before .from() over six concurrent exchanges
   * @expectedResult All six are delivered and the throttle events carry scope "route"
   */
  test("route-scope .throttle() paces with scope route", async () => {
    const s = spy();
    const passed: { scope: string }[] = [];

    t = await testContext()
      .on("route:throttle:passed", (payload) => {
        passed.push(payload.details as { scope: string });
      })
      .routes(
        craft()
          .id("throttle-route-scope")
          .throttle({ requestsPerSecond: 5 })
          .from(simple([0, 1, 2, 3, 4, 5]))
          .to(s),
      )
      .build();

    await t.test();

    expect(t.errors).toHaveLength(0);
    expect(s.received).toHaveLength(6);
    expect(passed).toHaveLength(6);
    expect(passed.every((p) => p.scope === "route")).toBe(true);
  });

  /**
   * @case Route-scope throttle sits OUTSIDE route-scope retry, so a retried exchange is admitted only once
   * @preconditions Route with .throttle().retry() before .from() over one exchange whose step fails on its first attempt
   * @expectedResult The pipeline retries and succeeds, but the throttle gate admits the exchange exactly once (one passed event for two attempts)
   */
  test("route-scope throttle admits once across retry attempts", async () => {
    const s = spy();
    const passed: unknown[] = [];
    let calls = 0;

    t = await testContext()
      .on("route:throttle:passed", (payload) => {
        passed.push(payload.details);
      })
      .routes(
        craft()
          .id("throttle-outside-retry")
          .throttle({ requestsPerSecond: 100 })
          .retry({ maxAttempts: 3, backoffMs: 1 })
          .from(simple("in"))
          .transform((body: string) => {
            calls++;
            if (calls === 1) throw new Error("first attempt fails");
            return body.toUpperCase();
          })
          .to(s),
      )
      .build();

    await t.test();

    expect(t.errors).toHaveLength(0);
    expect(calls).toBe(2);
    expect(s.received).toHaveLength(1);
    expect(s.received[0].body).toBe("IN");
    // Admission happens once, before retry re-runs the tail: were the
    // gate inside retry, this would be 2.
    expect(passed).toHaveLength(1);
  });

  /**
   * @case requestsPerMinute is accepted as an alternative rate unit
   * @preconditions Route with .throttle({ requestsPerMinute: 600 }) over three exchanges
   * @expectedResult All three are delivered (600/min === 10/s, a burst of 600 admits them immediately)
   */
  test("accepts requestsPerMinute", async () => {
    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("throttle-per-minute")
          .from(simple([0, 1, 2]))
          .throttle({ requestsPerMinute: 600 })
          .to(s),
      )
      .build();

    await t.test();

    expect(t.errors).toHaveLength(0);
    expect(s.received).toHaveLength(3);
  });

  /**
   * @case Route shutdown cancels a pending pacing wait without dropping the exchange
   * @preconditions Route with .throttle({ requestsPerMinute: 1 }) over two exchanges; the context is stopped while the second paces
   * @expectedResult Both exchanges are delivered even though the second's ~60s wait is cut short by shutdown
   */
  test("shutdown cuts the pacing wait short; the exchange still runs", async () => {
    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("throttle-cancel")
          // Rate of 1/min: capacity 1, so the first bursts and the
          // second must wait ~60s -- long enough to interrupt.
          .throttle({ requestsPerMinute: 1 })
          .from(simple([0, 1]))
          .to(s),
      )
      .build();

    await t.startAndWaitReady();
    // Let the first burst through and the second enter its pacing wait.
    await new Promise((resolve) => setTimeout(resolve, 30));
    await t.stop();

    await waitFor(() => s.received.length === 2);
    expect(s.received).toHaveLength(2);
  });

  /**
   * @case Invalid throttle options are rejected at build time
   * @preconditions Throttle wrappers configured with no rate, both rates, and a non-positive rate
   * @expectedResult Building the route throws RC5003 before any exchange is processed
   */
  test("rejects invalid options at build time", () => {
    expect(() =>
      craft()
        .id("throttle-none")
        .from(simple("in"))
        // @ts-expect-error -- exactly one rate field is required
        .throttle({})
        .to(spy()),
    ).toThrow(/exactly one/);

    expect(() =>
      craft()
        .id("throttle-both")
        // @ts-expect-error -- the two rate fields are mutually exclusive
        .throttle({ requestsPerSecond: 5, requestsPerMinute: 5 })
        .from(simple("in"))
        .to(spy()),
    ).toThrow(/exactly one/);

    expect(() =>
      craft()
        .id("throttle-zero")
        .from(simple("in"))
        .throttle({ requestsPerSecond: 0 })
        .to(spy()),
    ).toThrow(/requestsPerSecond/);

    expect(() =>
      craft()
        .id("throttle-negative")
        .throttle({ requestsPerMinute: -1 })
        .from(simple("in"))
        .to(spy()),
    ).toThrow(/requestsPerMinute/);
  });

  /**
   * @case Builder body type is preserved across .throttle()
   * @preconditions Route chaining .throttle() between typed transforms
   * @expectedResult The chain compiles with the string body flowing through the wrapper and produces the typed result
   */
  test("preserves the builder body type", async () => {
    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("throttle-typed")
          .from(simple("typed"))
          .throttle({ requestsPerSecond: 100 })
          // Compile-time check: `body` must still be string here.
          .transform((body: string) => body.length)
          .to(s),
      )
      .build();

    await t.test();

    expect(t.errors).toHaveLength(0);
    expect(s.received[0].body).toBe(5);
  });

  /**
   * @case A step-scope throttle propagates an inner step failure to the default error path
   * @preconditions Step-scope .throttle() wrapping a step that throws, with no route-level .error() handler
   * @expectedResult The error surfaces on the default error path (t.errors), it is not swallowed by the gate
   */
  test("propagates inner step failure to the default error path", async () => {
    t = await testContext()
      .routes(
        craft()
          .id("throttle-inner-fail")
          .from(simple("in"))
          .throttle({ requestsPerSecond: 100 })
          .transform(() => {
            throw new Error("inner step broke");
          })
          .to(spy()),
      )
      .build();

    await t.test();

    expect(t.errors).toHaveLength(1);
    expect(t.errors[0].message).toContain("inner step broke");
  });

  /**
   * @case A step-scope inner failure cascades to the route-scope error handler
   * @preconditions Route with a route-scope .error() handler and a step-scope .throttle() wrapping a throwing step
   * @expectedResult The route-level handler receives the inner error and recovers, so t.errors stays empty
   */
  test("cascades an inner failure to the route-scope .error() handler", async () => {
    let handlerError: unknown;

    t = await testContext()
      .routes(
        craft()
          .id("throttle-cascade")
          .error((error) => {
            handlerError = error;
            return "handled";
          })
          .from(simple("in"))
          .throttle({ requestsPerSecond: 100 })
          .transform(() => {
            throw new Error("gated step broke");
          })
          .to(spy()),
      )
      .build();

    await t.test();

    expect(t.errors).toHaveLength(0);
    expect((handlerError as Error).message).toContain("gated step broke");
  });

  /**
   * @case Stacked step-scope wrappers: retry re-enters the throttle gate per attempt
   * @preconditions .retry({ maxAttempts: 2 }).throttle() wrapping a step that fails once then succeeds
   * @expectedResult Retry re-runs the throttle-wrapped step, the second attempt passes the gate and succeeds, none dropped
   */
  test("stacks under .retry() so each attempt re-enters the gate", async () => {
    const s = spy();
    let calls = 0;
    let passes = 0;

    t = await testContext()
      .on("route:throttle:passed", () => {
        passes++;
      })
      .routes(
        craft()
          .id("throttle-stacked")
          .from(simple("in"))
          .retry({ maxAttempts: 2, backoffMs: 1 })
          .throttle({ requestsPerSecond: 100 })
          .transform((body: string) => {
            calls++;
            if (calls === 1) throw new Error("first attempt fails");
            return body.toUpperCase();
          })
          .to(s),
      )
      .build();

    await t.test();

    expect(t.errors).toHaveLength(0);
    expect(calls).toBe(2);
    // Retry wraps throttle, so the gate is entered once per attempt.
    expect(passes).toBe(2);
    expect(s.received).toHaveLength(1);
    expect(s.received[0].body).toBe("IN");
  });
});
