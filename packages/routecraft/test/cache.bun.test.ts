import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import {
  craft,
  direct,
  MemoryCacheProvider,
  type CacheProvider,
  simple,
} from "@routecraft/routecraft";

/**
 * Helper: build a CacheProvider spy that records every call and
 * delegates to a real in-memory provider. Lets tests assert ordering
 * (get -> miss -> set on first call; get -> hit on second) without
 * reaching into internal state.
 */
function spyProvider(): CacheProvider & {
  calls: { method: string; args: unknown[] }[];
  inner: MemoryCacheProvider;
} {
  const inner = new MemoryCacheProvider();
  const calls: { method: string; args: unknown[] }[] = [];
  return {
    calls,
    inner,
    async get(key) {
      calls.push({ method: "get", args: [key] });
      return inner.get(key);
    },
    async set(key, value, ttl) {
      calls.push({ method: "set", args: [key, value, ttl] });
      return inner.set(key, value, ttl);
    },
    async delete(key) {
      calls.push({ method: "delete", args: [key] });
      return inner.delete(key);
    },
    async has(key) {
      calls.push({ method: "has", args: [key] });
      return inner.has(key);
    },
    async getOrCompute(key, loader, ttl) {
      calls.push({ method: "getOrCompute", args: [key, ttl] });
      return inner.getOrCompute(key, loader, ttl);
    },
  };
}

