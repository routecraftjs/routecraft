import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { craft, simple, noop } from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";
import type { CallLlmParams } from "../src/llm/providers/llm-utils.ts";
import type {
  LlmOptions,
  LlmPluginOptions,
  LlmResult,
} from "../src/llm/types.ts";

// The dispatcher is stubbed at the providers barrel, the boundary the LLM
// destination hands its options to. What the destination puts in that object
// is the thing under test: the copy it used to make was field by field, so an
// option could typecheck on `LlmOptions` and reach nothing.
mock.module("../src/llm/providers/index.ts", () => ({
  callLlm: mock(async (): Promise<LlmResult> => ({ text: "ok" })),
  streamLlm: mock(async (): Promise<LlmResult> => ({ text: "ok" })),
}));

const { callLlm } = await import("../src/llm/providers/index.ts");
const callLlmMock = callLlm as unknown as ReturnType<typeof mock>;
const { llm, llmPlugin } = await import("../src/index.ts");

/** The options object the last dispatch handed the provider call. */
function dispatchedOptions(): CallLlmParams["options"] {
  const params = callLlmMock.mock.calls[0]?.[0] as CallLlmParams | undefined;
  if (!params) throw new Error("callLlm was not dispatched");
  return params.options;
}

describe("llm() carries its sampling block to the provider call", () => {
  let t: TestContext | undefined;

  beforeEach(() => {
    callLlmMock.mockClear();
    callLlmMock.mockResolvedValue({ text: "ok" });
  });

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  const run = async (
    options: LlmOptions | undefined,
    defaultOptions?: LlmPluginOptions["defaultOptions"],
  ) => {
    t = await testContext()
      .routes(
        craft()
          .id("sampling")
          .from(simple("go"))
          .enrich(llm("openai:gpt-test", options))
          .to(noop()),
      )
      .with({
        plugins: [
          llmPlugin({
            providers: { openai: { apiKey: "k" } },
            ...(defaultOptions ? { defaultOptions } : {}),
          }),
        ],
      })
      .build();
    await t.test();
    expect(t.errors).toHaveLength(0);
  };

  /**
   * @case A reasoning level authored on llm() reaches the provider call
   * @preconditions Route enriches with llm("openai:gpt-test", { reasoning: "low" })
   * @expectedResult The dispatched options carry reasoning "low", not just a compiling option
   */
  test("reasoning reaches the dispatch", async () => {
    await run({ reasoning: "low" });
    expect(dispatchedOptions().reasoning).toBe("low");
  });

  /**
   * @case A raw providerOptions passthrough reaches the provider call
   * @preconditions Route enriches with a providerOptions naming an openai setting
   * @expectedResult The dispatched options carry the same object
   */
  test("providerOptions reaches the dispatch", async () => {
    await run({
      providerOptions: { openai: { reasoningEffort: "xhigh" } },
    });
    expect(dispatchedOptions().providerOptions).toEqual({
      openai: { reasoningEffort: "xhigh" },
    });
  });

  /**
   * @case The rest of the sampling block still travels, alongside the new options
   * @preconditions Every sampling field set on one llm() call
   * @expectedResult All of them appear on the dispatched options
   */
  test("the whole sampling block travels", async () => {
    await run({
      temperature: 0.4,
      maxTokens: 64,
      topP: 0.8,
      frequencyPenalty: 0.5,
      presencePenalty: 0.6,
      reasoning: "high",
    });
    expect(dispatchedOptions()).toMatchObject({
      temperature: 0.4,
      maxTokens: 64,
      topP: 0.8,
      frequencyPenalty: 0.5,
      presencePenalty: 0.6,
      reasoning: "high",
    });
  });

  /**
   * @case An llm() call that asks for nothing is unchanged by the new options
   * @preconditions Route enriches with llm(modelId) and no options
   * @expectedResult Temperature and maxTokens are the framework defaults and no reasoning or providerOptions is sent
   */
  test("an unspecified call sends the defaults and nothing more", async () => {
    await run(undefined);
    const options = dispatchedOptions();
    expect(options.temperature).toBe(0);
    expect(options.maxTokens).toBe(1024);
    expect(options.reasoning).toBeUndefined();
    expect(options.providerOptions).toBeUndefined();
  });

  /**
   * @case A context-level default reasoning applies to a call that omits it
   * @preconditions llmPlugin({ defaultOptions: { reasoning: "high" } }) and an llm() call with no reasoning
   * @expectedResult The dispatched options carry the default
   */
  test("a plugin default reasoning applies", async () => {
    await run(undefined, { reasoning: "high" });
    expect(dispatchedOptions().reasoning).toBe("high");
  });

  /**
   * @case A per-call reasoning wins over the context-level default
   * @preconditions llmPlugin default "high", call-site "none"
   * @expectedResult The dispatched options carry "none"
   */
  test("a per-call reasoning wins over the plugin default", async () => {
    await run({ reasoning: "none" }, { reasoning: "high" });
    expect(dispatchedOptions().reasoning).toBe("none");
  });
});
