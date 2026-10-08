import { describe, expect, test } from "bun:test";
import { getDirectChannel } from "../src/adapters/direct/shared.ts";
// Registers the `direct` config applier and the default `routecraft.direct`
// plugin, which importing the context alone does not.
import "../src/adapters/direct/config.ts";
import { directPlugin } from "../src/plugins/direct/index.ts";
import {
  createDirectRegistry,
  DIRECT,
} from "../src/adapters/direct/registry.ts";
import { CraftContext } from "../src/context.ts";
import { DefaultExchange } from "../src/exchange.ts";
import { definePlugin } from "../src/kernel/plugin.ts";
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

async function installedContext(
  channelType?: DirectChannelType<DirectChannel>,
): Promise<CraftContext> {
  const ctx = new CraftContext(
    channelType !== undefined ? { direct: { channelType } } : {},
  );
  await ctx.initPlugins();
  return ctx;
}

describe("CraftConfig.direct defaults", () => {
  /**
   * @case CraftContext provides the direct channelType when config.direct is set
   * @preconditions CraftConfig includes a direct field; initPlugins() has run
   *   (the direct config key installs routecraft.direct with those options)
   * @expectedResult The DIRECT port carries the configured channelType
   */
  test("provides channelType through the DIRECT port", async () => {
    const ctx = await installedContext(MockChannelType);

    expect(ctx.lookup(DIRECT)?.channelType).toBe(MockChannelType);
  });

  /**
   * @case The default direct plugin carries no channel type
   * @preconditions CraftConfig does not include a direct field; initPlugins() has run
   * @expectedResult DIRECT is provided by the default plugin, with no channelType
   */
  test("provides the default registry when config.direct is omitted", async () => {
    const ctx = await installedContext();

    expect(ctx.lookup(DIRECT)).toBeDefined();
    expect(ctx.lookup(DIRECT)?.channelType).toBeUndefined();
  });
});

describe("default routecraft.direct plugin", () => {
  /**
   * @case An application installing routecraft.direct itself displaces the default
   * @preconditions config.plugins carries directPlugin() with a channel type; no direct config key
   * @expectedResult No RC1101 for a duplicate id, and DIRECT carries the explicit plugin's channel type
   */
  test("an explicit plugin with the default's id replaces it", async () => {
    const ctx = new CraftContext({
      plugins: [directPlugin({ channelType: MockChannelType })],
    });
    await ctx.initPlugins();

    expect(ctx.lookup(DIRECT)?.channelType).toBe(MockChannelType);
  });

  /**
   * @case A plugin that replaces DIRECT is the selected provider
   * @preconditions A third-party plugin declares provides and replaces DIRECT alongside the default
   * @expectedResult The context resolves DIRECT to the replacement's registry, not the default's
   */
  test("a plugin replacing DIRECT is selected over the default", async () => {
    const replacement = createDirectRegistry();
    const ctx = new CraftContext({
      plugins: [
        definePlugin({
          id: "acme.endpoints",
          provides: [DIRECT],
          replaces: [DIRECT],
          bind(c) {
            c.provide(DIRECT, replacement);
          },
        }),
      ],
    });
    await ctx.initPlugins();

    expect(ctx.lookup(DIRECT)).toBe(replacement);
  });

  /**
   * @case The registry hands out capability snapshots, never its stored entries
   * @preconditions A capability with tags registered; a caller mutates the tags on what capability() and capabilities() return
   * @expectedResult Later reads still see the tags as registered, so a plugin reading DIRECT directly cannot change what others list
   */
  test("capability getters return snapshots", () => {
    const registry = createDirectRegistry();
    registry.registerCapability({ endpoint: "x", tags: ["one"] });

    registry.capability("x")!.tags!.push("mutated");
    for (const entry of registry.capabilities()) entry.tags!.push("mutated");

    expect(registry.capability("x")!.tags).toEqual(["one"]);
    expect([...registry.capabilities()].map((c) => c.tags)).toEqual([["one"]]);
  });

  /**
   * @case Sending to an endpoint no channel holds is refused without creating one
   * @preconditions A started context whose registry holds no channel for "ghost"
   * @expectedResult send() rejects with RC5004 and existing() still finds nothing, so a dead forward leaves no empty channel for later callers to mistake for a listener
   */
  test("send to an absent endpoint is RC5004 and creates no channel", async () => {
    const ctx = await installedContext();
    const registry = ctx.lookup(DIRECT)!;

    await expect(
      registry.send("ghost", new DefaultExchange(ctx, { body: 1 })),
    ).rejects.toThrow(expect.objectContaining({ rc: "RC5004" }));

    expect(registry.existing("ghost")).toBeUndefined();
  });

  /**
   * @case Every context carries its own registry
   * @preconditions Two contexts built without any direct configuration
   * @expectedResult Each resolves DIRECT to a distinct registry, so endpoints never leak between applications
   */
  test("each context gets a fresh default registry", async () => {
    const first = await installedContext();
    const second = await installedContext();

    expect(first.lookup(DIRECT)).not.toBe(second.lookup(DIRECT));
  });
});

describe("resolveChannelType via getDirectChannel", () => {
  /**
   * @case getDirectChannel uses context-level channelType when per-adapter is absent
   * @preconditions Context provides a DIRECT channelType, adapter options are empty
   * @expectedResult Channel is an instance of the context-level channel type
   */
  test("uses context-level channelType when per-adapter is absent", async () => {
    const ctx = await installedContext(MockChannelType);

    const channel = getDirectChannel(ctx, "test-endpoint", {});
    expect(channel).toBeInstanceOf(MockDirectChannel);
  });

  /**
   * @case getDirectChannel prefers per-adapter channelType over context default
   * @preconditions Both the context defaults and per-adapter options have channelType
   * @expectedResult Channel is an instance of the per-adapter channel type, not the context one
   */
  test("prefers per-adapter channelType over context default", async () => {
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

    const ctx = await installedContext(MockChannelType);
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
  test("falls back to in-memory channel when no channelType is set", async () => {
    const ctx = await installedContext();

    const channel = getDirectChannel(ctx, "test-endpoint", {});
    expect(channel).toBeDefined();
    expect(channel).not.toBeInstanceOf(MockDirectChannel);
  });
});
