import { describe, test, expect, afterEach, vi, beforeEach } from "vitest";
import { craft, simple } from "@routecraft/routecraft";
import { spy, testContext, type TestContext } from "@routecraft/testing";
import {
  agent,
  llmPlugin,
  type AgentDelta,
  type AgentResult,
} from "../src/index.ts";
import type { LlmResult } from "../src/llm/types.ts";

// Mock both LLM dispatch paths so the streaming tests stay hermetic.
// `streamLlm` synthesises a small token stream (text-delta x2),
// forwards it to `onDelta`, and returns a consolidated LlmResult
// mirroring what the real provider would build after the stream
// drains. Coarse decision events (tool-call, tool-result, finished,
// error) flow on the context bus and are tested separately.
vi.mock("../src/llm/providers/index.ts", () => ({
  callLlm: vi.fn(
    async (): Promise<LlmResult> => ({
      text: "non-stream",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }),
  ),
  streamLlm: vi.fn(
    async ({
      onDelta,
    }: {
      onDelta: (d: AgentDelta) => void | Promise<void>;
    }): Promise<LlmResult> => {
      // Mirror the real runStreamGenerate: listener throws are caught
      // and logged so a noisy consumer doesn't break the dispatch.
      const safe = async (d: AgentDelta) => {
        try {
          await onDelta(d);
        } catch {
          // swallow, mirrors frameworkLogger.warn in the real path
        }
      };
      await safe({ type: "text-delta", text: "Hel" });
      await safe({ type: "text-delta", text: "lo" });
      return {
        text: "Hello",
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      };
    },
  ),
}));

import { callLlm, streamLlm } from "../src/llm/providers/index.ts";
const callLlmMock = callLlm as unknown as ReturnType<typeof vi.fn>;
const streamLlmMock = streamLlm as unknown as ReturnType<typeof vi.fn>;

describe("agent streaming: onDelta -> streamLlm wiring", () => {
  let t: TestContext | undefined;

  beforeEach(() => {
    callLlmMock.mockClear();
    streamLlmMock.mockClear();
  });

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case Agent without onDelta uses the synchronous path
   * @preconditions Inline agent with no `onDelta`
   * @expectedResult callLlm called once; streamLlm not called
   */
  test("no onDelta -> callLlm, not streamLlm", async () => {
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes(
        craft()
          .id("sync-only")
          .from(simple("hi"))
          .to(
            agent({
              system: "Be helpful.",
              model: "anthropic:claude-opus-4-7",
            }),
          ),
      )
      .build();

    await t.test();
    expect(callLlmMock).toHaveBeenCalledTimes(1);
    expect(streamLlmMock).not.toHaveBeenCalled();
  });

  /**
   * @case Agent with onDelta triggers the streaming path
   * @preconditions Inline agent with `onDelta` callback
   * @expectedResult streamLlm called once; callLlm not called
   */
  test("onDelta present -> streamLlm, not callLlm", async () => {
    const deltas: AgentDelta[] = [];
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes(
        craft()
          .id("stream-on")
          .from(simple("hi"))
          .to(
            agent({
              system: "Be helpful.",
              model: "anthropic:claude-opus-4-7",
              onDelta: (d) => {
                deltas.push(d);
              },
            }),
          ),
      )
      .build();

    await t.test();
    expect(streamLlmMock).toHaveBeenCalledTimes(1);
    expect(callLlmMock).not.toHaveBeenCalled();
  });

  /**
   * @case Listener receives every emitted delta in order
   * @preconditions onDelta collects all deltas into an array
   * @expectedResult Deltas seen are [text-delta "Hel", text-delta "lo"]
   */
  test("listener receives deltas in dispatch order", async () => {
    const deltas: AgentDelta[] = [];
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes(
        craft()
          .id("delta-order")
          .from(simple("hi"))
          .to(
            agent({
              system: "x",
              model: "anthropic:claude-opus-4-7",
              onDelta: (d) => {
                deltas.push(d);
              },
            }),
          ),
      )
      .build();

    await t.test();
    expect(deltas).toHaveLength(2);
    expect(deltas[0]).toEqual({ type: "text-delta", text: "Hel" });
    expect(deltas[1]).toEqual({ type: "text-delta", text: "lo" });
  });

  /**
   * @case Body is the consolidated AgentResult after the stream drains
   * @preconditions Streaming agent followed by a sink
   * @expectedResult Sink sees AgentResult { text: "Hello", usage: {...} }
   */
  test("downstream body is the consolidated AgentResult", async () => {
    const sink = spy();
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes(
        craft()
          .id("stream-then-sink")
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
    const body = sink.received[0].body as AgentResult;
    expect(body.text).toBe("Hello");
    expect(body.usage).toEqual({
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
    });
  });

  /**
   * @case Throwing listener does not abort the dispatch
   * @preconditions onDelta throws on every call
   * @expectedResult Dispatch completes, AgentResult body still consolidated
   */
  test("listener throw is contained; dispatch completes", async () => {
    let received = 0;
    const sink = spy();
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes(
        craft()
          .id("throwing-listener")
          .from(simple("hi"))
          .to(
            agent({
              system: "x",
              model: "anthropic:claude-opus-4-7",
              onDelta: () => {
                received++;
                throw new Error("listener boom");
              },
            }),
          )
          .to(sink),
      )
      .build();

    await t.test();
    expect(received).toBe(2);
    const body = sink.received[0].body as AgentResult;
    expect(body.text).toBe("Hello");
  });

  /**
   * @case Async listener is awaited so back-pressure flows back into the stream
   * @preconditions onDelta returns a Promise that resolves after a tick
   * @expectedResult All deltas delivered before the dispatch resolves; ordering preserved
   */
  test("async listener is awaited", async () => {
    const deltas: AgentDelta[] = [];
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes(
        craft()
          .id("async-listener")
          .from(simple("hi"))
          .to(
            agent({
              system: "x",
              model: "anthropic:claude-opus-4-7",
              onDelta: async (d) => {
                await new Promise((r) => setTimeout(r, 1));
                deltas.push(d);
              },
            }),
          ),
      )
      .build();

    await t.test();
    expect(deltas).toHaveLength(2);
    expect(deltas[0]).toEqual({ type: "text-delta", text: "Hel" });
    expect(deltas[1]).toEqual({ type: "text-delta", text: "lo" });
  });
});
