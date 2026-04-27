import { describe, test, expect } from "vitest";
import { normalizeStreamDelta } from "../src/agent/events.ts";

describe("normalizeStreamDelta: Vercel SDK part to AgentDelta", () => {
  /**
   * @case Plain text deltas map 1:1 onto text-delta deltas
   * @preconditions Part of shape { type: "text-delta", text }
   * @expectedResult Returns { type: "text-delta", text }
   */
  test("text-delta passes through", () => {
    expect(normalizeStreamDelta({ type: "text-delta", text: "hi" })).toEqual({
      type: "text-delta",
      text: "hi",
    });
  });

  /**
   * @case Empty text deltas are dropped (would emit a no-op delta)
   * @preconditions Part with empty text
   * @expectedResult null (filtered)
   */
  test("empty text-delta is filtered", () => {
    expect(normalizeStreamDelta({ type: "text-delta", text: "" })).toBeNull();
  });

  /**
   * @case Legacy SDK field name `textDelta` is honoured for cross-version safety
   * @preconditions Part with `textDelta` instead of `text`
   * @expectedResult Returns text-delta with the legacy field's value
   */
  test("text-delta accepts legacy `textDelta` field", () => {
    expect(
      normalizeStreamDelta({ type: "text-delta", textDelta: "legacy" }),
    ).toEqual({ type: "text-delta", text: "legacy" });
  });

  /**
   * @case Reasoning deltas surface for "thinking..." UI
   * @preconditions Part of shape { type: "reasoning-delta", text }
   * @expectedResult Returns { type: "reasoning-delta", text }
   */
  test("reasoning-delta passes through", () => {
    expect(
      normalizeStreamDelta({ type: "reasoning-delta", text: "musing" }),
    ).toEqual({ type: "reasoning-delta", text: "musing" });
  });

  /**
   * @case Legacy SDK field name `delta` is honoured for cross-version safety
   * @preconditions Part with `delta` instead of `text`
   * @expectedResult Returns reasoning-delta with the legacy field's value
   */
  test("reasoning-delta accepts legacy `delta` field", () => {
    expect(
      normalizeStreamDelta({ type: "reasoning-delta", delta: "musing-legacy" }),
    ).toEqual({ type: "reasoning-delta", text: "musing-legacy" });
  });

  /**
   * @case Coarse decision parts (tool-call, tool-result, tool-error) are filtered out
   * @preconditions Parts that previously routed through the delta channel
   * @expectedResult null - those parts now flow on the context bus instead
   */
  test("coarse decision parts are filtered (now on context bus)", () => {
    expect(
      normalizeStreamDelta({
        type: "tool-call",
        toolCallId: "c1",
        toolName: "echo",
        input: { msg: "hi" },
      }),
    ).toBeNull();
    expect(
      normalizeStreamDelta({
        type: "tool-result",
        toolCallId: "c1",
        toolName: "echo",
        output: "ok",
      }),
    ).toBeNull();
    expect(
      normalizeStreamDelta({
        type: "tool-error",
        toolCallId: "c1",
        toolName: "echo",
        error: new Error("boom"),
      }),
    ).toBeNull();
    expect(
      normalizeStreamDelta({
        type: "finish-step",
        finishReason: "tool-calls",
      }),
    ).toBeNull();
    expect(
      normalizeStreamDelta({
        type: "finish",
        finishReason: "stop",
      }),
    ).toBeNull();
    expect(normalizeStreamDelta({ type: "error", error: {} })).toBeNull();
  });

  /**
   * @case Low-level parts are filtered (text-start/end, tool-input-*, abort, raw)
   * @preconditions Parts with types not in the public surface
   * @expectedResult null
   */
  test("low-level SDK parts are filtered out", () => {
    expect(normalizeStreamDelta({ type: "text-start", id: "0" })).toBeNull();
    expect(normalizeStreamDelta({ type: "text-end", id: "0" })).toBeNull();
    expect(
      normalizeStreamDelta({ type: "tool-input-start", id: "x" }),
    ).toBeNull();
    expect(
      normalizeStreamDelta({ type: "tool-input-delta", id: "x", delta: "{" }),
    ).toBeNull();
    expect(normalizeStreamDelta({ type: "abort" })).toBeNull();
    expect(normalizeStreamDelta({ type: "raw", payload: {} })).toBeNull();
  });

  /**
   * @case Garbage input is dropped, not thrown
   * @preconditions Non-object inputs
   * @expectedResult null for each
   */
  test("non-object input returns null", () => {
    expect(normalizeStreamDelta(null)).toBeNull();
    expect(normalizeStreamDelta(undefined)).toBeNull();
    expect(normalizeStreamDelta("text")).toBeNull();
    expect(normalizeStreamDelta(42)).toBeNull();
  });
});
