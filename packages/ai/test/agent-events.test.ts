import { describe, test, expect } from "vitest";
import { normalizeStreamPart } from "../src/agent/events.ts";

describe("normalizeStreamPart: Vercel SDK part to AgentEvent", () => {
  /**
   * @case Plain text deltas map 1:1 onto text-delta events
   * @preconditions Part of shape { type: "text-delta", text }
   * @expectedResult Returns { type: "text-delta", text }
   */
  test("text-delta passes through", () => {
    expect(normalizeStreamPart({ type: "text-delta", text: "hi" })).toEqual({
      type: "text-delta",
      text: "hi",
    });
  });

  /**
   * @case Empty text deltas are dropped (would emit a no-op event)
   * @preconditions Part with empty text
   * @expectedResult null (filtered)
   */
  test("empty text-delta is filtered", () => {
    expect(normalizeStreamPart({ type: "text-delta", text: "" })).toBeNull();
  });

  /**
   * @case Legacy SDK field name `textDelta` is honoured for cross-version safety
   * @preconditions Part with `textDelta` instead of `text`
   * @expectedResult Returns text-delta with the legacy field's value
   */
  test("text-delta accepts legacy `textDelta` field", () => {
    expect(
      normalizeStreamPart({ type: "text-delta", textDelta: "legacy" }),
    ).toEqual({ type: "text-delta", text: "legacy" });
  });

  /**
   * @case Reasoning deltas surface for "thinking..." UI
   * @preconditions Part of shape { type: "reasoning-delta", text }
   * @expectedResult Returns { type: "reasoning-delta", text }
   */
  test("reasoning-delta passes through", () => {
    expect(
      normalizeStreamPart({ type: "reasoning-delta", text: "musing" }),
    ).toEqual({ type: "reasoning-delta", text: "musing" });
  });

  /**
   * @case Legacy SDK field name `delta` is honoured for cross-version safety
   * @preconditions Part with `delta` instead of `text`
   * @expectedResult Returns reasoning-delta with the legacy field's value
   */
  test("reasoning-delta accepts legacy `delta` field", () => {
    expect(
      normalizeStreamPart({ type: "reasoning-delta", delta: "musing-legacy" }),
    ).toEqual({ type: "reasoning-delta", text: "musing-legacy" });
  });

  /**
   * @case Tool calls carry id, name, and validated input
   * @preconditions Part of shape { type: "tool-call", toolCallId, toolName, input }
   * @expectedResult Returns the same shape with `input` (not `args`)
   */
  test("tool-call maps cleanly", () => {
    expect(
      normalizeStreamPart({
        type: "tool-call",
        toolCallId: "c1",
        toolName: "echo",
        input: { msg: "hi" },
      }),
    ).toEqual({
      type: "tool-call",
      toolCallId: "c1",
      toolName: "echo",
      input: { msg: "hi" },
    });
  });

  /**
   * @case Tool result carries handler return value
   * @preconditions Part of shape { type: "tool-result", toolCallId, toolName, output }
   * @expectedResult Returns the same shape with `output` (not `result`)
   */
  test("tool-result maps cleanly", () => {
    expect(
      normalizeStreamPart({
        type: "tool-result",
        toolCallId: "c1",
        toolName: "echo",
        output: "echoed hi",
      }),
    ).toEqual({
      type: "tool-result",
      toolCallId: "c1",
      toolName: "echo",
      output: "echoed hi",
    });
  });

  /**
   * @case Tool error carries the thrown value
   * @preconditions Part of shape { type: "tool-error", toolCallId, toolName, error }
   * @expectedResult Returns the same shape
   */
  test("tool-error maps cleanly", () => {
    const err = new Error("boom");
    expect(
      normalizeStreamPart({
        type: "tool-error",
        toolCallId: "c1",
        toolName: "echo",
        error: err,
      }),
    ).toEqual({
      type: "tool-error",
      toolCallId: "c1",
      toolName: "echo",
      error: err,
    });
  });

  /**
   * @case Step finish carries reason and optional usage
   * @preconditions Part with finishReason and usage
   * @expectedResult Returns step-finish with same fields
   */
  test("finish-step maps to step-finish with usage", () => {
    expect(
      normalizeStreamPart({
        type: "finish-step",
        finishReason: "tool-calls",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      }),
    ).toEqual({
      type: "step-finish",
      finishReason: "tool-calls",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
  });

  /**
   * @case Final finish prefers totalUsage when present
   * @preconditions Part with totalUsage
   * @expectedResult Returns finish with usage from totalUsage
   */
  test("finish prefers totalUsage over usage", () => {
    expect(
      normalizeStreamPart({
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      }),
    ).toEqual({
      type: "finish",
      finishReason: "stop",
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    });
  });

  /**
   * @case Error events surface to the listener
   * @preconditions Part of shape { type: "error", error }
   * @expectedResult Returns { type: "error", error }
   */
  test("error passes through", () => {
    const err = { code: "ECONNRESET" };
    expect(normalizeStreamPart({ type: "error", error: err })).toEqual({
      type: "error",
      error: err,
    });
  });

  /**
   * @case Low-level parts are filtered (text-start/end, tool-input-*, abort, raw)
   * @preconditions Parts with types not in the public surface
   * @expectedResult null
   */
  test("low-level SDK parts are filtered out", () => {
    expect(normalizeStreamPart({ type: "text-start", id: "0" })).toBeNull();
    expect(normalizeStreamPart({ type: "text-end", id: "0" })).toBeNull();
    expect(
      normalizeStreamPart({ type: "tool-input-start", id: "x" }),
    ).toBeNull();
    expect(
      normalizeStreamPart({ type: "tool-input-delta", id: "x", delta: "{" }),
    ).toBeNull();
    expect(normalizeStreamPart({ type: "abort" })).toBeNull();
    expect(normalizeStreamPart({ type: "raw", payload: {} })).toBeNull();
  });

  /**
   * @case Garbage input is dropped, not thrown
   * @preconditions Non-object inputs
   * @expectedResult null for each
   */
  test("non-object input returns null", () => {
    expect(normalizeStreamPart(null)).toBeNull();
    expect(normalizeStreamPart(undefined)).toBeNull();
    expect(normalizeStreamPart("text")).toBeNull();
    expect(normalizeStreamPart(42)).toBeNull();
  });
});
