import { afterEach, describe, expect, test } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  CACHE,
  cacheProvider,
  craft,
  DefaultExchange,
  definePlugin,
  direct,
  MemoryCacheProvider,
  OperationType,
  RESILIENCE,
  resilienceProvider,
  simple,
  noop,
  type PositionRun,
  type StepOutcome,
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
   * @case A plugin replacing RESILIENCE fills the same methods placed after .from()
   * @preconditions A plugin provides and replaces RESILIENCE, delegating to the default provider but recording each position's scope; a route wraps one step in .retry(), .timeout(), .circuitBreaker(), .concurrency() and .throttle()
   * @expectedResult Every step-scope wrapper runs through the replacement with scope "step" and the wrapped step's label, so one port fills both scopes
   */
  test("a plugin replacing RESILIENCE fills the step-scope wrappers", async () => {
    const seen: string[] = [];
    const recording = definePlugin({
      id: "test.recording-resilience",
      provides: [RESILIENCE],
      replaces: [RESILIENCE],
      bind(c) {
        const wrap = (
          name: string,
          build: () => { run(run: PositionRun): Promise<StepOutcome> },
        ) => {
          const inner = build();
          return {
            run(run: PositionRun) {
              seen.push(`${name}:${run.scope}:${run.stepLabel}`);
              return inner.run(run);
            },
          };
        };
        c.provide(RESILIENCE, {
          throttle(options, scope) {
            seen.push(`throttle:${scope.scope}:${scope.stepLabel}`);
            return resilienceProvider.throttle(options, scope);
          },
          circuitBreaker: (options) =>
            wrap("circuitBreaker", () =>
              resilienceProvider.circuitBreaker(options),
            ),
          retry: (options) =>
            wrap("retry", () => resilienceProvider.retry(options)),
          timeout: (options) =>
            wrap("timeout", () => resilienceProvider.timeout(options)),
          concurrency: (options) =>
            wrap("concurrency", () => resilienceProvider.concurrency(options)),
        });
      },
    });
    t = await testContext()
      .with({ plugins: [recording] })
      .routes(
        craft()
          .id("wrapped")
          .from(direct())
          .retry({ maxAttempts: 2 })
          .timeout("1s")
          .circuitBreaker({ failureThreshold: 3 })
          .concurrency({ max: 2 })
          .throttle({ rate: 100, per: "1s" })
          .transform((body) => body)
          .to(noop()),
      )
      .build();
    await t.startAndWaitReady();

    await t.client.sendDirect("wrapped", "a");

    expect(seen).toEqual([
      "retry:step:transform",
      "timeout:step:transform",
      "circuitBreaker:step:transform",
      "concurrency:step:transform",
      "throttle:step:transform",
    ]);
  });

  /**
   * @case A step-scope throttle gate's outcome is what the wrapper acts on
   * @preconditions A plugin replacing RESILIENCE whose throttle gate completes the exchange with a substitute body instead of continuing; a route wraps a transform in .throttle()
   * @expectedResult The wrapped transform never runs and the caller receives the gate's body, as the executor would honour the same outcome from the route-scope gate
   */
  test("a step-scope throttle gate's outcome is honoured", async () => {
    let inner = 0;
    const completing = definePlugin({
      id: "test.completing-throttle",
      provides: [RESILIENCE],
      replaces: [RESILIENCE],
      bind(c) {
        c.provide(RESILIENCE, {
          ...resilienceProvider,
          throttle: () => ({
            operation: OperationType.THROTTLE,
            label: "throttle",
            adapter: { adapterId: "test.gate" },
            skipStepEvents: true,
            async execute(exchange) {
              return {
                kind: "complete",
                exchange: DefaultExchange.rewrap(exchange, { body: "gated" }),
              };
            },
          }),
        });
      },
    });
    t = await testContext()
      .with({ plugins: [completing] })
      .routes(
        craft()
          .id("gated")
          .from(direct())
          .throttle({ rate: 100 })
          .transform((body) => {
            inner++;
            return body;
          })
          .to(noop()),
      )
      .build();
    await t.startAndWaitReady();

    expect(await t.client.sendDirect<string, string>("gated", "a")).toBe(
      "gated",
    );
    expect(inner).toBe(0);
  });

  /**
   * @case A plugin replacing CACHE fills a .cache() placed after .from()
   * @preconditions A plugin provides and replaces CACHE, delegating to the default provider but counting step-scope runs; a route wraps one step in .cache()
   * @expectedResult The wrapper runs through the replacement's wrap position on every exchange, with the key the wrapper derived, and a second call is served from the cache
   */
  test("a plugin replacing CACHE fills the step-scope cache", async () => {
    const keys: string[] = [];
    let inner = 0;
    const counting = definePlugin({
      id: "test.counting-cache",
      provides: [CACHE],
      replaces: [CACHE],
      bind(c) {
        const positions = cacheProvider();
        c.provide(CACHE, {
          ...positions,
          wrap(options) {
            const position = positions.wrap(options);
            return {
              run(run) {
                keys.push(`${run.scope}:${run.stepLabel}:${run.key}`);
                return position.run(run);
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
          .id("cached")
          .from(direct())
          .cache({ key: () => "same" })
          .transform((body) => {
            inner++;
            return body;
          })
          .to(noop()),
      )
      .build();
    await t.startAndWaitReady();

    await t.client.sendDirect("cached", "a");
    await t.client.sendDirect("cached", "b");

    expect(keys).toEqual(["step:transform:same", "step:transform:same"]);
    expect(inner).toBe(1);
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
