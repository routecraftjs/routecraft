import { describe, expect, test } from "bun:test";
import { clipText } from "../src/shared/clip-text.ts";

describe("clipText", () => {
  /**
   * @case Text within the cap passes through unchanged
   * @preconditions A 10-unit string and a cap of 10
   * @expectedResult The same string
   */
  test("keeps text within the cap", () => {
    expect(clipText("0123456789", 10)).toBe("0123456789");
  });

  /**
   * @case The cap is measured in characters, ellipsis included, and never splits a surrogate pair
   * @preconditions 300 astral characters (600 units) under a cap of 500, then 600 of them
   * @expectedResult The 300 pass through whole; the 600 are cut to 500 characters ending in the ellipsis with every astral character intact
   */
  test("bounds astral text by characters at a code point boundary", () => {
    const within = "\u{1F600}".repeat(300);
    expect(clipText(within, 500)).toBe(within);
    const clipped = clipText("\u{1F600}".repeat(600), 500);
    expect([...clipped]).toHaveLength(500);
    expect(clipped.endsWith("...")).toBe(true);
    expect([...clipped.slice(0, -3)].every((c) => c === "\u{1F600}")).toBe(
      true,
    );
  });
});
