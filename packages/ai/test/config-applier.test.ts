import { describe, expect, test } from "vitest";
import { CraftContext, defineConfig } from "@routecraft/routecraft";
import { ADAPTER_LLM_PROVIDERS } from "../src/llm/types.ts";
import { ADAPTER_AGENT_REGISTRY } from "../src/agent/index.ts";
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
});
