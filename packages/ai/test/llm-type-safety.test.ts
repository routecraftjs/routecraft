import { describe, test, expectTypeOf } from "vitest";
import { z } from "zod";
import { llm } from "../src/llm/llm.ts";
import type { LlmResult, LlmResultWithOutput } from "../src/llm/types.ts";
import type { Destination } from "@routecraft/routecraft";

/**
 * Type-level tests: llm() return type narrows when outputSchema is provided.
 */
describe("LLM adapter type safety", () => {
  /**
   * @case llm(modelId) without options returns Destination with LlmResult
   * @preconditions llm("ollama:x")
   * @expectedResult Type matches Destination<unknown, LlmResult>
   */
  test("llm(modelId) returns Destination<unknown, LlmResult>", () => {
    expectTypeOf(llm("ollama:my-model")).toMatchTypeOf<
      Destination<unknown, LlmResult>
    >();
  });

  /**
   * @case llm(modelId, { outputSchema }) narrows result.output to schema output type
   * @preconditions llm("ollama:x", { outputSchema: z.object({ answer: z.string() }) })
   * @expectedResult Return type is Destination with result.output typed as { answer: string }
   */
  test("llm(modelId, { outputSchema }) narrows body.output type", () => {
    const schema = z.object({ answer: z.string() });
    type Expected = LlmResultWithOutput<typeof schema>;
    expectTypeOf(llm("ollama:x", { outputSchema: schema })).toMatchTypeOf<
      Destination<unknown, Expected>
    >();
    // Ensure Expected has output?: { answer: string }
    expectTypeOf<Expected["output"]>().toMatchTypeOf<
      { answer: string } | undefined
    >();
  });
});
