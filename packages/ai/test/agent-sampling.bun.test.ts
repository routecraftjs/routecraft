import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { craft, simple, noop } from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";
import type { AgentDefaultOptions, AgentOptions } from "../src/agent/types.ts";
import type { CallLlmParams } from "../src/llm/providers/llm-utils.ts";
import type { LlmResult } from "../src/llm/types.ts";

// Stub the dispatcher at the providers barrel: these tests are about the
// options object the agent session builds, not about what a model does with
// it. Before this path existed the session built that object from two
// hardcoded constants, so an agent could not ask for anything.
mock.module("../src/llm/providers/index.ts", () => ({
  callLlm: mock(async (): Promise<LlmResult> => ({ text: "ok" })),
  streamLlm: mock(async (): Promise<LlmResult> => ({ text: "ok" })),
}));

const { callLlm } = await import("../src/llm/providers/index.ts");
const callLlmMock = callLlm as unknown as ReturnType<typeof mock>;
const { agent, agentPlugin, llmPlugin } = await import("../src/index.ts");

/** The options object the agent's model call handed the provider. */
function dispatchedOptions(): CallLlmParams["options"] {
  const params = callLlmMock.mock.calls[0]?.[0] as CallLlmParams | undefined;
  if (!params) throw new Error("callLlm was not dispatched");
  return params.options;
}

