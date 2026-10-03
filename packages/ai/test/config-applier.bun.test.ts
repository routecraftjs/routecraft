import { describe, expect, expectTypeOf, test } from "bun:test";
import { CraftContext, defineConfig } from "@routecraft/routecraft";
import { LLM } from "../src/llm/types.ts";
import { AGENTS } from "../src/agent/port.ts";
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
   * @case Setting `llm` on CraftConfig provides its providers through the LLM port
   * @preconditions Config has `llm: { providers: { openai: { apiKey } } }`; no plugins[] entry
   * @expectedResult After initPlugins(), the LLM port's providers map contains "openai"
   */
  test("llm key provides providers through the LLM port", async () => {
    const ctx = new CraftContext(
      defineConfig({
        llm: {
          providers: { openai: { apiKey: "sk-test" } },
        },
      }),
    );
    await ctx.initPlugins();

    const providers = ctx.lookup(LLM)?.providers;
    expect(providers).toBeInstanceOf(Map);
    expect(providers?.has("openai")).toBe(true);

    await ctx.stop();
  });

  /**
   * @case Setting `agent` on CraftConfig registers named agents in the store
   * @preconditions Config has `agent: { agents: { reply: { ... } } }`
   * @expectedResult After initPlugins(), the AGENTS registry contains "reply"
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

    const registry = ctx.lookup(AGENTS)?.agents;
    expect(registry).toBeInstanceOf(Map);
    expect((registry as Map<string, unknown>).has("reply")).toBe(true);

    await ctx.stop();
  });

  /**
   * @case `llm` first-class key and a user `plugins: []` entry coexist
   *   without conflict
   * @preconditions Config has `llm` set AND a no-op user plugin in plugins[]
   * @expectedResult Both run; the LLM port carries the providers; no errors emitted
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
            id: "test.user",
            bind() {
              userPluginRan = true;
            },
          },
        ],
      }),
    );
    await ctx.initPlugins();

    expect(userPluginRan).toBe(true);
    expect(ctx.lookup(LLM)?.providers.has("openai")).toBe(true);

    await ctx.stop();
  });

  /**
   * @case @routecraft/ai augments CraftConfig with llm/mcp/embedding/agent
   *   keys typed as their respective plugin options
   * @preconditions @routecraft/ai is imported (side-effect registers
   *   appliers and merges the augmentation into CraftConfig)
   * @expectedResult defineConfig accepts each AI key with the matching
   *   options type and rejects a key those options do not declare (the 0.6
   *   `mcp.host` / `mcp.port`). A regression that broke the augmentation,
   *   the self-reference in define-config.ts, or the import path used by
   *   registerConfigApplier would fail these assertions.
   */
  test("augments CraftConfig with AI keys typed as plugin options", () => {
    const cfg = defineConfig({
      llm: { providers: { openai: { apiKey: "sk" } } },
      mcp: {},
      embedding: { providers: {} },
      agent: { agents: {} },
    });

    expectTypeOf(cfg.llm).toEqualTypeOf<LlmPluginOptions | undefined>();
    expectTypeOf(cfg.mcp).toEqualTypeOf<McpPluginOptions | undefined>();
    expectTypeOf(cfg.embedding).toEqualTypeOf<
      EmbeddingPluginOptions | undefined
    >();
    expectTypeOf(cfg.agent).toEqualTypeOf<AgentPluginOptions | undefined>();

    defineConfig({
      // @ts-expect-error 0.6 listener options; 0.7 declares them under servers
      mcp: { transport: "http", host: "0.0.0.0", port: 8081 },
    });
  });
});
