import { describe, expect, test } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { llmPlugin } from "../src/index.ts";
import { resolveLanguageModel } from "../src/llm/providers/resolve.ts";

/** Build a deterministic in-process model that always returns `text`. */
function mockModel(text: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      finishReason: { unified: "stop" as const, raw: "stop" },
      usage: {
        inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 4, text: 4, reasoning: 0 },
      },
      content: [{ type: "text" as const, text }],
      warnings: [],
    }),
  });
}

// These tests resolve the provider directly via `resolveLanguageModel` rather
// than dispatching through `llm()`. The dispatch path goes through the
// `./providers/index.ts` barrel (`callLlm`) and the `ai` package, both of which
// sibling test files replace with `mock.module`; bun shares one module registry
// across the whole `bun test` run, so a route-level assertion here would read
// another file's stub depending on file order. `resolveLanguageModel` depends on
// neither mocked module, so it exercises the new `custom`/`lmstudio` logic
// deterministically.
describe("custom LLM provider (in-process model)", () => {
  /**
   * @case A supplied LanguageModel instance is passed straight through (no key, no network)
   * @preconditions A custom config carrying a MockLanguageModelV3 instance
   * @expectedResult resolveLanguageModel returns the same model instance
   */
  test("returns a supplied LanguageModel instance unchanged", async () => {
    const model = mockModel("Hello from a local model");
    const resolved = await resolveLanguageModel(
      { provider: "custom", model },
      "local",
    );
    expect(resolved).toBe(model);
  });

  /**
   * @case A custom provider factory receives the model name from "custom:name"
   * @preconditions Provider model is a (modelId) => LanguageModel factory
   * @expectedResult Factory is invoked with "greeter" and its model is returned
   */
  test("invokes a factory with the parsed model name", async () => {
    const seen: string[] = [];
    const built = mockModel("built greeter");
    const resolved = await resolveLanguageModel(
      {
        provider: "custom",
        model: (modelId: string) => {
          seen.push(modelId);
          return built;
        },
      },
      "greeter",
    );
    expect(seen).toEqual(["greeter"]);
    expect(resolved).toBe(built);
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
        // Not a valid LanguageModel (no doGenerate/doStream). This compiles
        // because `custom.model` is deliberately typed `unknown`; the shape
        // contract is enforced at runtime by assertLanguageModelShape.
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
