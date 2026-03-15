import { describe, test, expectTypeOf } from "vitest";
import { craft, simple, only, type HeaderValue } from "../src/index.ts";

/**
 * End-to-end type-level tests for header propagation through the builder chain.
 *
 * Each test builds a route and asserts the exchange headers type at every step.
 * If typecheck passes, the propagation is correct.
 * TypeScript evaluates expectTypeOf() at compile time, so these are type tests,
 * not runtime tests.
 */
describe("header propagation through full builder chain", () => {
  /**
   * @case from() seeds empty headers; no keys are pre-typed
   * @preconditions craft().from(source) with no .header() calls
   * @expectedResult exchange.headers inside process() does not expose arbitrary string keys
   */
  test("from() seeds empty headers -- no untracked keys pre-typed", () => {
    craft()
      .from(simple("test"))
      .process((exchange) => {
        // Framework headers are always accessible
        expectTypeOf(exchange.headers["routecraft.route"]).toExtend<
          HeaderValue | undefined
        >();
        // Untracked user keys must NOT be typed as HeaderValue
        expectTypeOf<(typeof exchange)["headers"]>().not.toExtend<{
          "x-untracked": HeaderValue;
        }>();
        return exchange;
      });
  });

  /**
   * @case .header() accumulates into H; subsequent steps see the key
   * @preconditions .header('x-a', ...).header('x-b', ...)
   * @expectedResult both x-a and x-b are HeaderValue inside process(); x-unknown is not
   */
  test("accumulated .header() keys flow into process() exchange", () => {
    craft()
      .from(simple("test"))
      .header("x-a", "val-a")
      .header("x-b", "val-b")
      .process((exchange) => {
        expectTypeOf(exchange.headers["x-a"]).toEqualTypeOf<HeaderValue>();
        expectTypeOf(exchange.headers["x-b"]).toEqualTypeOf<HeaderValue>();
        expectTypeOf<(typeof exchange)["headers"]>().not.toExtend<{
          "x-unknown": HeaderValue;
        }>();
        return exchange;
      });
  });

  /**
   * @case process() preserves current Headers by default
   * @preconditions .header('x-trace').process((e) => e).filter(...)
   * @expectedResult x-trace still typed in filter callback after process()
   */
  test("process() preserves headers across body-type change", () => {
    craft()
      .from(simple("raw"))
      .header("x-trace", "abc")
      .process((exchange) => {
        return { ...exchange, body: 42 };
      })
      .filter((exchange) => {
        expectTypeOf(exchange.headers["x-trace"]).toEqualTypeOf<HeaderValue>();
        return true;
      });
  });

  /**
   * @case Complex chain: headers accumulate, survive process(), accumulate more, flow through
   *   transform and enrich(only)
   * @preconditions multi-step chain mixing .header(), .process(), .transform(), .enrich(only)
   * @expectedResult each step sees exactly the headers declared up to that point;
   *   body type evolves correctly through transform and enrich
   */
  test("headers accumulate and survive transform, process, and enrich(only)", () => {
    craft()
      .from(simple({ id: 1, name: "alice" }))
      .header("x-tenant", "acme")
      // transform changes body type; headers must survive
      .transform((body) => ({ ...body, normalized: body.name.toLowerCase() }))
      .tap((exchange) => {
        expectTypeOf(exchange.headers["x-tenant"]).toEqualTypeOf<HeaderValue>();
        expectTypeOf(exchange.body.normalized).toEqualTypeOf<string>();
        expectTypeOf<(typeof exchange)["headers"]>().not.toExtend<{
          "x-env": HeaderValue;
        }>();
      })
      .header("x-env", "prod")
      // process() changes body type; both headers survive
      .process((exchange) => {
        expectTypeOf(exchange.headers["x-tenant"]).toEqualTypeOf<HeaderValue>();
        expectTypeOf(exchange.headers["x-env"]).toEqualTypeOf<HeaderValue>();
        return { ...exchange, body: exchange.body.id };
      })
      .filter((exchange) => {
        expectTypeOf(exchange.headers["x-tenant"]).toEqualTypeOf<HeaderValue>();
        expectTypeOf(exchange.headers["x-env"]).toEqualTypeOf<HeaderValue>();
        return exchange.body > 0;
      })
      // enrich(only) merges one field from the enricher result into the body
      .enrich(
        async () => ({ score: 42, label: "high" }),
        only(
          (result: { score: number; label: string }) => result.score,
          "score",
        ),
      )
      .tap((exchange) => {
        // Body now carries score
        expectTypeOf(exchange.body.score).toEqualTypeOf<number>();
        // Headers survive enrich unchanged
        expectTypeOf(exchange.headers["x-tenant"]).toEqualTypeOf<HeaderValue>();
        expectTypeOf(exchange.headers["x-env"]).toEqualTypeOf<HeaderValue>();
      })
      .header("x-scored", "yes")
      .tap((exchange) => {
        expectTypeOf(exchange.headers["x-tenant"]).toEqualTypeOf<HeaderValue>();
        expectTypeOf(exchange.headers["x-env"]).toEqualTypeOf<HeaderValue>();
        expectTypeOf(exchange.headers["x-scored"]).toEqualTypeOf<HeaderValue>();
        expectTypeOf<(typeof exchange)["headers"]>().not.toExtend<{
          "x-ghost": HeaderValue;
        }>();
      });
  });

  /**
   * @case Headers are preserved across split and aggregate
   * @preconditions .header('x-trace', ...).split().aggregate()
   * @expectedResult aggregate result still has x-trace tracked
   */
  test("headers preserved across split and aggregate", () => {
    craft()
      .from(simple([1, 2, 3]))
      .header("x-trace", "123")
      .split()
      .aggregate()
      .process((exchange) => {
        expectTypeOf(exchange.headers["x-trace"]).toEqualTypeOf<HeaderValue>();
        return exchange;
      });
  });
});
