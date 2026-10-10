import { describe, expectTypeOf, test } from "bun:test";
import { craft, simple } from "../src/index.ts";
import type { Destination, Enricher, Exchange } from "../src/index.ts";
import { expectBodyOf } from "./helpers/types.ts";

/**
 * A fetch-only factory whose body type parameter has no inference site
 * other than the contextual return type, the shape of `llm()`, `agent()`
 * and `embedding()`.
 */
function lookup<T = unknown>(options: {
  key: (exchange: Exchange<T>) => string;
}): Enricher<T, { found: boolean }> {
  return {
    fetch: async (exchange) => ({ found: options.key(exchange) !== "" }),
  };
}

/** The same factory shape with both slots, as `file()` and `http()` have. */
function store<T = unknown>(options: {
  key: (exchange: Exchange<T>) => string;
}): Destination<T> & Enricher<T, { found: boolean }> {
  return {
    send: async () => {},
    fetch: async (exchange) => ({ found: options.key(exchange) !== "" }),
  };
}

/**
 * Type-level tests: `.to()` resolves a fetch-only adapter through the
 * Enricher overload first, so the route's body type reaches the factory's
 * callbacks without a type argument, while a dual-role adapter still lands
 * on the Destination overload (#694).
 */
describe(".to() overload resolution type safety", () => {
  /**
   * @case A fetch-only adapter in .to() infers its body type from the route
   * @preconditions from(simple({ id })) then .to(lookup({ key: (ex) => ex.body.id })) with no type argument
   * @expectedResult The callback reads `body.id` as a string and the fetched value replaces the body
   */
  test("fetch-only adapter in to() infers the body from the route", () => {
    const route = craft()
      .from(simple({ id: "a" }))
      .to(
        lookup({
          key: (exchange) => {
            expectTypeOf(exchange.body).toEqualTypeOf<{ id: string }>();
            return exchange.body.id;
          },
        }),
      );
    expectBodyOf(route).toEqualTypeOf<{ found: boolean }>();
  });

  /**
   * @case A dual-role adapter in .to() keeps the body: send wins
   * @preconditions from(simple({ id })) then .to(store({ key: (ex) => ex.body.id })) with no type argument
   * @expectedResult The callback still reads `body.id`, and the body type is unchanged after the step
   */
  test("dual-role adapter in to() keeps the body and still types its callback", () => {
    const route = craft()
      .from(simple({ id: "a" }))
      .to(
        store({
          key: (exchange) => {
            expectTypeOf(exchange.body).toEqualTypeOf<{ id: string }>();
            return exchange.body.id;
          },
        }),
      );
    expectBodyOf(route).toEqualTypeOf<{ id: string }>();
  });

  /**
   * @case The same fetch-only adapter through .enrich() agrees with .to()
   * @preconditions from(simple({ id })) then .enrich(lookup({ key }))
   * @expectedResult Both operations give the callback the route body and replace the body with the fetched value
   */
  test("to() and enrich() agree for a fetch-only adapter", () => {
    const route = craft()
      .from(simple({ id: "a" }))
      .enrich(lookup({ key: (exchange) => exchange.body.id }));
    expectBodyOf(route).toEqualTypeOf<{ found: boolean }>();
  });

  /**
   * @case The function forms of .to() are unaffected by the overload order
   * @preconditions from(simple("data")) then .to(fn) returning a value, void, and a Promise<void>
   * @expectedResult A returned value replaces the body; a void or Promise<void> return keeps it
   */
  test("callable to() forms keep their return-type routing", () => {
    const replaced = craft()
      .from(simple("data"))
      .to((exchange) => exchange.body.length);
    expectBodyOf(replaced).toEqualTypeOf<number>();

    const kept = craft()
      .from(simple("data"))
      .to((exchange) => {
        void exchange;
      });
    expectBodyOf(kept).toEqualTypeOf<string>();

    const keptAsync = craft()
      .from(simple("data"))
      .to(async (exchange) => {
        void exchange;
      });
    expectBodyOf(keptAsync).toEqualTypeOf<string>();
  });
});
