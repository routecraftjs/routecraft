import { describe, expect, expectTypeOf, test } from "vitest";
import { CraftContext, defineConfig } from "@routecraft/routecraft";
import { ADAPTER_LLM_PROVIDERS } from "../src/llm/types.ts";
import { ADAPTER_AGENT_REGISTRY } from "../src/agent/index.ts";
import type { LlmPluginOptions } from "../src/llm/types.ts";
import type { McpPluginOptions } from "../src/mcp/types.ts";
import type { EmbeddingPluginOptions } from "../src/embedding/types.ts";
import type { AgentPluginOptions } from "../src/agent/plugin.ts";
// Side-effect import: registers config appliers for llm/mcp/embedding/agent.
import "../src/index.ts";

/**
 * The AI package's barrel registers config appliers as a side effect, so
 * importing `@routecraft/ai` (or its src/index.ts) anywhere is enough to
 * make `llm`, `mcp`, `embedding`, and `agent` first-class CraftConfig keys.
 */
describe("@routecraft/ai config appliers", () => {
  /**
   * @case Setting `llm` on CraftConfig registers providers in the store
   * @preconditions Config has `llm: { providers: { openai: { apiKey } } }`; no plugins[] entry
   * @expectedResult After initPlugins(), ADAPTER_LLM_PROVIDERS map contains "openai"
   */
  test("llm key registers providers via the store", async () => {
    const ctx = new CraftContext(
      defineConfig({
        llm: {
          providers: { openai: { apiKey: "sk-test" } },
        },
      }),
    );
    await ctx.initPlugins();

    const providers = ctx.getStore(ADAPTER_LLM_PROVIDERS);
    expect(providers).toBeInstanceOf(Map);
    expect((providers as Map<string, unknown>).has("openai")).toBe(true);

    await ctx.stop();
  });

  /**
   * @case Setting `agent` on CraftConfig registers named agents in the store
   * @preconditions Config has `agent: { agents: { reply: { ... } } }`
   * @expectedResult After initPlugins(), ADAPTER_AGENT_REGISTRY contains "reply"
   */
  test("agent key registers agents via the store", async () => {
    const ctx = new CraftContext(
      defineConfig({
        agent: {
          agents: {
            reply: {
              model: "openai:gpt-4o-mini",
              system: "You are concise.",
              description: "Reply to incoming messages concisely.",
            },
          },
        },
      }),
    );
    await ctx.initPlugins();

    const registry = ctx.getStore(ADAPTER_AGENT_REGISTRY);
    expect(registry).toBeInstanceOf(Map);
    expect((registry as Map<string, unknown>).has("reply")).toBe(true);

    await ctx.stop();
  });

  /**
   * @case `llm` first-class key and a user `plugins: []` entry coexist
   *   without conflict
   * @preconditions Config has `llm` set AND a no-op user plugin in plugins[]
   * @expectedResult Both run; provider store is populated; no errors emitted
   */
  test("llm key coexists with user plugins[]", async () => {
    let userPluginRan = false;
    const ctx = new CraftContext(
      defineConfig({
        llm: {
          providers: { openai: { apiKey: "sk-test" } },
        },
        plugins: [
          {
            apply() {
              userPluginRan = true;
            },
          },
        ],
      }),
    );
    await ctx.initPlugins();

    expect(userPluginRan).toBe(true);
    const providers = ctx.getStore(ADAPTER_LLM_PROVIDERS);
    expect((providers as Map<string, unknown>).has("openai")).toBe(true);

    await ctx.stop();
  });

  /**
   * @case @routecraft/ai augments CraftConfig with llm/mcp/embedding/agent
   *   keys typed as their respective plugin options
   * @preconditions @routecraft/ai is imported (side-effect registers
   *   appliers and merges the augmentation into CraftConfig)
   * @expectedResult defineConfig accepts each AI key with the matching
   *   options type. A regression that broke the augmentation, the
   *   self-reference in define-config.ts, or the import path used by
   *   registerConfigApplier would fail these assertions.
   */
  test("augments CraftConfig with AI keys typed as plugin options", () => {
    const cfg = defineConfig({
      llm: { providers: { openai: { apiKey: "sk" } } },
      mcp: {},
      embedding: { providers: {} },
      agent: { agents: {} },
    });

    expectTypeOf(cfg.llm).toMatchTypeOf<LlmPluginOptions>();
    expectTypeOf(cfg.mcp).toMatchTypeOf<McpPluginOptions>();
    expectTypeOf(cfg.embedding).toMatchTypeOf<EmbeddingPluginOptions>();
    expectTypeOf(cfg.agent).toMatchTypeOf<AgentPluginOptions>();
  });
});
