import { describe, expectTypeOf, test } from "bun:test";
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
  });

  /**
   * @case Explicit two-generic form produces Destination<TIn, TOut>
   * @preconditions direct<{ name: string }, { result: number }>("ep")
   * @expectedResult Type matches Destination<{ name: string }, { result: number }>
   */
  test("direct<TIn, TOut>(string) returns Destination<TIn, TOut>", () => {
    type In = { name: string; body: string };
    type Out = { result: number; latencyMs: number };
    expectTypeOf(direct<In, Out>("ep")).toMatchTypeOf<Destination<In, Out>>();
  });

  /**
   * @case Explicit two-generic form does not collapse to the symmetric variant
   * @preconditions direct<{ a: 1 }, { b: 2 }>("ep")
   * @expectedResult Type does not match Destination<{ a: 1 }, { a: 1 }>
   */
  test("direct<TIn, TOut> with TIn != TOut is not assignable to Destination<TIn, TIn>", () => {
    const dest = direct<{ a: 1 }, { b: 2 }>("ep");
    expectTypeOf(dest).not.toMatchTypeOf<Destination<{ a: 1 }, { a: 1 }>>();
  });

  /**
   * @case Function-form endpoint still resolves to the symmetric overload
   * @preconditions direct((ex) => "ep") with Exchange<X>
   * @expectedResult Type matches Destination<X, X>
   */
  test("direct(function) still returns Destination<T, T>", () => {
    type X = { id: string };
    expectTypeOf(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- param only for type
      direct((_ex: { body: X; headers: Record<string, unknown> }) => "ep"),
    ).toMatchTypeOf<Destination<X, X>>();
  });
});
