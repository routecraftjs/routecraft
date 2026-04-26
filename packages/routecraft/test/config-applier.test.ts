import { afterEach, describe, expect, test } from "vitest";
import {
  CraftContext,
  type CraftPlugin,
  defineConfig,
  registerConfigApplier,
} from "../src/index.ts";

/**
 * Access the cross-instance applier registry directly so tests can sandbox
 * registrations and reset between cases. Mirrors the symbol used in
 * config-applier.ts.
 */
const REGISTRY_KEY = Symbol.for("routecraft.config-applier-registry");

type GlobalWithRegistry = typeof globalThis & {
  [REGISTRY_KEY]?: Map<string, (opts: unknown) => CraftPlugin>;
};

function snapshotRegistry(): Map<string, (opts: unknown) => CraftPlugin> {
  const g = globalThis as GlobalWithRegistry;
  return new Map(g[REGISTRY_KEY] ?? new Map());
}

function restoreRegistry(
  snapshot: Map<string, (opts: unknown) => CraftPlugin>,
): void {
  const g = globalThis as GlobalWithRegistry;
  g[REGISTRY_KEY] = new Map(snapshot);
}

/**
 * Augment CraftConfig with sandbox keys so the test file can register
 * appliers without depending on @routecraft/ai. The augmentation must
 * target the published module specifier so it propagates to the same
 * interface identity that registerConfigApplier and defineConfig see.
 */
declare module "@routecraft/routecraft" {
  interface CraftConfig {
    __testApplier?: { value: string };
    __testApplierB?: { value: string };
  }
}

describe("registerConfigApplier", () => {
  let snapshot: Map<string, (opts: unknown) => CraftPlugin>;

  afterEach(() => {
    if (snapshot) restoreRegistry(snapshot);
  });

  /**
   * @case A registered config applier produces a plugin during context init
   *   when the corresponding key is set on CraftConfig
   * @preconditions Applier registered for "__testApplier"; config has the key set
   * @expectedResult Plugin's apply() runs during initPlugins() with the config value
   */
  test("applier produces a plugin when key is present", async () => {
    snapshot = snapshotRegistry();

    const applied: Array<{ value: string }> = [];
    registerConfigApplier("__testApplier", (options) => ({
      apply() {
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
    snapshot = snapshotRegistry();

    let called = false;
    registerConfigApplier("__testApplier", () => ({
      apply() {
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
    snapshot = snapshotRegistry();

    const order: string[] = [];
    registerConfigApplier("__testApplier", () => ({
      apply() {
        order.push("applier");
      },
    }));

    const userPlugin: CraftPlugin = {
      apply() {
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
   * @expectedResult Apply order matches registration order; user plugins run last
   */
  test("multiple appliers run in registration order", async () => {
    snapshot = snapshotRegistry();

    const order: string[] = [];
    registerConfigApplier("__testApplier", () => ({
      apply() {
        order.push("a");
      },
    }));
    registerConfigApplier("__testApplierB", () => ({
      apply() {
        order.push("b");
      },
    }));

    const userPlugin: CraftPlugin = {
      apply() {
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
   * @case Teardown for an applier-produced plugin runs during context.stop(),
   *   in reverse-of-startup order so user plugins tear down first
   * @preconditions Applier produces a plugin with teardown; user plugins[] also has teardown
   * @expectedResult Stop calls user teardown first, then applier teardown
   */
  test("teardown runs in reverse order on stop", async () => {
    snapshot = snapshotRegistry();

    const order: string[] = [];
    registerConfigApplier("__testApplier", () => ({
      apply() {},
      teardown() {
        order.push("applier-teardown");
      },
    }));

    const userPlugin: CraftPlugin = {
      apply() {},
      teardown() {
        order.push("user-teardown");
      },
    };

    const ctx = new CraftContext({
      __testApplier: { value: "x" },
      plugins: [userPlugin],
    });
    await ctx.initPlugins();
    await ctx.stop();

    expect(order).toEqual(["user-teardown", "applier-teardown"]);
  });

  /**
   * @case Re-registering the same key with a new applier replaces the previous
   *   registration (last writer wins)
   * @preconditions Two registerConfigApplier calls for the same key
   * @expectedResult Only the latest applier runs when the context is built
   */
  test("re-registration replaces the previous applier", async () => {
    snapshot = snapshotRegistry();

    const calls: string[] = [];
    registerConfigApplier("__testApplier", () => ({
      apply() {
        calls.push("first");
      },
    }));
    registerConfigApplier("__testApplier", () => ({
      apply() {
        calls.push("second");
      },
    }));

    const ctx = new CraftContext({ __testApplier: { value: "x" } });
    await ctx.initPlugins();

    expect(calls).toEqual(["second"]);
  });
});

describe("defineConfig", () => {
  /**
   * @case defineConfig is an identity function at runtime
   * @preconditions Any CraftConfig-shaped object is passed in
   * @expectedResult Returns the same reference, unchanged
   */
  test("returns the input unchanged", () => {
    const input = { cron: { timezone: "UTC" } };
    const output = defineConfig(input);

    expect(output).toBe(input);
  });
});
