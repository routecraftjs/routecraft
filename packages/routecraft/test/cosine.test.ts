import { describe, test, expect } from "vitest";
import { cosine, type Comparator } from "../src/adapters/cosine.ts";

describe("cosine()", () => {
  /**
   * @case cosine(options) returns an object with compare function
   * @preconditions options with field and optional threshold
   * @expectedResult Return value has compare property (function)
   */
  test("returns a Comparator", () => {
    const comp = cosine({ field: "vec", threshold: 0.9 });
    expect(comp).toHaveProperty("compare");
    expect(typeof comp.compare).toBe("function");
  });

  /**
   * @case compare(a, b) when vectors identical
   * @preconditions Same vector on both items, threshold 0.82
   * @expectedResult Returns true
   */
  test("compare returns true when similarity above threshold", () => {
    const comp = cosine({ field: "vec", threshold: 0.82 });
    const a = { vec: [1, 0, 0, 0] };
    const b = { vec: [1, 0, 0, 0] };
    expect(comp.compare(a, b)).toBe(true);
  });

  /**
   * @case compare(a, b) when vectors orthogonal and threshold high
   * @preconditions Orthogonal vectors, threshold 0.99
   * @expectedResult Returns false
   */
  test("compare returns false when similarity below threshold", () => {
    const comp = cosine({ field: "vec", threshold: 0.99 });
    const a = { vec: [1, 0, 0, 0] };
    const b = { vec: [0, 1, 0, 0] };
    expect(comp.compare(a, b)).toBe(false);
  });

  /**
   * @case cosine({ field }) without threshold uses default 0.82
   * @preconditions options with field only
   * @expectedResult Identical vectors compare true
   */
  test("uses default threshold 0.82 when not provided", () => {
    const comp = cosine({ field: "v" }) as Comparator<{ v: number[] }>;
    expect(comp.compare({ v: [1, 0] }, { v: [1, 0] })).toBe(true);
  });

  /**
   * @case compare when field is missing or not number[]
   * @preconditions One item has non-array at field or missing field
   * @expectedResult Returns false
   */
  test("compare returns false when field is not an array", () => {
    const comp = cosine({ field: "vec" });
    expect(comp.compare({ vec: "not-array" }, { vec: [1, 0] })).toBe(false);
    expect(comp.compare({ vec: [1, 0] }, { other: [1, 0] })).toBe(false);
  });
});
