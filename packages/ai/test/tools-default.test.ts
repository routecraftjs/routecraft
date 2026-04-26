import { describe, test, expect, afterEach } from "vitest";
import { ContextBuilder } from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  ADAPTER_AGENT_DEFAULT_OPTIONS,
  ADAPTER_AGENT_REGISTRY,
  agent,
  agentPlugin,
  defaultFns,
  isToolSelection,
  tools,
  type AgentRegisteredOptions,
} from "../src/index.ts";

describe("agentPlugin defaultOptions storage", () => {
  let t: TestContext | undefined;
  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case defaultOptions.tools is stored under ADAPTER_AGENT_DEFAULT_OPTIONS
   * @preconditions agentPlugin({ defaultOptions: { tools: tools(["currentTime"]) } })
   * @expectedResult Store entry has a `tools` ToolSelection
   */
  test("agentPlugin stores defaultOptions.tools under the new symbol", async () => {
    t = await testContext()
      .with({
        plugins: [
          agentPlugin({
            functions: { ...defaultFns },
            defaultOptions: { tools: tools(["currentTime"]) },
          }),
        ],
      })
      .build();

    const stored = t.ctx.getStore(ADAPTER_AGENT_DEFAULT_OPTIONS);
    expect(stored).toBeDefined();
    expect(isToolSelection(stored!.tools!)).toBe(true);
  });

  /**
   * @case defaultOptions.model is stored under ADAPTER_AGENT_DEFAULT_OPTIONS
   * @preconditions agentPlugin({ defaultOptions: { model: "anthropic:claude-opus-4-7" } })
   * @expectedResult Store entry has a `model` string
   */
  test("agentPlugin stores defaultOptions.model under the new symbol", async () => {
    t = await testContext()
      .with({
        plugins: [
          agentPlugin({
            defaultOptions: { model: "anthropic:claude-opus-4-7" },
          }),
        ],
      })
      .build();

    const stored = t.ctx.getStore(ADAPTER_AGENT_DEFAULT_OPTIONS);
    expect(stored?.model).toBe("anthropic:claude-opus-4-7");
  });

  /**
   * @case Without defaultOptions, ADAPTER_AGENT_DEFAULT_OPTIONS is unset
   * @preconditions agentPlugin without defaultOptions field
   * @expectedResult Store entry is undefined
   */
  test("agentPlugin without defaultOptions does not set the store", async () => {
    t = await testContext()
      .with({ plugins: [agentPlugin({ functions: { ...defaultFns } })] })
      .build();

    expect(t.ctx.getStore(ADAPTER_AGENT_DEFAULT_OPTIONS)).toBeUndefined();
  });

  /**
   * @case Two installs both supplying the same default field throw at context init
   * @preconditions Two agentPlugin entries each set defaultOptions.tools
   * @expectedResult build() rejects with RC5003 mentioning the conflict
   */
  test("two installs each setting defaultOptions.tools throws", async () => {
    await expect(
      new ContextBuilder()
        .with({
          plugins: [
            agentPlugin({
              functions: { ...defaultFns },
              defaultOptions: { tools: tools(["currentTime"]) },
            }),
            agentPlugin({
              defaultOptions: { tools: tools(["randomUuid"]) },
            }),
          ],
        })
        .build(),
    ).rejects.toThrow(/defaultOptions\.tools.*already set/i);
  });

  /**
   * @case Two installs each setting defaultOptions.model throw at context init
   * @preconditions Two agentPlugin entries each set a different default model
   * @expectedResult build() rejects with RC5003 mentioning the conflict
   */
  test("two installs each setting defaultOptions.model throws", async () => {
    await expect(
      new ContextBuilder()
        .with({
          plugins: [
            agentPlugin({
              defaultOptions: { model: "anthropic:claude-opus-4-7" },
            }),
            agentPlugin({
              defaultOptions: { model: "openai:gpt-4o" },
            }),
          ],
        })
        .build(),
    ).rejects.toThrow(/defaultOptions\.model.*already set/i);
  });

  /**
   * @case Two installs each setting a DIFFERENT default field merge cleanly
   * @preconditions install A sets defaultOptions.model, install B sets defaultOptions.tools
   * @expectedResult Both fields end up on the stored value
   */
  test("two installs setting different default fields merge", async () => {
    t = await testContext()
      .with({
        plugins: [
          agentPlugin({
            defaultOptions: { model: "anthropic:claude-opus-4-7" },
          }),
          agentPlugin({
            functions: { ...defaultFns },
            defaultOptions: { tools: tools(["currentTime"]) },
          }),
        ],
      })
      .build();

    const stored = t.ctx.getStore(ADAPTER_AGENT_DEFAULT_OPTIONS);
    expect(stored?.model).toBe("anthropic:claude-opus-4-7");
    expect(isToolSelection(stored!.tools!)).toBe(true);
  });

  /**
   * @case agentPlugin rejects defaultOptions that is not an object
   * @preconditions agentPlugin({ defaultOptions: ["x"] as never })
   * @expectedResult Synchronous RC5003 thrown at plugin construction
   */
  test("agentPlugin rejects a non-object defaultOptions", () => {
    expect(() =>
      agentPlugin({
        defaultOptions: ["x"] as never,
      }),
    ).toThrow(/defaultOptions/i);
  });

  /**
   * @case agentPlugin rejects defaultOptions.tools that is not a ToolSelection
   * @preconditions agentPlugin({ defaultOptions: { tools: ["x"] as never } })
   * @expectedResult Synchronous RC5003 thrown
   */
  test("agentPlugin rejects a non-ToolSelection defaultOptions.tools", () => {
    expect(() =>
      agentPlugin({
        defaultOptions: { tools: ["x"] as never },
      }),
    ).toThrow(/defaultOptions\.tools/i);
  });

  /**
   * @case agentPlugin rejects defaultOptions.model that is not "providerId:modelName"
   * @preconditions agentPlugin({ defaultOptions: { model: "anthropic-only" } })
   * @expectedResult Synchronous RC5003 thrown
   */
  test("agentPlugin rejects a malformed defaultOptions.model", () => {
    expect(() =>
      agentPlugin({
        defaultOptions: { model: "anthropic-only" },
      }),
    ).toThrow(/defaultOptions\.model/i);
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
   * @case Registered agent without model is accepted at init when defaultOptions.model is set
   * @preconditions defaultOptions.model set; agent omits model
   * @expectedResult build() succeeds and the registered agent's model is undefined (resolved at dispatch)
   */
  test("registered agent without model is accepted when a default exists", async () => {
    t = await testContext()
      .with({
        plugins: [
          agentPlugin({
            defaultOptions: { model: "anthropic:claude-opus-4-7" },
            agents: {
              inheritor: {
                description: "Inherits the default model.",
                system: "Be precise.",
              },
            },
          }),
        ],
      })
      .build();

    const entry = t.ctx.getStore(ADAPTER_AGENT_REGISTRY)?.get("inheritor") as
      | AgentRegisteredOptions
      | undefined;
    expect(entry?.model).toBeUndefined();
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

  /**
   * @case Inline agent({}) without model is accepted at construction (resolution deferred to dispatch)
   * @preconditions agent({ system: "..." }) -- no model, no defaults at construction
   * @expectedResult agent() returns a destination without throwing
   */
  test("inline agent without model is accepted at construction", () => {
    const dest = agent({ system: "Be helpful." });
    expect(dest).toBeDefined();
  });

  /**
   * @case Inline agent({ model: "..." }) with malformed model throws
   * @preconditions agent with model: "anthropic-only" (no colon)
   * @expectedResult Synchronous RC5003 thrown
   */
  test("inline agent rejects malformed model string", () => {
    expect(() =>
      agent({
        model: "anthropic-only",
        system: "Be helpful.",
      }),
    ).toThrow(/model/i);
  });
});
