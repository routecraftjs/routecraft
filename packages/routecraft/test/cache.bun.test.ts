import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import {
  craft,
  CacheWrapperStep,
  DefaultExchange,
  direct,
  markAuthentic,
  MemoryCacheProvider,
  noop,
  type Adapter,
  type CacheProvider,
  type Exchange,
  type Principal,
  type Source,
  type Step,
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
   * @case Pre-from .cache() stages route-scope config (does not throw)
   * @preconditions craft().cache(...) called BEFORE .from()
   * @expectedResult Builder accepts the call; the next route carries the route-scope config
   */
  test("route-scope .cache() (before .from()) stages without throwing", () => {
    expect(() => {
      craft()
        .id("route-scope")
        .cache({ ttl: 1000 })
        .from(simple("x"))
        .to(noop());
    }).not.toThrow();
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

  /**
   * @case On a miss the wrapped step's header mutations survive downstream
   * @preconditions .cache().header('x-test', 'yes').to(sink); single send (miss)
   * @expectedResult sink sees the header set by the wrapped step (not stripped by the cache rewrap)
   */
  test("preserves the wrapped step's header mutations on a miss", async () => {
    const provider = new MemoryCacheProvider();
    const sink = spy();

    t = await testContext()
      .routes(
        craft()
          .id("cache-headers")
          .from(direct())
          .cache({ provider })
          .header("x-test", "yes")
          .to(sink),
      )
      .build();

    await t.startAndWaitReady();
    await t.client.send("cache-headers", "body");

    expect(sink.received).toHaveLength(1);
    expect(sink.received[0].headers["x-test"]).toBe("yes");
  });

  /**
   * @case A `null` result is a valid cached value (not a perpetual miss)
   * @preconditions Wrapped transform returns null
   * @expectedResult compute runs once across two sends; both sink bodies are null
   */
  test("caches a null result instead of recomputing forever", async () => {
    const provider = new MemoryCacheProvider();
    let calls = 0;
    const sink = spy();

    t = await testContext()
      .routes(
        craft()
          .id("cache-null")
          .from(direct())
          .cache({ provider })
          .transform(() => {
            calls++;
            return null;
          })
          .to(sink),
      )
      .build();

    await t.startAndWaitReady();
    await t.client.send("cache-null", "x");
    await t.client.send("cache-null", "x");

    expect(calls).toBe(1);
    expect(sink.received).toHaveLength(2);
    expect(sink.received[0].body).toBeNull();
    expect(sink.received[1].body).toBeNull();
  });

  /**
   * @case A legitimate `undefined` body is not mistaken for a drop
   * @preconditions Wrapped transform returns undefined
   * @expectedResult Pipeline continues (sink reached); undefined is not cached so it recomputes
   */
  test("an undefined body is forwarded, not treated as a drop", async () => {
    const provider = new MemoryCacheProvider();
    let calls = 0;
    const sink = spy();

    t = await testContext()
      .routes(
        craft()
          .id("cache-undefined")
          .from(direct())
          .cache({ provider })
          .transform(() => {
            calls++;
            return undefined;
          })
          .to(sink),
      )
      .build();

    await t.startAndWaitReady();
    await t.client.send("cache-undefined", "x");
    await t.client.send("cache-undefined", "x");

    // undefined is the miss sentinel: never cached, so it recomputes.
    expect(calls).toBe(2);
    expect(provider.size).toBe(0);
    // The exchange still flowed to the sink (not dropped).
    expect(sink.received).toHaveLength(2);
    expect(sink.received[0].body).toBeUndefined();
  });

  /**
   * @case Stacked .error(h).cache().to(d): error OUTSIDE cache catches the rethrow
   * @preconditions error wraps cache wraps a throwing transform
   * @expectedResult Handler recovers; nothing is cached (error is outside the cache)
   */
  test("stacked .error().cache(): handler recovers and nothing is cached", async () => {
    const provider = new MemoryCacheProvider();
    const sink = spy();
    let attempts = 0;

    t = await testContext()
      .routes(
        craft()
          .id("error-outside-cache")
          .from(direct())
          .error(() => ({ recovered: true }))
          .cache({ provider })
          .transform(() => {
            attempts++;
            throw new Error("boom");
          })
          .to(sink),
      )
      .build();

    await t.startAndWaitReady();
    await t.client.send("error-outside-cache", "x");
    await t.client.send("error-outside-cache", "x");

    expect(attempts).toBe(2);
    expect(provider.size).toBe(0);
    expect(sink.received).toHaveLength(2);
    expect(sink.received[0].body).toEqual({ recovered: true });
  });

  /**
   * @case Stacked .cache().error(h): recovery value IS cached (documented footgun)
   * @preconditions cache wraps error wraps a throwing transform
   * @expectedResult Handler runs once; recovered value is cached and replayed on the second send
   */
  test("stacked .cache().error(): recovery value is cached and replayed", async () => {
    const provider = new MemoryCacheProvider();
    const sink = spy();
    let handlerCalls = 0;

    t = await testContext()
      .routes(
        craft()
          .id("error-inside-cache")
          .from(direct())
          .cache({ provider })
          .error(() => {
            handlerCalls++;
            return { recovered: true };
          })
          .transform(() => {
            throw new Error("boom");
          })
          .to(sink),
      )
      .build();

    await t.startAndWaitReady();
    await t.client.send("error-inside-cache", "x");
    await t.client.send("error-inside-cache", "x");

    // Second send is a cache hit: the handler is not invoked again.
    expect(handlerCalls).toBe(1);
    expect(sink.received).toHaveLength(2);
    expect(sink.received[0].body).toEqual({ recovered: true });
    expect(sink.received[1].body).toEqual({ recovered: true });
  });

  /**
   * @case A cache rethrow cascades to a route-level .error() handler
   * @preconditions Route-level .error() before .from(); wrapped transform throws
   * @expectedResult Route handler is invoked once and the route reports no unhandled errors (route-scope recovery does not resume the pipeline, matching existing .error() semantics)
   */
  test("cache failure cascades to the route-level error handler", async () => {
    const provider = new MemoryCacheProvider();
    const routeHandler = mock(() => ({ caughtAtRoute: true }));
    const sink = spy();

    t = await testContext()
      .routes(
        craft()
          .id("cache-cascade")
          .error(routeHandler)
          .from(simple("x"))
          .cache({ provider })
          .transform(() => {
            throw new Error("boom");
          })
          .to(sink),
      )
      .build();

    await t.test();

    expect(routeHandler).toHaveBeenCalledTimes(1);
    expect(t.errors).toHaveLength(0);
    expect(provider.size).toBe(0);
  });

  /**
   * @case With no handler, a cache rethrow hits the default error path
   * @preconditions No route/step handler; wrapped transform throws; simple source
   * @expectedResult t.errors records the failure; sink not reached; route not stopped
   */
  test("cache failure with no handler hits the default error path", async () => {
    const provider = new MemoryCacheProvider();
    const sink = spy();

    t = await testContext()
      .routes(
        craft()
          .id("cache-default-error")
          .from(simple("x"))
          .cache({ provider })
          .transform(() => {
            throw new Error("boom-default");
          })
          .to(sink),
      )
      .build();

    await t.test();
    expect(t.errors[0]?.message).toMatch(/boom-default/);
    expect(sink.received).toHaveLength(0);
    expect(provider.size).toBe(0);
  });

  /**
   * @case Builder body type is preserved across .cache()
   * @preconditions transform<string,number> then .cache() then transform<number,number>
   * @expectedResult Compiles (tsc enforces the number input after cache) and runs end to end
   */
  test("preserves the builder body type across the wrapper", async () => {
    const provider = new MemoryCacheProvider();
    const sink = spy();

    t = await testContext()
      .routes(
        craft()
          .id("cache-types")
          .from(direct())
          .transform((b: string) => b.length)
          .cache({ provider })
          // If .cache() dropped the type, `n: number` would not type-check.
          .transform((n: number) => n * 2)
          .to(sink),
      )
      .build();

    await t.startAndWaitReady();
    await t.client.send("cache-types", "abcd");

    expect(sink.received).toHaveLength(1);
    expect(sink.received[0].body).toBe(8);
  });

  /**
   * @case Concurrent same-key exchanges share one inner run through the wrapper (stampede)
   * @preconditions Hand-built CacheWrapperStep over a slow inner; two real exchanges, same key, executed concurrently
   * @expectedResult Inner runs once; the loser deduped via the in-flight path; both queues forward the shared body
   */
  test("concurrent same-key exchanges share one inner run through the wrapper", async () => {
    // A real context is needed so the dedup path's DefaultExchange.rewrap
    // works on the waiter exchange. Hand-build the wrapper (rather than
    // routing) to drive deterministic concurrency into a single instance.
    t = await testContext()
      .routes(craft().id("ctx-host").from(simple("x")).to(noop()))
      .build();
    await t.startAndWaitReady();
    const ctx = t.ctx;

    const provider = new MemoryCacheProvider();
    let runs = 0;
    const innerStep: Step<Adapter> = {
      operation: "transform" as Step<Adapter>["operation"],
      adapter: { adapterId: "fake.inner" } as unknown as Adapter,
      async execute(
        exchange: Exchange,
        _remaining: Step<Adapter>[],
        queue: { exchange: Exchange; steps: Step<Adapter>[] }[],
      ): Promise<void> {
        runs++;
        await new Promise((r) => setTimeout(r, 20));
        queue.push({
          exchange: DefaultExchange.rewrap(exchange, { body: "value" }),
          steps: [],
        });
      },
    };
    const wrapper = new CacheWrapperStep(innerStep, {
      provider,
      key: () => "same",
    });

    const ex1 = new DefaultExchange(ctx, { body: "a" });
    const ex2 = new DefaultExchange(ctx, { body: "b" });
    const q1: { exchange: Exchange; steps: Step<Adapter>[] }[] = [];
    const q2: { exchange: Exchange; steps: Step<Adapter>[] }[] = [];

    await Promise.all([
      wrapper.execute(ex1, [], q1),
      wrapper.execute(ex2, [], q2),
    ]);

    expect(runs).toBe(1);
    expect(q1).toHaveLength(1);
    expect(q2).toHaveLength(1);
    expect(q1[0]!.exchange.body).toBe("value");
    expect(q2[0]!.exchange.body).toBe("value");
  });

  /**
   * @case Concurrent drop: when the loader drops, the deduped waiter drops too
   * @preconditions Hand-built wrapper; slow inner that pushes nothing (a drop); two concurrent same-key exchanges
   * @expectedResult Inner runs once; neither exchange is forwarded; nothing is cached
   */
  test("concurrent drop propagates to the deduped waiter", async () => {
    t = await testContext()
      .routes(craft().id("ctx-host-drop").from(simple("x")).to(noop()))
      .build();
    await t.startAndWaitReady();
    const ctx = t.ctx;

    const provider = new MemoryCacheProvider();
    let runs = 0;
    const droppingInner: Step<Adapter> = {
      operation: "filter" as Step<Adapter>["operation"],
      adapter: { adapterId: "fake.filter" } as unknown as Adapter,
      async execute(): Promise<void> {
        runs++;
        await new Promise((r) => setTimeout(r, 20));
        // Push nothing: an empty inner queue signals a drop to the wrapper.
      },
    };
    const wrapper = new CacheWrapperStep(droppingInner, {
      provider,
      key: () => "same",
    });

    const ex1 = new DefaultExchange(ctx, { body: "a" });
    const ex2 = new DefaultExchange(ctx, { body: "b" });
    const q1: { exchange: Exchange; steps: Step<Adapter>[] }[] = [];
    const q2: { exchange: Exchange; steps: Step<Adapter>[] }[] = [];

    await Promise.all([
      wrapper.execute(ex1, [], q1),
      wrapper.execute(ex2, [], q2),
    ]);

    expect(runs).toBe(1);
    // Both exchanges dropped: nothing forwarded downstream, nothing cached.
    expect(q1).toHaveLength(0);
    expect(q2).toHaveLength(0);
    expect(provider.size).toBe(0);
  });

  /**
   * @case A provider read failure is wrapped as RC5028 (retryable boundary code)
   * @preconditions Custom provider whose getOrCompute throws before running the loader
   * @expectedResult The wrapped step never runs; the failure surfaces as RC5028
   */
  test("provider read failure surfaces as RC5028", async () => {
    let innerRuns = 0;
    const failing: CacheProvider = {
      async get() {
        return undefined;
      },
      async set() {},
      async delete() {},
      async has() {
        return false;
      },
      async getOrCompute() {
        throw new Error("redis-unreachable");
      },
    };
    const sink = spy();

    t = await testContext()
      .routes(
        craft()
          .id("cache-provider-read-fail")
          .from(direct())
          .cache({ provider: failing })
          .transform((b: string) => {
            innerRuns++;
            return b;
          })
          .to(sink),
      )
      .build();

    await t.startAndWaitReady();
    await expect(
      t.client.send("cache-provider-read-fail", "x"),
    ).rejects.toThrow(/provider read failed/);
    expect(innerRuns).toBe(0);
    expect(sink.received).toHaveLength(0);
  });

  /**
   * @case A provider write failure (after the step succeeds) is wrapped as RC5028
   * @preconditions Custom provider whose getOrCompute runs the loader then throws
   * @expectedResult The wrapped step runs once; the failure surfaces as RC5028 (phase "set")
   */
  test("provider write failure surfaces as RC5028", async () => {
    let innerRuns = 0;
    const failing: CacheProvider = {
      async get() {
        return undefined;
      },
      async set() {},
      async delete() {},
      async has() {
        return false;
      },
      async getOrCompute<T>(_key: string, loader: () => Promise<T>) {
        await loader();
        throw new Error("write-failed");
      },
    };
    const sink = spy();

    t = await testContext()
      .routes(
        craft()
          .id("cache-provider-write-fail")
          .from(direct())
          .cache({ provider: failing })
          .transform((b: string) => {
            innerRuns++;
            return b;
          })
          .to(sink),
      )
      .build();

    await t.startAndWaitReady();
    await expect(
      t.client.send("cache-provider-write-fail", "x"),
    ).rejects.toThrow(/provider write failed/);
    expect(innerRuns).toBe(1);
    expect(sink.received).toHaveLength(0);
  });
});

describe(".cache() route scope: dual-mode wrapper", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case First send misses cache and runs the full pipeline; result returned to caller
   * @preconditions craft().cache(...).from(direct()).transform(slow).to(noop()) and one send
   * @expectedResult Pipeline runs; client.send returns the computed body
   */
  test("first send misses and runs the pipeline", async () => {
    const provider = new MemoryCacheProvider();
    const compute = mock((b: string) => `out:${b}`);

    t = await testContext()
      .routes(
        craft()
          .id("route-cache-miss")
          .cache({ provider })
          .from(direct())
          .transform(compute)
          .to(noop()),
      )
      .build();

    await t.startAndWaitReady();
    const result = await t.client.send("route-cache-miss", "hello");

    expect(compute).toHaveBeenCalledTimes(1);
    expect(result).toBe("out:hello");
  });

  /**
   * @case Second send with the same body skips the WHOLE pipeline
   * @preconditions Same route as above, two sends with identical input
   * @expectedResult compute runs once; both sends return the cached body; sink not reached on hit
   */
  test("second send with same key skips the entire pipeline", async () => {
    const provider = new MemoryCacheProvider();
    const compute = mock((b: string) => `out:${b}`);
    const sink = spy();

    t = await testContext()
      .routes(
        craft()
          .id("route-cache-hit")
          .cache({ provider })
          .from(direct())
          .transform(compute)
          .to(sink),
      )
      .build();

    await t.startAndWaitReady();
    const a = await t.client.send("route-cache-hit", "x");
    const b = await t.client.send("route-cache-hit", "x");

    // Pipeline ran exactly once.
    expect(compute).toHaveBeenCalledTimes(1);
    // Sink saw the miss output; the hit reuses the cached body without
    // invoking the destination (the whole pipeline is skipped).
    expect(sink.received).toHaveLength(1);
    // Both callers see the same returned body.
    expect(a).toBe("out:x");
    expect(b).toBe("out:x");
  });

  /**
   * @case Side effects do not replay on a cache hit
   * @preconditions Wrapped transform increments an external counter
   * @expectedResult Counter increments once across N identical sends
   */
  test("side effects are skipped on a hit (the pipeline does not run)", async () => {
    const provider = new MemoryCacheProvider();
    let sideEffects = 0;

    t = await testContext()
      .routes(
        craft()
          .id("route-cache-sideeffect")
          .cache({ provider })
          .from(direct())
          .transform((b: string) => {
            sideEffects++;
            return `out:${b}`;
          })
          .to(noop()),
      )
      .build();

    await t.startAndWaitReady();
    for (let i = 0; i < 5; i++) {
      await t.client.send("route-cache-sideeffect", "same");
    }

    expect(sideEffects).toBe(1);
  });

  /**
   * @case TTL expiry forces a fresh pipeline run
   * @preconditions cache({ ttl: 5 }); second send after a 30ms wait
   * @expectedResult Pipeline runs twice; second result reflects the fresh compute
   */
  test("TTL expiry recomputes at route scope", async () => {
    const provider = new MemoryCacheProvider();
    let counter = 0;

    t = await testContext()
      .routes(
        craft()
          .id("route-cache-ttl")
          .cache({ provider, ttl: 5 })
          .from(direct())
          .transform(() => ({ counter: ++counter }))
          .to(noop()),
      )
      .build();

    await t.startAndWaitReady();
    const a = await t.client.send("route-cache-ttl", "x");
    await new Promise((r) => setTimeout(r, 30));
    const b = await t.client.send("route-cache-ttl", "x");

    expect(counter).toBe(2);
    expect(a).toEqual({ counter: 1 });
    expect(b).toEqual({ counter: 2 });
  });

  /**
   * @case Custom key isolates entries
   * @preconditions key derived from body.id; different ids miss, repeats hit
   * @expectedResult Distinct ids each trigger one compute; same id reuses
   */
  test("custom key partitions the cache at route scope", async () => {
    const provider = new MemoryCacheProvider();
    const compute = mock((b: { id: number }) => ({ id: b.id, v: b.id * 2 }));

    t = await testContext()
      .routes(
        craft()
          .id("route-cache-custom-key")
          .cache({
            provider,
            key: (e) => String((e.body as { id: number }).id),
          })
          .from(direct())
          .transform(compute)
          .to(noop()),
      )
      .build();

    await t.startAndWaitReady();
    await t.client.send("route-cache-custom-key", { id: 1 });
    await t.client.send("route-cache-custom-key", { id: 1 });
    await t.client.send("route-cache-custom-key", { id: 2 });

    expect(compute).toHaveBeenCalledTimes(2);
  });

  /**
   * @case Unbalanced .split() (no matching .aggregate()) is rejected at build()
   * @preconditions craft().cache().from().split().to() with no aggregate
   * @expectedResult RC5003 thrown at .build() pointing to the missing aggregate
   */
  test("unbalanced .split() rejects route-scope cache at build time", () => {
    expect(() => {
      craft()
        .id("route-cache-split-unbalanced")
        .cache({ ttl: 1000 })
        .from<number[]>(simple([1, 2, 3]))
        .split()
        .to(noop())
        .build();
    }).toThrow(/unbalanced \.split\(\)/);
  });

  /**
   * @case Balanced .split() + .aggregate() is allowed at build time
   * @preconditions craft().cache().from().split()...aggregate()...to()
   * @expectedResult Build succeeds; the route definition is returned
   */
  test("balanced .split() + .aggregate() is accepted at build time", () => {
    expect(() => {
      craft()
        .id("route-cache-split-balanced")
        .cache({ ttl: 1000 })
        .from<number[]>(simple([1, 2, 3]))
        .split()
        .transform((n: number) => n * 2)
        .aggregate()
        .to(noop())
        .build();
    }).not.toThrow();
  });

  /**
   * @case Nested balanced split/aggregate is allowed
   * @preconditions Two nested split/aggregate pairs around the cache
   * @expectedResult Build succeeds; nesting collapses depth back to zero
   */
  test("nested balanced split/aggregate is accepted at build time", () => {
    expect(() => {
      craft()
        .id("route-cache-split-nested")
        .cache({ ttl: 1000 })
        .from<number[][]>(
          simple([
            [1, 2],
            [3, 4],
          ]),
        )
        .split()
        .split()
        .transform((n: number) => n + 1)
        .aggregate()
        .aggregate()
        .to(noop())
        .build();
    }).not.toThrow();
  });

  /**
   * @case Balanced split+aggregate produces one cache write per source body
   * @preconditions Route with cache, split, transform, aggregate; same input twice
   * @expectedResult First call computes and caches the aggregated body;
   *                 second call hits the cache and skips the pipeline.
   */
  test("balanced split+aggregate caches the aggregated body", async () => {
    const provider = new MemoryCacheProvider();
    let transformRuns = 0;

    t = await testContext()
      .routes(
        craft()
          .id("route-cache-split-balanced-runtime")
          .cache({ provider, key: (e) => JSON.stringify(e.body) })
          .from(direct())
          .split()
          .transform((n: number) => {
            transformRuns++;
            return n * 2;
          })
          .aggregate()
          .to(noop()),
      )
      .build();

    await t.startAndWaitReady();

    const first = await t.client.send(
      "route-cache-split-balanced-runtime",
      [1, 2, 3],
    );
    const second = await t.client.send(
      "route-cache-split-balanced-runtime",
      [1, 2, 3],
    );

    expect(transformRuns).toBe(3);
    expect(first).toEqual([2, 4, 6]);
    expect(second).toEqual([2, 4, 6]);
    expect(provider.size).toBe(1);
  });

  /**
   * @case Route-scope cache emits scope-aware lifecycle events
   * @preconditions Subscribed to route:*:cache:hit / miss / stored
   * @expectedResult Events fire with scope: "route" and the derived key
   */
  test("emits scope: 'route' lifecycle events", async () => {
    const provider = new MemoryCacheProvider();
    const events: { name: string; scope?: string; stepLabel?: string }[] = [];

    t = await testContext()
      .routes(
        craft()
          .id("route-cache-events")
          .cache({ provider })
          .from(direct())
          .transform((b: string) => `out:${b}`)
          .to(noop()),
      )
      .build();

    for (const name of ["hit", "miss", "stored"] as const) {
      t.ctx.on(
        `route:route-cache-events:cache:${name}` as never,
        (payload: {
          details: { scope?: string; stepLabel?: string; key?: string };
        }) => {
          events.push({
            name,
            scope: payload.details.scope,
            stepLabel: payload.details.stepLabel,
          });
        },
      );
    }

    await t.startAndWaitReady();
    await t.client.send("route-cache-events", "hello");
    await t.client.send("route-cache-events", "hello");

    const names = events.map((e) => e.name);
    expect(names).toContain("miss");
    expect(names).toContain("stored");
    expect(names).toContain("hit");
    for (const e of events) {
      expect(e.scope).toBe("route");
      expect(e.stepLabel).toBe("route");
    }
  });

  /**
   * @case A cache hit emits exchange:restored alongside cache:hit
   * @preconditions Subscribed to route:*:exchange:restored
   * @expectedResult exchange:restored fires once with source: "cache" on the second (hit) send
   */
  test("cache hit emits exchange:restored", async () => {
    const provider = new MemoryCacheProvider();
    const restored: { source?: string }[] = [];

    t = await testContext()
      .routes(
        craft()
          .id("route-cache-restored")
          .cache({ provider })
          .from(direct())
          .transform((b: string) => `out:${b}`)
          .to(noop()),
      )
      .build();

    t.ctx.on(
      `route:route-cache-restored:exchange:restored` as never,
      (payload: { details: { source?: string } }) => {
        restored.push({ source: payload.details.source });
      },
    );

    await t.startAndWaitReady();
    await t.client.send("route-cache-restored", "x");
    await t.client.send("route-cache-restored", "x");

    expect(restored).toHaveLength(1);
    expect(restored[0]!.source).toBe("cache");
  });

  /**
   * @case .input() validation runs before the cache check (not bypassed on hit)
   * @preconditions Route has .input({ body: schema }).cache(); send an invalid body
   * @expectedResult Validation rejects the request; the cache provider is never consulted, nothing cached
   */
  test(".input() validation runs before the cache check", async () => {
    const schema = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value: unknown) => {
          if (typeof value === "object" && value !== null && "ok" in value) {
            return { value: value as { ok: true } };
          }
          return { issues: [{ message: "must have ok:true" }] };
        },
      },
    } as const;
    const provider = new MemoryCacheProvider();
    let pipelineRuns = 0;

    t = await testContext()
      .routes(
        craft()
          .id("route-cache-input")
          .input(schema as never)
          .cache({ provider })
          .from(direct())
          .transform((b) => {
            pipelineRuns++;
            return b;
          })
          .to(noop()),
      )
      .build();

    await t.startAndWaitReady();

    // Invalid input is rejected before the cache is consulted; pipeline never runs.
    await expect(
      t.client.send("route-cache-input", { bad: 1 }),
    ).rejects.toThrow();
    expect(pipelineRuns).toBe(0);
    expect(provider.size).toBe(0);

    // A valid input runs the pipeline once and caches.
    await t.client.send("route-cache-input", { ok: true });
    expect(pipelineRuns).toBe(1);
    expect(provider.size).toBe(1);

    // Repeat: cache hit, pipeline does not run again.
    await t.client.send("route-cache-input", { ok: true });
    expect(pipelineRuns).toBe(1);
  });

  /**
   * @case .authorize() runs before the cache check; unauthorized callers do not see cached responses
   * @preconditions Route has .authorize({ roles: ['admin'] }).cache({ provider }); admin populates the cache, then a non-admin caller hits the same key
   * @expectedResult Admin's call caches; non-admin's call fails with RC5015 even though the cache has an entry for the body; cache provider was never read for the rejected call
   */
  test(".authorize() runs BEFORE the cache check (no unauthorized cache hits)", async () => {
    function principalSource(
      body: unknown,
      principal?: Principal,
    ): Source<unknown> {
      return {
        subscribe: async (_ctx, handler) => {
          const headers = principal
            ? { "routecraft.auth.principal": markAuthentic(principal) }
            : undefined;
          await handler(body, headers);
        },
      };
    }

    const provider = new MemoryCacheProvider();
    let pipelineRuns = 0;

    // First route: admin populates the cache.
    const adminPrincipal: Principal = {
      kind: "custom",
      scheme: "bearer",
      subject: "alice",
      roles: ["admin"],
    };
    const adminCtx = await testContext()
      .routes(
        craft()
          .id("auth-before-cache")
          .authorize({ roles: ["admin"] })
          .cache({ provider })
          .from(principalSource("payload", adminPrincipal))
          .transform((b: string) => {
            pipelineRuns++;
            return `done:${b}`;
          })
          .to(noop()),
      )
      .build();
    await adminCtx.test();
    await adminCtx.stop();
    expect(pipelineRuns).toBe(1);
    expect(provider.size).toBe(1);

    // Second route: a non-admin sends the SAME body. The cache has a hit
    // for that body, but .authorize() runs first and rejects the call.
    const guestPrincipal: Principal = {
      kind: "custom",
      scheme: "bearer",
      subject: "bob",
      roles: ["guest"],
    };
    const guestErrors: unknown[] = [];
    const guestCtx = await testContext()
      .routes(
        craft()
          .id("auth-before-cache")
          .authorize({ roles: ["admin"] })
          .cache({ provider })
          .from(principalSource("payload", guestPrincipal))
          .transform((b: string) => {
            pipelineRuns++;
            return `done:${b}`;
          })
          .to(noop()),
      )
      .on("route:auth-before-cache:exchange:failed", ({ details }) => {
        guestErrors.push((details as { error: { rc?: string } }).error);
      })
      .build();
    await guestCtx.test();
    await guestCtx.stop();

    // Authorize rejected the guest BEFORE the cache check, so:
    // - the pipeline did NOT run again (still 1 total run)
    // - the cache wasn't consulted for the guest, no extra entry
    // - the guest saw RC5015 (permission denied)
    expect(pipelineRuns).toBe(1);
    expect(provider.size).toBe(1);
    expect(guestErrors).toHaveLength(1);
    expect((guestErrors[0] as { rc: string }).rc).toBe("RC5015");
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
   * @case `null` is storable and distinct from a miss
   * @preconditions set a null value, then get
   * @expectedResult get returns null (a hit), has returns true
   */
  test("stores null as a value distinct from a cache miss", async () => {
    await provider.set("k", null);
    expect(await provider.has("k")).toBe(true);
    expect(await provider.get("k")).toBeNull();
    expect(await provider.get("absent")).toBeUndefined();
  });

  /**
   * @case set() rejects undefined (the miss sentinel)
   * @preconditions set with undefined value
   * @expectedResult Throws RC5028 rather than silently no-opping
   */
  test("set() throws on undefined instead of silently dropping", async () => {
    await expect(provider.set("k", undefined)).rejects.toThrow(
      /RC5028|undefined/,
    );
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
