import { afterEach, describe, expect, test } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  craft,
  direct,
  MemoryCacheProvider,
  OperationType,
  simple,
  noop,
} from "@routecraft/routecraft";

describe("pre-from filter chain assembly", () => {
  /**
   * @case Builder call order does NOT change the runtime chain order
   * @preconditions Two routes declared with different builder orders; both have .authorize(), .cache(), .error()
   * @expectedResult Both routes produce identical preParseFilters / postParseFilters / postFromFilters arrays
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

    expect(a!.preParseFilters.map((f) => f.label)).toEqual(
      b!.preParseFilters.map((f) => f.label),
    );
    expect(a!.postParseFilters.map((f) => f.label)).toEqual(
      b!.postParseFilters.map((f) => f.label),
    );
    expect(a!.postFromFilters.map((f) => f.label)).toEqual(
      b!.postFromFilters.map((f) => f.label),
    );
  });

  /**
   * @case Authorize sits in preParseFilters, cache-check in postParseFilters, cache-store in postFromFilters
   * @preconditions Route declares .authorize().cache().from()
   * @expectedResult Each filter lands in the documented slot per .standards/pre-from-filter-chain.md
   */
  test("filters land in the documented chain positions", () => {
    const [route] = craft()
      .id("chain-positions")
      .authorize({ roles: ["admin"] })
      .cache({ ttl: 60_000 })
      .from(simple("x"))
      .to(noop())
      .build();

    expect(route!.preParseFilters).toHaveLength(1);
    expect(route!.preParseFilters[0]!.operation).toBe(OperationType.VALIDATE);

    expect(route!.postParseFilters.map((f) => f.label)).toEqual([
      "cache-check",
    ]);

    expect(route!.postFromFilters.map((f) => f.label)).toEqual(["cache-store"]);
  });

  /**
   * @case Multiple .authorize() calls stack in declaration order in preParseFilters
   * @preconditions Route declares two .authorize() calls
   * @expectedResult preParseFilters has two ValidateSteps in the order declared
   */
  test("stacked .authorize() calls populate preParseFilters in declaration order", () => {
    const [route] = craft()
      .id("stacked-authorize")
      .authorize({ roles: ["admin"] })
      .authorize({ scopes: ["billing:write"] })
      .from(simple("x"))
      .to(noop())
      .build();

    expect(route!.preParseFilters).toHaveLength(2);
    expect(route!.preParseFilters[0]!.operation).toBe(OperationType.VALIDATE);
    expect(route!.preParseFilters[1]!.operation).toBe(OperationType.VALIDATE);
  });

  /**
   * @case Routes with neither .authorize() nor .cache() have empty filter arrays
   * @preconditions Bare route with just a source and destination
   * @expectedResult All three filter arrays are empty
   */
  test("routes with no chain features have empty filter arrays", () => {
    const [route] = craft().id("bare").from(simple("x")).to(noop()).build();

    expect(route!.preParseFilters).toEqual([]);
    expect(route!.postParseFilters).toEqual([]);
    expect(route!.postFromFilters).toEqual([]);
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
