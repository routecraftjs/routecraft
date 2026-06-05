import { afterEach, describe, expect, test } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { craft, noop, simple } from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";
import { llm, llmPlugin } from "../src/index.ts";
import { resolveLanguageModel } from "../src/llm/providers/resolve.ts";
import type { LlmResult } from "../src/llm/types.ts";

/** Build a deterministic in-process model that always returns `text`. */
function mockModel(text: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      finishReason: "stop",
      usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      content: [{ type: "text", text }],
      warnings: [],
    }),
  });
}

describe("custom LLM provider (in-process model)", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case llm("custom:...") runs an in-process model end to end with no key or network
   * @preconditions llmPlugin registers a custom provider carrying a MockLanguageModelV3
   * @expectedResult Enriched body carries the mock's text and usage
   */
  test("dispatches a supplied LanguageModel through generateText", async () => {
    let captured: LlmResult | undefined;
    t = await testContext()
      .routes([
        craft()
          .id("custom-direct")
          .from(simple({ body: "Hello" }))
          .enrich(llm("custom:local"))
          .process((ex) => {
            captured = ex.body as LlmResult;
            return ex.body;
          })
          .to(noop()),
      ])
      .with({
        plugins: [
          llmPlugin({
            providers: {
              custom: { model: mockModel("Hello from a local model") },
            },
          }),
        ],
      })
      .build();

    await t.test();
    expect(t.errors).toHaveLength(0);
    expect(captured?.text).toBe("Hello from a local model");
    // Proves the value flowed through the AI SDK generateText path.
    expect(captured?.raw).toBeDefined();
  });

  /**
   * @case A custom provider factory receives the model name from "custom:name"
   * @preconditions Provider model is a (modelId) => LanguageModel factory
   * @expectedResult Factory is invoked with "greeter" and its model is used
   */
  test("invokes a factory with the parsed model name", async () => {
    const seen: string[] = [];
    let captured: LlmResult | undefined;
    t = await testContext()
      .routes([
        craft()
          .id("custom-factory")
          .from(simple({ body: "Hi" }))
          .enrich(llm("custom:greeter"))
          .process((ex) => {
            captured = ex.body as LlmResult;
            return ex.body;
          })
          .to(noop()),
      ])
      .with({
        plugins: [
          llmPlugin({
            providers: {
              custom: {
                model: (modelId: string) => {
                  seen.push(modelId);
                  return mockModel(`built ${modelId}`);
                },
              },
            },
          }),
        ],
      })
      .build();

    await t.test();
    expect(t.errors).toHaveLength(0);
    expect(seen).toEqual(["greeter"]);
    expect(captured?.text).toBe("built greeter");
  });

  /**
   * @case llmPlugin rejects a custom provider without a model
   * @preconditions providers.custom is registered with no `model`
   * @expectedResult Build throws a TypeError naming custom.model
   */
  test("validation requires a model", () => {
    expect(() =>
      // @ts-expect-error intentionally missing required `model`
      llmPlugin({ providers: { custom: {} } }),
    ).toThrow(/custom"\]\.model/);
  });

  /**
   * @case A concrete custom model is shape-checked at plugin apply, not first dispatch
   * @preconditions providers.custom.model is an object without doGenerate/doStream
   * @expectedResult llmPlugin throws immediately, naming the invalid model
   */
  test("validation asserts a concrete model's shape eagerly", () => {
    expect(() =>
      llmPlugin({
        // @ts-expect-error not a valid LanguageModel (no doGenerate/doStream)
        providers: { custom: { model: {} } },
      }),
    ).toThrow(/Invalid model/i);
  });
});

describe("lmstudio LLM provider", () => {
  /**
   * @case resolveLanguageModel("lmstudio") returns an AI SDK chat model
   * @preconditions A minimal lmstudio config (no baseURL/apiKey overrides)
   * @expectedResult Resolved model is shaped like a LanguageModel and carries the model id
   */
  test("resolves to a valid model via the OpenAI-compatible client", async () => {
    const model = (await resolveLanguageModel(
      { provider: "lmstudio" },
      "qwen2.5-7b-instruct",
    )) as { modelId?: string; doGenerate?: unknown; doStream?: unknown };

    expect(model.modelId).toBe("qwen2.5-7b-instruct");
    expect(typeof model.doGenerate).toBe("function");
    expect(typeof model.doStream).toBe("function");
  });

  /**
   * @case A config-level modelId overrides the name from the model string
   * @preconditions lmstudio config sets modelId; resolve called with a different name
   * @expectedResult The config modelId wins
   */
  test("config modelId overrides the parsed name", async () => {
    const model = (await resolveLanguageModel(
      { provider: "lmstudio", modelId: "phi-4" },
      "ignored",
    )) as { modelId?: string };

    expect(model.modelId).toBe("phi-4");
  });

  /**
   * @case llmPlugin rejects a non-string lmstudio baseURL
   * @preconditions providers.lmstudio.baseURL is a number
   * @expectedResult Build throws a TypeError naming baseURL
   */
  test("validation rejects a non-string baseURL", () => {
    expect(() =>
      llmPlugin({
        // @ts-expect-error baseURL must be a string
        providers: { lmstudio: { baseURL: 1234 } },
      }),
    ).toThrow(/lmstudio"\]\.baseURL/);
  });
});
