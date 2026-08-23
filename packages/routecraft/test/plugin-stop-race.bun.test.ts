import { afterEach, describe, expect, test } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import { craft, direct, noop, type CraftPlugin } from "../src/index.ts";
import { CraftContext } from "../src/context.ts";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for a recorded phase, bounded.
 *
 * An unbounded poll turns a lifecycle regression into a hung suite instead
 * of a failure, which is the same blindness a fixed sleep causes from the
 * other side.
 */
const waitFor = async (reached: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!reached()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
};

/**
 * A `stop()` that arrives while a plugin lifecycle hook is still awaiting.
 *
 * Teardown keys off the applied set, so the plugin is torn down. The defect
 * is the order: the hook resolved after its own `teardown()` had run, so
 * anything it acquired past its last await point was acquired after the
 * release meant to cover it and nothing ever released it. For a process that
 * exits the OS reclaims; for an embedder or a test building successive
 * contexts in one process, the interval or socket simply lives on.
 *
 * Shutdown therefore waits for the hook rather than interrupting it, and
 * waits unbounded, on a promise covering the lifecycle hooks alone. It never
 * covers `run()`, which for an indefinite route resolves only once the
 * context stops: waiting on that would deadlock the shutdown this ordering
 * exists to serve.
 */
describe("a stop racing a plugin lifecycle hook", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * How long a gated hook stays in flight.
   *
   * This is the hook's own duration, not a synchronisation guess: the test
   * waits for the hook to be entered before stopping, so the race is
   * established deterministically and the assertions never depend on when
   * this elapses. It only has to outlast the moment teardown would otherwise
   * begin, which for a context with no routes to drain is immediate.
   */
  const HOOK_MS = 200;

  /**
   * @case stop() lands while a plugin's start() is still awaiting
   * @preconditions A directly constructed context whose plugin start() is still running when stop() arrives
   * @expectedResult The observed order is enter, resolve, teardown. Teardown running second would release a plugin that is still acquiring, which is the leak this ticket exists for
   */
  test("waits for an in-flight start() before tearing that plugin down", async () => {
    const order: string[] = [];

    // Built by hand and without routes: stage one then has nothing to drain,
    // so a shutdown that did not wait would reach teardown immediately and
    // the ordering assertion below would catch it with the whole hook
    // duration to spare.
    const ctx = new CraftContext({
      plugins: [
        {
          name: "slow-start",
          apply() {},
          async start() {
            order.push("start:enter");
            await sleep(HOOK_MS);
            order.push("start:resolve");
          },
          teardown() {
            order.push("teardown");
          },
        },
      ],
    });

    const started = ctx.start();
    started.catch(() => {});
    await waitFor(
      () => order.includes("start:enter"),
      "the start hook to be entered",
    );

    await ctx.stop();
    await started;

    expect(order).toEqual(["start:enter", "start:resolve", "teardown"]);
  });

  /**
   * @case stop() lands while a plugin's apply() is still awaiting
   * @preconditions A directly constructed context, two plugins, the first still in apply() when stop() arrives
   * @expectedResult The first resolves before its teardown, and the second never applies. A plugin applied after teardown has walked the applied set acquires what nothing will release
   */
  test("waits for an in-flight apply() and applies no plugin after it", async () => {
    const order: string[] = [];

    // ContextBuilder.build() awaits initPlugins(), so a gated apply() would
    // hold the builder itself and the test would never reach its stop().
    const ctx = new CraftContext({
      plugins: [
        {
          name: "slow-apply",
          async apply() {
            order.push("apply:enter");
            await sleep(HOOK_MS);
            order.push("apply:resolve");
          },
          teardown() {
            order.push("teardown");
          },
        },
        {
          name: "later",
          apply() {
            order.push("later:apply");
          },
        },
      ],
    });

    const started = ctx.start();
    started.catch(() => {});
    await waitFor(
      () => order.includes("apply:enter"),
      "the apply hook to be entered",
    );

    await ctx.stop();
    await started.catch(() => undefined);

    expect(order).toEqual(["apply:enter", "apply:resolve", "teardown"]);
  });

  /**
   * @case stop() on a started context with indefinite routes and no hook in flight
   * @preconditions A healthy plugin whose start() has already resolved, and a route whose source runs until the context stops
   * @expectedResult stop() resolves and teardown runs. The wait is scoped to lifecycle hooks, so it cannot be held open by the route work that only ends at shutdown
   */
  test("adds no wait when no hook is in flight", async () => {
    const order: string[] = [];

    const plugin: CraftPlugin = {
      name: "prompt-start",
      apply() {},
      start() {
        order.push("start");
      },
      teardown() {
        order.push("teardown");
      },
    };

    t = await testContext()
      .with({ plugins: [plugin] })
      .routes(craft().id("worker").from(direct()).to(noop()))
      .build();
    await t.startAndWaitReady();

    const wedged = Symbol("wedged");
    const outcome = await Promise.race([
      t.ctx.stop(),
      sleep(5_000).then(() => wedged),
    ]);

    expect(outcome).not.toBe(wedged);
    expect(order).toEqual(["start", "teardown"]);
  });

  /**
   * @case A plugin:starting subscriber stops the context synchronously
   * @preconditions A handler on the lifecycle event that calls stop() before the hook is invoked
   * @expectedResult The hook never runs and the shutdown completes. Event handlers dispatch synchronously, so a stop can land between the walk's guard and the hook, and a hook started into a shutdown that now waits for it could hold that shutdown open forever
   */
  test("starts no hook when an event handler stops the context", async () => {
    const order: string[] = [];
    let stopping: Promise<unknown> | undefined;

    const ctx = new CraftContext({
      plugins: [
        {
          name: "stopped-at-the-event",
          apply() {},
          start() {
            order.push("start:enter");
          },
          teardown() {
            order.push("teardown");
          },
        },
      ],
    });
    ctx.on("plugin:starting", () => {
      order.push("stop");
      stopping = ctx.stop();
    });

    await ctx.start().catch(() => undefined);
    await stopping;

    expect(order).toEqual(["stop", "teardown"]);
  });

  /**
   * @case A plugin:applying subscriber stops the context synchronously
   * @preconditions The same handler shape one phase earlier, on the apply walk, with a route registered
   * @expectedResult The plugin never applies, so it is not torn down either, and the boot goes no further: a route started here would announce progress for a context that is already gone, and refuse with RC3001 against its aborted controller anyway
   */
  test("applies no plugin and starts no route when an event handler stops the context", async () => {
    const order: string[] = [];
    let stopping: Promise<unknown> | undefined;

    const ctx = new CraftContext({
      plugins: [
        {
          name: "stopped-at-the-event",
          apply() {
            order.push("apply:enter");
          },
          teardown() {
            order.push("teardown");
          },
        },
      ],
    });
    ctx.registerRoutes(
      ...craft().id("worker").from(direct()).to(noop()).build(),
    );
    ctx.on("route:starting", () => {
      order.push("route:starting");
    });
    ctx.on("plugin:applying", () => {
      order.push("stop");
      stopping = ctx.stop();
    });

    await ctx.start().catch(() => undefined);
    await stopping;

    expect(order).toEqual(["stop"]);
  });

  /**
   * @case A hook requests shutdown without awaiting it, then finishes its own work
   * @preconditions A start() hook that calls ctx.stop() unawaited and then keeps working past an await
   * @expectedResult The hook settles before its teardown, and the shutdown completes. This is the sanctioned spelling for a hook that wants the context down without failing the boot, so it is a guarantee rather than an accident: awaiting the same call would have the hook wait for a shutdown that is waiting for the hook
   */
  test("shuts down cleanly when a hook requests it without awaiting", async () => {
    const order: string[] = [];
    let stopping: Promise<unknown> | undefined;

    const ctx: CraftContext = new CraftContext({
      plugins: [
        {
          name: "requests-shutdown",
          apply() {},
          async start() {
            order.push("start:enter");
            stopping = ctx.stop();
            // Work after the request, so the assertion measures the ordering
            // rather than a hook that happened to finish first.
            await sleep(HOOK_MS);
            order.push("start:resolve");
          },
          teardown() {
            order.push("teardown");
          },
        },
      ],
    });

    // Asserted before awaiting the outcome: run() awaits the shutdown before
    // resolving, so start() returning already means the context is down, and
    // checking here pins that rather than only the recorded order.
    await ctx.start();
    expect(order).toEqual(["start:enter", "start:resolve", "teardown"]);

    await stopping;
  });
});
