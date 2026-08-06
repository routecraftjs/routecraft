import { describe, expectTypeOf, test } from "bun:test";
import { z } from "zod";
import { llm } from "../src/llm/llm.ts";
import type { LlmResult, LlmResultWithOutput } from "../src/llm/types.ts";
import type { Enricher } from "@routecraft/routecraft";

/**
 * Type-level tests: llm() return type narrows when an `output` schema is provided.
 */
describe("LLM adapter type safety", () => {
  /**
   * @case llm(modelId) without options returns Enricher with LlmResult
   * @preconditions llm("ollama:x")
   * @expectedResult Type matches Enricher<unknown, LlmResult>
   */
  test("llm(modelId) returns Enricher<unknown, LlmResult>", () => {
    expectTypeOf(llm("ollama:my-model")).toMatchTypeOf<
      Enricher<unknown, LlmResult>
    >();
  });

  /**
   * @case llm(modelId, { output }) narrows result.output to schema output type
   * @preconditions llm("ollama:x", { output: z.object({ answer: z.string() }) })
   * @expectedResult Return type is Enricher with result.output typed as { answer: string }
   */
  test("llm(modelId, { output }) narrows body.output type", () => {
    const schema = z.object({ answer: z.string() });
    type Expected = LlmResultWithOutput<typeof schema>;
    expectTypeOf(llm("ollama:x", { output: schema })).toMatchTypeOf<
      Enricher<unknown, Expected>
    >();
    // Ensure Expected has output?: { answer: string }
    expectTypeOf<Expected["output"]>().toMatchTypeOf<
      { answer: string } | undefined
    >();
  });
});
