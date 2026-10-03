import { describe, expect, mock, test } from "bun:test";
import {
  CRON_DEFAULTS,
  CronSourceAdapter,
} from "../src/adapters/cron/source.ts";
// Registers the `cron` config applier, which importing the context alone does not.
import "../src/adapters/cron/config.ts";
import { CraftContext } from "../src/context.ts";

function mockContext(cronDefaults?: Record<string, unknown>): CraftContext {
  const store = new Map();
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
    lookup: (port: unknown) =>
      port === CRON_DEFAULTS ? cronDefaults : undefined,
  } as unknown as CraftContext;
}

describe("CraftConfig.cron defaults", () => {
  /**
   * @case CraftContext provides cron defaults when config.cron is set
   * @preconditions CraftConfig includes a cron field; initPlugins() has run
   *   (the cron config applier provides the CRON_DEFAULTS port during bind)
   * @expectedResult Looking up CRON_DEFAULTS yields the configured defaults
   */
  test("provides cron defaults through the CRON_DEFAULTS port", async () => {
    const defaults = { timezone: "UTC", maxJitter: 2000 };
    const ctx = new CraftContext({ cron: defaults });
    await ctx.initPlugins();

    const stored = ctx.lookup(CRON_DEFAULTS);
    expect(stored).toEqual(defaults);
  });

  /**
   * @case CraftContext provides no cron defaults when config.cron is omitted
   * @preconditions CraftConfig does not include a cron field
   * @expectedResult Looking up CRON_DEFAULTS returns undefined
   */
  test("provides no defaults when config.cron is omitted", () => {
    const ctx = new CraftContext({});

    const stored = ctx.lookup(CRON_DEFAULTS);
    expect(stored).toBeUndefined();
  });

  /**
   * @case CronSourceAdapter merges context defaults with per-adapter options
   * @preconditions Context provides a timezone default through CRON_DEFAULTS, adapter has maxJitter override
   * @expectedResult mergedOptions returns both timezone from the context defaults and maxJitter from adapter
   */
  test("CronSourceAdapter merges config defaults with per-adapter options", () => {
    const ctx = mockContext({ timezone: "UTC", maxJitter: 2000 });

    const adapter = new CronSourceAdapter("@daily", { maxJitter: 5000 });
    const merged = adapter.mergedOptions(ctx);

    expect(merged.timezone).toBe("UTC");
    expect(merged.maxJitter).toBe(5000); // per-adapter wins
  });
});
