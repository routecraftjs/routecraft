import { describe, expect, test } from "bun:test";
import { toLlmUsage } from "../src/llm/providers/llm-utils.ts";

describe("toLlmUsage", () => {
  /**
   * @case basic token fields are passed through unchanged
   * @preconditions SDK usage object with inputTokens, outputTokens, totalTokens
   * @expectedResult LlmUsage has the same values; no extra keys
   */
  test("passes through basic token counts", () => {
    const result = toLlmUsage({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    });
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
    expect(result.totalTokens).toBe(150);
    expect(result.cacheReadTokens).toBeUndefined();
    expect(result.cacheWriteTokens).toBeUndefined();
  });

  /**
   * @case cache token details from inputTokenDetails are extracted correctly
   * @preconditions SDK usage with inputTokenDetails.cacheReadTokens and cacheWriteTokens
   * @expectedResult LlmUsage carries cacheReadTokens and cacheWriteTokens
   */
  test("extracts cacheReadTokens and cacheWriteTokens from inputTokenDetails", () => {
    const result = toLlmUsage({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      inputTokenDetails: {
        cacheReadTokens: 80,
        cacheWriteTokens: 20,
      },
    });
    expect(result.cacheReadTokens).toBe(80);
    expect(result.cacheWriteTokens).toBe(20);
  });

  /**
   * @case partial cache detail -- only cacheReadTokens present
   * @preconditions inputTokenDetails has cacheReadTokens but not cacheWriteTokens
   * @expectedResult cacheReadTokens set, cacheWriteTokens absent
   */
  test("handles partial inputTokenDetails gracefully", () => {
    const result = toLlmUsage({
      inputTokens: 50,
      outputTokens: 10,
      totalTokens: 60,
      inputTokenDetails: { cacheReadTokens: 40 },
    });
    expect(result.cacheReadTokens).toBe(40);
    expect(result.cacheWriteTokens).toBeUndefined();
  });

  /**
   * @case undefined fields are omitted, not set to undefined
   * @preconditions SDK usage with all fields undefined
   * @expectedResult empty LlmUsage object (no own properties)
   */
  test("omits undefined fields entirely", () => {
    const result = toLlmUsage({});
    expect(Object.keys(result)).toHaveLength(0);
  });
});
