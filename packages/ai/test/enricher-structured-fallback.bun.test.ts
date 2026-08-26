import { afterEach, describe, expect, mock, test } from "bun:test";
import { craft, simple } from "@routecraft/routecraft";
import { spy, testContext, type TestContext } from "@routecraft/testing";
import type { LlmResult } from "../src/llm/types.ts";

// The fallback only runs when the SDK left `output` unset but produced text,
// so the stub reproduces exactly that: a provider that answers in JSON and
// sets no structured output.
mock.module("../src/llm/providers/index.ts", () => ({
  callLlm: mock(async (): Promise<LlmResult> => ({
    text: '{"a":"hi"}',
    finishReason: "stop",
    stepsCount: 1,
  })),
  streamLlm: mock(async (): Promise<LlmResult> => {
    throw new Error("unused in this test");
  }),
}));

const { llm, llmPlugin } = await import("../src/index.ts");

/**
 * `parseStructuredTextFallback` recovers a structured output by validating
 * `result.text` when the SDK left `result.output` unset. It is the one
 * migrated boundary that declines rather than throwing, so a schema it
 * refuses is a silently dropped fallback rather than an error, and it is
 * where a callable schema reaching validation is most visible in the AI path.
 */
describe("llm structured-text fallback", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /** The shape ArkType ships: a callable carrying the bag. */
  const callableSchema = () =>
    Object.assign(() => undefined, {
      "~standard": {
        version: 1,
        vendor: "callable",
        validate: (value: unknown) => ({ value }),
        jsonSchema: { input: () => ({ type: "object" }) },
      },
    });

  const runWith = async (output: unknown) => {
    const downstream = spy();
    t = await testContext()
      .routes(
        craft()
          .id("fallback")
          .from(simple("go"))
          .enrich(llm("openai:gpt-test", { output } as never))
          .to(downstream),
      )
      .with({
        plugins: [llmPlugin({ providers: { openai: { apiKey: "k" } } })],
      })
      .build();
    await t.test();
    return downstream;
  };

  /**
   * @case A callable schema reaches the fallback and validates the parsed text
   * @preconditions Provider returns JSON text and no structured output; the route's output schema is a callable carrying ~standard
   * @expectedResult result.output carries the parsed value, because the guard no longer declines a function before validation runs
   */
  test("validates parsed text against a callable schema", async () => {
    const downstream = await runWith(callableSchema());

    expect(downstream.received).toHaveLength(1);
    const result = downstream.received[0].body as { output?: unknown };
    expect(result.output).toEqual({ a: "hi" });
  });

  /**
   * @case A schema that rejects the parsed text drops the fallback silently
   * @preconditions Same provider response; the output schema is callable and resolves to issues
   * @expectedResult result.output stays undefined and the exchange still completes, because this site declines rather than throwing. A value that is not a schema at all cannot reach here: toAiOutputSpec refuses it when building the output spec, well before the fallback runs
   */
  test("declines rather than throwing when the schema rejects", async () => {
    const rejecting = Object.assign(() => undefined, {
      "~standard": {
        version: 1,
        vendor: "callable",
        validate: () => ({ issues: [{ message: "nope" }] }),
        jsonSchema: { input: () => ({ type: "object" }) },
      },
    });

    const downstream = await runWith(rejecting);

    expect(downstream.received).toHaveLength(1);
    const result = downstream.received[0].body as { output?: unknown };
    expect(result.output).toBeUndefined();
    expect(t.errors).toHaveLength(0);
  });
});
