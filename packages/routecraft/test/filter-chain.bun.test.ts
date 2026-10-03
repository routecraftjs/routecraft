import { afterEach, describe, expect, test } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  craft,
  definePlugin,
  direct,
  MemoryCacheProvider,
  OperationType,
  RESILIENCE,
  resilienceProvider,
  simple,
  noop,
} from "@routecraft/routecraft";
import { compilePositions } from "../src/pipeline/positions.ts";

describe("pre-from filter chain assembly", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case Builder call order does NOT change what the route definition configures
   * @preconditions Two routes declared with different builder orders; both have .authorize(), .cache(), .error()
   * @expectedResult Both definitions carry the same authorize and cache configuration
   */
  test("builder declaration order does not affect chain assembly", () => {
    const [a] = craft()
      .id("a")
      .authorize()
      .error(() => "recovered")
      .cache({ ttl: 1000 })
      .from(simple("x"))
      .to(noop())
      .build();

    const [b] = craft()
      .id("b")
      .cache({ ttl: 1000 })
      .error(() => "recovered")
      .authorize()
      .from(simple("x"))
      .to(noop())
      .build();

    expect(a!.authorize).toEqual(b!.authorize);
    expect(a!.cache?.ttl).toBe(b!.cache?.ttl);
  });

  /**
   * @case The default providers fill authorize with a gate and the cache pair with check and store steps
   * @preconditions Route declares .authorize().cache().from(); compiled against an application with the default plugins
   * @expectedResult One validate gate in authorize, a cache-check step, and a cache-store step
   */
  test("filters land in the documented chain positions", async () => {
    const [route] = craft()
      .id("chain-positions")
      .authorize({ roles: ["admin"] })
      .cache({ ttl: 60_000 })
      .from(simple("x"))
      .to(noop())
      .build();
    t = await testContext().build();

    const positions = compilePositions(route!, t.ctx);

    expect(positions.authorize).toHaveLength(1);
    expect(positions.authorize[0]!.operation).toBe(OperationType.VALIDATE);
    expect(positions.cacheCheck?.label).toBe("cache-check");
    expect(positions.cacheStore?.label).toBe("cache-store");
  });

  /**
   * @case Multiple .authorize() calls stack in declaration order
   * @preconditions Route declares two .authorize() calls
   * @expectedResult The definition carries both in order, and two validate gates compile from them
   */
  test("stacked .authorize() calls fill authorize in declaration order", async () => {
    const [route] = craft()
      .id("stacked-authorize")
      .authorize({ roles: ["admin"] })
      .authorize({ scopes: ["billing:write"] })
      .from(simple("x"))
      .to(noop())
      .build();
    t = await testContext().build();

    expect(route!.authorize).toEqual([
      { roles: ["admin"] },
      { scopes: ["billing:write"] },
    ]);
    const positions = compilePositions(route!, t.ctx);
    expect(positions.authorize.map((gate) => gate.operation)).toEqual([
      OperationType.VALIDATE,
      OperationType.VALIDATE,
    ]);
  });

  /**
   * @case A route with no chain features configures no positions
   * @preconditions Bare route with just a source and destination
   * @expectedResult No position field is set on the definition, and nothing compiles
   */
  test("routes with no chain features configure no positions", async () => {
    const [route] = craft().id("bare").from(simple("x")).to(noop()).build();
    t = await testContext().build();

    for (const field of [
      "authorize",
      "cache",
      "throttle",
      "circuitBreaker",
      "retry",
      "timeout",
      "concurrency",
    ] as const) {
      expect(route![field]).toBeUndefined();
    }
    expect(compilePositions(route!, t.ctx)).toEqual({
      authorize: [],
      throttle: [],
      concurrency: [],
    });
  });

  /**
   * @case A configured position whose port nobody provides refuses the route
   * @preconditions Route declares .retry(); the positions compile against a context whose lookup finds no provider
   * @expectedResult RC1111 naming the route, the method and the port
   */
  test("a position with no provider is RC1111", () => {
    const [route] = craft()
      .id("unprovided")
      .retry({ maxAttempts: 2 })
      .from(simple("x"))
      .to(noop())
      .build();

    expect(() => compilePositions(route!, { lookup: () => undefined })).toThrow(
      expect.objectContaining({
        rc: "RC1111",
        message: expect.stringContaining(
          'Route "unprovided" uses .retry(), and no installed plugin provides "routecraft.resilience@1"',
        ),
      }),
    );
  });

  /**
   * @case An installed plugin that replaces RESILIENCE fills the route's resilience positions
   * @preconditions A plugin provides and replaces RESILIENCE, delegating to the default provider but counting retry runs; a route declares .retry()
   * @expectedResult The route's retry position runs through the replacement on every exchange
   */
  test("a plugin replacing RESILIENCE fills the retry position", async () => {
    let runs = 0;
    const counting = definePlugin({
      id: "test.counting-resilience",
      provides: [RESILIENCE],
      replaces: [RESILIENCE],
      bind(c) {
        c.provide(RESILIENCE, {
          ...resilienceProvider,
          retry(options) {
            const inner = resilienceProvider.retry(options);
            return {
              run(run) {
                runs++;
                return inner.run(run);
              },
            };
          },
        });
      },
    });
    t = await testContext()
      .with({ plugins: [counting] })
      .routes(
        craft()
          .id("replaced-retry")
          .retry({ maxAttempts: 2 })
          .from(direct())
          .to(noop()),
      )
      .build();
    await t.startAndWaitReady();

    await t.client.sendDirect("replaced-retry", "a");
    await t.client.sendDirect("replaced-retry", "b");

    expect(runs).toBe(2);
  });
});

describe("pre-from filter chain runtime", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case Cache key set by `cache-check` survives user-step body rewrites and is read by `cache-store`
   * @preconditions Route-scope cache + a transform that rewrites the body (forcing a rewrap between check and store)
   * @expectedResult First call misses (transform runs, cache writes); second call hits (transform skipped). Verifies internals.cacheKey persists across rewrap.
   */
  test("internals.cacheKey persists across user-step rewraps from cache-check to cache-store", async () => {
    const provider = new MemoryCacheProvider();
    let transformRuns = 0;

    t = await testContext()
      .routes(
        craft()
          .id("cache-key-rewrap")
          .cache({ provider, key: (e) => String(e.body) })
          .from(direct())
          .transform((b) => {
            transformRuns++;
            // Body mutation forces a rewrap; the new exchange must
            // still carry internals.cacheKey from the cache-check step
            // for cache-store to find it at the tail.
            return `transformed:${b}`;
          })
          .to(noop()),
      )
      .build();

    await t.startAndWaitReady();
    const first = await t.client.sendDirect("cache-key-rewrap", "hello");
    const second = await t.client.sendDirect("cache-key-rewrap", "hello");

    expect(transformRuns).toBe(1);
    expect(first).toBe("transformed:hello");
    expect(second).toBe("transformed:hello");
    expect(provider.size).toBe(1);
  });
});
