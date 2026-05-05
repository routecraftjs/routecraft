import { describe, expect, mock, test } from "bun:test";
import {
  ADAPTER_CRON_OPTIONS,
  CronSourceAdapter,
} from "../src/adapters/cron/source.ts";
import { CraftContext } from "../src/context.ts";

function mockContext(cronDefaults?: Record<string, unknown>): CraftContext {
  const store = new Map();
  if (cronDefaults) {
    store.set(ADAPTER_CRON_OPTIONS, cronDefaults);
  }
  return {
    logger: {
      trace: mock(),
      debug: mock(),
      info: mock(),
      warn: mock(),
      error: mock(),
      fatal: mock(),
    },
    getStore: (key: symbol) => store.get(key),
    setStore: (key: symbol, value: unknown) => store.set(key, value),
  } as unknown as CraftContext;
}

describe("CraftConfig.cron defaults", () => {
  /**
   * @case CraftContext stores cron defaults when config.cron is provided
   * @preconditions CraftConfig includes a cron field with timezone and jitterMs
   * @expectedResult The context store contains the defaults under ADAPTER_CRON_OPTIONS
   */
  test("stores cron defaults in the context store", () => {
    const defaults = { timezone: "UTC", jitterMs: 2000 };
    const ctx = new CraftContext({ cron: defaults });

    const stored = ctx.getStore(ADAPTER_CRON_OPTIONS);
    expect(stored).toEqual(defaults);
  });

  /**
   * @case CraftContext does not set store when config.cron is omitted
   * @preconditions CraftConfig does not include a cron field
   * @expectedResult The context store returns undefined for ADAPTER_CRON_OPTIONS
   */
  test("does not set store when config.cron is omitted", () => {
    const ctx = new CraftContext({});

    const stored = ctx.getStore(ADAPTER_CRON_OPTIONS);
    expect(stored).toBeUndefined();
  });

  /**
   * @case CronSourceAdapter merges context defaults with per-adapter options
   * @preconditions Context store has timezone default, adapter has jitterMs override
   * @expectedResult mergedOptions returns both timezone from store and jitterMs from adapter
   */
  test("CronSourceAdapter merges config defaults with per-adapter options", () => {
    const ctx = mockContext({ timezone: "UTC", jitterMs: 2000 });

    const adapter = new CronSourceAdapter("@daily", { jitterMs: 5000 });
    const merged = adapter.mergedOptions(ctx);

    expect(merged.timezone).toBe("UTC");
    expect(merged.jitterMs).toBe(5000); // per-adapter wins
  });
});
