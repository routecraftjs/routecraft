import { afterEach, describe, expect, test } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  craft,
  direct,
  definePlugin,
  rcCodeOf,
  when,
  otherwise,
  CACHE,
  RESILIENCE,
  type RouteBuilder,
} from "@routecraft/routecraft";

/** Displaces a default plugin without providing what it provided. */
const without = (id: "routecraft.resilience" | "routecraft.cache") =>
  definePlugin({ id });

async function startFailure(
  t: TestContext,
): Promise<{ code: string | undefined; message: string }> {
  try {
    await t.startAndWaitReady();
    return { code: undefined, message: "" };
  } catch (error) {
    return {
      code: rcCodeOf(error),
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

describe("step-scope positions are validated at route start", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    await t?.stop().catch(() => undefined);
    t = undefined;
  });

  /**
   * @case A missing RESILIENCE provider fails start at both scopes of .retry()
   * @preconditions The default resilience plugin is displaced by an empty descriptor; one route places .retry() before .from(), another after it
   * @expectedResult Both contexts refuse to start with RC1111 naming .retry() and the routecraft.resilience port; neither reaches dispatch
   */
  test(".retry() at route scope and step scope both fail start with RC1111", async () => {
    const routes: Record<string, RouteBuilder> = {
      route: craft()
        .id("work")
        .retry()
        .from(direct())
        .transform(() => "ok"),
      step: craft()
        .id("work")
        .from(direct())
        .retry()
        .transform(() => "ok"),
    };
    for (const [scope, route] of Object.entries(routes)) {
      t = await testContext()
        .with({ plugins: [without("routecraft.resilience")] })
        .routes([route])
        .build();
      const failure = await startFailure(t);
      expect([scope, failure.code]).toEqual([scope, "RC1111"]);
      expect(failure.message).toContain(".retry()");
      expect(failure.message).toContain(RESILIENCE.name);
      await t.stop().catch(() => undefined);
      t = undefined;
    }
  });

  /**
   * @case A missing CACHE provider fails start at both scopes of .cache()
   * @preconditions The default cache plugin is displaced by an empty descriptor; one route places .cache() before .from(), another after it
   * @expectedResult Both contexts refuse to start with RC1111 naming .cache() and the routecraft.cache port
   */
  test(".cache() at route scope and step scope both fail start with RC1111", async () => {
    const routes: Record<string, RouteBuilder> = {
      route: craft()
        .id("work")
        .cache()
        .from(direct())
        .transform(() => "ok"),
      step: craft()
        .id("work")
        .from(direct())
        .cache()
        .transform(() => "ok"),
    };
    for (const [scope, route] of Object.entries(routes)) {
      t = await testContext()
        .with({ plugins: [without("routecraft.cache")] })
        .routes([route])
        .build();
      const failure = await startFailure(t);
      expect([scope, failure.code]).toEqual([scope, "RC1111"]);
      expect(failure.message).toContain(".cache()");
      expect(failure.message).toContain(CACHE.name);
      await t.stop().catch(() => undefined);
      t = undefined;
    }
  });

  /**
   * @case Every provider-backed wrapper is checked, and the diagnostic names the wrapped step
   * @preconditions The default resilience plugin is displaced; a route wraps a transform step in each of .timeout(), .circuitBreaker(), .concurrency() and .throttle() in turn
   * @expectedResult Each route fails start with RC1111 naming its method, the wrapped step and the routecraft.resilience port
   */
  test("timeout, circuitBreaker, concurrency and throttle are checked and name the step", async () => {
    const wrapped: Record<string, (b: RouteBuilder) => RouteBuilder> = {
      timeout: (b) => b.timeout("1s"),
      circuitBreaker: (b) => b.circuitBreaker({ failureThreshold: 1 }),
      concurrency: (b) => b.concurrency({ max: 1 }),
      throttle: (b) => b.throttle({ rate: 1, per: "1s" }),
    };
    for (const [method, wrap] of Object.entries(wrapped)) {
      const route = wrap(craft().id("work").from(direct())).transform(
        () => "ok",
      );
      t = await testContext()
        .with({ plugins: [without("routecraft.resilience")] })
        .routes([route])
        .build();
      const failure = await startFailure(t);
      expect([method, failure.code]).toEqual([method, "RC1111"]);
      expect(failure.message).toContain(`.${method}()`);
      expect(failure.message).toContain('step "transform"');
      expect(failure.message).toContain(RESILIENCE.name);
      await t.stop().catch(() => undefined);
      t = undefined;
    }
  });

  /**
   * @case A wrapper nested in a .choice() branch is caught at start
   * @preconditions The default resilience plugin is displaced; the only .retry() sits inside a when() branch of a .choice()
   * @expectedResult The context refuses to start with RC1111 naming .retry()
   */
  test("a .retry() inside a .choice() branch fails start", async () => {
    t = await testContext()
      .with({ plugins: [without("routecraft.resilience")] })
      .routes([
        craft()
          .id("work")
          .from(direct())
          .choice(
            when(
              () => true,
              (b) => b.retry().transform(() => "branch"),
            ),
            otherwise((b) => b.transform(() => "other")),
          ),
      ])
      .build();
    const failure = await startFailure(t);
    expect(failure.code).toBe("RC1111");
    expect(failure.message).toContain(".retry()");
  });

  /**
   * @case A wrapper stacked under a step-scope .error() is caught at start
   * @preconditions The default resilience plugin is displaced; .error(h).retry() wraps the step, so the retry wrapper is the error wrapper's inner step
   * @expectedResult The context refuses to start with RC1111 naming .retry(); .error() itself requires no provider
   */
  test("a .retry() wrapped by .error() fails start", async () => {
    t = await testContext()
      .with({ plugins: [without("routecraft.resilience")] })
      .routes([
        craft()
          .id("work")
          .from(direct())
          .error(() => "recovered")
          .retry()
          .transform(() => "ok"),
      ])
      .build();
    const failure = await startFailure(t);
    expect(failure.code).toBe("RC1111");
    expect(failure.message).toContain(".retry()");
  });

  /**
   * @case Wrappers that resolve no provider start without one
   * @preconditions Both default plugins are displaced; the route uses only step-scope .error() and .delay()
   * @expectedResult The context starts and the route answers a direct call
   */
  test(".error() and .delay() need no provider", async () => {
    t = await testContext()
      .with({
        plugins: [
          without("routecraft.resilience"),
          without("routecraft.cache"),
        ],
      })
      .routes([
        craft()
          .id("work")
          .from(direct())
          .error(() => "recovered")
          .delay(1)
          .transform(() => "ok"),
      ])
      .build();
    await t.startAndWaitReady();
    expect(await t.client.sendDirect<object, string>("work", {})).toBe("ok");
  });

  /**
   * @case A correctly configured route starts and runs
   * @preconditions The default plugins are installed; the route stacks .error(), .retry(), .timeout() and .cache() at step scope and nests a .retry() in a .choice() branch
   * @expectedResult The context reports ready and the route answers a direct call
   */
  test("a route with providers for every wrapper still starts and runs", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("work")
          .from(direct())
          .error(() => "recovered")
          .retry({ maxAttempts: 2, backoff: 0 })
          .timeout("1s")
          .cache()
          .transform(() => "ok")
          .choice(
            when(
              () => true,
              (b) => b.retry().transform((body) => `${body}:branch`),
            ),
            otherwise((b) => b.transform(() => "other")),
          ),
      ])
      .build();
    await t.startAndWaitReady();
    expect(await t.client.sendDirect<object, string>("work", {})).toBe(
      "ok:branch",
    );
  });
});
