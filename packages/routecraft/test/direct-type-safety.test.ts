import { describe, test, expectTypeOf } from "vitest";
import { z } from "zod";
import { direct } from "../src/adapters/direct.ts";
import type { Source } from "../src/operations/from.ts";
import type { Destination } from "../src/operations/to.ts";

/**
 * Type-level tests: direct() returns Source<T> when options provided (e.g. {}), Destination<T, T> when not.
 */
describe("Direct adapter type safety", () => {
  /**
   * @case direct() with second arg (empty options) is typed as Source
   * @preconditions direct("ep", {})
   * @expectedResult Type matches Source<unknown>
   */
  test("direct(endpoint, {}) returns Source", () => {
    expectTypeOf(direct("ep", {})).toMatchTypeOf<Source<unknown>>();
  });

  /**
   * @case direct() with schema in options is typed as Source
   * @preconditions direct("ep", { schema })
   * @expectedResult Type matches Source<unknown>
   */
  test("direct(endpoint, { schema }) returns Source", () => {
    expectTypeOf(direct("ep", { schema: z.object({}) })).toMatchTypeOf<
      Source<unknown>
    >();
  });

  /**
   * @case direct() with no second arg is typed as Destination
   * @preconditions direct("ep")
   * @expectedResult Type matches Destination<unknown, unknown>
   */
  test("direct(endpoint) with no second arg returns Destination", () => {
    expectTypeOf(direct("ep")).toMatchTypeOf<Destination<unknown, unknown>>();
  });

  /**
   * @case direct() with function endpoint (no options) is typed as Destination
   * @preconditions direct((ex) => "ep")
   * @expectedResult Type matches Destination<unknown, unknown>
   */
  test("direct(function) returns Destination", () => {
    expectTypeOf(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- param only for type
      direct((_ex: { body: unknown }) => "ep"),
    ).toMatchTypeOf<Destination<unknown, unknown>>();
  });

  /**
   * @case Source-shaped return is not assignable to Destination
   * @preconditions direct("ep", {})
   * @expectedResult Type does not match Destination
   */
  test("Source return is not assignable to Destination", () => {
    const withOptions = direct("ep", {});
    expectTypeOf(withOptions).not.toMatchTypeOf<
      Destination<unknown, unknown>
    >();
  });

  /**
   * @case Destination-shaped return is not assignable to Source
   * @preconditions direct("ep")
   * @expectedResult Type does not match Source
   */
  test("Destination return is not assignable to Source", () => {
    const noOptions = direct("ep");
    expectTypeOf(noOptions).not.toMatchTypeOf<Source<unknown>>();
  });
});
