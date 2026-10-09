import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  bootServer,
  signHs256,
  testContext,
  spy,
  type TestContext,
} from "@routecraft/testing";
import {
  craft,
  CacheWrapperStep,
  DefaultExchange,
  direct,
  http,
  jwt,
  defaultAuthority,
  MemoryCacheProvider,
  noop,
  otherwise,
  when,
  type Adapter,
  type CacheProvider,
  type CraftConfig,
  type Exchange,
  type Principal,
  type Source,
  type Step,
  simple,
  type StepContext,
  type StepOutcome,
  CACHE,
  bindCacheProvider,
  cacheProvider,
  definePlugin,
  getExchangeContext,
  port,
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
   * @preconditions Two client.sendDirect calls with identical input through the same direct route
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
          .from<string>(direct())
          .cache({ provider })
          .transform(compute)
          .to(sink),
      )
      .build();

    await t.startAndWaitReady();
    await t.client.sendDirect("cache-hit", "hello");
    await t.client.sendDirect("cache-hit", "hello");

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
          .from<{ id: number }>(direct())
          .cache({
            key: (e) => String((e.body as { id: number }).id),
            provider,
          })
          .transform(compute)
          .to(sink),
      )
      .build();

    await t.startAndWaitReady();
    await t.client.sendDirect("cache-by-id", { id: 1 });
    await t.client.sendDirect("cache-by-id", { id: 1 });
    await t.client.sendDirect("cache-by-id", { id: 2 });
    await t.client.sendDirect("cache-by-id", { id: 1 });

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
    await expect(
      t.client.sendDirect("cache-no-poison", "input"),
    ).rejects.toThrow();
    await expect(
      t.client.sendDirect("cache-no-poison", "input"),
    ).rejects.toThrow();

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
    await t.client.sendDirect("cache-ttl", "hello");
    await new Promise((r) => setTimeout(r, 30));
    await t.client.sendDirect("cache-ttl", "hello");

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
          .from<string>(direct())
          .cache({ provider })
          .transform((b: string) => `out:${b}`)
          .to(sink),
      )
      .build();

    for (const name of ["hit", "miss", "stored", "failed"] as const) {
      t.ctx.on(
        `route:cache:${name}` as never,
        (payload: { details: { scope?: string; stepLabel?: string } }) => {
          events.push(name);
          expect(payload.details.scope).toBe("step");
          expect(payload.details.stepLabel).toBeDefined();
        },
      );
    }

    await t.startAndWaitReady();
    await t.client.sendDirect("cache-events", "hello");
    await t.client.sendDirect("cache-events", "hello");

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
    await t.client.sendDirect("cache-headers", "body");

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
    await t.client.sendDirect("cache-null", "x");
    await t.client.sendDirect("cache-null", "x");

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
    await t.client.sendDirect("cache-undefined", "x");
    await t.client.sendDirect("cache-undefined", "x");

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
    await t.client.sendDirect("error-outside-cache", "x");
    await t.client.sendDirect("error-outside-cache", "x");

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
    await t.client.sendDirect("error-inside-cache", "x");
    await t.client.sendDirect("error-inside-cache", "x");

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
          .from<string>(direct())
          .transform((b: string) => b.length)
          .cache({ provider })
          // If .cache() dropped the type, `n: number` would not type-check.
          .transform((n: number) => n * 2)
          .to(sink),
      )
      .build();

    await t.startAndWaitReady();
    await t.client.sendDirect("cache-types", "abcd");

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
      async execute(exchange: Exchange): Promise<StepOutcome> {
        runs++;
        await new Promise((r) => setTimeout(r, 20));
        return {
          kind: "continue",
          exchange: DefaultExchange.rewrap(exchange, { body: "value" }),
        };
      },
    };
    const wrapper = new CacheWrapperStep(innerStep, {
      provider,
      key: () => "same",
    });

    const ex1 = new DefaultExchange(ctx, { body: "a" });
    const ex2 = new DefaultExchange(ctx, { body: "b" });
    const stepContext: StepContext = {
      takePending: () => [],
      runPaths: async () => {},
      runPath: async () => ({ failed: false, dropped: false }),
      captureDownstream: () => async () => ({ failed: false, dropped: false }),
      invoke: async (_point, exchange) => exchange,
    };

    const [o1, o2] = await Promise.all([
      wrapper.execute(ex1, stepContext),
      wrapper.execute(ex2, stepContext),
    ]);

    expect(runs).toBe(1);
    expect(o1.kind).toBe("continue");
    expect(o2.kind).toBe("continue");
    if (o1.kind === "continue") expect(o1.exchange.body).toBe("value");
    if (o2.kind === "continue") expect(o2.exchange.body).toBe("value");
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
      async execute(): Promise<StepOutcome> {
        runs++;
        await new Promise((r) => setTimeout(r, 20));
        // A drop outcome signals the wrapper to cache nothing.
        return { kind: "drop" };
      },
    };
    const wrapper = new CacheWrapperStep(droppingInner, {
      provider,
      key: () => "same",
    });

    const ex1 = new DefaultExchange(ctx, { body: "a" });
    const ex2 = new DefaultExchange(ctx, { body: "b" });
    const stepContext: StepContext = {
      takePending: () => [],
      runPaths: async () => {},
      runPath: async () => ({ failed: false, dropped: false }),
      captureDownstream: () => async () => ({ failed: false, dropped: false }),
      invoke: async (_point, exchange) => exchange,
    };

    const [o1, o2] = await Promise.all([
      wrapper.execute(ex1, stepContext),
      wrapper.execute(ex2, stepContext),
    ]);

    expect(runs).toBe(1);
    // Both exchanges dropped: nothing forwarded downstream, nothing cached.
    expect(o1.kind).toBe("drop");
    expect(o2.kind).toBe("drop");
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
          .from<string>(direct())
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
      t.client.sendDirect("cache-provider-read-fail", "x"),
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
          .from<string>(direct())
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
      t.client.sendDirect("cache-provider-write-fail", "x"),
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
   * @expectedResult Pipeline runs; client.sendDirect returns the computed body
   */
  test("first send misses and runs the pipeline", async () => {
    const provider = new MemoryCacheProvider();
    const compute = mock((b: string) => `out:${b}`);

    t = await testContext()
      .routes(
        craft()
          .id("route-cache-miss")
          .cache({ provider })
          .from<string>(direct())
          .transform(compute)
          .to(noop()),
      )
      .build();

    await t.startAndWaitReady();
    const result = await t.client.sendDirect("route-cache-miss", "hello");

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
          .from<string>(direct())
          .transform(compute)
          .to(sink),
      )
      .build();

    await t.startAndWaitReady();
    const a = await t.client.sendDirect("route-cache-hit", "x");
    const b = await t.client.sendDirect("route-cache-hit", "x");

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
          .from<string>(direct())
          .transform((b: string) => {
            sideEffects++;
            return `out:${b}`;
          })
          .to(noop()),
      )
      .build();

    await t.startAndWaitReady();
    for (let i = 0; i < 5; i++) {
      await t.client.sendDirect("route-cache-sideeffect", "same");
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
    const a = await t.client.sendDirect<string, { counter: number }>(
      "route-cache-ttl",
      "x",
    );
    await new Promise((r) => setTimeout(r, 30));
    const b = await t.client.sendDirect<string, { counter: number }>(
      "route-cache-ttl",
      "x",
    );

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
          .from<{ id: number }>(direct())
          .transform(compute)
          .to(noop()),
      )
      .build();

    await t.startAndWaitReady();
    await t.client.sendDirect("route-cache-custom-key", { id: 1 });
    await t.client.sendDirect("route-cache-custom-key", { id: 1 });
    await t.client.sendDirect("route-cache-custom-key", { id: 2 });

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
   * @case Route-scope cache on a route that authenticates in its pipeline is refused at build
   * @preconditions Route-scope .cache() (once with the default key, once with a custom key) and an .authenticate() step after .from()
   * @expectedResult build() throws RC5003 naming .authenticate(), since a hit would skip it
   */
  test("route-scope cache with .authenticate() in the pipeline is refused", () => {
    for (const options of [{}, { key: () => "k" }]) {
      let error: unknown;
      try {
        craft()
          .id("route-cache-authenticate")
          .cache(options)
          .from<string>(direct())
          .authenticate(() => ({ subject: "alice" }))
          .to(noop())
          .build();
      } catch (err) {
        error = err;
      }
      expect(error).toMatchObject({ rc: "RC5003" });
      expect((error as Error).message).toMatch(
        /without running \.authenticate\(\)/,
      );
    }
  });

  /**
   * @case An .authenticate() nested in a choice branch under a wrapper is found too
   * @preconditions Route-scope .cache(); .authenticate() sits inside otherwise(b => b.error(h).authenticate(...))
   * @expectedResult build() throws RC5003
   */
  test("route-scope cache with a nested, wrapped .authenticate() is refused", () => {
    expect(() =>
      craft()
        .id("route-cache-authenticate-nested")
        .cache()
        .from<string>(direct())
        .choice(
          otherwise((b) => b
            .error(() => "anon")
            .authenticate(() => ({ subject: "alice" }))),
        )
        .to(noop())
        .build(),
    ).toThrow(/\.authenticate\(\)/);
  });

  /**
   * @case A step-scope cache placed after .authenticate() is the supported alternative
   * @preconditions No route-scope cache; .authenticate() then a step-scope .cache() around a transform
   * @expectedResult build() succeeds
   */
  test("step-scope cache after .authenticate() builds", () => {
    expect(() =>
      craft()
        .id("step-cache-after-authenticate")
        .from<string>(direct())
        .authenticate(() => ({ subject: "alice" }))
        .cache()
        .transform((b: string) => b)
        .to(noop())
        .build(),
    ).not.toThrow();
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
          .from<number[]>(direct())
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

    const first = await t.client.sendDirect(
      "route-cache-split-balanced-runtime",
      [1, 2, 3],
    );
    const second = await t.client.sendDirect(
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
    const events: {
      name: string;
      scope: string | undefined;
      stepLabel: string | undefined;
    }[] = [];

    t = await testContext()
      .routes(
        craft()
          .id("route-cache-events")
          .cache({ provider })
          .from<string>(direct())
          .transform((b: string) => `out:${b}`)
          .to(noop()),
      )
      .build();

    for (const name of ["hit", "miss", "stored"] as const) {
      t.ctx.on(
        `route:cache:${name}` as never,
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
    await t.client.sendDirect("route-cache-events", "hello");
    await t.client.sendDirect("route-cache-events", "hello");

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
    const restored: { source: string | undefined }[] = [];

    t = await testContext()
      .routes(
        craft()
          .id("route-cache-restored")
          .cache({ provider })
          .from<string>(direct())
          .transform((b: string) => `out:${b}`)
          .to(noop()),
      )
      .build();

    t.ctx.on(
      `route:exchange:restored` as never,
      (payload: { details: { source?: string } }) => {
        restored.push({ source: payload.details.source });
      },
    );

    await t.startAndWaitReady();
    await t.client.sendDirect("route-cache-restored", "x");
    await t.client.sendDirect("route-cache-restored", "x");

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
      t.client.sendDirect("route-cache-input", { bad: 1 }),
    ).rejects.toThrow();
    expect(pipelineRuns).toBe(0);
    expect(provider.size).toBe(0);

    // A valid input runs the pipeline once and caches.
    await t.client.sendDirect("route-cache-input", { ok: true });
    expect(pipelineRuns).toBe(1);
    expect(provider.size).toBe(1);

    // Repeat: cache hit, pipeline does not run again.
    await t.client.sendDirect("route-cache-input", { ok: true });
    expect(pipelineRuns).toBe(1);
  });

  /**
   * @case .authorize() runs before the cache check; unauthorized callers do not see cached responses
   * @preconditions Route has .authorize({ roles: ['admin'] }).cache({ provider }); admin populates the cache, then a non-admin caller hits the same key
   * @expectedResult Admin's call caches; non-admin's call fails with RC5015 even though the cache has an entry for the body; cache provider was never read for the rejected call
   */
  test(".authorize() runs BEFORE the cache check (no unauthorized cache hits)", async () => {
    function principalSource<T>(body: T, principal?: Principal): Source<T> {
      return {
        subscribe: async (sub) => {
          const headers = principal
            ? { "routecraft.auth.principal": defaultAuthority.brand(principal) }
            : undefined;
          await sub.emit({ message: body, ...(headers ? { headers } : {}) });
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
      .on("route:exchange:failed", ({ details }) => {
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

const JWT_SECRET = "cache-test-secret";
const JWT_ISSUER = "https://idp.test";
const JWT_AUDIENCE = "https://api.test";

/** Bearer token for `sub`, signed for the jwt validator {@link bootHttp} configures. */
function bearer(sub: string): string {
  return `Bearer ${signHs256({ secret: JWT_SECRET, claims: { sub } })}`;
}

/**
 * Run `routes` in a context of their own, send one body to `routeId`, and
 * stop the context even when the send fails. Stands in for an earlier
 * process (or route version) that populated a shared provider.
 */
async function sendOnce(
  routes: Parameters<ReturnType<typeof testContext>["routes"]>[0],
  routeId: string,
  body: string,
): Promise<unknown> {
  const ctx = await testContext().routes(routes).build();
  try {
    await ctx.startAndWaitReady();
    return await ctx.client.sendDirect(routeId, body);
  } finally {
    await ctx.stop();
  }
}

/**
 * Thin wrapper over the shared `bootServer` helper: serve `routes` over
 * http, optionally behind jwt auth, and report failed exchanges.
 */
async function bootHttp(opts: {
  routes: Parameters<ReturnType<typeof testContext>["routes"]>[0];
  auth?: boolean;
  onFailed?: (details: unknown) => void;
}): Promise<{ ctx: TestContext; port: number }> {
  return bootServer((builder) => {
    const b = builder.routes(opts.routes).with({
      servers: { default: { port: 0 } },
      http: opts.auth
        ? {
            auth: jwt({
              secret: JWT_SECRET,
              issuer: JWT_ISSUER,
              audience: JWT_AUDIENCE,
            }),
          }
        : {},
    } as CraftConfig);
    const onFailed = opts.onFailed;
    return onFailed
      ? b.on("route:exchange:failed", ({ details }) => onFailed(details))
      : b;
  });
}

describe(".cache() default key identity", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case Two route-scope caches on one provider do not answer for each other
   * @preconditions Routes r1 and r2 both use .cache() with the default key on one shared provider (standing in for the process-wide default); the same body is sent to each
   * @expectedResult Each route runs its own pipeline and returns its own result
   */
  test("two routes with the same body keep separate route-scope entries", async () => {
    const provider = new MemoryCacheProvider();

    t = await testContext()
      .routes([
        craft()
          .id("key-route-a")
          .cache({ provider })
          .from<string>(direct())
          .transform((b: string) => `a:${b}`)
          .to(noop()),
        craft()
          .id("key-route-b")
          .cache({ provider })
          .from<string>(direct())
          .transform((b: string) => `b:${b}`)
          .to(noop()),
      ])
      .build();

    await t.startAndWaitReady();
    const a = await t.client.sendDirect("key-route-a", "same");
    const b = await t.client.sendDirect("key-route-b", "same");

    expect(a).toBe("a:same");
    expect(b).toBe("b:same");
    expect(provider.size).toBe(2);
  });

  /**
   * @case Two step-scope caches in one route do not collide on an equal input body
   * @preconditions One route with .cache().transform(identity) followed by .cache().transform(upper), so both caches see body "x"
   * @expectedResult The second transform runs and its output reaches the sink; two entries are stored
   */
  test("two step-scope caches in one route keep separate entries", async () => {
    const provider = new MemoryCacheProvider();
    const upper = mock((b: string) => b.toUpperCase());
    const sink = spy();

    t = await testContext()
      .routes(
        craft()
          .id("key-two-steps")
          .from<string>(direct())
          .cache({ provider })
          .transform((b: string) => b)
          .cache({ provider })
          .transform(upper)
          .to(sink),
      )
      .build();

    await t.startAndWaitReady();
    await t.client.sendDirect("key-two-steps", "x");
    await t.client.sendDirect("key-two-steps", "x");

    expect(upper).toHaveBeenCalledTimes(1);
    expect(sink.received.map((e) => e.body)).toEqual(["X", "X"]);
    expect(provider.size).toBe(2);
  });

  /**
   * @case A step-scope cache's key is stable across builds of the same route source
   * @preconditions The same route source is built into two contexts in turn, sharing one provider (standing in for an external one across a restart)
   * @expectedResult The second context hits the entry the first stored; the wrapped step runs once
   */
  test("step-scope entries survive a rebuild of the same route", async () => {
    const provider = new MemoryCacheProvider();
    const compute = mock((b: string) => `computed:${b}`);
    const build = () =>
      craft()
        .id("key-rebuild")
        .from<string>(direct())
        .transform((b: string) => b)
        .cache({ provider })
        .transform(compute)
        .to(noop());

    expect(await sendOnce(build(), "key-rebuild", "x")).toBe("computed:x");

    t = await testContext().routes(build()).build();
    await t.startAndWaitReady();
    const second = await t.client.sendDirect("key-rebuild", "x");

    expect(second).toBe("computed:x");
    expect(compute).toHaveBeenCalledTimes(1);
    expect(provider.size).toBe(1);
  });

  /**
   * @case A cache nested in a choice branch under an outer wrapper still gets a stable site
   * @preconditions otherwise(b => b.error(h).cache().transform(compute)); the same route source is built into two contexts in turn, sharing one provider
   * @expectedResult The build-time walk finds the cache through the branch and the wrapper, so the second context hits and compute runs once
   */
  test("a nested, wrapped step-scope cache survives a rebuild", async () => {
    const provider = new MemoryCacheProvider();
    const compute = mock((b: string) => `computed:${b}`);
    const build = () =>
      craft()
        .id("key-rebuild-nested")
        .from<string>(direct())
        .choice(
          otherwise((b) => b
            .error(() => "recovered")
            .cache({ provider })
            .transform(compute)),
        )
        .to(noop());

    expect(await sendOnce(build(), "key-rebuild-nested", "x")).toBe(
      "computed:x",
    );

    t = await testContext().routes(build()).build();
    await t.startAndWaitReady();
    const second = await t.client.sendDirect("key-rebuild-nested", "x");

    expect(second).toBe("computed:x");
    expect(compute).toHaveBeenCalledTimes(1);
  });

  /**
   * @case A route edit that moves a different step onto a cached step's old position misses instead of reading its entry
   * @preconditions One provider; v1 is .cache().transform(A); v2 of the same route id inserts .cache().transform(B) before .cache().transform(A), so B's cache takes A's old index
   * @expectedResult v2 runs B on the same body rather than returning A's cached output
   */
  test("a route edit never lets one step read another step's entries", async () => {
    const provider = new MemoryCacheProvider();
    const runB = mock((b: string) => `B:${b}`);

    const v1 = craft()
      .id("key-edit")
      .from<string>(direct())
      .cache({ provider })
      .transform((b: string) => `A:${b}`)
      .to(noop());
    expect(await sendOnce(v1, "key-edit", "x")).toBe("A:x");

    t = await testContext()
      .routes(
        craft()
          .id("key-edit")
          .from<string>(direct())
          .cache({ provider })
          .transform(runB)
          .cache({ provider })
          .transform((b: string) => `A:${b}`)
          .to(noop()),
      )
      .build();
    await t.startAndWaitReady();
    const result = await t.client.sendDirect("key-edit", "x");

    expect(runB).toHaveBeenCalledTimes(1);
    expect(result).toBe("A:B:x");
  });

  /**
   * @case The default step-scope key separates principals
   * @preconditions Step-scope .cache() before a process step that reads the principal; the source emits the same body as alice, bob, then alice
   * @expectedResult Bob gets his own result; alice's repeat is a hit, so the step runs twice in total
   */
  test("step scope keeps separate entries per principal", async () => {
    const principal = (subject: string): Principal => ({
      kind: "custom",
      scheme: "bearer",
      issuer: "https://idp.test",
      subject,
    });
    const source: Source<string> = {
      subscribe: async (sub) => {
        for (const subject of ["alice", "bob", "alice"]) {
          await sub.emit({
            message: "same",
            headers: {
              "routecraft.auth.principal": defaultAuthority.brand(
                principal(subject),
              ),
            },
          });
        }
      },
    };
    let runs = 0;
    const sink = spy();

    t = await testContext()
      .routes(
        craft()
          .id("key-step-principal")
          .from(source)
          .cache({ provider: new MemoryCacheProvider() })
          .process((ex) =>
            DefaultExchange.rewrap(ex, {
              body: {
                subject: ex.auth.principal?.subject ?? null,
                run: ++runs,
              },
            }),
          )
          .to(sink),
      )
      .build();
    await t.test();

    expect(runs).toBe(2);
    expect(sink.received.map((e) => e.body)).toEqual([
      { subject: "alice", run: 1 },
      { subject: "bob", run: 2 },
      { subject: "alice", run: 1 },
    ]);
  });

  /**
   * @case An unnamed route whose cache uses the default key warns that its key changes on every start
   * @preconditions A route with no .id() and a step-scope .cache() without a key
   * @expectedResult The route logger warns once, naming the generated id and telling the user to add .id()
   */
  test("an unnamed route with a default-key cache warns", async () => {
    t = await testContext({ fn: mock })
      .routes(
        craft()
          .from<string>(direct())
          .cache({ provider: new MemoryCacheProvider() })
          .transform((b: string) => b)
          .to(noop()),
      )
      .build();

    const warnings = t.logger.warn.mock.calls.map((call) => String(call[1]));
    const routeId = t.ctx.getRoutes()[0]?.definition.id ?? "";
    expect(warnings.filter((w) => w.includes("Add .id()"))).toHaveLength(1);
    expect(warnings.find((w) => w.includes("Add .id()"))).toContain(routeId);
  });

  /**
   * @case A named route, or an unnamed one whose cache has a custom key, does not warn
   * @preconditions One route with .id() and a default-key cache; one route without .id() whose cache supplies key
   * @expectedResult Neither route logs the unnamed-route warning
   */
  test("a named route or a custom-key cache does not warn", async () => {
    t = await testContext({ fn: mock })
      .routes([
        craft()
          .id("key-named")
          .cache({ provider: new MemoryCacheProvider() })
          .from<string>(direct())
          .to(noop()),
        craft()
          .from<string>(direct())
          .cache({ provider: new MemoryCacheProvider(), key: () => "k" })
          .transform((b: string) => b)
          .to(noop()),
      ])
      .build();

    const warnings = t.logger.warn.mock.calls.map((call) => String(call[1]));
    expect(warnings.some((w) => w.includes("Add .id()"))).toBe(false);
  });

  /**
   * @case Reordering a cache and an .error() in one wrapper stack misses instead of reading the other ordering's entry
   * @preconditions One provider and one route id; v1 is .cache().error(recover).transform(step) with step failing, so the recovery value is cached; v2 is .error(recover).cache().transform(step) with step succeeding; the step and handler are the same functions in both
   * @expectedResult v2 runs the step and returns its own result, not v1's cached recovery value
   */
  test("reordering wrappers around a cache changes its site", async () => {
    const provider = new MemoryCacheProvider();
    let failing = true;
    const recover = () => "recovered";
    const step = (b: string) => {
      if (failing) throw new Error("upstream down");
      return `computed:${b}`;
    };

    const v1 = craft()
      .id("key-wrapper-order")
      .from<string>(direct())
      .cache({ provider })
      .error(recover)
      .transform(step)
      .to(noop());
    expect(await sendOnce(v1, "key-wrapper-order", "x")).toBe("recovered");

    failing = false;
    t = await testContext()
      .routes(
        craft()
          .id("key-wrapper-order")
          .from<string>(direct())
          .error(recover)
          .cache({ provider })
          .transform(step)
          .to(noop()),
      )
      .build();
    await t.startAndWaitReady();

    const result = await t.client.sendDirect<string, string>(
      "key-wrapper-order",
      "x",
    );
    expect(result).toBe("computed:x");
  });

  /**
   * @case Editing an .error() handler between a cache and its step misses instead of replaying the old handler's recovery value
   * @preconditions One provider and one route id; the step always fails; v1 is .cache().error(() => "fallback-v1").transform(step), v2 the same route with the handler returning "fallback-v2"
   * @expectedResult v2 runs the step again and returns its own handler's value, not v1's cached one
   */
  test("changing an .error() handler below a cache changes its key", async () => {
    const provider = new MemoryCacheProvider();
    const step = mock((): string => {
      throw new Error("upstream down");
    });
    const build = (fallback: () => string) =>
      craft()
        .id("key-error-options")
        .from<string>(direct())
        .cache({ provider })
        .error(fallback)
        .transform(step)
        .to(noop());

    expect(
      await sendOnce(
        build(() => "fallback-v1"),
        "key-error-options",
        "x",
      ),
    ).toBe("fallback-v1");

    t = await testContext()
      .routes(build(() => "fallback-v2"))
      .build();
    await t.startAndWaitReady();
    const result = await t.client.sendDirect("key-error-options", "x");

    expect(result).toBe("fallback-v2");
    expect(step).toHaveBeenCalledTimes(2);
    expect(provider.size).toBe(2);
  });

  /**
   * @case Editing a .retry() policy between a cache and its step misses instead of replaying a recovery the new policy would not have reached
   * @preconditions One provider and one route id; .cache().error(fallback).retry({ maxAttempts }).transform(flaky), where flaky fails its first call in each version and succeeds after; v1 has maxAttempts 1, v2 has maxAttempts 2
   * @expectedResult v1 caches the fallback; v2 re-attempts, recovers, and returns the computed value rather than v1's cached fallback
   */
  test("changing a .retry() option below a cache changes its key", async () => {
    const provider = new MemoryCacheProvider();
    let failuresLeft = 0;
    const flaky = mock((b: string) => {
      if (failuresLeft > 0) {
        failuresLeft--;
        throw new Error("transient");
      }
      return `computed:${b}`;
    });
    const fallback = () => "fallback";
    const build = (maxAttempts: number) =>
      craft()
        .id("key-retry-options")
        .from<string>(direct())
        .cache({ provider })
        .error(fallback)
        .retry({ maxAttempts, backoff: 0 })
        .transform(flaky)
        .to(noop());

    failuresLeft = 1;
    expect(await sendOnce(build(1), "key-retry-options", "x")).toBe("fallback");

    failuresLeft = 1;
    t = await testContext().routes(build(2)).build();
    await t.startAndWaitReady();
    const result = await t.client.sendDirect("key-retry-options", "x");

    expect(result).toBe("computed:x");
    expect(flaky).toHaveBeenCalledTimes(3);
  });

  /**
   * @case A cache above a stack of every wrapper kind keeps its key across a rebuild of the unchanged route
   * @preconditions One provider; .cache() above .error(), .retry(), .timeout(), .delay(), .throttle(), .circuitBreaker(), .concurrency() and an inner .cache() with a custom key, all over one step; the same route source is built into two contexts in turn
   * @expectedResult The second context hits the entry the first stored and returns the same value; the step runs once
   */
  test("an unchanged wrapper stack below a cache still hits after a rebuild", async () => {
    const provider = new MemoryCacheProvider();
    const inner = new MemoryCacheProvider();
    const compute = mock((b: string) => `computed:${b}`);
    const build = () =>
      craft()
        .id("key-wrapper-stack-rebuild")
        .from<string>(direct())
        .cache({ provider })
        .error(() => "fallback")
        .retry({ maxAttempts: 2, backoff: 0, retryOn: () => true })
        .timeout("5s")
        .delay(0)
        .throttle({ rate: 100, per: "second" })
        .circuitBreaker({ failureThreshold: 5, fallback: () => "open" })
        .concurrency({ max: 4 })
        .cache({ provider: inner, key: (ex) => `inner:${String(ex.body)}` })
        .transform(compute)
        .to(noop());

    expect(await sendOnce(build(), "key-wrapper-stack-rebuild", "x")).toBe(
      "computed:x",
    );
    // Without this the inner cache answers round two, hiding a miss on the outer key.
    inner.clear();

    t = await testContext().routes(build()).build();
    await t.startAndWaitReady();
    const second = await t.client.sendDirect("key-wrapper-stack-rebuild", "x");

    expect(second).toBe("computed:x");
    expect(compute).toHaveBeenCalledTimes(1);
  });

  /**
   * @case Editing a wrapper above a cache keeps the cache's entries
   * @preconditions One provider and one route id; v1 is .retry({ maxAttempts: 2 }).cache().transform(compute), v2 the same with maxAttempts 3, so only the outer wrapper's options differ
   * @expectedResult v2 hits the entry v1 stored and returns the same value; compute runs once
   */
  test("a wrapper's options above a cache do not enter its key", async () => {
    const provider = new MemoryCacheProvider();
    const compute = mock((b: string) => `computed:${b}`);
    const build = (maxAttempts: number) =>
      craft()
        .id("key-wrapper-above")
        .from<string>(direct())
        .retry({ maxAttempts, backoff: 0 })
        .cache({ provider })
        .transform(compute)
        .to(noop());

    expect(await sendOnce(build(2), "key-wrapper-above", "x")).toBe(
      "computed:x",
    );

    t = await testContext().routes(build(3)).build();
    await t.startAndWaitReady();
    const second = await t.client.sendDirect("key-wrapper-above", "x");

    expect(second).toBe("computed:x");
    expect(compute).toHaveBeenCalledTimes(1);
  });

  /**
   * @case Editing a step under a route-scope cache misses instead of replaying what the old pipeline produced
   * @preconditions One provider and one route id with .cache() before .from(); v1 transforms to "A:<body>", v2 to "B:<body>"
   * @expectedResult v2 runs its own pipeline and returns "B:x", not v1's cached "A:x"
   */
  test("editing a step under a route-scope cache changes its key", async () => {
    const provider = new MemoryCacheProvider();
    const build = (step: (b: string) => string) =>
      craft()
        .id("key-route-edit")
        .cache({ provider })
        .from<string>(direct())
        .transform(step)
        .to(noop());

    expect(
      await sendOnce(
        build((b) => `A:${b}`),
        "key-route-edit",
        "x",
      ),
    ).toBe("A:x");

    t = await testContext()
      .routes(build((b) => `B:${b}`))
      .build();
    await t.startAndWaitReady();
    const result = await t.client.sendDirect("key-route-edit", "x");

    expect(result).toBe("B:x");
    expect(provider.size).toBe(2);
  });

  /**
   * @case Editing a .choice() predicate under a route-scope cache misses, though every step in both branches is unchanged
   * @preconditions One provider and one route id with .cache() before .from(); .choice(when(p, match), otherwise(other)) where v1's p selects "x" and v2's p rejects it
   * @expectedResult v1 returns the match branch's value; v2 runs the pipeline again and returns the otherwise branch's value
   */
  test("editing a branch predicate under a route-scope cache changes its key", async () => {
    const provider = new MemoryCacheProvider();
    const build = (selects: (ex: Exchange<string>) => boolean) =>
      craft()
        .id("key-route-predicate")
        .cache({ provider })
        .from<string>(direct())
        .choice(
          when(selects, (b) => b.transform((s: string) => `match:${s}`)),
          otherwise((b) => b.transform((s: string) => `other:${s}`)),
        )
        .to(noop());

    expect(
      await sendOnce(
        build((ex) => ex.body === "x"),
        "key-route-predicate",
        "x",
      ),
    ).toBe("match:x");

    t = await testContext()
      .routes(build((ex) => ex.body !== "x"))
      .build();
    await t.startAndWaitReady();
    const result = await t.client.sendDirect("key-route-predicate", "x");

    expect(result).toBe("other:x");
  });

  /**
   * @case Editing a step-scope wrapper's options under a route-scope cache misses
   * @preconditions One provider and one route id with .cache() before .from(); the pipeline is .error(fallback).transform(step) with step always failing; v1's handler returns "fallback-v1", v2's "fallback-v2"
   * @expectedResult v2 runs the pipeline again and returns "fallback-v2", not v1's cached value
   */
  test("editing a wrapper under a route-scope cache changes its key", async () => {
    const provider = new MemoryCacheProvider();
    const step = mock((): string => {
      throw new Error("upstream down");
    });
    const build = (fallback: () => string) =>
      craft()
        .id("key-route-wrapper")
        .cache({ provider })
        .from<string>(direct())
        .error(fallback)
        .transform(step)
        .to(noop());

    expect(
      await sendOnce(
        build(() => "fallback-v1"),
        "key-route-wrapper",
        "x",
      ),
    ).toBe("fallback-v1");

    t = await testContext()
      .routes(build(() => "fallback-v2"))
      .build();
    await t.startAndWaitReady();
    const result = await t.client.sendDirect("key-route-wrapper", "x");

    expect(result).toBe("fallback-v2");
    expect(step).toHaveBeenCalledTimes(2);
  });

  /**
   * @case A route-scope cache over an unchanged pipeline with nested branches and wrappers still hits after a rebuild
   * @preconditions One provider; .cache() before .from() over .error(h).retry(...).transform(compute) and a .choice() with when/otherwise branches; the same route source is built into two contexts in turn
   * @expectedResult The second context hits the entry the first stored and returns the same value; compute runs once
   */
  test("an unchanged pipeline under a route-scope cache still hits after a rebuild", async () => {
    const provider = new MemoryCacheProvider();
    const compute = mock((b: string) => `computed:${b}`);
    const build = () =>
      craft()
        .id("key-route-rebuild")
        .cache({ provider })
        .from<string>(direct())
        .error(() => "fallback")
        .retry({ maxAttempts: 2, backoff: 0 })
        .transform(compute)
        .choice(
          when(
            (ex: Exchange<string>) => ex.body.startsWith("computed"),
            (b) => b.transform((s: string) => `match:${s}`),
          ),
          otherwise((b) => b.transform((s: string) => `other:${s}`)),
        )
        .to(noop());

    expect(await sendOnce(build(), "key-route-rebuild", "x")).toBe(
      "match:computed:x",
    );

    t = await testContext().routes(build()).build();
    await t.startAndWaitReady();
    const second = await t.client.sendDirect("key-route-rebuild", "x");

    expect(second).toBe("match:computed:x");
    expect(compute).toHaveBeenCalledTimes(1);
  });

  /**
   * @case The default key separates delegates acting for the same subject
   * @preconditions Step-scope .cache(); the source emits the same body as alice delegated to agent-1, then to agent-2, then to agent-1 again
   * @expectedResult agent-2 gets its own result; agent-1's repeat is a hit, so the step runs twice
   */
  test("step scope keeps separate entries per actor", async () => {
    const delegated = (actor: string): Principal => ({
      kind: "custom",
      scheme: "bearer",
      issuer: "https://idp.test",
      subject: "alice",
      actor: {
        kind: "custom",
        scheme: "bearer",
        issuer: "https://agents.test",
        subject: actor,
      },
    });
    const source: Source<string> = {
      subscribe: async (sub) => {
        for (const actor of ["agent-1", "agent-2", "agent-1"]) {
          await sub.emit({
            message: "same",
            headers: {
              "routecraft.auth.principal": defaultAuthority.brand(
                delegated(actor),
              ),
            },
          });
        }
      },
    };
    let runs = 0;
    const sink = spy();

    t = await testContext()
      .routes(
        craft()
          .id("key-step-actor")
          .from(source)
          .cache({ provider: new MemoryCacheProvider() })
          .process((ex) =>
            DefaultExchange.rewrap(ex, {
              body: {
                actor: ex.auth.principal?.actor?.subject ?? null,
                run: ++runs,
              },
            }),
          )
          .to(sink),
      )
      .build();
    await t.test();

    expect(runs).toBe(2);
    expect(sink.received.map((e) => e.body)).toEqual([
      { actor: "agent-1", run: 1 },
      { actor: "agent-2", run: 2 },
      { actor: "agent-1", run: 1 },
    ]);
  });

  /**
   * @case The default key terminates on a self-referential actor chain and keeps it apart from the actorless principal
   * @preconditions Step-scope .cache(); the source emits the same body twice under a principal whose actor is itself, then once under the same issuer and subject with no actor
   * @expectedResult Key derivation completes; the repeat is a hit and the actorless principal misses, so the step runs twice
   */
  test("step scope keys a self-referential actor chain", async () => {
    const cyclic: Principal & { actor?: Principal } = {
      kind: "custom",
      scheme: "bearer",
      issuer: "https://idp.test",
      subject: "alice",
    };
    cyclic.actor = cyclic;
    const plain: Principal = {
      kind: "custom",
      scheme: "bearer",
      issuer: "https://idp.test",
      subject: "alice",
    };
    const source: Source<string> = {
      subscribe: async (sub) => {
        for (const principal of [cyclic, cyclic, plain]) {
          await sub.emit({
            message: "same",
            headers: {
              "routecraft.auth.principal": defaultAuthority.brand(principal),
            },
          });
        }
      },
    };
    let runs = 0;
    const sink = spy();

    t = await testContext()
      .routes(
        craft()
          .id("key-step-cyclic-actor")
          .from(source)
          .cache({ provider: new MemoryCacheProvider() })
          .process((ex) => DefaultExchange.rewrap(ex, { body: ++runs }))
          .to(sink),
      )
      .build();
    await t.test();

    expect(runs).toBe(2);
    expect(sink.received.map((e) => e.body)).toEqual([1, 1, 2]);
  });

  /**
   * @case A custom key is used verbatim, so routes sharing a provider share its entries
   * @preconditions Two routes with the same constant custom key on one provider
   * @expectedResult The second route receives the first route's cached result without running its pipeline
   */
  test("a custom key is not namespaced by route", async () => {
    const provider = new MemoryCacheProvider();
    const second = mock((b: string) => `b:${b}`);

    t = await testContext()
      .routes([
        craft()
          .id("key-custom-a")
          .cache({ provider, key: () => "shared" })
          .from<string>(direct())
          .transform((b: string) => `a:${b}`)
          .to(noop()),
        craft()
          .id("key-custom-b")
          .cache({ provider, key: () => "shared" })
          .from<string>(direct())
          .transform(second)
          .to(noop()),
      ])
      .build();

    await t.startAndWaitReady();
    await t.client.sendDirect("key-custom-a", "x");
    const b = await t.client.sendDirect("key-custom-b", "x");

    expect(b).toBe("a:x");
    expect(second).not.toHaveBeenCalled();
  });

  /**
   * @case The default key separates principals on an authenticated route
   * @preconditions POST /me behind jwt auth with route-scope .cache(); alice, bob, then alice again send the same body {}
   * @expectedResult Bob gets his own response, not alice's; alice's second call is a hit, so the pipeline runs twice in total
   */
  test("different principals with the same body get separate entries", async () => {
    const provider = new MemoryCacheProvider();
    let runs = 0;

    const bound = await bootHttp({
      auth: true,
      routes: craft()
        .id("key-me")
        .cache({ provider })
        .from(http({ path: "/me", method: "POST" }))
        .process((ex) =>
          DefaultExchange.rewrap(ex, {
            body: { subject: ex.auth.principal?.subject ?? null, run: ++runs },
          }),
        )
        .to(noop()),
    });
    t = bound.ctx;

    const call = async (sub: string): Promise<unknown> => {
      const res = await fetch(`http://127.0.0.1:${bound.port}/me`, {
        method: "POST",
        headers: {
          authorization: bearer(sub),
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(res.status).toBe(200);
      return res.json();
    };

    expect(await call("alice")).toEqual({ subject: "alice", run: 1 });
    expect(await call("bob")).toEqual({ subject: "bob", run: 2 });
    expect(await call("alice")).toEqual({ subject: "alice", run: 1 });
    expect(runs).toBe(2);
  });

  /**
   * @case A bodiless GET with the default key fails with an accurate RC5029
   * @preconditions GET /items/:id with route-scope .cache() and no key; the http source leaves the body undefined
   * @expectedResult The request answers 500 and the exchange fails with RC5029 saying there is nothing to key on and pointing at `key`
   */
  test("a bodiless GET with the default key fails with RC5029", async () => {
    const failures: unknown[] = [];

    const bound = await bootHttp({
      routes: craft()
        .id("key-bodiless")
        .cache({ provider: new MemoryCacheProvider() })
        .from(http({ path: "/items/:id", method: "GET" }))
        .transform(() => ({ ok: true }))
        .to(noop()),
      onFailed: (details) => failures.push(details),
    });
    t = bound.ctx;

    const res = await fetch(`http://127.0.0.1:${bound.port}/items/1`);

    expect(res.status).toBe(500);
    expect(failures).toHaveLength(1);
    const error = (failures[0] as { error: { rc: string; message: string } })
      .error;
    expect(error.rc).toBe("RC5029");
    expect(error.message).toMatch(/nothing to key on/);
    expect(error.message).toMatch(/Supply a key/);
  });

  /**
   * @case A bodiless GET caches per path parameter once an explicit key is supplied
   * @preconditions GET /items/:id with .cache({ key }) reading routecraft.http.params; requests for /items/1, /items/2, /items/1
   * @expectedResult Each id gets its own response; the repeat of /items/1 is a hit
   */
  test("a bodiless GET caches with an explicit key", async () => {
    let runs = 0;

    const bound = await bootHttp({
      routes: craft()
        .id("key-bodiless-explicit")
        .cache({
          provider: new MemoryCacheProvider(),
          key: (ex) =>
            `item:${JSON.stringify(ex.headers["routecraft.http.params"])}`,
        })
        .from(http({ path: "/items/:id", method: "GET" }))
        .process((ex) =>
          DefaultExchange.rewrap(ex, {
            body: {
              id: ex.headers["routecraft.http.params"]?.["id"],
              run: ++runs,
            },
          }),
        )
        .to(noop()),
    });
    t = bound.ctx;

    const get = async (id: string): Promise<unknown> =>
      (await fetch(`http://127.0.0.1:${bound.port}/items/${id}`)).json();

    expect(await get("1")).toEqual({ id: "1", run: 1 });
    expect(await get("2")).toEqual({ id: "2", run: 2 });
    expect(await get("1")).toEqual({ id: "1", run: 1 });
    expect(runs).toBe(2);
  });

  /**
   * @case Step scope caches an error reply that the wrapped step returns without throwing
   * @preconditions .cache() wraps a transform that returns a 503-shaped body instead of throwing, like an enricher with throwOnHttpError: false
   * @expectedResult The 503-shaped body is cached: the transform runs once and both sends receive it
   */
  test("step scope caches an error reply returned as a value", async () => {
    const provider = new MemoryCacheProvider();
    let calls = 0;
    const sink = spy();

    t = await testContext()
      .routes(
        craft()
          .id("key-step-5xx")
          .from<string>(direct())
          .cache({ provider })
          .transform(() => {
            calls++;
            return { status: 503, body: "upstream down" };
          })
          .to(sink),
      )
      .build();

    await t.startAndWaitReady();
    await t.client.sendDirect("key-step-5xx", "x");
    await t.client.sendDirect("key-step-5xx", "x");

    expect(calls).toBe(1);
    expect(sink.received.map((e) => e.body)).toEqual([
      { status: 503, body: "upstream down" },
      { status: 503, body: "upstream down" },
    ]);
  });

  /**
   * @case Route scope never stores an exchange that fails after the expensive step
   * @preconditions Route-scope .cache(); a transform succeeds, then a later step throws
   * @expectedResult Both sends fail, the transform runs on each, and nothing is stored
   */
  test("route scope does not cache when a later step throws", async () => {
    const provider = new MemoryCacheProvider();
    let calls = 0;

    t = await testContext()
      .routes(
        craft()
          .id("key-route-fails")
          .cache({ provider })
          .from<string>(direct())
          .transform((b: string) => {
            calls++;
            return `computed:${b}`;
          })
          .process(() => {
            throw new Error("downstream failed");
          })
          .to(noop()),
      )
      .build();

    await t.startAndWaitReady();
    await t.client.sendDirect("key-route-fails", "x").catch(() => undefined);
    await t.client.sendDirect("key-route-fails", "x").catch(() => undefined);

    expect(calls).toBe(2);
    expect(provider.size).toBe(0);
  });
});

describe("the default cache provider is the application's own", () => {
  const contexts: TestContext[] = [];

  afterEach(async () => {
    await Promise.all(contexts.splice(0).map((c) => c.stop()));
  });

  /**
   * @case Two applications run one route id over one body with the default cache
   * @preconditions One route definition with .cache() and no provider, installed in two contexts whose plugin provides a different value to the route; the same body dispatched to each
   * @expectedResult Each application computes and serves its own value; a warm entry in one never answers the other
   */
  test("two applications never read each other's default cache entries", async () => {
    const VALUE = port<string>("test.value@1");
    const value = (v: string) =>
      definePlugin({
        id: "test.value",
        provides: [VALUE],
        bind(c) {
          c.provide(VALUE, v);
        },
      });
    const route = () =>
      craft()
        .id("cache-per-application")
        .cache()
        .from(direct())
        .transform((_b, ex) => getExchangeContext(ex)!.require(VALUE));
    const a = await testContext()
      .with({ plugins: [value("A")] })
      .routes(route())
      .build();
    const b = await testContext()
      .with({ plugins: [value("B")] })
      .routes(route())
      .build();
    contexts.push(a, b);
    await Promise.all([a.startAndWaitReady(), b.startAndWaitReady()]);
    expect(
      await a.client.sendDirect<object, string>("cache-per-application", {}),
    ).toBe("A");
    expect(
      await b.client.sendDirect<object, string>("cache-per-application", {}),
    ).toBe("B");
    expect(
      await a.client.sendDirect<object, string>("cache-per-application", {}),
    ).toBe("A");
  });

  /**
   * @case A plugin replacing CACHE receives the call site's provider choice
   * @preconditions A replacement that records whether the resolved options carry a provider, for a .cache() without one and a .cache({ provider })
   * @expectedResult The options carry undefined for the first and the supplied provider for the second; bindCacheProvider settles the first on the fallback
   */
  test("hands a replacement the provider the call site supplied, or none", async () => {
    const seen: Array<CacheProvider | undefined> = [];
    const own = new MemoryCacheProvider();
    const fallback = new MemoryCacheProvider();
    const recording = definePlugin({
      id: "test.recording-cache",
      provides: [CACHE],
      replaces: [CACHE],
      bind(c) {
        const positions = cacheProvider(fallback);
        c.provide(CACHE, {
          ...positions,
          wrap(options) {
            seen.push(options.provider);
            expect(bindCacheProvider(options, fallback).provider).toBe(
              options.provider ?? fallback,
            );
            return positions.wrap(options);
          },
        });
      },
    });
    const t = await testContext()
      .with({ plugins: [recording] })
      .routes([
        craft()
          .id("unsupplied")
          .from(direct())
          .cache()
          .transform(() => 1),
        craft()
          .id("supplied")
          .from(direct())
          .cache({ provider: own })
          .transform(() => 2),
      ])
      .build();
    contexts.push(t);
    await t.startAndWaitReady();
    await t.client.sendDirect("unsupplied", {});
    await t.client.sendDirect("supplied", {});
    expect(seen).toEqual([undefined, own]);
  });
});