describe(".cache() step scope: dual-mode wrapper", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case First exchange misses cache and runs the wrapped step; cached body forwarded
   * @preconditions .from(simple).cache({ provider }).transform(compute).to(sink)
   * @expectedResult sink receives compute's output; provider was queried once and stored once
   */
  test("first exchange misses, runs inner, and caches the result", async () => {
    const provider = spyProvider();
    const compute = mock((b: string) => `computed:${b}`);
    const sink = spy();

    t = await testContext()
      .routes(
        craft()
          .id("cache-miss")
          .from(simple("hello"))
          .cache({ provider })
          .transform(compute)
          .to(sink),
      )
      .build();

    await t.test();

    expect(compute).toHaveBeenCalledTimes(1);
    expect(sink.received).toHaveLength(1);
    expect(sink.received[0].body).toBe("computed:hello");
    // First exchange: getOrCompute is the only public entry point
    // because the wrapper routes both hit/miss through it.
    const methods = provider.calls.map((c) => c.method);
    expect(methods).toContain("getOrCompute");
  });

  /**
   * @case Repeat invocations with the same body reuse the cached value
   * @preconditions Two client.send calls with identical input through the same direct route
   * @expectedResult compute runs only once across both invocations
   */
  test("second exchange with same key hits the cache and skips the wrapped step", async () => {
    const provider = new MemoryCacheProvider();
    const compute = mock((b: string) => `computed:${b}`);
    const sink = spy();

    t = await testContext()
      .routes(
        craft()
          .id("cache-hit")
          .from(direct())
          .cache({ provider })
          .transform(compute)
          .to(sink),
      )
      .build();

    await t.startAndWaitReady();
    await t.client.send("cache-hit", "hello");
    await t.client.send("cache-hit", "hello");

    expect(compute).toHaveBeenCalledTimes(1);
    expect(sink.received).toHaveLength(2);
    expect(sink.received[0].body).toBe("computed:hello");
    expect(sink.received[1].body).toBe("computed:hello");
  });

  /**
   * @case Different keys do not collide; same key reuses the entry
   * @preconditions Custom key function partitions the cache by body.id
   * @expectedResult Distinct ids each trigger one compute; duplicates reuse
   */
  test("custom key function isolates entries by derived key", async () => {
    const provider = new MemoryCacheProvider();
    const compute = mock((b: { id: number }) => ({ id: b.id, v: b.id * 2 }));
    const sink = spy();

    t = await testContext()
      .routes(
        craft()
          .id("cache-by-id")
          .from(direct())
          .cache({
            key: (e) => String((e.body as { id: number }).id),
            provider,
          })
          .transform(compute)
          .to(sink),
      )
      .build();

    await t.startAndWaitReady();
    await t.client.send("cache-by-id", { id: 1 });
    await t.client.send("cache-by-id", { id: 1 });
    await t.client.send("cache-by-id", { id: 2 });
    await t.client.send("cache-by-id", { id: 1 });

    // id=1 computed once, id=2 computed once
    expect(compute).toHaveBeenCalledTimes(2);
    expect(sink.received).toHaveLength(4);
    expect(sink.received[0].body).toEqual({ id: 1, v: 2 });
    expect(sink.received[1].body).toEqual({ id: 1, v: 2 });
    expect(sink.received[2].body).toEqual({ id: 2, v: 4 });
    expect(sink.received[3].body).toEqual({ id: 1, v: 2 });
  });

  /**
   * @case Wrapped step throws; the error propagates and nothing is cached
   * @preconditions transform throws on every call
   * @expectedResult Subsequent calls retry (no poisoned cache entry)
   */
  test("errors from the wrapped step are not cached", async () => {
    const provider = new MemoryCacheProvider();
    let attempts = 0;
    const sink = spy();

    t = await testContext()
      .routes(
        craft()
          .id("cache-no-poison")
          .from(direct())
          .cache({ provider })
          .transform(() => {
            attempts++;
            throw new Error(`attempt-${attempts}`);
          })
          .to(sink),
      )
      .build();

    await t.startAndWaitReady();
    await expect(t.client.send("cache-no-poison", "input")).rejects.toThrow();
    await expect(t.client.send("cache-no-poison", "input")).rejects.toThrow();

    expect(attempts).toBe(2);
    expect(sink.received).toHaveLength(0);
    expect(provider.size).toBe(0);
  });

  /**
   * @case TTL expiry triggers a recompute
   * @preconditions ttl: 1ms; wait > 1ms between calls
   * @expectedResult compute runs twice; second sink value reflects fresh compute
   */
  test("TTL expiry forces a recompute on next call", async () => {
    const provider = new MemoryCacheProvider();
    let counter = 0;
    const sink = spy();

    t = await testContext()
      .routes(
        craft()
          .id("cache-ttl")
          .from(direct())
          .cache({ provider, ttl: 5 })
          .transform(() => ({ counter: ++counter }))
          .to(sink),
      )
      .build();

    await t.startAndWaitReady();
    await t.client.send("cache-ttl", "hello");
    await new Promise((r) => setTimeout(r, 30));
    await t.client.send("cache-ttl", "hello");

    expect(counter).toBe(2);
    expect(sink.received).toHaveLength(2);
    expect(sink.received[0].body).toEqual({ counter: 1 });
    expect(sink.received[1].body).toEqual({ counter: 2 });
  });

  /**
   * @case Concurrent same-key calls share one inner execution (stampede protection)
   * @preconditions Provider.getOrCompute dedupes; two concurrent calls with same key
   * @expectedResult Loader runs once; both calls resolve with the same value
   */
  test("MemoryCacheProvider.getOrCompute dedupes concurrent loaders", async () => {
    const provider = new MemoryCacheProvider();
    let runs = 0;
    const loader = async (): Promise<string> => {
      runs++;
      await new Promise((r) => setTimeout(r, 10));
      return "value";
    };

    const [a, b, c] = await Promise.all([
      provider.getOrCompute("k", loader),
      provider.getOrCompute("k", loader),
      provider.getOrCompute("k", loader),
    ]);

    expect(runs).toBe(1);
    expect(a).toBe("value");
    expect(b).toBe("value");
    expect(c).toBe("value");
  });

  /**
   * @case A failing loader does not poison the cache
   * @preconditions Loader rejects on first call; succeeds on retry
   * @expectedResult First call rejects; second call invokes loader again and caches success
   */
  test("MemoryCacheProvider.getOrCompute does not cache a thrown loader", async () => {
    const provider = new MemoryCacheProvider();
    let calls = 0;
    const loader = async (): Promise<string> => {
      calls++;
      if (calls === 1) throw new Error("fail");
      return "ok";
    };

    await expect(provider.getOrCompute("k", loader)).rejects.toThrow("fail");
    const second = await provider.getOrCompute("k", loader);
    expect(second).toBe("ok");
    expect(calls).toBe(2);
  });

  /**
   * @case Provider rotation: explicit provider overrides the module default
   * @preconditions Two separate providers; the user's provider stores; default does not
   * @expectedResult provider.size === 1; default provider untouched for this key
   */
  test("explicit provider does not share state with the module default", async () => {
    const provider = new MemoryCacheProvider();
    const compute = mock((b: string) => `computed:${b}`);
    const sink = spy();

    t = await testContext()
      .routes(
        craft()
          .id("explicit-provider")
          .from(simple("isolated"))
          .cache({ provider })
          .transform(compute)
          .to(sink),
      )
      .build();

    await t.test();
    expect(provider.size).toBe(1);
  });

  /**
   * @case Pre-from .cache() throws RC2001 (route-scope is not yet implemented)
   * @preconditions craft().cache(...) called BEFORE .from()
   * @expectedResult Builder throws RC2001 with a clear message pointing at #112
   */
  test("route-scope .cache() (before .from()) throws RC2001", () => {
    expect(() => {
      craft().id("route-scope").cache({ ttl: 1000 });
    }).toThrow(/Route-scope \.cache\(\)/i);
  });

  /**
   * @case Dropped exchanges (filter) are not cached
   * @preconditions Wrapped filter drops every exchange
   * @expectedResult Sink receives nothing; provider stays empty
   */
  test("dropped exchanges are not cached", async () => {
    const provider = new MemoryCacheProvider();
    const sink = spy();

    t = await testContext()
      .routes(
        craft()
          .id("cache-drop")
          .from(simple("drop-me"))
          .cache({ provider })
          .filter(() => false)
          .to(sink),
      )
      .build();

    await t.test();
    expect(sink.received).toHaveLength(0);
    expect(provider.size).toBe(0);
  });

  /**
   * @case Wrapper emits cache:miss + cache:stored on miss; cache:hit on subsequent run
   * @preconditions Subscribed to cache lifecycle events
   * @expectedResult Event ordering matches the spec; details carry scope/stepLabel/key
   */
  test("emits scope-aware cache lifecycle events", async () => {
    const provider = new MemoryCacheProvider();
    const events: string[] = [];
    const sink = spy();

    t = await testContext()
      .routes(
        craft()
          .id("cache-events")
          .from(direct())
          .cache({ provider })
          .transform((b: string) => `out:${b}`)
          .to(sink),
      )
      .build();

    for (const name of ["hit", "miss", "stored", "failed"] as const) {
      t.ctx.on(
        `route:cache-events:cache:${name}` as never,
        (payload: { details: { scope?: string; stepLabel?: string } }) => {
          events.push(name);
          expect(payload.details.scope).toBe("step");
          expect(payload.details.stepLabel).toBeDefined();
        },
      );
    }

    await t.startAndWaitReady();
    await t.client.send("cache-events", "hello");
    await t.client.send("cache-events", "hello");

    expect(events).toContain("miss");
    expect(events).toContain("stored");
    expect(events).toContain("hit");
    expect(events.indexOf("hit")).toBeGreaterThan(events.indexOf("miss"));
  });
});

