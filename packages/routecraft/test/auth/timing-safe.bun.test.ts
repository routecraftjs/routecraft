import { describe, expect, test } from "bun:test";
import { timingSafeStringEqual } from "../../src/index.ts";

describe("timingSafeStringEqual", () => {
  /**
   * @case The secret and the presented candidate are identical
   * @preconditions Two equal strings
   * @expectedResult True. The helper is a comparison first; the constant-time property is worthless if it does not admit the right credential
   */
  test("admits an identical candidate", () => {
    expect(timingSafeStringEqual("s3cret-value", "s3cret-value")).toBe(true);
  });

  /**
   * @case The candidate differs at the first byte
   * @preconditions Two strings of equal length differing from the start
   * @expectedResult False, and by the same path a candidate differing at the last byte takes, which is the whole point of the helper
   */
  test("refuses a candidate of the same length", () => {
    expect(timingSafeStringEqual("s3cret-value", "X3cret-value")).toBe(false);
    expect(timingSafeStringEqual("s3cret-value", "s3cret-valuX")).toBe(false);
  });

  /**
   * @case The candidate is a different length from the secret
   * @preconditions A candidate longer, shorter, and empty against the same secret
   * @expectedResult False rather than a thrown error. `timingSafeEqual` rejects unequal buffer lengths by throwing, and a caller comparing a caller-supplied value must get an ordinary rejection instead
   */
  test("refuses a candidate of a different length without throwing", () => {
    expect(timingSafeStringEqual("s3cret-value", "s3cret-value-longer")).toBe(
      false,
    );
    expect(timingSafeStringEqual("s3cret-value", "s3cret")).toBe(false);
    expect(timingSafeStringEqual("s3cret-value", "")).toBe(false);
  });

  /**
   * @case Multi-byte characters compare by bytes, not by code units
   * @preconditions Two strings whose UTF-8 encodings differ but whose lengths in code units match
   * @expectedResult False. The comparison runs over the encoded buffers, so a secret carrying non-ASCII is compared as it is transmitted
   */
  test("compares the encoded bytes", () => {
    expect(timingSafeStringEqual("café", "cafe")).toBe(false);
    expect(timingSafeStringEqual("café", "café")).toBe(true);
  });
});
