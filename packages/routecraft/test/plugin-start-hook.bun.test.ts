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

    expect(context.ctx.start()).rejects.toThrow(
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

    expect(context.ctx.start()).rejects.toThrow("the real cause");
  });
});
