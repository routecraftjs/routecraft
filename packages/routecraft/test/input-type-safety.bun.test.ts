import { describe, expectTypeOf, test } from "bun:test";
import { z } from "zod";
import { craft, simple } from "@routecraft/routecraft";
import { direct } from "../src/adapters/direct/index.ts";

const QuerySchema = z.object({ query: z.string(), limit: z.number() });
type Query = z.infer<typeof QuerySchema>;

/**
 * Type-level tests: `.input({ body: schema })` retypes the pre-from builder
 * so an untyped source (`direct()` is `Source<unknown>`) no longer forces
 * the duplicated `.from<T>()` generic. Typed sources and explicit generics
 * still win; staging a new route resets the bag.
 */
describe("Route .input() body type inference", () => {
  /**
   * @case .input({ body }) narrows .from(direct()) without a generic
   * @preconditions craft().input({ body: QuerySchema }).from(direct())
   * @expectedResult Pipeline steps see the schema's inferred output type
   */
  test("input bundle narrows an untyped source", () => {
    craft()
      .id("typed-bundle")
      .input({ body: QuerySchema })
      .from(direct())
      .transform((body) => {
        expectTypeOf(body).toEqualTypeOf<Query>();
        return body;
      });
  });

  /**
   * @case Bare-schema shorthand narrows the chain the same way
   * @preconditions craft().input(QuerySchema).from(direct())
   * @expectedResult Pipeline steps see the schema's inferred output type
   */
  test("bare schema shorthand narrows an untyped source", () => {
    craft()
      .id("typed-bare")
      .input(QuerySchema)
      .from(direct())
      .transform((body) => {
        expectTypeOf(body).toEqualTypeOf<Query>();
        return body;
      });
  });

  /**
   * @case Explicit .from<T>() generic still overrides the declared input
   * @preconditions .input({ body: QuerySchema }).from<{ q: string }>(direct())
   * @expectedResult Pipeline steps see the explicit generic, not the schema
   */
  test("explicit from generic overrides the declared input", () => {
    craft()
      .id("explicit-generic")
      .input({ body: QuerySchema })
      .from<{ q: string }>(direct())
      .transform((body) => {
        expectTypeOf(body).toEqualTypeOf<{ q: string }>();
        return body;
      });
  });

  /**
   * @case A typed source wins over the declared input
   * @preconditions .input({ body: QuerySchema }).from(simple("greeting"))
   * @expectedResult Pipeline steps see the source's body type (string)
   */
  test("typed source wins over the declared input", () => {
    craft()
      .id("typed-source")
      .input({ body: QuerySchema })
      .from(simple("greeting"))
      .transform((body) => {
        expectTypeOf(body).toEqualTypeOf<string>();
        return body;
      });
  });

  /**
   * @case Headers-only .input() does not retype the chain
   * @preconditions .input({ headers: schema }).from(direct())
   * @expectedResult Pipeline steps still see unknown
   */
  test("headers-only input leaves the body unknown", () => {
    craft()
      .id("headers-only")
      .input({ headers: z.object({ "x-tenant": z.string() }) })
      .from(direct())
      .transform((body) => {
        expectTypeOf(body).toEqualTypeOf<unknown>();
        return body;
      });
  });

  /**
   * @case No .input() keeps the pre-existing unknown behaviour
   * @preconditions craft().from(direct()) with no declared input
   * @expectedResult Pipeline steps see unknown
   */
  test("no input keeps an untyped source unknown", () => {
    craft()
      .id("no-input")
      .from(direct())
      .transform((body) => {
        expectTypeOf(body).toEqualTypeOf<unknown>();
        return body;
      });
  });

  /**
   * @case Multi-source .from() inherits the declared input type
   * @preconditions .input({ body: QuerySchema }).from(direct(), direct())
   * @expectedResult Pipeline steps see the schema's inferred output type
   */
  test("multi-source from inherits the declared input", () => {
    craft()
      .id("multi-source")
      .input({ body: QuerySchema })
      .from(direct(), direct())
      .transform((body) => {
        expectTypeOf(body).toEqualTypeOf<Query>();
        return body;
      });
  });

  /**
   * @case Staging the next route resets the declared input
   * @preconditions Route 1 declares .input(); route 2 starts via .id()
   * @expectedResult Route 2's .from(direct()) body is unknown again
   */
  test("next-route staging does not leak the declared input", () => {
    craft()
      .id("first")
      .input({ body: QuerySchema })
      .from(direct())
      .to(() => undefined)
      .id("second")
      .from(direct())
      .transform((body) => {
        expectTypeOf(body).toEqualTypeOf<unknown>();
        return body;
      });
  });
});
