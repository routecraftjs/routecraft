import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  CraftContext,
  type Plugin,
  registerConfigApplier,
} from "../src/index.ts";

/**
 * Access the cross-instance applier registry directly so tests can sandbox
 * registrations and reset between cases. Mirrors the symbol used in
 * config-applier.ts.
 */
const REGISTRY_KEY = Symbol.for("routecraft.config-applier-registry");

type GlobalWithRegistry = typeof globalThis & {
  [REGISTRY_KEY]?: Map<string, (opts: unknown) => Plugin>;
};

function snapshotRegistry(): Map<string, (opts: unknown) => Plugin> {
  const g = globalThis as GlobalWithRegistry;
  return new Map(g[REGISTRY_KEY] ?? new Map());
}

function restoreRegistry(
  snapshot: Map<string, (opts: unknown) => Plugin>,
): void {
  const g = globalThis as GlobalWithRegistry;
  g[REGISTRY_KEY] = new Map(snapshot);
}

/**
 * Augment CraftConfig with sandbox keys so the test file can register
 * appliers without depending on @routecraft/ai. The augmentation must
 * target the published module specifier so it propagates to the same
 * interface identity that registerConfigApplier sees.
 */
declare module "@routecraft/routecraft" {
  interface CraftConfig {
    __testApplier?: { value: string };
    __testApplierB?: { value: string };
  }
}

describe("registerConfigApplier", () => {
  // Capture in beforeEach (not in each test body) so a future setup change
  // that throws before the test body runs still restores the registry.
  let snapshot: Map<string, (opts: unknown) => Plugin> | undefined;

  beforeEach(() => {
    snapshot = snapshotRegistry();
  });

  afterEach(() => {
    if (snapshot) restoreRegistry(snapshot);
    snapshot = undefined;
  });

  /**
   * @case A registered config applier produces a plugin during context init
   *   when the corresponding key is set on CraftConfig
   * @preconditions Applier registered for "__testApplier"; config has the key set
   * @expectedResult Plugin's bind() runs during initPlugins() with the config value
   */
  test("applier produces a plugin when key is present", async () => {
    const applied: Array<{ value: string }> = [];
    registerConfigApplier("__testApplier", (options) => ({
      id: "test.applier",
      bind() {
        applied.push(options);
      },
    }));

    const ctx = new CraftContext({ __testApplier: { value: "hello" } });
    await ctx.initPlugins();

    expect(applied).toEqual([{ value: "hello" }]);
  });

  /**
   * @case A registered config applier is skipped when the corresponding key
   *   is absent from the config
   * @preconditions Applier registered for "__testApplier"; config omits the key
   * @expectedResult The applier is never invoked
   */
  test("applier is not invoked when key is absent", async () => {
    let called = false;
    registerConfigApplier("__testApplier", () => ({
      id: "test.applier",
      bind() {
        called = true;
      },
    }));

    const ctx = new CraftContext({});
    await ctx.initPlugins();

    expect(called).toBe(false);
  });

  /**
   * @case Plugins from config appliers run before user-supplied plugins
   * @preconditions Applier registered for "__testApplier"; config has key + plugins[]
   * @expectedResult initPlugins runs the applier-produced plugin first, then user plugins
   */
  test("applier-produced plugin runs before user plugins[]", async () => {
    const order: string[] = [];
    registerConfigApplier("__testApplier", () => ({
      id: "test.applier",
      bind() {
        order.push("applier");
      },
    }));

    const userPlugin: Plugin = {
      id: "test.user",
      bind() {
        order.push("user");
      },
    };

    const ctx = new CraftContext({
      __testApplier: { value: "x" },
      plugins: [userPlugin],
    });
    await ctx.initPlugins();

    expect(order).toEqual(["applier", "user"]);
  });

  /**
   * @case Multiple config appliers run in registration order, before user plugins
   * @preconditions Two appliers registered (__testApplier, __testApplierB); both keys set
   * @expectedResult Bind order matches registration order; user plugins run last
   */
  test("multiple appliers run in registration order", async () => {
    const order: string[] = [];
    registerConfigApplier("__testApplier", () => ({
      id: "test.applier",
      bind() {
        order.push("a");
      },
    }));
    registerConfigApplier("__testApplierB", () => ({
      id: "test.applier-b",
      bind() {
        order.push("b");
      },
    }));

    const userPlugin: Plugin = {
      id: "test.user",
      bind() {
        order.push("user");
      },
    };

    const ctx = new CraftContext({
      __testApplier: { value: "1" },
      __testApplierB: { value: "2" },
      plugins: [userPlugin],
    });
    await ctx.initPlugins();

    expect(order).toEqual(["a", "b", "user"]);
  });

  /**
   * @case stop for an applier-produced plugin runs during context.stop(),
   *   in reverse-of-startup order so user plugins stop first
   * @preconditions Applier produces a plugin with stop; user plugins[] also has stop
   * @expectedResult context.stop() calls the user stop first, then the applier stop
   */
  test("plugin stop runs in reverse order on context stop", async () => {
    const order: string[] = [];
    registerConfigApplier("__testApplier", () => ({
      id: "test.applier",
      bind() {},
      stop() {
        order.push("applier-stop");
      },
    }));

    const userPlugin: Plugin = {
      id: "test.user",
      bind() {},
      stop() {
        order.push("user-stop");
      },
    };

    const ctx = new CraftContext({
      __testApplier: { value: "x" },
      plugins: [userPlugin],
    });
    await ctx.initPlugins();
    await ctx.stop();

    expect(order).toEqual(["user-stop", "applier-stop"]);
  });

  /**
   * @case Re-registering the same key with a new applier replaces the previous
   *   registration (last writer wins)
   * @preconditions Two registerConfigApplier calls for the same key
   * @expectedResult Only the latest applier runs when the context is built
   */
  test("re-registration replaces the previous applier", async () => {
    const calls: string[] = [];
    registerConfigApplier("__testApplier", () => ({
      id: "test.applier",
      bind() {
        calls.push("first");
      },
    }));
    registerConfigApplier("__testApplier", () => ({
      id: "test.applier",
      bind() {
        calls.push("second");
      },
    }));

    const ctx = new CraftContext({ __testApplier: { value: "x" } });
    await ctx.initPlugins();

    expect(calls).toEqual(["second"]);
  });
});
