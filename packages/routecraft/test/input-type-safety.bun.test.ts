import { describe, expectTypeOf, test } from "bun:test";
import { z } from "zod";
import { craft, simple } from "../src/index.ts";
import { direct } from "../src/adapters/direct/index.ts";
import type { RouteBuilder } from "../src/builder.ts";

/**
 * Type-level tests: `.input()` with a body schema retypes the pre-from
 * chain so `.from(source)` opens the pipeline with the schema's inferred
 * output type, without a duplicated `.from<T>()` generic (#421).
 */
describe(".input() retyping type safety", () => {
  const querySchema = z.object({ userId: z.string(), limit: z.number() });
  type Query = z.infer<typeof querySchema>;

  /**
   * @case .input({ body: schema }).from(direct()) seeds body from the schema
   * @preconditions Body schema in bundle form, untyped direct() source
   * @expectedResult RouteBuilder<{ body: Query }> with no .from<T>() generic
   */
  test("input({ body }) types the following from()", () => {
    const route = craft()
      .id("typed-bundle")
      .input({ body: querySchema })
      .from(direct());
    expectTypeOf(route).toEqualTypeOf<RouteBuilder<{ body: Query }>>();
  });

  /**
   * @case .input(schema) bare-schema shorthand also retypes the chain
   * @preconditions Bare Standard Schema (body-only shorthand)
   * @expectedResult RouteBuilder<{ body: Query }>
   */
  test("input(bareSchema) types the following from()", () => {
    const route = craft().id("typed-bare").input(querySchema).from(direct());
    expectTypeOf(route).toEqualTypeOf<RouteBuilder<{ body: Query }>>();
  });

  /**
   * @case Explicit .from<T>() generic overrides the staged schema type
   * @preconditions Typed .input() followed by .from<Override>(direct())
   * @expectedResult RouteBuilder<{ body: Override }>
   */
  test("explicit from<T>() overrides the staged type", () => {
    type Override = { raw: string };
    const route = craft()
      .id("typed-override")
      .input({ body: querySchema })
      .from<Override>(direct());
    expectTypeOf(route).toEqualTypeOf<RouteBuilder<{ body: Override }>>();
  });

  /**
   * @case Staging calls after a typed .input() keep the staged body type
   * @preconditions .input({ body }) then .description() then .from(direct())
   * @expectedResult RouteBuilder<{ body: Query }>; staging does not erase it
   */
  test("staging methods preserve the staged type", () => {
    const route = craft()
      .id("typed-staged")
      .input({ body: querySchema })
      .description("keeps the schema type")
      .tag("read-only")
      .from(direct());
    expectTypeOf(route).toEqualTypeOf<RouteBuilder<{ body: Query }>>();
  });

  /**
   * @case Multi-ingress .from(a, b) after typed .input() shares the body type
   * @preconditions .input(schema) then .from(direct(), direct())
   * @expectedResult RouteBuilder<{ body: Query }> without an explicit generic
   */
  test("multi-source from() after input() is typed", () => {
    const route = craft()
      .id("typed-multi")
      .input(querySchema)
      .from(direct(), direct());
    expectTypeOf(route).toEqualTypeOf<RouteBuilder<{ body: Query }>>();
  });

  /**
   * @case .input({ headers }) without a body schema does not retype
   * @preconditions Headers-only schema bundle, source with a concrete type
   * @expectedResult Body type still flows from the source adapter
   */
  test("headers-only input() leaves source inference intact", () => {
    const route = craft()
      .id("headers-only")
      .input({ headers: z.object({ "x-tenant": z.string() }) })
      .from(simple({ id: 0 }));
    expectTypeOf(route).toEqualTypeOf<RouteBuilder<{ body: { id: number } }>>();
  });

  /**
   * @case Downstream steps see the schema output type on the body
   * @preconditions Typed .input() and a .transform() reading the body
   * @expectedResult The transform callback's body parameter is Query
   */
  test("transform after typed input() sees the schema output", () => {
    craft()
      .id("typed-downstream")
      .input({ body: querySchema })
      .from(direct())
      .transform((body) => {
        expectTypeOf(body).toEqualTypeOf<Query>();
        return body.userId;
      });
  });
});