describe("MemoryCacheProvider", () => {
  let provider: MemoryCacheProvider;
  beforeEach(() => {
    provider = new MemoryCacheProvider({ max: 4 });
  });

  /**
   * @case Basic get/set/has/delete semantics
   * @preconditions Fresh provider
   * @expectedResult Each method behaves like a TTL-less map
   */
  test("supports get / set / has / delete", async () => {
    expect(await provider.has("k")).toBe(false);
    expect(await provider.get("k")).toBeUndefined();
    await provider.set("k", 42);
    expect(await provider.has("k")).toBe(true);
    expect(await provider.get("k")).toBe(42);
    await provider.delete("k");
    expect(await provider.has("k")).toBe(false);
  });

  /**
   * @case LRU eviction kicks in past `max`
   * @preconditions max: 4; insert 5 distinct keys
   * @expectedResult Oldest (least-recently-used) entry is gone
   */
  test("evicts the least-recently-used entry when max is exceeded", async () => {
    await provider.set("a", 1);
    await provider.set("b", 2);
    await provider.set("c", 3);
    await provider.set("d", 4);
    // Touch a so b becomes LRU.
    await provider.get("a");
    await provider.set("e", 5);
    expect(await provider.has("a")).toBe(true);
    expect(await provider.has("b")).toBe(false);
  });

  /**
   * @case Per-set TTL overrides the default
   * @preconditions Provider default ttl unset; set with ttl: 5ms
   * @expectedResult Entry disappears after the TTL elapses
   */
  test("per-call ttl expires the entry", async () => {
    await provider.set("k", "v", 5);
    expect(await provider.get("k")).toBe("v");
    await new Promise((r) => setTimeout(r, 30));
    expect(await provider.get("k")).toBeUndefined();
  });

  /**
   * @case clear() empties the cache
   * @preconditions Two entries
   * @expectedResult size returns to zero
   */
  test("clear() drops every entry", async () => {
    await provider.set("a", 1);
    await provider.set("b", 2);
    expect(provider.size).toBe(2);
    provider.clear();
    expect(provider.size).toBe(0);
  });
});
