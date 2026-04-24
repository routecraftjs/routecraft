import { describe, test, expectTypeOf } from "vitest";
import { z } from "zod";
import { direct } from "../src/adapters/direct/index.ts";
import type { Source } from "../src/operations/from.ts";
import type { Destination } from "../src/operations/to.ts";

/**
 * Type-level tests: direct() returns Source when called with options or no
 * args, Destination when called with a string or function endpoint.
 */
describe("Direct adapter type safety", () => {
  /**
   * @case direct() with an empty options object is typed as Source
   * @preconditions direct({})
   * @expectedResult Type matches Source<unknown>
   */
  test("direct({}) returns Source", () => {
    expectTypeOf(direct({})).toMatchTypeOf<Source<unknown>>();
  });

  /**
   * @case direct() with no args is typed as Source
   * @preconditions direct()
   * @expectedResult Type matches Source<unknown>
   */
  test("direct() with no args returns Source", () => {
    expectTypeOf(direct()).toMatchTypeOf<Source<unknown>>();
  });

  /**
   * @case direct() with a string endpoint is typed as Destination
   * @preconditions direct("ep")
   * @expectedResult Type matches Destination<unknown, unknown>
   */
  test("direct(string) returns Destination", () => {
    expectTypeOf(direct("ep")).toMatchTypeOf<Destination<unknown, unknown>>();
  });

  /**
   * @case direct() with function endpoint is typed as Destination
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
   * @preconditions direct({})
   * @expectedResult Type does not match Destination
   */
  test("Source return is not assignable to Destination", () => {
    const src = direct({});
    expectTypeOf(src).not.toMatchTypeOf<Destination<unknown, unknown>>();
  });

  /**
   * @case Destination-shaped return is not assignable to Source
   * @preconditions direct("ep")
   * @expectedResult Type does not match Source
   */
  test("Destination return is not assignable to Source", () => {
    const dest = direct("ep");
    expectTypeOf(dest).not.toMatchTypeOf<Source<unknown>>();
  });

  /**
   * @case channelType option passes type-check on source
   * @preconditions direct({ channelType: CustomChannel })
   * @expectedResult Type matches Source<unknown>
   */
  test("direct({ channelType }) returns Source", () => {
    // Minimal shape sufficient to satisfy the channel constraint.
    class NoopChannel {
      async send() {
        return null as unknown;
      }
      async subscribe() {}
      async unsubscribe() {}
    }
    expectTypeOf(direct({ channelType: NoopChannel })).toMatchTypeOf<
      Source<unknown>
    >();
    // Ensure z import stays referenced so the file compiles cleanly under
    // noUnusedLocals even when the schema-based cases are dropped.
    expectTypeOf(z.object({})).not.toBeAny();
  });
});
