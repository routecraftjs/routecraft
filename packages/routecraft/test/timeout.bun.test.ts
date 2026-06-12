import { afterEach, describe, expect, test } from "bun:test";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import { craft, simple } from "@routecraft/routecraft";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Timeout wrapper (.timeout())", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case Wrapped step settles within the deadline and passes through unchanged
   * @preconditions Route with .timeout(500) wrapping a fast transform
   * @expectedResult The destination receives the transformed body; started and stopped events fire, expired does not
   */
  test("passes through when the step settles in time", async () => {
    const s = spy();
    const events: string[] = [];

    t = await testContext()
      .on("route:timeout:started", () => {
        events.push("started");
      })
      .on("route:timeout:stopped", () => {
        events.push("stopped");
      })
      .on("route:timeout:expired", () => {
        events.push("expired");
      })
      .routes(
        craft()
          .id("timeout-pass")
          .from(simple("fast"))
          .timeout(500)
          .transform((body: string) => body.toUpperCase())
          .to(s),
      )
      .build();

    await t.test();

    expect(t.errors).toHaveLength(0);
    expect(s.received[0].body).toBe("FAST");
    expect(events).toEqual(["started", "stopped"]);
  });

  /**
   * @case Deadline fires before the wrapped step settles
   * @preconditions Route with .timeout(30) wrapping a 300ms transform and no error handler
   * @expectedResult RC5011 reaches the default error path, route:timeout:expired fires with scope "step", and the destination is never called
   */
  test("throws RC5011 when the deadline fires first", async () => {
    const s = spy();
    const expired: unknown[] = [];

    t = await testContext()
      .on("route:timeout:expired", (payload) => {
        expired.push(payload.details);
      })
      .routes(
        craft()
          .id("timeout-expired")
          .from(simple("slow"))
          .timeout(30)
          .transform(async (body: string) => {
            await sleep(300);
            return body;
          })
          .to(s),
      )
      .build();

    await t.test();

    expect(s.received).toHaveLength(0);
    // The abandoned inner work settles after the deadline; its outcome
    // must be discarded, never delivered downstream late.
    await sleep(350);
    expect(s.received).toHaveLength(0);
    expect(t.errors).toHaveLength(1);
    expect(t.errors[0].rc).toBe("RC5011");
    expect(t.errors[0].retryable).toBe(true);
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({
      routeId: "timeout-expired",
      scope: "step",
      timeoutMs: 30,
    });
  });

  /**
   * @case A step failure inside the deadline propagates unchanged
   * @preconditions Route with .timeout(500) wrapping a transform that throws immediately
   * @expectedResult The original error (not RC5011) reaches the default error path and no expired event fires
   */
  test("propagates the inner error unchanged when the step throws in time", async () => {
    let expiredCount = 0;

    t = await testContext()
      .on("route:timeout:expired", () => {
        expiredCount++;
      })
      .routes(
        craft()
          .id("timeout-inner-throw")
          .from(simple("in"))
          .timeout(500)
          .transform(() => {
            throw new Error("inner boom");
          })
          .to(spy()),
      )
      .build();

    await t.test();

    expect(expiredCount).toBe(0);
    expect(t.errors).toHaveLength(1);
    expect(t.errors[0].rc).not.toBe("RC5011");
    expect(t.errors[0].message).toContain("inner boom");
  });

  /**
   * @case A step-scope error handler outside the timeout recovers from expiry
   * @preconditions Route with .error(h).timeout(30) wrapping a slow transform (error wrapper outermost)
   * @expectedResult The handler receives RC5011, its return value replaces the body, and the pipeline continues to the destination
   */
  test("cascades expiry to an outer step-scope .error() handler", async () => {
    const s = spy();
    let handlerError: unknown;

    t = await testContext()
      .routes(
        craft()
          .id("timeout-error-cascade")
          .from(simple("in"))
          .error((error) => {
            handlerError = error;
            return "fallback";
          })
          .timeout(30)
          .transform(async (body: string) => {
            await sleep(300);
            return body;
          })
          .to(s),
      )
      .build();

    await t.test();

    expect(t.errors).toHaveLength(0);
    expect((handlerError as { rc: string }).rc).toBe("RC5011");
    expect(s.received).toHaveLength(1);
    expect(s.received[0].body).toBe("fallback");
  });

  /**
   * @case Route-scope timeout bounds the whole pipeline
   * @preconditions Route with .timeout(30) declared BEFORE .from() and a 300ms step in the pipeline
   * @expectedResult route:timeout:expired fires with scope "route", RC5011 reaches the default error path, and the destination is never called
   */
  test("route scope: bounds the whole pipeline", async () => {
    const s = spy();
    const expired: unknown[] = [];

    t = await testContext()
      .on("route:timeout:expired", (payload) => {
        expired.push(payload.details);
      })
      .routes(
        craft()
          .id("timeout-route-scope")
          .timeout(30)
          .from(simple("slow"))
          .transform(async (body: string) => {
            await sleep(300);
            return body;
          })
          .to(s),
      )
      .build();

    await t.test();

    expect(s.received).toHaveLength(0);
    // The abandoned nested run settles after the deadline; its outcome
    // must be discarded, never delivered downstream late.
    await sleep(350);
    expect(s.received).toHaveLength(0);
    expect(t.errors).toHaveLength(1);
    expect(t.errors[0].rc).toBe("RC5011");
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({
      routeId: "timeout-route-scope",
      scope: "route",
      stepLabel: "route",
      timeoutMs: 30,
    });
  });

  /**
   * @case Route-scope timeout passes a fast pipeline through untouched
   * @preconditions Route with .timeout(500) declared BEFORE .from() and a fast pipeline
   * @expectedResult The destination receives the body; started and stopped fire with scope "route", expired does not
   */
  test("route scope: fast pipeline passes through", async () => {
    const s = spy();
    const events: string[] = [];

    t = await testContext()
      .on("route:timeout:started", () => {
        events.push("started");
      })
      .on("route:timeout:stopped", () => {
        events.push("stopped");
      })
      .on("route:timeout:expired", () => {
        events.push("expired");
      })
      .routes(
        craft()
          .id("timeout-route-fast")
          .timeout(500)
          .from(simple("ok"))
          .transform((body: string) => body.length)
          .to(s),
      )
      .build();

    await t.test();

    expect(t.errors).toHaveLength(0);
    expect(s.received[0].body).toBe(2);
    expect(events).toEqual(["started", "stopped"]);
  });

  /**
   * @case Each retry attempt gets its own deadline and the final RC5011 escapes
   * @preconditions Route with .retry({ maxAttempts: 2, backoffMs: 1 }).timeout(30) wrapping an always-slow transform
   * @expectedResult Two expired events fire (one per attempt), one retry:attempt fires, and the final RC5011 reaches the default error path
   */
  test("retry().timeout(): per-attempt deadline, final RC5011 escapes", async () => {
    let expiredCount = 0;
    let attemptCount = 0;

    t = await testContext()
      .on("route:timeout:expired", () => {
        expiredCount++;
      })
      .on("route:retry:attempt", () => {
        attemptCount++;
      })
      .routes(
        craft()
          .id("retry-timeout-stack")
          .from(simple("slow"))
          .retry({ maxAttempts: 2, backoffMs: 1 })
          .timeout(30)
          .transform(async (body: string) => {
            await sleep(300);
            return body;
          })
          .to(spy()),
      )
      .build();

    await t.test();

    expect(expiredCount).toBe(2);
    expect(attemptCount).toBe(1);
    expect(t.errors).toHaveLength(1);
    expect(t.errors[0].rc).toBe("RC5011");
  });

  /**
   * @case Invalid timeout deadlines are rejected at build time in both scopes
   * @preconditions Timeout wrappers configured with 0 and NaN deadlines, step scope and route scope
   * @expectedResult Building throws RC5003 instead of deferring to an instant runtime expiry
   */
  test("rejects non-finite or non-positive timeoutMs at build time", () => {
    expect(() =>
      craft().id("timeout-zero").from(simple("in")).timeout(0).to(spy()),
    ).toThrow(/timeoutMs/);
    expect(() =>
      craft()
        .id("timeout-nan")
        .from(simple("in"))
        .timeout(Number.NaN)
        .to(spy()),
    ).toThrow(/timeoutMs/);
    // Route scope validates at staging time, before .from().
    expect(() => craft().id("timeout-route-zero").timeout(0)).toThrow(
      /timeoutMs/,
    );
  });

  /**
   * @case Builder body type is preserved across .timeout()
   * @preconditions Route chaining .timeout() between typed transforms
   * @expectedResult The chain compiles with the string body type flowing through the wrapper and produces the typed result
   */
  test("preserves the builder body type", async () => {
    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("timeout-typed")
          .from(simple("typed"))
          .timeout(500)
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
