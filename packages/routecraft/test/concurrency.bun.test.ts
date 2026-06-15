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

    t = await testContext()
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
});
