import { describe, test, expect, vi } from "vitest";
import {
  ADAPTER_DIRECT_OPTIONS,
  getMergedOptions,
} from "../src/adapters/direct/shared.ts";
import { CraftContext } from "../src/context.ts";

function mockContext(directDefaults?: Record<string, unknown>): CraftContext {
  const store = new Map();
  if (directDefaults) {
    store.set(ADAPTER_DIRECT_OPTIONS, directDefaults);
  }
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

describe("CraftConfig.direct defaults", () => {
  /**
   * @case CraftContext stores direct defaults when config.direct is provided
   * @preconditions CraftConfig includes a direct field with description
   * @expectedResult The context store contains the defaults under ADAPTER_DIRECT_OPTIONS
   */
  test("stores direct defaults in the context store", () => {
    const defaults = { description: "Internal API", keywords: ["internal"] };
    const ctx = new CraftContext({ direct: defaults });

    const stored = ctx.getStore(ADAPTER_DIRECT_OPTIONS);
    expect(stored).toEqual(defaults);
  });

  /**
   * @case CraftContext does not set store when config.direct is omitted
   * @preconditions CraftConfig does not include a direct field
   * @expectedResult The context store returns undefined for ADAPTER_DIRECT_OPTIONS
   */
  test("does not set store when config.direct is omitted", () => {
    const ctx = new CraftContext({});

    const stored = ctx.getStore(ADAPTER_DIRECT_OPTIONS);
    expect(stored).toBeUndefined();
  });

  /**
   * @case getMergedOptions merges context defaults with per-adapter options
   * @preconditions Context store has description default, adapter has keywords override
   * @expectedResult merged result contains description from store and keywords from adapter
   */
  test("getMergedOptions merges config defaults with per-adapter options", () => {
    const ctx = mockContext({
      description: "Internal API",
      keywords: ["internal"],
    });

    const merged = getMergedOptions(ctx, { keywords: ["rpc", "custom"] });

    expect(merged.description).toBe("Internal API");
    expect(merged.keywords).toEqual(["rpc", "custom"]); // per-adapter wins
  });
});
