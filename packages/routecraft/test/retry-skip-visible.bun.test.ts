import { afterEach, describe, expect, test } from "bun:test";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import {
  craft,
  isTransient,
  rcError,
  simple,
  type AnyRouteBuilder,
} from "@routecraft/routecraft";

/**
 * A `.retry()` that never re-attempts used to look the same in the events as
 * one that ran out of attempts. `route:retry:stopped` now says which.
 */
describe("route:retry:stopped says why the retry gave up", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  async function run(route: AnyRouteBuilder) {
    const stopped: Array<Record<string, unknown>> = [];
    t = await testContext()
      .on("route:retry:stopped", (payload) => {
        stopped.push(payload.details as Record<string, unknown>);
      })
      .routes(route)
      .build();
    await t.test();
    return stopped;
  }

  /**
   * @case A non-retryable error stops the retry on the first attempt and says so
   * @preconditions Step-scope .retry({ maxAttempts: 3 }) around a transform that throws RC5003, which is registered retryable: false
   * @expectedResult One attempt, and the stopped event carries reason "not-retryable" and code "RC5003"
   */
  test("a refused error reports not-retryable with its code", async () => {
    let calls = 0;
    const stopped = await run(
      craft()
        .id("skip-step")
        .from(simple("in"))
        .retry({ maxAttempts: 3, backoff: 1 })
        .transform(() => {
          calls++;
          throw rcError("RC5003", undefined, { message: "misconfigured" });
        })
        .to(spy()),
    );
    expect(calls).toBe(1);
    expect(stopped).toEqual([
      expect.objectContaining({
        success: false,
        attemptNumber: 1,
        reason: "not-retryable",
        code: "RC5003",
      }),
    ]);
  });

  /**
   * @case The same visibility at route scope
   * @preconditions .retry() declared before .from(), the pipeline throws RC5012 (authentication, retryable: false)
   * @expectedResult One run of the pipeline, and the stopped event carries scope "route", reason "not-retryable" and code "RC5012"
   */
  test("a route-scope retry reports the refusal too", async () => {
    let calls = 0;
    const stopped = await run(
      craft()
        .id("skip-route")
        .retry({ maxAttempts: 3, backoff: 1 })
        .from(simple("in"))
        .transform(() => {
          calls++;
          throw rcError("RC5012", undefined, { message: "bad token" });
        })
        .to(spy()),
    );
    expect(calls).toBe(1);
    expect(stopped).toEqual([
      expect.objectContaining({
        scope: "route",
        success: false,
        reason: "not-retryable",
        code: "RC5012",
      }),
    ]);
  });

  /**
   * @case Running out of attempts is reported as exhausted, without a code for a foreign error
   * @preconditions .retry({ maxAttempts: 2 }) around a transform that always throws a plain Error
   * @expectedResult Two attempts, reason "exhausted", and no code because the error is not a RoutecraftError
   */
  test("exhausted attempts report exhausted", async () => {
    let calls = 0;
    const stopped = await run(
      craft()
        .id("exhausted")
        .from(simple("in"))
        .retry({ maxAttempts: 2, backoff: 1 })
        .transform(() => {
          calls++;
          throw new Error("always fails");
        })
        .to(spy()),
    );
    expect(calls).toBe(2);
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toMatchObject({
      success: false,
      attemptNumber: 2,
      reason: "exhausted",
    });
    expect(stopped[0]).not.toHaveProperty("code");
  });

  /**
   * @case A custom retryOn that refuses on the last attempt is still a refusal
   * @preconditions maxAttempts 2; retryOn accepts the first failure and refuses the second
   * @expectedResult Two attempts and reason "not-retryable": more attempts would not have helped
   */
  test("a refusal on the last attempt is not-retryable, not exhausted", async () => {
    let failures = 0;
    const stopped = await run(
      craft()
        .id("last-refused")
        .from(simple("in"))
        .retry({ maxAttempts: 2, backoff: 1, retryOn: () => ++failures < 2 })
        .transform(() => {
          throw new Error("fails");
        })
        .to(spy()),
    );
    expect(stopped[0]).toMatchObject({
      attemptNumber: 2,
      reason: "not-retryable",
    });
  });

  /**
   * @case A success carries neither a reason nor a code
   * @preconditions .retry() around a transform that succeeds
   * @expectedResult The stopped event reports success with no reason and no code
   */
  test("a success has no reason", async () => {
    const stopped = await run(
      craft()
        .id("fine")
        .from(simple("in"))
        .retry({ maxAttempts: 2, backoff: 1 })
        .transform((body: string) => body)
        .to(spy()),
    );
    expect(stopped[0]).toMatchObject({ success: true });
    expect(stopped[0]).not.toHaveProperty("reason");
    expect(stopped[0]).not.toHaveProperty("code");
  });

  /**
   * @case isTransient is the default retry rule, usable inside a custom retryOn
   * @preconditions A retryable RoutecraftError, a non-retryable one, one overridden to retryable, and a plain Error
   * @expectedResult Only the non-retryable RoutecraftError is not transient
   */
  test("isTransient matches the default rule", () => {
    expect(isTransient(rcError("RC5010"))).toBe(true);
    expect(isTransient(rcError("RC5003"))).toBe(false);
    expect(isTransient(rcError("RC5003", undefined, { retryable: true }))).toBe(
      true,
    );
    expect(isTransient(new Error("unknown"))).toBe(true);
  });
});
