import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { craft, simple } from "@routecraft/routecraft";
import { spy, testContext, type TestContext } from "@routecraft/testing";
import { agent, llmPlugin, type AgentResult } from "../src/index.ts";
import type { LlmResult, LlmToolCallSummary } from "../src/llm/types.ts";

// Captures the tool map the LLM provider received so the test can
// assert that a synthetic `_block_load_<name>` tool was registered.
let capturedTools: Record<string, unknown> | undefined;

mock.module("../src/llm/providers/index.ts", () => ({
  callLlm: mock(
    async (params: { tools?: Record<string, unknown> }): Promise<LlmResult> => {
      capturedTools = params.tools;
      // Simulate the model deciding to invoke the loader tool, plus a
      // user-facing tool call, so the session can demonstrate that the
      // two surfaces are partitioned correctly.
      const toolCalls: LlmToolCallSummary[] = [
        {
          toolCallId: "user-1",
          toolName: "fetchOrder",
          input: { id: "1" },
          output: { ok: true },
        },
        {
          toolCallId: "loader-1",
          toolName: "_block_load_research",
          input: {},
          output: "research notes for the model",
        },
      ];
      return {
        text: "done",
        finishReason: "stop",
        toolCalls,
      };
    },
  ),
  streamLlm: mock(async (): Promise<LlmResult> => {
    throw new Error("unused in this test");
  }),
}));

describe('agent blocks: mode: "progressive" surfaces as a loader tool', () => {
  let t: TestContext | undefined;

  beforeEach(() => {
    capturedTools = undefined;
    mock.clearAllMocks();
  });

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case Progressive blocks register one `_block_load_<name>` tool per block; the model can invoke it
   * @preconditions Single progressive block declared on the agent
   * @expectedResult The captured tools map contains the loader; AgentResult.blocksLoaded reports the load
   */
  test("progressive blocks land in the tools map and load via AgentResult.blocksLoaded", async () => {
    const sink = spy();
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes(
        craft()
          .id("progressive-block")
          .from(simple("hi"))
          .to(
            agent({
              system: "x",
              model: "anthropic:claude-opus-4-7",
              blocks: {
                research: {
                  description: "Long-form research notes.",
                  mode: "progressive",
                  value: "<resolved research>",
                },
              },
            }),
          )
          .to(sink),
      )
      .build();

    await t.test();
    expect(capturedTools).toBeDefined();
    expect(Object.keys(capturedTools!).sort()).toEqual([
      "_block_load_research",
    ]);
    const result = sink.received[0]!.body as AgentResult;
    expect(result.blocksLoaded?.map((b) => b.blockName)).toEqual(["research"]);
    expect(result.blocksLoaded?.[0]?.toolName).toBe("_block_load_research");
    expect(result.toolCalls?.map((c) => c.toolName)).toEqual(["fetchOrder"]);
  });
});
