import { describe, test, expect, vi } from "vitest";
import { cronPlugin } from "../src/adapters/cron/plugin.ts";
import { ADAPTER_CRON_OPTIONS } from "../src/adapters/cron/source.ts";
import type { CraftContext } from "../src/context.ts";

function mockContext(): CraftContext {
  const store = new Map();
  return {
    logger: {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
    },
    getStore: (key: symbol) => store.get(key),
    setStore: (key: symbol, value: unknown) => store.set(key, value),
  } as unknown as CraftContext;
}

describe("cronPlugin", () => {
  /**
   * @case cronPlugin returns a CraftPlugin with an apply method
   * @preconditions Called with partial CronOptions
   * @expectedResult Returns an object with an apply function
   */
  test("returns a CraftPlugin with an apply method", () => {
    const plugin = cronPlugin({ timezone: "UTC" });
    expect(plugin).toHaveProperty("apply");
    expect(typeof plugin.apply).toBe("function");
  });

  /**
   * @case apply() writes default options to the context store
   * @preconditions Plugin created with timezone and jitterMs defaults
   * @expectedResult Context store contains the provided defaults under ADAPTER_CRON_OPTIONS
   */
  test("apply() writes default options to the context store", () => {
    const defaults = { timezone: "UTC", jitterMs: 2000 };
    const plugin = cronPlugin(defaults);
    const ctx = mockContext();

    plugin.apply(ctx);

    const stored = ctx.getStore(ADAPTER_CRON_OPTIONS);
    expect(stored).toEqual(defaults);
  });

  /**
   * @case apply() stores an empty object when called with no options
   * @preconditions Plugin created with empty options
   * @expectedResult Context store contains an empty object under ADAPTER_CRON_OPTIONS
   */
  test("apply() stores an empty object when called with no options", () => {
    const plugin = cronPlugin({});
    const ctx = mockContext();

    plugin.apply(ctx);

    const stored = ctx.getStore(ADAPTER_CRON_OPTIONS);
    expect(stored).toEqual({});
  });

  /**
   * @case Plugin has no teardown method
   * @preconditions Plugin created with any options
   * @expectedResult The teardown property is undefined
   */
  test("does not define a teardown method", () => {
    const plugin = cronPlugin({ timezone: "UTC" });
    expect(plugin.teardown).toBeUndefined();
  });
});
