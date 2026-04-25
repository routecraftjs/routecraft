import { describe, test, expect, afterEach } from "vitest";
import { ContextBuilder } from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  ADAPTER_AGENT_REGISTRY,
  ADAPTER_TOOLS_DEFAULT,
  agent,
  agentPlugin,
  defaultFns,
  isToolSelection,
  tools,
  type AgentRegisteredOptions,
} from "../src/index.ts";

describe("agentPlugin context-default tools", () => {
  let t: TestContext | undefined;
  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case Context-default tools are stored under ADAPTER_TOOLS_DEFAULT
   * @preconditions agentPlugin({ tools: tools(["currentTime"]) })
   * @expectedResult Store contains a ToolSelection at the new symbol
   */
  test("agentPlugin stores its tools default in the context store", async () => {
    t = await testContext()
      .with({
        plugins: [
          agentPlugin({
            functions: { ...defaultFns },
            tools: tools(["currentTime"]),
          }),
        ],
      })
      .build();

    const stored = t.ctx.getStore(ADAPTER_TOOLS_DEFAULT);
    expect(stored).toBeDefined();
    expect(isToolSelection(stored!)).toBe(true);
  });

  /**
   * @case Without a context default, ADAPTER_TOOLS_DEFAULT is unset
   * @preconditions agentPlugin without tools field
   * @expectedResult Store entry is undefined
   */
  test("agentPlugin without tools field does not set the default", async () => {
    t = await testContext()
      .with({ plugins: [agentPlugin({ functions: { ...defaultFns } })] })
      .build();

    expect(t.ctx.getStore(ADAPTER_TOOLS_DEFAULT)).toBeUndefined();
  });

  /**
   * @case Two installs both supplying a default throw at context init
   * @preconditions Two agentPlugin entries each with a tools: tools([...])
   * @expectedResult build() rejects with RC5003 mentioning the conflict
   */
  test("two installs each supplying a tools default throws", async () => {
    await expect(
      new ContextBuilder()
        .with({
          plugins: [
            agentPlugin({
              functions: { ...defaultFns },
              tools: tools(["currentTime"]),
            }),
            agentPlugin({
              tools: tools(["randomUuid"]),
            }),
          ],
        })
        .build(),
    ).rejects.toThrow(/default tool list is already set/i);
  });

  /**
   * @case agentPlugin rejects a non-ToolSelection passed as tools
   * @preconditions agentPlugin({ tools: ["currentTime"] as never })
   * @expectedResult Synchronous RC5003 thrown at plugin construction
   */
  test("agentPlugin rejects a non-ToolSelection tools value", () => {
    expect(() =>
      agentPlugin({
        tools: ["currentTime"] as never,
      }),
    ).toThrow(/tools\(/);
  });
});

describe("agentPlugin per-agent tools field", () => {
  let t: TestContext | undefined;
  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case Per-agent tools selection round-trips through the registry
   * @preconditions agentPlugin agents entry with tools: tools([...])
   * @expectedResult Registered options contain the same ToolSelection
   */
  test("per-agent tools selection is preserved on AgentRegisteredOptions", async () => {
    const sel = tools(["currentTime"]);
    t = await testContext()
      .with({
        plugins: [
          agentPlugin({
            functions: { ...defaultFns },
            agents: {
              researcher: {
                description: "Research workflow coordinator.",
                model: "anthropic:claude-opus-4-7",
                system: "Be precise.",
                tools: sel,
              },
            },
          }),
        ],
      })
      .build();

    const entry = t.ctx.getStore(ADAPTER_AGENT_REGISTRY)?.get("researcher") as
      | AgentRegisteredOptions
      | undefined;
    expect(entry?.tools).toBe(sel);
  });

  /**
   * @case agentPlugin throws when an agent's tools is not a ToolSelection
   * @preconditions agents entry with tools: ["currentTime"] cast to never
   * @expectedResult RC5003 thrown at context init naming the agent
   */
  test("agentPlugin throws when agent tools is not a ToolSelection", async () => {
    await expect(
      new ContextBuilder()
        .with({
          plugins: [
            agentPlugin({
              agents: {
                broken: {
                  description: "x",
                  model: "anthropic:claude-opus-4-7",
                  system: "y",
                  tools: ["currentTime"] as never,
                },
              },
            }),
          ],
        })
        .build(),
    ).rejects.toThrow(/agent "broken".*tools/i);
  });
});

describe("agent() inline tools validation", () => {
  /**
   * @case Inline agent({ tools }) rejects a non-ToolSelection synchronously
   * @preconditions agent({ ..., tools: ["currentTime"] as never })
   * @expectedResult RC5003 thrown synchronously by validateAgentOptions
   */
  test("inline agent({ tools }) rejects a non-ToolSelection", () => {
    expect(() =>
      agent({
        model: "anthropic:claude-opus-4-7",
        system: "Be helpful.",
        tools: ["currentTime"] as never,
      }),
    ).toThrow(/tools\(/);
  });

  /**
   * @case Inline agent({ tools: tools([...]) }) accepts a ToolSelection
   * @preconditions agent with tools: tools(["currentTime"])
   * @expectedResult agent() returns a destination without throwing
   */
  test("inline agent({ tools: tools(...) }) accepts a ToolSelection", () => {
    const dest = agent({
      model: "anthropic:claude-opus-4-7",
      system: "Be helpful.",
      tools: tools(["currentTime"]),
    });
    expect(dest).toBeDefined();
  });
});
