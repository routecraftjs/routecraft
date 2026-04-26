import { describe, test, expect, afterEach, vi, beforeEach } from "vitest";
import { craft, simple } from "@routecraft/routecraft";
import { spy, testContext, type TestContext } from "@routecraft/testing";
import {
  agent,
  llmPlugin,
  type AgentEvent,
  type AgentResult,
} from "../src/index.ts";
import type { LlmResult } from "../src/llm/types.ts";

// Mock both LLM dispatch paths so the streaming tests stay hermetic.
// `streamLlm` synthesises a small event stream (text-delta x2 +
// finish), forwards it to `onEvent`, and returns a consolidated
// LlmResult mirroring what the real provider would build after the
// stream drains. `callLlm` stays available for the non-streaming
// regression check.
vi.mock("../src/llm/providers/index.ts", () => ({
  callLlm: vi.fn(
    async (): Promise<LlmResult> => ({
      text: "non-stream",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }),
  ),
  streamLlm: vi.fn(
    async ({
      onEvent,
    }: {
      onEvent: (e: AgentEvent) => void | Promise<void>;
    }): Promise<LlmResult> => {
      // Mirror the real runStreamGenerate: listener throws are caught
      // and logged so a noisy consumer doesn't break the dispatch.
      const safe = async (e: AgentEvent) => {
        try {
          await onEvent(e);
        } catch {
          // swallow, mirrors frameworkLogger.warn in the real path
        }
      };
      await safe({ type: "text-delta", text: "Hel" });
      await safe({ type: "text-delta", text: "lo" });
      await safe({
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      });
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

describe("agent streaming: onEvent → streamLlm wiring", () => {
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
   * @case Agent without onEvent uses the synchronous path
   * @preconditions Inline agent with no `onEvent`
   * @expectedResult callLlm called once; streamLlm not called
   */
  test("no onEvent → callLlm, not streamLlm", async () => {
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
   * @case Agent with onEvent triggers the streaming path
   * @preconditions Inline agent with `onEvent` callback
   * @expectedResult streamLlm called once; callLlm not called
   */
  test("onEvent present → streamLlm, not callLlm", async () => {
    const events: AgentEvent[] = [];
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
              onEvent: (e) => {
                events.push(e);
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
   * @case Listener receives every emitted event in order
   * @preconditions onEvent collects all events into an array
   * @expectedResult Events seen are [text-delta "Hel", text-delta "lo", finish]
   */
  test("listener receives events in dispatch order", async () => {
    const events: AgentEvent[] = [];
    t = await testContext()
      .with({
        plugins: [
          llmPlugin({ providers: { anthropic: { apiKey: "sk-test" } } }),
        ],
      })
      .routes(
        craft()
          .id("event-order")
          .from(simple("hi"))
          .to(
            agent({
              system: "x",
              model: "anthropic:claude-opus-4-7",
              onEvent: (e) => {
                events.push(e);
              },
            }),
          ),
      )
      .build();

    await t.test();
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ type: "text-delta", text: "Hel" });
    expect(events[1]).toEqual({ type: "text-delta", text: "lo" });
    expect(events[2]).toMatchObject({ type: "finish", finishReason: "stop" });
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
              onEvent: () => {},
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
   * @preconditions onEvent throws on the first text-delta
   * @expectedResult Dispatch completes, AgentResult body still consolidated, subsequent events still attempted
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
              onEvent: () => {
                received++;
                throw new Error("listener boom");
              },
            }),
          )
          .to(sink),
      )
      .build();

    await t.test();
    // The mocked streamLlm awaits onEvent in a try/catch (mirrors the
    // real implementation), so all 3 events are still attempted and
    // the consolidated AgentResult still flows downstream.
    expect(received).toBe(3);
    const body = sink.received[0].body as AgentResult;
    expect(body.text).toBe("Hello");
  });

  /**
   * @case Async listener is awaited so back-pressure flows back into the stream
   * @preconditions onEvent returns a Promise that resolves after a tick
   * @expectedResult All events delivered before the dispatch resolves
   */
  test("async listener is awaited", async () => {
    const events: AgentEvent[] = [];
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
              onEvent: async (e) => {
                await new Promise((r) => setTimeout(r, 1));
                events.push(e);
              },
            }),
          ),
      )
      .build();

    await t.test();
    expect(events).toHaveLength(3);
    // Awaiting an async listener must preserve dispatch order; without
    // back-pressure the events would interleave.
    expect(events[0]).toEqual({ type: "text-delta", text: "Hel" });
    expect(events[1]).toEqual({ type: "text-delta", text: "lo" });
    expect(events[2]).toMatchObject({ type: "finish", finishReason: "stop" });
  });
});
