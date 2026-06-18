import { afterEach, describe, expect, test } from "bun:test";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import { craft, direct } from "@routecraft/routecraft";
import { Semaphore } from "../src/operations/semaphore.ts";
import { SleepAbortedError } from "../src/operations/cancellable-sleep.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Semaphore (shared concurrency primitive)", () => {
  /**
   * @case The semaphore admits up to `max` holders, then queues the rest until a slot frees
   * @preconditions A Semaphore(2); three acquire() calls before any release
   * @expectedResult The first two resolve immediately, the third stays pending until a holder releases, then resolves FIFO
   */
  test("admits up to max, queues the rest, releases FIFO", async () => {
    const sem = new Semaphore(2);
    const r1 = await sem.acquire();
    const r2 = await sem.acquire();
    expect(sem.inUse).toBe(2);

    let thirdAdmitted = false;
    const third = sem.acquire().then((release) => {
      thirdAdmitted = true;
      return release;
    });
    // Microtask flush: the third must NOT have been admitted while full.
    await Promise.resolve();
    expect(thirdAdmitted).toBe(false);
    expect(sem.waiting).toBe(1);

    r1(); // free one slot -> the queued waiter gets it
    const r3 = await third;
    expect(thirdAdmitted).toBe(true);
    expect(sem.inUse).toBe(2); // slot transferred, not double-counted

    r2();
    r3();
    expect(sem.inUse).toBe(0);
  });

  /**
   * @case tryAcquire takes a slot only when one is free and never queues
   * @preconditions A Semaphore(1) with one slot already taken
   * @expectedResult The first tryAcquire returns a release; the second returns undefined; after release a third succeeds
   */
  test("tryAcquire returns undefined when full", () => {
    const sem = new Semaphore(1);
    const r1 = sem.tryAcquire();
    expect(r1).toBeDefined();
    expect(sem.tryAcquire()).toBeUndefined();
    r1!();
    expect(sem.tryAcquire()).toBeDefined();
  });

  /**
   * @case A release function is idempotent so a wrapper releasing twice frees exactly one slot
   * @preconditions A Semaphore(1); the single holder's release is called twice
   * @expectedResult inUse returns to 0 (not negative) and a subsequent acquire still works
   */
  test("release is idempotent", () => {
    const sem = new Semaphore(1);
    const r1 = sem.tryAcquire()!;
    r1();
    r1(); // second call is a no-op
    expect(sem.inUse).toBe(0);
    expect(sem.tryAcquire()).toBeDefined();
  });

  /**
   * @case A queued acquire is cancelled when its signal aborts (route shutdown)
   * @preconditions A full Semaphore(1) and a queued acquire(signal); the signal then aborts
   * @expectedResult The queued acquire rejects with SleepAbortedError and leaves no dangling waiter
   */
  test("acquire rejects with SleepAbortedError when the signal aborts", async () => {
    const sem = new Semaphore(1);
    sem.tryAcquire(); // fill the only slot
    const controller = new AbortController();
    const pending = sem.acquire(controller.signal);
    expect(sem.waiting).toBe(1);

    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(SleepAbortedError);
    expect(sem.waiting).toBe(0);
  });
});