describe("agent sampling options reach the model call", () => {
  let t: TestContext | undefined;

  beforeEach(() => {
    callLlmMock.mockClear();
    callLlmMock.mockResolvedValue({ text: "ok" });
  });

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  // The non-streaming overload of `agent()`; these tests assert on the call
  // options, not on how the reply is delivered.
  type SyncAgentOptions = AgentOptions & { stream?: false };

  const run = async (
    options: SyncAgentOptions,
    defaultOptions?: AgentDefaultOptions,
  ) => {
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          agentPlugin(defaultOptions ? { defaultOptions } : {}),
        ],
      })
      .routes(
        craft()
          .id("sampled-agent")
          .from(simple("hi"))
          .to(agent(options))
          .to(noop()),
      )
      .build();
    await t.test();
    expect(t.errors).toHaveLength(0);
  };

  const inline = (extra: Partial<SyncAgentOptions> = {}): SyncAgentOptions => ({
    model: "anthropic:claude-test",
    system: "be useful",
    ...extra,
  });

  /**
   * @case An agent declaring a non-default temperature has it reach the call
   * @preconditions Inline agent with temperature 0.9, no context defaults
   * @expectedResult The dispatched options carry 0.9 rather than the hardcoded 0 the session used to send
   */
  test("a declared temperature reaches the call", async () => {
    await run(inline({ temperature: 0.9 }));
    expect(dispatchedOptions().temperature).toBe(0.9);
  });

  /**
   * @case An agent declaring a reasoning level has it reach the call
   * @preconditions Inline agent with reasoning "none", the cheap-classifier case
   * @expectedResult The dispatched options carry "none"
   */
  test("a declared reasoning level reaches the call", async () => {
    await run(inline({ reasoning: "none" }));
    expect(dispatchedOptions().reasoning).toBe("none");
  });

  /**
   * @case The rest of the sampling block reaches the call too
   * @preconditions Inline agent setting maxTokens, topP, both penalties and providerOptions
   * @expectedResult Every one of them appears on the dispatched options
   */
  test("the whole sampling block reaches the call", async () => {
    await run(
      inline({
        maxTokens: 4096,
        topP: 0.5,
        frequencyPenalty: 0.25,
        presencePenalty: 0.75,
        providerOptions: { anthropic: { effort: "max" } },
      }),
    );
    expect(dispatchedOptions()).toMatchObject({
      maxTokens: 4096,
      topP: 0.5,
      frequencyPenalty: 0.25,
      presencePenalty: 0.75,
      providerOptions: { anthropic: { effort: "max" } },
    });
  });

  /**
   * @case An agent that declares no sampling behaves exactly as it did before the block existed
   * @preconditions Inline agent with model and system only
   * @expectedResult Temperature 0 and maxTokens 1024, the values the session hardcoded, and nothing else sent
   */
  test("an agent that asks for nothing keeps today's behaviour", async () => {
    await run(inline());
    const options = dispatchedOptions();
    expect(options.temperature).toBe(0);
    expect(options.maxTokens).toBe(1024);
    expect(options.reasoning).toBeUndefined();
    expect(options.providerOptions).toBeUndefined();
    expect(options.topP).toBeUndefined();
  });

  /**
   * @case A context-level sampling default applies to an agent that omits it
   * @preconditions agentPlugin({ defaultOptions: { temperature, reasoning } }) with an agent setting neither
   * @expectedResult Both defaults reach the call
   */
  test("context defaults apply to an agent that omits them", async () => {
    await run(inline(), { temperature: 0.3, reasoning: "medium" });
    expect(dispatchedOptions()).toMatchObject({
      temperature: 0.3,
      reasoning: "medium",
    });
  });

  /**
   * @case A per-agent value wins over the context default, per key
   * @preconditions Context defaults temperature 0.3 and reasoning "medium"; the agent sets reasoning "high" only
   * @expectedResult The agent's reasoning wins and the default temperature still applies
   */
  test("a per-agent value wins per key", async () => {
    await run(inline({ reasoning: "high" }), {
      temperature: 0.3,
      reasoning: "medium",
    });
    expect(dispatchedOptions()).toMatchObject({
      temperature: 0.3,
      reasoning: "high",
    });
  });

  /**
   * @case Sampling defaults from two agentPlugin installs both survive the merge
   * @preconditions One install sets defaultOptions.temperature, a second sets defaultOptions.reasoning
   * @expectedResult Both reach the call; the second install's value is not dropped by the merge
   */
  test("sampling defaults from separate installs both apply", async () => {
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          agentPlugin({ defaultOptions: { temperature: 0.2 } }),
          agentPlugin({ defaultOptions: { reasoning: "low" } }),
        ],
      })
      .routes(
        craft()
          .id("two-installs")
          .from(simple("hi"))
          .to(agent(inline()))
          .to(noop()),
      )
      .build();
    await t.test();
    expect(t.errors).toHaveLength(0);
    expect(dispatchedOptions()).toMatchObject({
      temperature: 0.2,
      reasoning: "low",
    });
  });

  /**
   * @case Two installs setting the same sampling default are a conflict, not a silent winner
   * @preconditions Both agentPlugin installs set defaultOptions.temperature
   * @expectedResult build() rejects naming the field, the same way a duplicate default model does
   */
  test("two installs setting the same sampling default throw", async () => {
    await expect(
      testContext()
        .with({
          plugins: [
            agentPlugin({ defaultOptions: { temperature: 0.2 } }),
            agentPlugin({ defaultOptions: { temperature: 0.9 } }),
          ],
        })
        .build(),
    ).rejects.toThrow(/defaultOptions\.temperature.*already set/i);
  });

  /**
   * @case Two agents on the same model can ask for different reasoning effort
   * @preconditions Two routes, one agent at "none" and one at "high", both naming the same model id
   * @expectedResult The two dispatches carry different levels, which is the case the ticket was filed for
   */
  test("two agents on one model can differ", async () => {
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
          agentPlugin({}),
        ],
      })
      .routes([
        craft()
          .id("judge")
          .from(simple("hi"))
          .to(agent(inline({ reasoning: "none" })))
          .to(noop()),
        craft()
          .id("assistant")
          .from(simple("hi"))
          .to(agent(inline({ reasoning: "high" })))
          .to(noop()),
      ])
      .build();
    await t.test();
    expect(t.errors).toHaveLength(0);

    const levels = callLlmMock.mock.calls
      .map((call) => (call[0] as CallLlmParams).options.reasoning)
      .sort();
    expect(levels).toEqual(["high", "none"]);
  });
});
