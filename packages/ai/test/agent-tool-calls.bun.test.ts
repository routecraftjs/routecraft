import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { craft, simple } from "@routecraft/routecraft";
import { spy, testContext, type TestContext } from "@routecraft/testing";
import {
  agent,
  llmPlugin,
  type AgentResult,
  type AgentToolCallSummary,
} from "../src/index.ts";
import type { LlmResult } from "../src/llm/types.ts";

// Mock the LLM dispatcher so we control what tool calls flow into
// the result. The tests assert on AgentResult.toolCalls produced by
// the session, regardless of whether the streaming or sync path was
// taken.
mock.module("../src/llm/providers/index.ts", () => ({
  callLlm: mock(
    async (): Promise<LlmResult> => ({
      text: "stubbed",
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      toolCalls: [
        {
          toolCallId: "call-1",
          toolName: "fetchOrder",
          input: { id: "abc" },
          output: { status: "shipped" },
        },
        {
          toolCallId: "call-2",
          toolName: "sendSlack",
          input: { channel: "#ops" },
          error: new Error("slack-down"),
        },
      ],
    }),
  ),
  streamLlm: mock(
    async (params: {
      onDelta: (d: { type: string; text: string }) => void | Promise<void>;
    }): Promise<LlmResult> => {
      await params.onDelta({ type: "text-delta", text: "ok" });
      return {
        text: "ok",
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        toolCalls: [
          {
            toolCallId: "stream-call-1",
            toolName: "search",
            input: { q: "weather" },
            output: { results: ["sunny"] },
          },
        ],
      };
    },
  ),
}));

