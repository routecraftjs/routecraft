import { describe, expectTypeOf, test } from "bun:test";
import { craft, simple } from "@routecraft/routecraft";
import { direct } from "../src/adapters/direct/index.ts";
import type { Source } from "../src/operations/from.ts";
import type { Enricher } from "../src/operations/enrich.ts";

/**
 * Type-level tests: direct() returns Source when called with options or no
 * args, Enricher (the pull-in role) when called with a string or function
 * endpoint.
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
   * @case direct() with a string endpoint is typed as Enricher
   * @preconditions direct("ep")
   * @expectedResult Type matches Enricher<unknown, unknown>
   */
  test("direct(string) returns Enricher", () => {
    expectTypeOf(direct("ep")).toMatchTypeOf<Enricher<unknown, unknown>>();
  });

  /**
   * @case direct() with function endpoint is typed as Enricher
   * @preconditions direct((ex) => "ep")
   * @expectedResult Type matches Enricher<unknown, unknown>
   */
  test("direct(function) returns Enricher", () => {
    expectTypeOf(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- param only for type
      direct((_ex: { body: unknown }) => "ep"),
    ).toMatchTypeOf<Enricher<unknown, unknown>>();
  });

  /**
   * @case Source-shaped return is not assignable to Enricher
   * @preconditions direct({})
   * @expectedResult Type does not match Enricher
   */
  test("Source return is not assignable to Enricher", () => {
    const src = direct({});
    expectTypeOf(src).not.toMatchTypeOf<Enricher<unknown, unknown>>();
  });

  /**
   * @case Enricher-shaped return is not assignable to Source
   * @preconditions direct("ep")
   * @expectedResult Type does not match Source
   */
  test("Enricher return is not assignable to Source", () => {
    const client = direct("ep");
    expectTypeOf(client).not.toMatchTypeOf<Source<unknown>>();
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
   * @case Explicit two-generic form produces Enricher<TIn, TOut>
   * @preconditions direct<{ name: string }, { result: number }>("ep")
   * @expectedResult Type matches Enricher<{ name: string }, { result: number }>
   */
  test("direct<TIn, TOut>(string) returns Enricher<TIn, TOut>", () => {
    type In = { name: string; body: string };
    type Out = { result: number; latencyMs: number };
    expectTypeOf(direct<In, Out>("ep")).toMatchTypeOf<Enricher<In, Out>>();
  });

  /**
   * @case Explicit two-generic form does not collapse to the symmetric variant
   * @preconditions direct<{ a: 1 }, { b: 2 }>("ep")
   * @expectedResult Type does not match Enricher<{ a: 1 }, { a: 1 }>
   */
  test("direct<TIn, TOut> with TIn != TOut is not assignable to Enricher<TIn, TIn>", () => {
    const client = direct<{ a: 1 }, { b: 2 }>("ep");
    expectTypeOf(client).not.toMatchTypeOf<Enricher<{ a: 1 }, { a: 1 }>>();
  });

  /**
   * @case Function-form endpoint still resolves to the symmetric overload
   * @preconditions direct((ex) => "ep") with Exchange<X>
   * @expectedResult Type matches Enricher<X, X>
   */
  test("direct(function) still returns Enricher<T, T>", () => {
    type X = { id: string };
    expectTypeOf(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- param only for type
      direct((_ex: { body: X; headers: Record<string, unknown> }) => "ep"),
    ).toMatchTypeOf<Enricher<X, X>>();
  });

  /**
   * @case Explicit two-generic form accepts a function endpoint
   * @preconditions direct<TIn, TOut>((ex: Exchange<TIn>) => "ep")
   * @expectedResult Type matches Enricher<TIn, TOut>
   */
  test("direct<TIn, TOut>(function) returns Enricher<TIn, TOut>", () => {
    type In = { kind: "lookup"; id: string };
    type Out = { found: boolean; value: number };
    expectTypeOf(
      direct<In, Out>(
        // eslint-disable-next-line @typescript-eslint/no-unused-vars -- param only for type
        (_ex: { body: In; headers: Record<string, unknown> }) => "ep",
      ),
    ).toMatchTypeOf<Enricher<In, Out>>();
  });

  /**
   * @case .enrich(direct<TIn, TOut>(...)) with the aggregator omitted replaces the body with TOut
   * @preconditions Builder chain: from(simple<TIn>(...)).enrich(direct<TIn, TOut>("ep")).tap(...)
   * @expectedResult The tap's exchange.body type is TOut, not TIn & TOut
   */
  test(".enrich(direct<TIn, TOut>(string)) replaces downstream body with TOut", () => {
    type In = { query: string };
    type Out = { answer: string; tokens: number };

    craft()
      .id("type-test-caller")
      .from(simple<In>({ query: "hi" }))
      .enrich(direct<In, Out>("type-test-callee"))
      .tap((ex) => {
        // Aggregator omitted = replace: the body becomes the callee's output.
        expectTypeOf(ex.body).toEqualTypeOf<Out>();
      });
  });
});
