import { describe, expect, mock, test } from "bun:test";
import {
  DIRECT_DEFAULTS,
  getDirectChannel,
} from "../src/adapters/direct/shared.ts";
// Registers the `direct` config applier, which importing the context alone does not.
import "../src/adapters/direct/config.ts";
import { CraftContext } from "../src/context.ts";
import type {
  DirectChannel,
  DirectChannelType,
} from "../src/adapters/direct/types.ts";

/** Properly typed mock channel for tests. */
class MockDirectChannel implements DirectChannel {
  constructor(public endpoint: string) {}
  async send(_endpoint: string, message: unknown) {
    return message;
  }
  async subscribe() {}
  async unsubscribe() {}
}

const MockChannelType =
  MockDirectChannel as unknown as DirectChannelType<DirectChannel>;

function mockContext(
  channelType?: DirectChannelType<DirectChannel>,
): CraftContext {
  const store = new Map();
  const defaults = channelType ? { channelType } : undefined;
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
      port === DIRECT_DEFAULTS ? defaults : undefined,
  } as unknown as CraftContext;
}

describe("CraftConfig.direct defaults", () => {
  /**
   * @case CraftContext provides the direct channelType when config.direct is set
   * @preconditions CraftConfig includes a direct field; initPlugins() has run
   *   (the direct config applier provides the DIRECT_DEFAULTS port during bind)
   * @expectedResult Looking up DIRECT_DEFAULTS yields the configured channelType
   */
  test("provides channelType through the DIRECT_DEFAULTS port", async () => {
    const ctx = new CraftContext({
      direct: { channelType: MockChannelType },
    });
    await ctx.initPlugins();

    const stored = ctx.lookup(DIRECT_DEFAULTS);
    expect(stored).toHaveProperty("channelType", MockChannelType);
  });

  /**
   * @case CraftContext provides no direct defaults when config.direct is omitted
   * @preconditions CraftConfig does not include a direct field
   * @expectedResult Looking up DIRECT_DEFAULTS returns undefined
   */
  test("provides no defaults when config.direct is omitted", () => {
    const ctx = new CraftContext({});

    const stored = ctx.lookup(DIRECT_DEFAULTS);
    expect(stored).toBeUndefined();
  });
});

describe("resolveChannelType via getDirectChannel", () => {
  /**
   * @case getDirectChannel uses context-level channelType when per-adapter is absent
   * @preconditions Context provides a DIRECT_DEFAULTS channelType, adapter options are empty
   * @expectedResult Channel is an instance of the context-level channel type
   */
  test("uses context-level channelType when per-adapter is absent", () => {
    const ctx = mockContext(MockChannelType);

    const channel = getDirectChannel(ctx, "test-endpoint", {});
    expect(channel).toBeInstanceOf(MockDirectChannel);
  });

  /**
   * @case getDirectChannel prefers per-adapter channelType over context default
   * @preconditions Both the context defaults and per-adapter options have channelType
   * @expectedResult Channel is an instance of the per-adapter channel type, not the context one
   */
  test("prefers per-adapter channelType over context default", () => {
    class AdapterChannel implements DirectChannel {
      static brand = "adapter";
      constructor(public endpoint: string) {}
      async send(_endpoint: string, message: unknown) {
        return message;
      }
      async subscribe() {}
      async unsubscribe() {}
    }
    const AdapterChannelType =
      AdapterChannel as unknown as DirectChannelType<DirectChannel>;

    const ctx = mockContext(MockChannelType);
    const channel = getDirectChannel(ctx, "test-endpoint", {
      channelType: AdapterChannelType,
    });

    expect(channel).toBeInstanceOf(AdapterChannel);
    expect(channel).not.toBeInstanceOf(MockDirectChannel);
  });

  /**
   * @case getDirectChannel falls back to in-memory when no channelType is set
   * @preconditions Neither the context defaults nor per-adapter options have channelType
   * @expectedResult Channel is created (in-memory default), not an instance of MockDirectChannel
   */
  test("falls back to in-memory channel when no channelType is set", () => {
    const ctx = mockContext(); // no context-level channelType

    const channel = getDirectChannel(ctx, "test-endpoint", {});
    expect(channel).toBeDefined();
    expect(channel).not.toBeInstanceOf(MockDirectChannel);
  });
});