describe("Concurrency wrapper (.concurrency())", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case Step-scope .concurrency() bounds the wrapped step to `max` simultaneous in-flight exchanges
   * @preconditions .concurrency({ max: 2 }) over a slow step, with five exchanges sent concurrently
   * @expectedResult All five are delivered and the observed peak simultaneity never exceeds 2
   */
  test("bounds simultaneous in-flight to max (queue mode)", async () => {
    let inFlight = 0;
    let peak = 0;
    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("cc-step-max")
          .from(direct())
          .concurrency({ max: 2 })
          .process(async (ex) => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await sleep(40);
            inFlight--;
            return ex;
          })
          .to(s),
      )
      .build();

    await t.startAndWaitReady();
    await Promise.all(
      [0, 1, 2, 3, 4].map((i) => t.client.sendDirect("cc-step-max", i)),
    );

    expect(t.errors).toHaveLength(0);
    expect(s.received).toHaveLength(5);
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(1); // proves it actually ran concurrently
  });

  /**
   * @case The bulkhead emits queued / acquired / released around admission
   * @preconditions .concurrency({ max: 1 }) over a slow step with three concurrent exchanges
   * @expectedResult Three acquired and three released (one acquired waited:false, two waited:true); two queued; all scope "step"
   */
  test("emits queued, acquired and released with scope step", async () => {
    const acquired: { waited: boolean; scope: string; inUse: number }[] = [];
    const queued: { scope: string; queueDepth: number }[] = [];
    const released: { scope: string; heldMs: number }[] = [];

    t = await testContext()
      .on("route:concurrency:acquired", (p) => {
        acquired.push(
          p.details as { waited: boolean; scope: string; inUse: number },
        );
      })
      .on("route:concurrency:queued", (p) => {
        queued.push(p.details as { scope: string; queueDepth: number });
      })
      .on("route:concurrency:released", (p) => {
        released.push(p.details as { scope: string; heldMs: number });
      })
      .routes(
        craft()
          .id("cc-step-events")
          .from(direct())
          .concurrency({ max: 1 })
          .process(async (ex) => {
            await sleep(20);
            return ex;
          })
          .to(spy()),
      )
      .build();

    await t.startAndWaitReady();
    await Promise.all(
      [0, 1, 2].map((i) => t.client.sendDirect("cc-step-events", i)),
    );

    expect(acquired).toHaveLength(3);
    expect(acquired.every((a) => a.scope === "step")).toBe(true);
    expect(acquired.filter((a) => a.waited === false)).toHaveLength(1);
    expect(acquired.filter((a) => a.waited === true)).toHaveLength(2);
    expect(queued).toHaveLength(2);
    expect(queued.every((q) => q.scope === "step")).toBe(true);
    expect(released).toHaveLength(3);
  });

  /**
   * @case Reject mode fails over-limit exchanges fast with RC5026 instead of queueing
   * @preconditions .concurrency({ max: 1, mode: "reject" }) over a slow step with three concurrent exchanges
   * @expectedResult One exchange runs; the other two reject with RC5026 and emit route:concurrency:rejected reason "busy"
   */
  test("reject mode fails fast with RC5026", async () => {
    const rejected: { reason: string; scope: string }[] = [];
    const s = spy();

    t = await testContext()
      .on("route:concurrency:rejected", (p) => {
        rejected.push(p.details as { reason: string; scope: string });
      })
      .routes(
        craft()
          .id("cc-reject")
          .from(direct())
          .concurrency({ max: 1, mode: "reject" })
          .process(async (ex) => {
            await sleep(40);
            return ex;
          })
          .to(s),
      )
      .build();

    await t.startAndWaitReady();
    const results = await Promise.allSettled(
      [0, 1, 2].map((i) => t.client.sendDirect("cc-reject", i)),
    );

    const failures = results.filter((r) => r.status === "rejected");
    expect(failures).toHaveLength(2);
    for (const f of failures) {
      expect(((f as PromiseRejectedResult).reason as { rc?: string }).rc).toBe(
        "RC5026",
      );
    }
    expect(s.received).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    expect(rejected.every((r) => r.reason === "busy")).toBe(true);
  });

  /**
   * @case A bounded maxQueue rejects once the wait line is full, while still admitting the queued exchange
   * @preconditions .concurrency({ max: 1, maxQueue: 1 }) over a slow step with three concurrent exchanges
   * @expectedResult One runs, one queues then runs (two delivered), one rejects with RC5026 reason "queue-full"
   */
  test("maxQueue rejects when the wait line is full", async () => {
    const rejected: { reason: string }[] = [];
    const s = spy();

    t = await testContext()
      .on("route:concurrency:rejected", (p) => {
        rejected.push(p.details as { reason: string });
      })
      .routes(
        craft()
          .id("cc-maxqueue")
          .from(direct())
          .concurrency({ max: 1, maxQueue: 1 })
          .process(async (ex) => {
            await sleep(40);
            return ex;
          })
          .to(s),
      )
      .build();

    await t.startAndWaitReady();
    const results = await Promise.allSettled(
      [0, 1, 2].map((i) => t.client.sendDirect("cc-maxqueue", i)),
    );

    const failures = results.filter((r) => r.status === "rejected");
    expect(failures).toHaveLength(1);
    expect(s.received).toHaveLength(2);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe("queue-full");
  });

  /**
   * @case A `key` partitions the bulkhead so each key gets its own slot pool
   * @preconditions .concurrency({ max: 1, key }) with two concurrent exchanges each for keys "a" and "b"
   * @expectedResult All four delivered; exactly two queued (one per key, carrying that key); a single global pool would have queued three
   */
  test("key partitions the slot pool per key", async () => {
    const queued: { key?: string }[] = [];
    const s = spy();

    t = await testContext()
      .on("route:concurrency:queued", (p) => {
        queued.push(p.details as { key?: string });
      })
      .routes(
        craft()
          .id("cc-keyed")
          .from(direct())
          .concurrency({ max: 1, key: (ex) => (ex.body as { u: string }).u })
          .process(async (ex) => {
            await sleep(30);
            return ex;
          })
          .to(s),
      )
      .build();

    await t.startAndWaitReady();
    await Promise.all(
      [{ u: "a" }, { u: "a" }, { u: "b" }, { u: "b" }].map((b) =>
        t.client.sendDirect("cc-keyed", b),
      ),
    );

    expect(t.errors).toHaveLength(0);
    expect(s.received).toHaveLength(4);
    // Two pools, each: 1 immediate + 1 queued. A single global pool (max 1)
    // would instead queue 3 of the 4.
    expect(queued).toHaveLength(2);
    expect(queued.map((q) => q.key).sort()).toEqual(["a", "b"]);
  });

  /**
   * @case Route-scope .concurrency() (before .from()) bounds the whole pipeline with scope "route"
   * @preconditions .concurrency({ max: 2 }) staged before .from() over a slow step with four concurrent exchanges
   * @expectedResult All four delivered, peak simultaneity <= 2, and the events carry scope "route"
   */
  test("route-scope .concurrency() bounds the pipeline with scope route", async () => {
    let inFlight = 0;
    let peak = 0;
    const acquired: { scope: string }[] = [];
    const s = spy();

    t = await testContext()
      .on("route:concurrency:acquired", (p) => {
        acquired.push(p.details as { scope: string });
      })
      .routes(
        craft()
          .id("cc-route-scope")
          .concurrency({ max: 2 })
          .from(direct())
          .process(async (ex) => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await sleep(40);
            inFlight--;
            return ex;
          })
          .to(s),
      )
      .build();

    await t.startAndWaitReady();
    await Promise.all(
      [0, 1, 2, 3].map((i) => t.client.sendDirect("cc-route-scope", i)),
    );

    expect(t.errors).toHaveLength(0);
    expect(s.received).toHaveLength(4);
    expect(peak).toBeLessThanOrEqual(2);
    expect(acquired).toHaveLength(4);
    expect(acquired.every((a) => a.scope === "route")).toBe(true);
  });

  /**
   * @case An outer .retry() re-attempts a reject-mode RC5026, because the bulkhead sits inside retry
   * @preconditions .retry() wrapping .concurrency({ max: 1, mode: "reject" }) over a slow step with two concurrent exchanges
   * @expectedResult Both exchanges are eventually delivered: the rejected one backs off and re-acquires a freed slot
   */
  test("an outer retry re-attempts a reject-mode RC5026", async () => {
    const s = spy();
    const rejected: { reason: string }[] = [];
    const attempts: unknown[] = [];

    t = await testContext()
      .on("route:concurrency:rejected", (p) => {
        rejected.push(p.details as { reason: string });
      })
      .on("route:retry:attempt", (p) => {
        attempts.push(p.details);
      })
      .routes(
        craft()
          .id("cc-retry-compose")
          .from(direct())
          .retry({ maxAttempts: 4, backoffMs: 40 })
          .concurrency({ max: 1, mode: "reject" })
          .process(async (ex) => {
            await sleep(20);
            return ex;
          })
          .to(s),
      )
      .build();

    await t.startAndWaitReady();
    const results = await Promise.allSettled(
      [0, 1].map((i) => t.client.sendDirect("cc-retry-compose", i)),
    );

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(s.received).toHaveLength(2);
    expect(t.errors).toHaveLength(0);
    // The point of the test: a reject-mode RC5026 actually fired and was
    // re-attempted by the outer retry (not silently admitted on attempt 1).
    expect(rejected.length).toBeGreaterThanOrEqual(1);
    expect(rejected.every((r) => r.reason === "busy")).toBe(true);
    expect(attempts.length).toBeGreaterThanOrEqual(1);
  });

  /**
   * @case Invalid options fail fast at build time rather than at first dispatch
   * @preconditions Route-scope .concurrency() called with max < 1, maxQueue in reject mode, and maxQueue 0
   * @expectedResult Each call throws RC5003 (validation) synchronously when the route is built
   */
  test("rejects invalid options at build time (RC5003)", () => {
    expect(() => craft().concurrency({ max: 0 })).toThrow(/RC5003|max/);
    expect(() =>
      craft().concurrency({ max: 1, mode: "reject", maxQueue: 5 }),
    ).toThrow(/RC5003|maxQueue/);
    expect(() => craft().concurrency({ max: 1, maxQueue: 0 })).toThrow(
      /RC5003|maxQueue/,
    );
  });

  /**
   * @case The slot is released when the wrapped step throws, so a later exchange can acquire it
   * @preconditions .concurrency({ max: 1 }) over a step that throws on the first exchange and succeeds on the second (sent sequentially)
   * @expectedResult The first exchange fails (error propagates); the second acquires the freed slot and succeeds
   */
  test("releases the slot when the inner step throws", async () => {
    let calls = 0;
    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("cc-release-on-throw")
          .from(direct())
          .concurrency({ max: 1 })
          .process(async (ex) => {
            calls++;
            if (calls === 1) {
              await sleep(10);
              throw new Error("boom");
            }
            return ex;
          })
          .to(s),
      )
      .build();

    await t.startAndWaitReady();
    const first = await t.client
      .sendDirect("cc-release-on-throw", "a")
      .then(() => "ok")
      .catch(() => "err");
    const second = await t.client
      .sendDirect("cc-release-on-throw", "b")
      .then(() => "ok")
      .catch(() => "err");

    expect(first).toBe("err");
    // If the slot had leaked on the throw, the second exchange would block
    // forever (max: 1, no free slot). It succeeding proves the finally released.
    expect(second).toBe("ok");
    expect(s.received).toHaveLength(1);
  });

  /**
   * @case Two stacked .concurrency() wrappers nest and the tighter (inner) limit dominates
   * @preconditions .concurrency({ max: 3 }).concurrency({ max: 1 }) over a slow step with three concurrent exchanges
   * @expectedResult All three delivered and observed peak simultaneity is 1 (the inner max wins)
   */
  test("stacked .concurrency() wrappers nest; the tighter limit wins", async () => {
    let inFlight = 0;
    let peak = 0;
    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("cc-stacked")
          .from(direct())
          .concurrency({ max: 3 })
          .concurrency({ max: 1 })
          .process(async (ex) => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await sleep(30);
            inFlight--;
            return ex;
          })
          .to(s),
      )
      .build();

    await t.startAndWaitReady();
    await Promise.all(
      [0, 1, 2].map((i) => t.client.sendDirect("cc-stacked", i)),
    );

    expect(t.errors).toHaveLength(0);
    expect(s.received).toHaveLength(3);
    expect(peak).toBe(1);
  });

  /**
   * @case A wrapped-step failure cascades to the route-level .error() handler with the original error (not RC5026)
   * @preconditions .concurrency({ max: 1 }) over a step that throws; a route-scope .error() handler staged before .from()
   * @expectedResult The handler is invoked with the inner step's error message
   */
  test("inner step failure cascades to the route-level .error() handler", async () => {
    const seen: string[] = [];

    t = await testContext()
      .routes(
        craft()
          .id("cc-cascade")
          .error((err) => {
            seen.push((err as Error).message);
            throw err;
          })
          .from(direct())
          .concurrency({ max: 1 })
          .process(() => {
            throw new Error("inner boom");
          })
          .to(spy()),
      )
      .build();

    await t.startAndWaitReady();
    await t.client.sendDirect("cc-cascade", "x").catch(() => {});

    expect(seen).toEqual(["inner boom"]);
  });

  /**
   * @case With no .error() handler, a wrapped-step failure uses the default error path and the route keeps processing
   * @preconditions .concurrency({ max: 1 }) over a step that throws on the first exchange only; no route .error()
   * @expectedResult The first exchange fails via the default error path (t.errors records it); a later exchange still succeeds
   */
  test("no route handler: inner step failure uses the default error path", async () => {
    let calls = 0;
    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("cc-default-err")
          .from(direct())
          .concurrency({ max: 1 })
          .process((ex) => {
            calls++;
            if (calls === 1) throw new Error("first fails");
            return ex;
          })
          .to(s),
      )
      .build();

    await t.startAndWaitReady();
    await t.client.sendDirect("cc-default-err", "a").catch(() => {});
    await t.client.sendDirect("cc-default-err", "b");

    expect(t.errors.length).toBeGreaterThanOrEqual(1);
    expect(t.errors[0].message).toContain("first fails");
    expect(s.received).toHaveLength(1);
  });

  /**
   * @case .concurrency() preserves the downstream body type (compile-time)
   * @preconditions A typed body flows through .concurrency() into a following .transform() with no cast
   * @expectedResult The route type-checks (the wrapper does not widen the body) and the transform runs on the typed body
   */
  test("preserves the downstream body type across the wrapper", async () => {
    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("cc-bodytype")
          .from(direct())
          .transform(() => ({ n: 41 }))
          .concurrency({ max: 2 })
          // `body` is inferred as { n: number }; if .concurrency() widened the
          // body type this line would not type-check.
          .transform((body) => body.n + 1)
          .to(s),
      )
      .build();

    await t.startAndWaitReady();
    await t.client.sendDirect("cc-bodytype", "ignored");

    expect(s.received[0].body).toBe(42);
  });

  /**
   * @case Keyed pools survive LRU eviction of in-use keys without corrupting the cache or losing exchanges
   * @preconditions .concurrency({ max: 1, key, maxKeys: 2 }) over a slow step with six distinct keys held concurrently (far above maxKeys)
   * @expectedResult All six exchanges complete with no errors (evicting an in-use pool must not corrupt the LRU or drop work)
   */
  test("keyed eviction above maxKeys does not corrupt the pool cache", async () => {
    const s = spy();
    const acquiredKeys = new Set<string>();

    t = await testContext()
      .on("route:concurrency:acquired", (p) => {
        const { key } = p.details as { key?: string };
        if (key !== undefined) acquiredKeys.add(key);
      })
      .routes(
        craft()
          .id("cc-evict")
          .from(direct())
          .concurrency({
            max: 1,
            key: (ex) => String((ex.body as { k: number }).k),
            maxKeys: 2,
          })
          .process(async (ex) => {
            await sleep(10);
            return ex;
          })
          .to(s),
      )
      .build();

    await t.startAndWaitReady();
    await Promise.all(
      [0, 1, 2, 3, 4, 5].map((k) => t.client.sendDirect("cc-evict", { k })),
    );

    expect(t.errors).toHaveLength(0);
    expect(s.received).toHaveLength(6);
    // Six distinct keys were admitted against a maxKeys of 2, so far more
    // than maxKeys pools existed at once: in-use pools were genuinely
    // evicted and rebuilt. The old re-entrant-`set`-in-`dispose` code would
    // have corrupted the LRU here and lost or mis-routed exchanges.
    expect(acquiredKeys.size).toBe(6);
  });
});
