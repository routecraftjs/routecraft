import { afterEach, describe, expect, test } from "bun:test";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import { craft, simple, rcError } from "@routecraft/routecraft";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

describe("Retry wrapper (.retry())", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case First attempt succeeds, no re-attempt happens
   * @preconditions Route with .retry() wrapping a transform that always succeeds
   * @expectedResult started and stopped (success true, attempt 1) fire; no attempt event; destination receives the value
   */
  test("passes through on first-attempt success", async () => {
    const s = spy();
    const events: Array<{ name: string; details: unknown }> = [];
    const record = (name: string) => (payload: { details: unknown }) =>
      void events.push({ name, details: payload.details });

    t = await testContext()
      .on("route:retry:started", record("started"))
      .on("route:retry:attempt", record("attempt"))
      .on("route:retry:stopped", record("stopped"))
      .routes(
        craft()
          .id("retry-first-success")
          .from(simple("ok"))
          .retry({ maxAttempts: 3, backoffMs: 1 })
          .transform((body: string) => body.toUpperCase())
          .to(s),
      )
      .build();

    await t.test();

    expect(t.errors).toHaveLength(0);
    expect(s.received[0].body).toBe("OK");
    expect(events.map((e) => e.name)).toEqual(["started", "stopped"]);
    expect(events[1].details).toMatchObject({
      attemptNumber: 1,
      success: true,
      scope: "step",
    });
  });

  /**
   * @case Transient failure recovers on a later attempt
   * @preconditions Route with .retry({ maxAttempts: 3 }) wrapping a transform that fails twice then succeeds
   * @expectedResult Two attempt events fire, stopped reports success on attempt 3, and the destination receives the value
   */
  test("recovers after transient failures", async () => {
    const s = spy();
    let calls = 0;
    const attempts: unknown[] = [];

    t = await testContext()
      .on("route:retry:attempt", (payload) => {
        attempts.push(payload.details);
      })
      .routes(
        craft()
          .id("retry-recovers")
          .from(simple("in"))
          .retry({ maxAttempts: 3, backoffMs: 1 })
          .transform((body: string) => {
            calls++;
            if (calls < 3) throw new Error(`attempt ${calls} fails`);
            return body.toUpperCase();
          })
          .to(s),
      )
      .build();

    await t.test();

    expect(t.errors).toHaveLength(0);
    expect(calls).toBe(3);
    expect(s.received[0].body).toBe("IN");
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ attemptNumber: 1, maxAttempts: 3 });
    expect(attempts[1]).toMatchObject({ attemptNumber: 2, maxAttempts: 3 });
  });

  /**
   * @case All attempts exhausted propagates the original error
   * @preconditions Route with .retry({ maxAttempts: 2 }) wrapping an always-failing transform and no error handler
   * @expectedResult The original error reaches the default error path, stopped reports success false on attempt 2, and the destination is never called
   */
  test("propagates the final error after exhausting attempts", async () => {
    const s = spy();
    let calls = 0;
    const stopped: unknown[] = [];

    t = await testContext()
      .on("route:retry:stopped", (payload) => {
        stopped.push(payload.details);
      })
      .routes(
        craft()
          .id("retry-exhausted")
          .from(simple("in"))
          .retry({ maxAttempts: 2, backoffMs: 1 })
          .transform(() => {
            calls++;
            throw new Error("always fails");
          })
          .to(s),
      )
      .build();

    await t.test();

    expect(calls).toBe(2);
    expect(s.received).toHaveLength(0);
    expect(t.errors).toHaveLength(1);
    expect(t.errors[0].message).toContain("always fails");
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toMatchObject({ attemptNumber: 2, success: false });
    expect((stopped[0] as { error?: Error }).error?.message).toContain(
      "always fails",
    );
  });

  /**
   * @case Default retryOn does not re-attempt non-retryable errors
   * @preconditions Route with .retry() wrapping a transform throwing RC5002 (validation, retryable false)
   * @expectedResult Exactly one call happens, no attempt event fires, and the RC5002 propagates
   */
  test("default retryOn skips non-retryable RoutecraftErrors", async () => {
    let calls = 0;
    let attemptCount = 0;

    t = await testContext()
      .on("route:retry:attempt", () => {
        attemptCount++;
      })
      .routes(
        craft()
          .id("retry-non-retryable")
          .from(simple("in"))
          .retry({ maxAttempts: 3, backoffMs: 1 })
          .transform(() => {
            calls++;
            throw rcError("RC5002", undefined, {
              message: "schema rejected the body",
            });
          })
          .to(spy()),
      )
      .build();

    await t.test();

    expect(calls).toBe(1);
    expect(attemptCount).toBe(0);
    expect(t.errors).toHaveLength(1);
    expect(t.errors[0].rc).toBe("RC5002");
  });

  /**
   * @case Custom retryOn overrides the default predicate
   * @preconditions Route with .retry({ retryOn: () => true }) wrapping a transform that throws non-retryable RC5002 once then succeeds
   * @expectedResult The non-retryable error IS re-attempted and the destination receives the recovered value
   */
  test("custom retryOn can force-retry non-retryable errors", async () => {
    const s = spy();
    let calls = 0;

    t = await testContext()
      .routes(
        craft()
          .id("retry-custom-predicate")
          .from(simple("in"))
          .retry({ maxAttempts: 2, backoffMs: 1, retryOn: () => true })
          .transform((body: string) => {
            calls++;
            if (calls === 1) {
              throw rcError("RC5002", undefined, {
                message: "rejected once",
              });
            }
            return body;
          })
          .to(s),
      )
      .build();

    await t.test();

    expect(t.errors).toHaveLength(0);
    expect(calls).toBe(2);
    expect(s.received).toHaveLength(1);
  });

  /**
   * @case Exponential backoff doubles the wait per attempt
   * @preconditions Route with .retry({ maxAttempts: 3, backoffMs: 10, exponential: true }) wrapping an always-failing transform
   * @expectedResult The attempt events report backoffMs 10 then 20
   */
  test("exponential backoff doubles per attempt", async () => {
    const waits: number[] = [];

    t = await testContext()
      .on("route:retry:attempt", (payload) => {
        waits.push((payload.details as { backoffMs: number }).backoffMs);
      })
      .routes(
        craft()
          .id("retry-exponential")
          .from(simple("in"))
          .retry({ maxAttempts: 3, backoffMs: 10, exponential: true })
          .transform(() => {
            throw new Error("always fails");
          })
          .to(spy()),
      )
      .build();

    await t.test();

    expect(waits).toEqual([10, 20]);
  });

  /**
   * @case Retry around timeout recovers when a later attempt is fast enough
   * @preconditions Route with .retry({ maxAttempts: 2 }).timeout(50) wrapping a transform that is slow on attempt 1 and fast on attempt 2
   * @expectedResult Attempt 1 expires (RC5011, retried by default), attempt 2 succeeds, and the destination receives the value
   */
  test("retry().timeout(): recovers when a later attempt beats the deadline", async () => {
    const s = spy();
    let calls = 0;
    let expiredCount = 0;

    t = await testContext()
      .on("route:timeout:expired", () => {
        expiredCount++;
      })
      .routes(
        craft()
          .id("retry-timeout-recovers")
          .from(simple("in"))
          .retry({ maxAttempts: 2, backoffMs: 1 })
          .timeout(50)
          .transform(async (body: string) => {
            calls++;
            if (calls === 1) await sleep(300);
            return body.toUpperCase();
          })
          .to(s),
      )
      .build();

    await t.test();

    expect(t.errors).toHaveLength(0);
    expect(expiredCount).toBe(1);
    expect(calls).toBe(2);
    expect(s.received[0].body).toBe("IN");
  });

  /**
   * @case Exhausted step-scope retry cascades to the route-scope error handler
   * @preconditions Route with a route-scope .error() handler and a step-scope .retry({ maxAttempts: 2 }) around an always-failing step
   * @expectedResult After both attempts fail the route-scope handler receives the original error and no default-path error is recorded
   */
  test("cascades to the route-scope .error() handler after exhaustion", async () => {
    let calls = 0;
    let handlerError: unknown;

    t = await testContext()
      .routes(
        craft()
          .id("retry-cascade")
          .error((error) => {
            handlerError = error;
            return "handled";
          })
          .from(simple("in"))
          .retry({ maxAttempts: 2, backoffMs: 1 })
          .transform(() => {
            calls++;
            throw new Error("still broken");
          })
          .to(spy()),
      )
      .build();

    await t.test();

    expect(calls).toBe(2);
    expect(t.errors).toHaveLength(0);
    expect((handlerError as Error).message).toContain("still broken");
  });

  /**
   * @case Route-scope retry re-runs the whole pipeline
   * @preconditions Route with .retry({ maxAttempts: 2 }) declared BEFORE .from() and a pipeline that fails once then succeeds
   * @expectedResult The retry events carry scope "route", the pipeline runs twice, and the destination receives the value
   */
  test("route scope: re-runs the whole pipeline on failure", async () => {
    const s = spy();
    let calls = 0;
    const events: unknown[] = [];

    t = await testContext()
      .on("route:retry:started", (payload) => {
        events.push(payload.details);
      })
      .routes(
        craft()
          .id("retry-route-scope")
          .retry({ maxAttempts: 2, backoffMs: 1 })
          .from(simple("in"))
          .transform((body: string) => {
            calls++;
            if (calls === 1) throw new Error("pipeline fails once");
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
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      scope: "route",
      stepLabel: "route",
      maxAttempts: 2,
    });
  });

  /**
   * @case Route-scope retry preserves split fan-out: every child processes inside the retried segment
   * @preconditions Route with .retry() declared BEFORE .from() and an unbalanced .split() (no aggregate) in the pipeline
   * @expectedResult All split children reach the destination on a successful run; nothing is collapsed or dropped by the retry segment
   */
  test("route scope: all split children process under retry", async () => {
    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("retry-split-fanout")
          .retry({ maxAttempts: 2, backoffMs: 1 })
          .from(simple("a-b-c"))
          .split((exchange) =>
            typeof exchange.body === "string" ? exchange.body.split("-") : [],
          )
          .transform((body: string) => body.toUpperCase())
          .to(s),
      )
      .build();

    await t.test();

    expect(t.errors).toHaveLength(0);
    expect(s.received.map((r) => r.body).sort()).toEqual(["A", "B", "C"]);
  });

  /**
   * @case Route-scope retry composes with route-scope timeout (per-attempt deadline)
   * @preconditions Route with .retry({ maxAttempts: 2 }).timeout(50) declared BEFORE .from(); the pipeline is slow on run 1, fast on run 2
   * @expectedResult Run 1 expires with scope "route", run 2 succeeds, and the destination receives the value
   */
  test("route scope: retry outside timeout gives each attempt its own deadline", async () => {
    const s = spy();
    let calls = 0;
    const expired: unknown[] = [];

    t = await testContext()
      .on("route:timeout:expired", (payload) => {
        expired.push(payload.details);
      })
      .routes(
        craft()
          .id("retry-timeout-route-scope")
          .retry({ maxAttempts: 2, backoffMs: 1 })
          .timeout(50)
          .from(simple("in"))
          .transform(async (body: string) => {
            calls++;
            if (calls === 1) await sleep(300);
            return body.toUpperCase();
          })
          .to(s),
      )
      .build();

    await t.test();

    expect(t.errors).toHaveLength(0);
    expect(calls).toBe(2);
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({ scope: "route" });
    expect(s.received[0].body).toBe("IN");
  });

  /**
   * @case Route shutdown during a backoff wait gives up instead of waiting it out
   * @preconditions Route with .retry({ backoffMs: 10000 }) around an always-failing step; the context is stopped during the first backoff
   * @expectedResult The last real error surfaces promptly on the default error path; the 10s backoff is not waited out
   */
  test("shutdown during backoff propagates the last error promptly", async () => {
    let calls = 0;

    t = await testContext()
      .routes(
        craft()
          .id("retry-shutdown")
          .from(simple("in"))
          .retry({ maxAttempts: 3, backoffMs: 10_000 })
          .transform(() => {
            calls++;
            throw new Error("fails into backoff");
          })
          .to(spy()),
      )
      .build();

    await t.startAndWaitReady();
    // Let attempt 1 fail and enter the 10s backoff, then stop.
    await new Promise((resolve) => setTimeout(resolve, 30));
    await t.stop();

    await waitFor(() => t.errors.length === 1);
    expect(calls).toBe(1);
    expect(t.errors[0].message).toContain("fails into backoff");
  });

  /**
   * @case Invalid maxAttempts is rejected at build time
   * @preconditions A retry wrapper configured with maxAttempts 0
   * @expectedResult Building the route throws RC5003 before any exchange is processed
   */
  test("rejects maxAttempts < 1 at build time", () => {
    expect(() =>
      craft()
        .id("retry-invalid")
        .from(simple("in"))
        .retry({ maxAttempts: 0 })
        .to(spy())
        .build(),
    ).toThrow(/maxAttempts/);
  });

  /**
   * @case Invalid backoff durations are rejected at build time
   * @preconditions A retry wrapper configured with a negative backoffMs
   * @expectedResult Building the route throws RC5003 instead of silently coercing the wait to zero
   */
  test("rejects negative backoffMs at build time", () => {
    expect(() =>
      craft()
        .id("retry-bad-backoff")
        .from(simple("in"))
        .retry({ backoffMs: -100 })
        .to(spy()),
    ).toThrow(/backoffMs/);
  });

  /**
   * @case Builder body type is preserved across .retry()
   * @preconditions Route chaining .retry() between typed transforms
   * @expectedResult The chain compiles with the string body type flowing through the wrapper and produces the typed result
   */
  test("preserves the builder body type", async () => {
    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("retry-typed")
          .from(simple("typed"))
          .retry({ maxAttempts: 2, backoffMs: 1 })
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
