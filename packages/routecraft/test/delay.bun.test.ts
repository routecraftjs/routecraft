import { afterEach, describe, expect, test } from "bun:test";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import { craft, simple } from "@routecraft/routecraft";

/** Poll until `predicate` returns true or `timeoutMs` elapses. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("Delay wrapper (.delay())", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case Delay waits before the wrapped step and passes the exchange through unchanged
   * @preconditions Route with .delay(60) wrapping the destination
   * @expectedResult The destination receives the original body, and the step runs no earlier than the configured delay
   */
  test("waits before the wrapped step, exchange unchanged", async () => {
    const s = spy();
    let deliveredAt = 0;
    const start = Date.now();

    t = await testContext()
      .routes(
        craft()
          .id("delay-pass-through")
          .from(simple("payload"))
          .delay(60)
          .transform((body: string) => {
            deliveredAt = Date.now();
            return body;
          })
          .to(s),
      )
      .build();

    await t.test();

    expect(t.errors).toHaveLength(0);
    expect(s.received).toHaveLength(1);
    expect(s.received[0].body).toBe("payload");
    // Allow a small scheduling tolerance; the wait must be in the
    // right order of magnitude, not exact.
    expect(deliveredAt - start).toBeGreaterThanOrEqual(50);
  });

  /**
   * @case Delay emits started and stopped lifecycle events with scope and stepLabel
   * @preconditions Route with .delay(20) wrapping a destination; event subscribers registered
   * @expectedResult route:delay:started and route:delay:stopped fire once each with delayMs, scope "step", and cancelled false
   */
  test("emits route:delay:started and route:delay:stopped", async () => {
    const started: unknown[] = [];
    const stopped: unknown[] = [];

    t = await testContext()
      .on("route:delay:started", (payload) => {
        started.push(payload.details);
      })
      .on("route:delay:stopped", (payload) => {
        stopped.push(payload.details);
      })
      .routes(
        craft().id("delay-events").from(simple("msg")).delay(20).to(spy()),
      )
      .build();

    await t.test();

    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      routeId: "delay-events",
      scope: "step",
      delayMs: 20,
    });
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toMatchObject({
      routeId: "delay-events",
      scope: "step",
      delayMs: 20,
      cancelled: false,
    });
    expect((stopped[0] as { elapsed: number }).elapsed).toBeGreaterThanOrEqual(
      15,
    );
  });

  /**
   * @case Delay composes with retry so the wait applies to every attempt
   * @preconditions Route with .retry({ maxAttempts: 2, backoffMs: 1 }).delay(10) wrapping a step that fails once then succeeds
   * @expectedResult Two route:delay:started events fire (one per attempt) and the destination receives the recovered value
   */
  test("retry().delay() waits before each attempt", async () => {
    const s = spy();
    let calls = 0;
    let delayStarts = 0;

    t = await testContext()
      .on("route:delay:started", () => {
        delayStarts++;
      })
      .routes(
        craft()
          .id("retry-delay-stack")
          .from(simple("in"))
          .retry({ maxAttempts: 2, backoffMs: 1 })
          .delay(10)
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
    expect(delayStarts).toBe(2);
    expect(s.received).toHaveLength(1);
    expect(s.received[0].body).toBe("IN");
  });

  /**
   * @case Route shutdown cancels a pending delay without dropping the exchange
   * @preconditions Route with .delay(5000) wrapping the destination; the context is stopped while the delay is pending
   * @expectedResult The wait is cut short (route:delay:stopped carries cancelled true), the wrapped step still runs, and the destination receives the body
   */
  test("shutdown cuts the wait short; the step still runs", async () => {
    const s = spy();
    const stopped: unknown[] = [];

    t = await testContext()
      .on("route:delay:stopped", (payload) => {
        stopped.push(payload.details);
      })
      .routes(
        craft().id("delay-cancel").from(simple("survives")).delay(5000).to(s),
      )
      .build();

    await t.startAndWaitReady();
    // Let the exchange enter the delay, then stop the context.
    await new Promise((resolve) => setTimeout(resolve, 30));
    await t.stop();

    await waitFor(() => s.received.length === 1);
    expect(s.received[0].body).toBe("survives");
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toMatchObject({ cancelled: true });
    expect((stopped[0] as { elapsed: number }).elapsed).toBeLessThan(5000);
  });

  /**
   * @case Invalid delay durations are rejected at build time
   * @preconditions A delay wrapper configured with a negative and a NaN duration
   * @expectedResult Building the route throws RC5003 before any exchange is processed
   */
  test("rejects non-finite or negative delayMs at build time", () => {
    expect(() =>
      craft().id("delay-negative").from(simple("in")).delay(-1).to(spy()),
    ).toThrow(/delayMs/);
    expect(() =>
      craft().id("delay-nan").from(simple("in")).delay(Number.NaN).to(spy()),
    ).toThrow(/delayMs/);
  });

  /**
   * @case Builder body type is preserved across .delay()
   * @preconditions Route chaining .delay() between typed transforms
   * @expectedResult The chain compiles with the string body type flowing through the wrapper and produces the typed result
   */
  test("preserves the builder body type", async () => {
    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("delay-typed")
          .from(simple("typed"))
          .delay(1)
          // Compile-time check: `body` must still be string here.
          .transform((body: string) => body.length)
          .to(s),
      )
      .build();

    await t.test();

    expect(t.errors).toHaveLength(0);
    expect(s.received[0].body).toBe(5);
  });
});
