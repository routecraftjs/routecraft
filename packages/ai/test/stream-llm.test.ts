import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { logger as frameworkLogger } from "@routecraft/routecraft";

// Mock the Vercel AI SDK so the real `streamLlm` (not its
// re-implementation in agent-streaming.test.ts) is exercised end to
// end. The mock provides a minimal `streamText` whose `fullStream`
// yields a controlled sequence and whose consolidation accessors
// resolve as Promises. Two text-deltas plus a coarse `finish` part
// (which is now filtered out by `normalizeStreamDelta`); the test
// asserts that only the deltas drive `onDelta` invocations.
vi.mock("ai", () => ({
  streamText: vi.fn(() => ({
    fullStream: (async function* () {
      yield { type: "text-delta", text: "o" };
      yield { type: "text-delta", text: "k" };
      yield { type: "finish", finishReason: "stop" };
    })(),
    text: Promise.resolve("ok"),
    usage: Promise.resolve(undefined),
    reasoningText: Promise.resolve(undefined),
    output: Promise.resolve(undefined),
  })),
}));

// Mock the Anthropic provider so resolveLanguageModel doesn't try to
// load `@ai-sdk/anthropic` from disk during the test.
vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: vi.fn(
    () =>
      function model() {
        return { doGenerate: () => null, doStream: () => null };
      },
  ),
}));

import { streamLlm } from "../src/llm/providers/index.ts";

describe("streamLlm: production listener-error containment", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(frameworkLogger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  /**
   * @case A throwing listener does not reject the dispatch
   * @preconditions onDelta throws synchronously on every invocation
   * @expectedResult Promise resolves with the consolidated LlmResult; warn called per throw
   */
  test("throwing onDelta does not abort dispatch", async () => {
    const result = await streamLlm({
      config: { provider: "anthropic", apiKey: "sk-test" },
      modelId: "claude-test",
      options: { temperature: 0, maxTokens: 64 },
      system: "x",
      user: "y",
      onDelta: () => {
        throw new Error("listener boom");
      },
    });
    expect(result.text).toBe("ok");
    // 2 deltas (the finish part is filtered) -> 2 listener
    // invocations -> 2 warn entries.
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls[0]?.[1]).toMatch(/agent\.onDelta listener threw/);
  });

  /**
   * @case Listener that throws on the first delta still receives the second
   * @preconditions onDelta throws on the first call, succeeds on the rest
   * @expectedResult Both deltas are delivered (catch lives per-delta, not per-stream)
   */
  test("subsequent deltas still delivered after a listener throw", async () => {
    let calls = 0;
    await streamLlm({
      config: { provider: "anthropic", apiKey: "sk-test" },
      modelId: "claude-test",
      options: { temperature: 0, maxTokens: 64 },
      system: "x",
      user: "y",
      onDelta: () => {
        calls++;
        if (calls === 1) throw new Error("first-only");
      },
    });
    expect(calls).toBe(2);
  });
});
