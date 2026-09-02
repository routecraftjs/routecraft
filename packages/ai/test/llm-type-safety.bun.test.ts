import { describe, expectTypeOf, test } from "bun:test";
import { z } from "zod";
import { craft, simple } from "@routecraft/routecraft";
import { agent } from "../src/agent/agent.ts";
import { embedding } from "../src/embedding/embedding.ts";
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

  /**
   * @case The legacy schema type parameter remains the first llm() generic
   * @preconditions llm<typeof schema>(modelId, { output: schema })
   * @expectedResult The output schema narrows the result without changing the body type
   */
  test("llm preserves the legacy output schema type parameter", () => {
    const schema = z.object({ answer: z.string() });
    expectTypeOf(
      llm<typeof schema>("ollama:x", { output: schema }),
    ).toMatchTypeOf<Enricher<unknown, LlmResultWithOutput<typeof schema>>>();
  });

  /**
   * @case An explicit body type parameter types the exchange passed to AI callbacks
   * @preconditions llm<undefined, Body>(), agent<Body>(), and embedding<Body>() supply the body type
   * @expectedResult Each callback can read the declared body fields without a cast
   */
  test("explicit body type flows into llm, agent, and embedding callbacks", () => {
    const body = z.object({ content: z.string(), text: z.string() });
    type Body = z.infer<typeof body>;
    const source = simple({ content: "hello", text: "hello" });

    craft()
      .input({ body })
      .from(source)
      .to(
        llm<undefined, Body>("ollama:my-model", {
          user: (exchange) => exchange.body.content,
        }),
      );

    craft()
      .input({ body })
      .from(source)
      .to(
        agent<Body>({
          model: "ollama:my-model",
          system: (exchange) => `Summarise ${exchange.body.text}`,
          user: (exchange) => exchange.body.content,
        }),
      );

    craft()
      .input({ body })
      .from(source)
      .enrich(
        embedding<Body>("openai:text-embedding-3-small", {
          using: (exchange) => exchange.body.content,
        }),
      );
  });
});