describe("AgentResult.toolCalls: post-dispatch tool-call summary", () => {
  let t: TestContext | undefined;

  beforeEach(() => {
    mock.clearAllMocks();
  });

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case AgentResult.toolCalls populated for sync dispatch
   * @preconditions Inline agent (no onDelta); mocked callLlm returns toolCalls
   * @expectedResult Sink body has both tool calls in invocation order with input/output/error fields
   */
  test("sync dispatch populates AgentResult.toolCalls", async () => {
    const sink = spy();
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes(
        craft()
          .id("sync-tool-calls")
          .from(simple("hi"))
          .to(agent({ system: "x", model: "anthropic:claude-opus-4-7" }))
          .to(sink),
      )
      .build();

    await t.test();
    const r = sink.received[0]!.body as AgentResult;
    expect(r.toolCalls).toHaveLength(2);
    const [first, second] = r.toolCalls!;
    expect(first).toMatchObject({
      toolCallId: "call-1",
      toolName: "fetchOrder",
      input: { id: "abc" },
      output: { status: "shipped" },
    });
    expect(first.error).toBeUndefined();
    expect(second).toMatchObject({
      toolCallId: "call-2",
      toolName: "sendSlack",
    });
    expect(second.output).toBeUndefined();
    expect(second.error).toBeInstanceOf(Error);
  });

  /**
   * @case AgentResult.toolCalls populated for streaming dispatch
   * @preconditions Inline agent with onDelta; mocked streamLlm returns toolCalls
   * @expectedResult Sink body has the streaming-path tool call summary
   */
  test("streaming dispatch populates AgentResult.toolCalls", async () => {
    const sink = spy();
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes(
        craft()
          .id("stream-tool-calls")
          .from(simple("hi"))
          .to(
            agent({
              system: "x",
              model: "anthropic:claude-opus-4-7",
              onDelta: () => {},
            }),
          )
          .to(sink),
      )
      .build();

    await t.test();
    const r = sink.received[0]!.body as AgentResult;
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls![0]).toMatchObject({
      toolCallId: "stream-call-1",
      toolName: "search",
      input: { q: "weather" },
      output: { results: ["sunny"] },
    });
  });

  /**
   * @case AgentResult.toolCalls absent when no tools were invoked
   * @preconditions Mock returns no toolCalls field
   * @expectedResult AgentResult.toolCalls is undefined (not an empty array)
   */
  test("toolCalls is undefined when no tools were invoked", async () => {
    const sink = spy();
    // Override the default mock for this test
    const { callLlm } = await import("../src/llm/providers/index.ts");
    (callLlm as unknown as ReturnType<typeof mock>).mockResolvedValueOnce({
      text: "no tools",
      finishReason: "stop",
      // no toolCalls
    });

    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes(
        craft()
          .id("no-tool-calls")
          .from(simple("hi"))
          .to(agent({ system: "x", model: "anthropic:claude-opus-4-7" }))
          .to(sink),
      )
      .build();

    await t.test();
    const r = sink.received[0]!.body as AgentResult;
    expect(r.toolCalls).toBeUndefined();
  });

  /**
   * @case Documented assertion pattern works end-to-end
   * @preconditions Pipeline asserts the agent called `replyEmail`; mock returns no such call; step-scope .error() forwards
   * @expectedResult The error path runs (assertion threw); the route does not reach the success sink
   */
  test("post-dispatch assertion + step-scope .error() escalation", async () => {
    const successSink = spy();
    const fallbackSink = spy();
    const captured: AgentToolCallSummary[][] = [];

    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes(
        craft()
          .id("must-have-replied")
          .from(simple("an inbound message"))
          .to(agent({ system: "x", model: "anthropic:claude-opus-4-7" }))
          .error(() => {
            // step-scope wrapper around the next .process(); captures
            // the assertion failure and routes to the fallback sink.
            return { escalated: true };
          })
          .process((ex) => {
            const r = ex.body as AgentResult;
            captured.push(r.toolCalls ?? []);
            const replied = r.toolCalls?.some(
              (c) => c.toolName === "replyEmail" && !c.error,
            );
            if (!replied) throw new Error("Agent did not call replyEmail");
            return ex;
          })
          .to(successSink)
          .to(fallbackSink),
      )
      .build();

    await t.test();
    // Mock returned tool calls but none was `replyEmail`, so the
    // assertion threw, the wrapper recovered with `{ escalated: true }`
    // and the pipeline continued past the wrapped step.
    expect(captured[0]?.map((c) => c.toolName)).toEqual([
      "fetchOrder",
      "sendSlack",
    ]);
    // The wrapper recovered and replaced the body; subsequent steps
    // saw `{ escalated: true }` and ran (both sinks fire).
    expect(successSink.received).toHaveLength(1);
    expect(successSink.received[0]?.body).toEqual({ escalated: true });
    expect(fallbackSink.received).toHaveLength(1);
  });

  /**
   * @case Block-loader tool invocations are partitioned out of AgentResult.toolCalls
   * @preconditions Mocked LLM returns a mix of a user-tool call and a `_block_load_<name>` call
   * @expectedResult AgentResult.toolCalls only contains the user-tool entry; the loader call surfaces on AgentResult.blocksLoaded
   */
  test("block-loader calls are excluded from toolCalls and listed in blocksLoaded", async () => {
    const sink = spy();
    const { callLlm } = await import("../src/llm/providers/index.ts");
    (callLlm as unknown as ReturnType<typeof mock>).mockResolvedValueOnce({
      text: "done",
      finishReason: "stop",
      toolCalls: [
        {
          toolCallId: "user-1",
          toolName: "fetchOrder",
          input: { id: "abc" },
          output: { status: "shipped" },
        },
        {
          toolCallId: "loader-1",
          toolName: "_block_load_memory",
          input: {},
          output: "remembered text",
        },
      ],
    });

    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes(
        craft()
          .id("partition-loader-calls")
          .from(simple("hi"))
          .to(agent({ system: "x", model: "anthropic:claude-opus-4-7" }))
          .to(sink),
      )
      .build();

    await t.test();
    const r = sink.received[0]!.body as AgentResult;
    expect(r.toolCalls?.map((c) => c.toolName)).toEqual(["fetchOrder"]);
    expect(r.blocksLoaded?.map((b) => b.blockName)).toEqual(["memory"]);
    expect(r.blocksLoaded?.[0]?.toolName).toBe("_block_load_memory");
    expect(r.blocksLoaded?.[0]?.output).toBe("remembered text");
  });
});
