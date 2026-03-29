import { describe, test, expect, vi } from "vitest";
import { directPlugin } from "../src/adapters/direct/plugin.ts";
import { ADAPTER_DIRECT_OPTIONS } from "../src/adapters/direct/shared.ts";
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

describe("directPlugin", () => {
  /**
   * @case directPlugin returns a CraftPlugin with an apply method
   * @preconditions Called with partial DirectOptionsMerged
   * @expectedResult Returns an object with an apply function
   */
  test("returns a CraftPlugin with an apply method", () => {
    const plugin = directPlugin({ description: "Internal API" });
    expect(plugin).toHaveProperty("apply");
    expect(typeof plugin.apply).toBe("function");
  });

  /**
   * @case apply() writes default options to the context store
   * @preconditions Plugin created with description and keywords defaults
   * @expectedResult Context store contains the provided defaults under ADAPTER_DIRECT_OPTIONS
   */
  test("apply() writes default options to the context store", () => {
    const defaults = {
      description: "Internal API",
      keywords: ["internal", "rpc"],
    };
    const plugin = directPlugin(defaults);
    const ctx = mockContext();

    plugin.apply(ctx);

    const stored = ctx.getStore(ADAPTER_DIRECT_OPTIONS);
    expect(stored).toEqual(defaults);
  });

  /**
   * @case apply() stores an empty object when called with no options
   * @preconditions Plugin created with empty options
   * @expectedResult Context store contains an empty object under ADAPTER_DIRECT_OPTIONS
   */
  test("apply() stores an empty object when called with no options", () => {
    const plugin = directPlugin({});
    const ctx = mockContext();

    plugin.apply(ctx);

    const stored = ctx.getStore(ADAPTER_DIRECT_OPTIONS);
    expect(stored).toEqual({});
  });

  /**
   * @case Plugin has no teardown method
   * @preconditions Plugin created with any options
   * @expectedResult The teardown property is undefined
   */
  test("does not define a teardown method", () => {
    const plugin = directPlugin({ description: "test" });
    expect(plugin.teardown).toBeUndefined();
  });
});
