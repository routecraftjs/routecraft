import { afterEach, describe, expect, test } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import { craft, direct, noop, type CraftPlugin } from "../src/index.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The third phase of the plugin lifecycle.
 *
 * `apply()` wires the context at build time, when no route is running.
 * `start()` begins work, and its whole reason to exist is that the routes
 * are up by the time it runs: the suspension sweeper re-enters a route's
 * error channel, which a route that has not started cannot serve. These
 * pin that ordering and the failure contract, because a plugin that starts
 * a timer and then throws is how a process ends up alive with no visible
 * cause.
 */
describe("the plugin start hook", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case start() runs after every route has been started, and after apply()
   * @preconditions A plugin recording the phase order, and a route whose source is running
   * @expectedResult apply precedes route start precedes start. The ordering is the hook's entire purpose: a background task that drives routes cannot run before they exist
   */
  test("runs after apply and after the routes are up", async () => {
    const order: string[] = [];

    const plugin: CraftPlugin = {
      name: "recorder",
      apply() {
        order.push("apply");
      },
      start() {
        order.push("start");
      },
    };

    t = await testContext()
      .with({ plugins: [plugin] })
      .routes([craft().id("worker").from(direct()).to(noop())])
      .build();
    await t.startAndWaitReady();
    order.push("ready");

    expect(order.indexOf("apply")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("start")).toBeGreaterThan(order.indexOf("apply"));
    expect(order).toContain("start");
  });

  /**
   * @case Plugins start in registration order
   * @preconditions Three plugins declaring start(), registered in a known order
   * @expectedResult They start in that order. A plugin whose task depends on an earlier plugin's runtime has the same ordering guarantee at start that it already has at apply
   */
  test("starts plugins in registration order", async () => {
    const started: string[] = [];
    const record = (name: string): CraftPlugin => ({
      name,
      apply() {},
      start() {
        started.push(name);
      },
    });

    t = await testContext()
      .with({ plugins: [record("first"), record("second"), record("third")] })
      .routes([craft().id("worker").from(direct()).to(noop())])
      .build();
    await t.startAndWaitReady();

    expect(started).toEqual(["first", "second", "third"]);
  });

  /**
   * @case An async start() is awaited before the next plugin starts
   * @preconditions A slow plugin whose start() resolves after a delay, registered before a fast one
   * @expectedResult The slow plugin finishes before the fast one begins. A hook that was fired and not awaited would interleave them, and a plugin whose task depends on an earlier plugin's would race it
   */
  test("awaits an async start before starting the next plugin", async () => {
    const order: string[] = [];
    let secondStarted: () => void;
    const bothRan = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });

    const slow: CraftPlugin = {
      name: "slow",
      apply() {},
      async start() {
        await sleep(20);
        order.push("slow finished");
      },
    };
    const fast: CraftPlugin = {
      name: "fast",
      apply() {},
      start() {
        order.push("fast started");
        secondStarted();
      },
    };

    t = await testContext()
      .with({ plugins: [slow, fast] })
      .routes([craft().id("worker").from(direct()).to(noop())])
      .build();
    await t.startAndWaitReady();
    await bothRan;

    expect(order).toEqual(["slow finished", "fast started"]);
  });

  /**
   * @case A context is not ready until its start hooks have finished
   * @preconditions A plugin whose start() takes measurably longer than the routes do to come up
   * @expectedResult startAndWaitReady() does not resolve first. Readiness that meant only routes-up would let a test assert against work a start hook had not yet done, which is precisely how the suspension sweeper's downtime scan would be raced
   */
  test("is not ready until the start hooks have finished", async () => {
    let finished = false;

    const plugin: CraftPlugin = {
      name: "slow",
      apply() {},
      async start() {
        await sleep(30);
        finished = true;
      },
    };

    t = await testContext()
      .with({ plugins: [plugin] })
      .routes([craft().id("worker").from(direct()).to(noop())])
      .build();
    await t.startAndWaitReady();

    expect(finished).toBe(true);
  });

  /**
   * @case A throwing start() fails context.start() with the original error
   * @preconditions A plugin whose start() throws a recognisable error
   * @expectedResult context.start() rejects with that exact error, unwrapped. The failure semantics are the hook's equivalent of a race test: a plugin that cannot start must not leave a context that reports itself as running
   */
  test("a throwing start fails the context start, preserving the error", async () => {
    const boom = new Error("sweeper could not open its schedule");
    const plugin: CraftPlugin = {
      name: "refuses",
      apply() {},
      start() {
        throw boom;
      },
    };

    const context = await testContext()
      .with({ plugins: [plugin] })
      .routes([craft().id("worker").from(direct()).to(noop())])
      .build();

    await expect(context.ctx.start()).rejects.toThrow(
      "sweeper could not open its schedule",
    );
  });

  /**
   * @case A failed start tears down the plugins that did start
   * @preconditions A first plugin that starts and records teardown, and a second whose start() throws
   * @expectedResult The first plugin is torn down. Without this a plugin that started an interval keeps the process alive after a boot that failed, which is the timer form of the leak tracked in #565
   */
  test("tears down already started plugins when a later one refuses", async () => {
    let tornDown = false;

    const holder: CraftPlugin = {
      name: "holder",
      apply() {},
      start() {},
      teardown() {
        tornDown = true;
      },
    };
    const refuses: CraftPlugin = {
      name: "refuses",
      apply() {},
      start() {
        throw new Error("no");
      },
    };

    const context = await testContext()
      .with({ plugins: [holder, refuses] })
      .routes([craft().id("worker").from(direct()).to(noop())])
      .build();

    await context.ctx.start().catch(() => {});

    expect(tornDown).toBe(true);
  });

  /**
   * @case A context that refuses its own config before it reaches the plugins
   * @preconditions A route that can reach .suspend() with no suspension block, so start() throws RC5052 before any hook runs
   * @expectedResult whenStarted() rejects with that error. A readiness signal that only settles once the plugin phase is reached leaves the two most common startup failures pending forever, so a broken process reports "still starting" instead of failing
   */
  test("whenStarted rejects when the context refuses its config", async () => {
    const context = await testContext()
      .routes([
        craft()
          .id("payout")
          .from(direct())
          .suspend({ expect: { "~standard": undefined } as never })
          .to(noop()),
      ])
      .build();

    const ready = context.ctx.whenStarted();
    await expect(context.ctx.start()).rejects.toThrow();
    await expect(ready).rejects.toThrow();
  });

  /**
   * @case A context started again after a failed start
   * @preconditions One plugin whose start() refuses, which shuts the context down
   * @expectedResult The second start() throws RC1004 rather than booting dead routes. A failed start ran the shutdown path, and a context whose controllers are gone must refuse loudly instead of reporting ready over routes that can no longer serve
   */
  test("a start after a failed one is refused", async () => {
    const plugin: CraftPlugin = {
      name: "flaky",
      apply() {},
      start() {
        throw new Error("first boot failed");
      },
    };

    t = await testContext()
      .with({ plugins: [plugin] })
      .routes([craft().id("worker").from(direct()).to(noop())])
      .build();

    const refused = await t.ctx.start().then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(String(refused)).toContain("first boot failed");

    await expect(t.ctx.start()).rejects.toMatchObject({ rc: "RC1004" });
  });

  /**
   * @case Two concurrent start() calls collapse into one boot
   * @preconditions A plugin counting its start() invocations, with start() called twice without awaiting
   * @expectedResult Both calls share one boot and the hook runs once. A double boot would run every start() hook twice, and the suspension plugin's second sweeper would orphan the first against a store that outlives neither
   */
  test("concurrent starts collapse into one boot", async () => {
    let started = 0;
    const plugin: CraftPlugin = {
      name: "counter",
      apply() {},
      start() {
        started++;
      },
    };

    t = await testContext()
      .with({ plugins: [plugin] })
      .routes([craft().id("worker").from(direct()).to(noop())])
      .build();

    const first = t.ctx.start();
    const second = t.ctx.start();
    first.catch(() => {});
    second.catch(() => {});
    await t.ctx.whenStarted();

    expect(started).toBe(1);
  });

  /**
   * @case A single route failing to start does not hold readiness
   * @preconditions Two routes, one whose source throws on subscribe, plus a plugin start() hook
   * @expectedResult whenStarted() resolves and the hook runs. One route failing does not fail the context by design, so readiness waits for no route still coming up rather than for all of them succeeding; a probe that must know a specific route is serving watches route:started
   */
  test("whenStarted resolves when a single route fails to start", async () => {
    let hookRan = false;
    const plugin: CraftPlugin = {
      name: "observer",
      apply() {},
      start() {
        hookRan = true;
      },
    };

    t = await testContext()
      .with({ plugins: [plugin] })
      .routes([
        craft()
          .id("broken")
          .from(() => {
            throw new Error("cannot bind");
          })
          .to(noop()),
        craft().id("worker").from(direct()).to(noop()),
      ])
      .build();

    void t.ctx.start().catch(() => {});
    await t.ctx.whenStarted();

    expect(hookRan).toBe(true);
  });

  /**
   * @case A throwing teardown during the unwind does not mask the start failure
   * @preconditions A first plugin whose teardown throws, and a second whose start() throws
   * @expectedResult context.start() still rejects with the start error, not the teardown error. The operator needs the cause of the failed boot, not whatever the cleanup hit on the way out
   */
  test("an unwind failure does not replace the start error", async () => {
    const holder: CraftPlugin = {
      name: "holder",
      apply() {},
      start() {},
      teardown() {
        throw new Error("teardown also failed");
      },
    };
    const refuses: CraftPlugin = {
      name: "refuses",
      apply() {},
      start() {
        throw new Error("the real cause");
      },
    };

    const context = await testContext()
      .with({ plugins: [holder, refuses] })
      .routes([craft().id("worker").from(direct()).to(noop())])
      .build();

    await expect(context.ctx.start()).rejects.toThrow("the real cause");
  });
});
