import { describe, test, expect, vi } from "vitest";
import {
  ADAPTER_DIRECT_OPTIONS,
  getDirectChannel,
} from "../src/adapters/direct/shared.ts";
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
  if (channelType) {
    store.set(ADAPTER_DIRECT_OPTIONS, { channelType });
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
   * @case CraftContext stores direct channelType when config.direct is provided
   * @preconditions CraftConfig includes a direct field with channelType
   * @expectedResult The context store contains the channelType under ADAPTER_DIRECT_OPTIONS
   */
  test("stores channelType in the context store", () => {
    const ctx = new CraftContext({
      direct: { channelType: MockChannelType },
    });

    const stored = ctx.getStore(ADAPTER_DIRECT_OPTIONS);
    expect(stored).toHaveProperty("channelType", MockChannelType);
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
});

describe("resolveChannelType via getDirectChannel", () => {
  /**
   * @case getDirectChannel uses context-level channelType when per-adapter is absent
   * @preconditions Context store has channelType, adapter options are empty
   * @expectedResult Channel is an instance of the context-level channel type
   */
  test("uses context-level channelType when per-adapter is absent", () => {
    const ctx = mockContext(MockChannelType);

    const channel = getDirectChannel(ctx, "test-endpoint", {});
    expect(channel).toBeInstanceOf(MockDirectChannel);
  });

  /**
   * @case getDirectChannel prefers per-adapter channelType over context default
   * @preconditions Both context store and per-adapter options have channelType
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
   * @preconditions Neither context store nor per-adapter options have channelType
   * @expectedResult Channel is created (in-memory default), not an instance of MockDirectChannel
   */
  test("falls back to in-memory channel when no channelType is set", () => {
    const ctx = mockContext(); // no channelType in store

    const channel = getDirectChannel(ctx, "test-endpoint", {});
    expect(channel).toBeDefined();
    expect(channel).not.toBeInstanceOf(MockDirectChannel);
  });
});
