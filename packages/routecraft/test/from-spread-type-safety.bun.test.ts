import { describe, expect, expectTypeOf, test } from "bun:test";
import { z } from "zod";
import {
  craft,
  simple,
  type SourceLike,
  type SourceList,
} from "../src/index.ts";
import { direct } from "../src/adapters/direct/index.ts";
import type { RouteBuilder } from "../src/builder.ts";

/**
 * Type-level tests: `.from()` accepts sources spread in after a leading
 * source, or spread on their own from a `SourceList`, while the
 * single-source overload keeps inferring the body exactly as before. An
 * empty or possibly-empty source list stays a compile error.
 *
 * A multi-source chain without `.input()` is refused at runtime with
 * RC2001, so those chains sit inside a function that is never called and
 * the assertion reads its return type through `.returns`.
 */
describe(".from() spread type safety", () => {
  const querySchema = z.object({ userId: z.string() });
  type Query = z.infer<typeof querySchema>;
  type Order = { orderId: string };

  const extra: SourceLike<unknown>[] = [direct(), simple({ userId: "u1" })];

  function ingresses(): SourceList {
    return [direct(), simple({ userId: "u1" })];
  }

  /**
   * @case A leading source followed by a spread plain array
   * @preconditions from(direct(), ...extra) where extra is SourceLike<unknown>[]; with and without .input()
   * @expectedResult Without .input() the body is unknown; after .input(schema) it is Query
   */
  test("leading source plus plain array spread compiles on both builders", () => {
    const open = () =>
      craft()
        .id("lead")
        .from(direct(), ...extra);
    const typed = craft()
      .id("typed-lead")
      .input(querySchema)
      .from(direct(), ...extra);
    expectTypeOf(open).returns.toEqualTypeOf<
      RouteBuilder<{ body: unknown; deferral?: unknown }>
    >();
    expectTypeOf(typed).toEqualTypeOf<
      RouteBuilder<{ body: Query; deferral?: unknown }>
    >();
  });

  /**
   * @case A helper returning a non-empty tuple is spread on its own
   * @preconditions from(...ingresses()) where ingresses returns SourceList; with and without .input()
   * @expectedResult Without .input() the body is unknown; after .input({ body }) it is Query
   */
  test("non-empty tuple helper spread compiles on both builders", () => {
    const open = () =>
      craft()
        .id("helper")
        .from(...ingresses());
    const typed = craft()
      .id("typed-helper")
      .input({ body: querySchema })
      .from(...ingresses());
    expectTypeOf(open).returns.toEqualTypeOf<
      RouteBuilder<{ body: unknown; deferral?: unknown }>
    >();
    expectTypeOf(typed).toEqualTypeOf<
      RouteBuilder<{ body: Query; deferral?: unknown }>
    >();
  });

  /**
   * @case Explicit from<T>() generic with a spread
   * @preconditions from<Order>(...ingresses()) without .input(), and from<Order>(direct(), ...extra) after a typed .input()
   * @expectedResult Both chains carry body Order; the generic overrides the staged schema type
   */
  test("explicit generic applies to a spread", () => {
    const open = () =>
      craft()
        .id("generic")
        .from<Order>(...ingresses());
    const overridden = craft()
      .id("generic-typed")
      .input(querySchema)
      .from<Order>(direct(), ...extra);
    expectTypeOf(open).returns.toEqualTypeOf<
      RouteBuilder<{ body: Order; deferral?: unknown }>
    >();
    expectTypeOf(overridden).toEqualTypeOf<
      RouteBuilder<{ body: Order; deferral?: unknown }>
    >();
  });

  /**
   * @case Spreading an `as const` tuple keeps compiling
   * @preconditions Two-element tuple spread, and a one-element tuple of simple({ id: 0 })
   * @expectedResult Two elements give an unknown body; one element resolves to the
   *   single-source overload and infers { id: number }
   */
  test("tuple spread still compiles and a one-tuple still infers", () => {
    const pair = [direct(), simple({ id: 0 })] as const;
    const single = [simple({ id: 0 })] as const;
    const openPair = () =>
      craft()
        .id("pair")
        .from(...pair);
    const route = craft()
      .id("one")
      .from(...single);
    expectTypeOf(openPair).returns.toEqualTypeOf<
      RouteBuilder<{ body: unknown; deferral?: unknown }>
    >();
    expectTypeOf(route).toEqualTypeOf<
      RouteBuilder<{ body: { id: number }; deferral?: unknown }>
    >();
  });

  /**
   * @case Single-source inference is unchanged by the spread overload
   * @preconditions from(simple({ id: 0 })) and from<Order>(direct())
   * @expectedResult Bodies are { id: number } and Order respectively
   */
  test("single-source inference is unchanged", () => {
    const inferred = craft()
      .id("inferred")
      .from(simple({ id: 0 }));
    const explicit = craft().id("explicit").from<Order>(direct());
    expectTypeOf(inferred).toEqualTypeOf<
      RouteBuilder<{ body: { id: number }; deferral?: unknown }>
    >();
    expectTypeOf(explicit).toEqualTypeOf<
      RouteBuilder<{ body: Order; deferral?: unknown }>
    >();
  });

  /**
   * @case An array passed without a spread is one Iterable source
   * @preconditions from([1, 2]) with no spread
   * @expectedResult RouteBuilder<{ body: number; deferral?: unknown }>: each element is a body, not a source
   */
  test("an unspread array is a single iterable source", () => {
    const route = craft().id("iterable").from([1, 2]);
    expectTypeOf(route).toEqualTypeOf<
      RouteBuilder<{ body: number; deferral?: unknown }>
    >();
  });

  /**
   * @case A possibly-empty source list is refused at compile time
   * @preconditions from() and from(...extra) with a plain array, on RouteBuilder and after .input()
   * @expectedResult Each call is a type error; the functions are never called, since every one would throw RC2001
   */
  test("empty and plain-array-only source lists do not compile", () => {
    const typed = () => craft().input(querySchema);
    const rejected = [
      // @ts-expect-error a route needs at least one source
      () => craft().from(),
      // @ts-expect-error a plain array may be empty, so it cannot be the only argument
      () => craft().from(...extra),
      // @ts-expect-error a route needs at least one source, with or without .input()
      () => typed().from(),
      // @ts-expect-error a plain array may be empty, with or without .input()
      () => typed().from(...extra),
    ];
    expect(rejected).toHaveLength(4);
  });
});
