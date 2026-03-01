import { describe, test, expect, afterEach } from "vitest";
import { llm, llmPlugin, LlmDestinationAdapter } from "../src/index.ts";
import { testContext, type TestContext } from "@routecraft/testing";
import { craft, simple, noop } from "@routecraft/routecraft";

describe("llm() DSL and adapter", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case llm(modelId) returns an LlmDestinationAdapter instance
   * @preconditions None
   * @expectedResult Destination has adapterId routecraft.adapter.llm
   */
  test("llm(providerId:modelName) returns an LlmDestinationAdapter", () => {
    const dest = llm("ollama:my-model");
    expect(dest).toBeInstanceOf(LlmDestinationAdapter);
    expect(dest.adapterId).toBe("routecraft.adapter.llm");
  });

  /**
   * @case llm(modelId, options) accepts optional systemPrompt and temperature
   * @preconditions None
   * @expectedResult Adapter options contain passed systemPrompt and temperature
   */
  test("llm(modelId, options) accepts optional options", () => {
    const dest = llm("ollama:my-model", {
      systemPrompt: "You are helpful.",
      temperature: 0.5,
    });
    expect(dest).toBeInstanceOf(LlmDestinationAdapter);
    expect(dest.options.systemPrompt).toBe("You are helpful.");
    expect(dest.options.temperature).toBe(0.5);
  });

  /**
   * @case send() throws when no llmPlugin registered
   * @preconditions Route uses enrich(llm("ollama:any")), plugins list empty
   * @expectedResult One error, message matches not found or no providers registered
   */
  test("send() throws when no plugin (no providers registered)", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("with-llm")
          .from(simple({ body: "Hello" }))
          .enrich(llm("ollama:any"))
          .to(noop()),
      ])
      .with({ plugins: [] })
      .build();

    await t.test();
    expect(t.errors).toHaveLength(1);
    const cause = (t.errors[0] as Error).cause as Error | undefined;
    expect(cause?.message ?? t.errors[0].message).toMatch(
      /not found|no providers registered/i,
    );
  });

  /**
   * @case send() throws when provider id not in llmPlugin providers
   * @preconditions llmPlugin registers only openai, route uses llm("ollama:other")
   * @expectedResult One error, message matches "ollama" not found
   */
  test("send() throws when provider is not in plugin providers", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("with-llm")
          .from(simple({ body: "Hello" }))
          .enrich(llm("ollama:other"))
          .to(noop()),
      ])
      .with({
        plugins: [
          llmPlugin({
            providers: {
              openai: { apiKey: "test-key" },
            },
          }),
        ],
      })
      .build();

    await t.test();
    expect(t.errors).toHaveLength(1);
    const cause = (t.errors[0] as Error).cause as Error | undefined;
    expect(cause?.message ?? t.errors[0].message).toMatch(
      /"ollama" not found/i,
    );
  });
});
