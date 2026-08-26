import { describe, expect, test } from "bun:test";
import { type } from "arktype";
import { z } from "zod";
import { isStandardSchema } from "../src/index.ts";

/**
 * The predicate seven boundaries share to decide whether a caller-supplied
 * value can be handed to `validateAgainst`, which dereferences
 * `~standard.validate` unguarded. It answers only that question: each
 * caller keeps its own refusal (#575).
 */
describe("isStandardSchema", () => {
  /**
   * @case A real schema library is recognised
   * @preconditions A Zod schema, which carries ~standard.validate
   * @expectedResult True, so the predicate accepts what the framework must accept
   */
  test("accepts a real Standard Schema", () => {
    expect(isStandardSchema(z.object({ a: z.string() }))).toBe(true);
  });

  /**
   * @case A callable schema is recognised
   * @preconditions An ArkType schema, which is a function object carrying ~standard
   * @expectedResult True. `validateAgainst` validates one happily, so a guard that rejected functions would be narrower than the thing it guards
   */
  test("accepts a callable schema", () => {
    expect(isStandardSchema(type({ a: "string" }))).toBe(true);
  });

  /**
   * @case A bag carrying no callable validator is rejected
   * @preconditions Value has a ~standard object with no validate
   * @expectedResult False, because the bag alone does not make it usable; this is the shape that separates testing the bag from testing the validator
   */
  test("rejects a ~standard bag with no validate", () => {
    expect(isStandardSchema({ "~standard": {} })).toBe(false);
  });

  /**
   * @case A non-callable validate is rejected
   * @preconditions ~standard.validate is present but not a function
   * @expectedResult False, so a truthiness check cannot let it through to be called
   */
  test("rejects a non-callable validate", () => {
    expect(isStandardSchema({ "~standard": { validate: "yes" } })).toBe(false);
  });

  /**
   * @case Values that are not objects are rejected without throwing
   * @preconditions null, undefined, and primitives, which arrive from user configuration
   * @expectedResult False for each, because the guard runs before any property access is safe
   */
  test("rejects non-objects without throwing", () => {
    for (const value of [null, undefined, "schema", 42, true]) {
      expect(isStandardSchema(value)).toBe(false);
    }
  });
});
