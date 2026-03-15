import { describe, test, expectTypeOf } from "vitest";
import {
  craft,
  direct,
  simple,
  log,
  type Exchange,
  type HeaderValue,
  type ForwardFn,
  type RegisteredDirectEndpoint,
  type ResolveKey,
  type ResolveBody,
  type DirectEndpointRegistry,
} from "../src/index.ts";
import type { RouteBuilder } from "../src/builder.ts";
import type { RoutecraftHeaders } from "../src/exchange.ts";

/**
 * Type-level tests for the declaration merging registry system.
 *
 * These tests verify that:
 * 1. Empty registries fall back to `string` (no breaking change)
 * 2. When registries are populated via declaration merging, adapter
 *    parameters are constrained to registered keys
 * 3. Header tracking accumulates through the builder chain
 */

// -- Phase 1: Registry tests (empty registries = string fallback) --

describe("Type registries: empty registry fallback", () => {
  /**
   * @case ResolveKey returns string when registry is empty
   * @preconditions DirectEndpointRegistry has no augmentation in this file
   * @expectedResult ResolveKey<DirectEndpointRegistry> equals string
   */
  test("ResolveKey<EmptyRegistry> resolves to string", () => {
    expectTypeOf<ResolveKey<DirectEndpointRegistry>>().toEqualTypeOf<string>();
  });

  /**
   * @case RegisteredDirectEndpoint is string when registry is empty
   * @preconditions No declaration merging for DirectEndpointRegistry
   * @expectedResult RegisteredDirectEndpoint equals string
   */
  test("RegisteredDirectEndpoint is string when registry is empty", () => {
    expectTypeOf<RegisteredDirectEndpoint>().toEqualTypeOf<string>();
  });

  /**
   * @case direct() accepts any string when registry is empty
   * @preconditions No declaration merging
   * @expectedResult direct("anything", {}) compiles
   */
  test("direct() accepts any string when registry is empty", () => {
    expectTypeOf(direct("anything", {})).toMatchTypeOf<unknown>();
    expectTypeOf(direct("literally-anything")).toMatchTypeOf<unknown>();
  });

  /**
   * @case ForwardFn accepts any string endpoint when registry is empty
   * @preconditions No declaration merging
   * @expectedResult ForwardFn first param is string
   */
  test("ForwardFn accepts any string when registry is empty", () => {
    expectTypeOf<ForwardFn>().toBeFunction();
    type FirstParam = Parameters<ForwardFn>[0];
    expectTypeOf<FirstParam>().toEqualTypeOf<string>();
  });
});

// -- Phase 1b: ResolveBody utility type --

describe("ResolveBody utility type", () => {
  /**
   * @case ResolveBody falls back to Fallback when registry is empty
   * @preconditions DirectEndpointRegistry has no augmentation in this file
   * @expectedResult ResolveBody<DirectEndpointRegistry, 'anything'> equals unknown
   */
  test("ResolveBody returns unknown when registry is empty", () => {
    expectTypeOf<
      ResolveBody<DirectEndpointRegistry, "anything">
    >().toEqualTypeOf<unknown>();
  });

  /**
   * @case ResolveBody returns custom fallback when registry is empty
   * @preconditions DirectEndpointRegistry has no augmentation
   * @expectedResult ResolveBody<DirectEndpointRegistry, 'x', string> equals string
   */
  test("ResolveBody respects custom fallback when registry is empty", () => {
    expectTypeOf<
      ResolveBody<DirectEndpointRegistry, "x", string>
    >().toEqualTypeOf<string>();
  });

  /**
   * @case ResolveBody resolves body type from populated registry
   * @preconditions Inline registry type with known keys
   * @expectedResult Matching key returns mapped type; unregistered key returns unknown
   */
  test("ResolveBody resolves known key from populated registry", () => {
    type TestRegistry = {
      payments: { amount: number };
      orders: { id: string };
    };
    expectTypeOf<ResolveBody<TestRegistry, "payments">>().toEqualTypeOf<{
      amount: number;
    }>();
    expectTypeOf<ResolveBody<TestRegistry, "orders">>().toEqualTypeOf<{
      id: string;
    }>();
    expectTypeOf<
      ResolveBody<TestRegistry, "unknown-key">
    >().toEqualTypeOf<unknown>();
  });
});

// -- Phase 1c: to() preserves body when destination returns void --

describe("to() body type preservation", () => {
  /**
   * @case to() with void destination preserves Current body type
   * @preconditions .from(simple("test")).to(sideEffect)
   * @expectedResult RouteBuilder<string, ...> (not RouteBuilder<void, ...>)
   */
  test("to() with void callback preserves body type", () => {
    const route = craft()
      .from(simple("test"))
      .to(() => {
        /* side effect */
      });
    expectTypeOf(route).toEqualTypeOf<
      RouteBuilder<string, Partial<RoutecraftHeaders>>
    >();
  });

  /**
   * @case to() with non-void destination replaces body type
   * @preconditions .from(simple("test")).to(() => 42)
   * @expectedResult RouteBuilder<number, ...>
   */
  test("to() with non-void callback replaces body type", () => {
    const route = craft()
      .from(simple("test"))
      .to(() => 42);
    expectTypeOf(route).toEqualTypeOf<
      RouteBuilder<number, Partial<RoutecraftHeaders>>
    >();
  });

  /**
   * @case chaining after void to() retains original body type
   * @preconditions .from(simple("test")).to(log()).transform(...)
   * @expectedResult transform receives string, not void
   */
  test("chaining after void to() retains original body", () => {
    craft()
      .from(simple("test"))
      .to(() => {})
      .transform((body) => {
        expectTypeOf(body).toEqualTypeOf<string>();
        return body.toUpperCase();
      });
  });
});

// -- Phase 2: Header tracking tests --

describe("Header type tracking through builder chain", () => {
  /**
   * @case Exchange with default H allows any header key
   * @preconditions Exchange<string> with default H parameter
   * @expectedResult headers allows arbitrary string keys
   */
  test("Exchange<T> with default H allows any header key", () => {
    type DefaultExchange = Exchange<string>;
    type Headers = DefaultExchange["headers"];
    expectTypeOf<Headers>().toMatchTypeOf<Record<string, HeaderValue>>();
  });

  /**
   * @case Exchange with specific H only allows known keys
   * @preconditions Exchange<string, { 'x-foo': HeaderValue }>
   * @expectedResult headers['x-foo'] is HeaderValue; untracked keys are not in the type
   */
  test("Exchange<T, H> with specific H narrows header keys", () => {
    type NarrowExchange = Exchange<string, { "x-foo": HeaderValue }>;
    type Headers = NarrowExchange["headers"];
    expectTypeOf<Headers["x-foo"]>().toEqualTypeOf<HeaderValue>();
    // Untracked keys must not be typed as HeaderValue -- this catches regressions where
    // the builder seeds headers too wide (e.g. Record<string, HeaderValue>).
    expectTypeOf<Headers>().not.toMatchTypeOf<{ "x-unknown": HeaderValue }>();
  });

  /**
   * @case .header() accumulates into the Headers type parameter
   * @preconditions craft().from(source).header('x-foo', 'bar')
   * @expectedResult RouteBuilder carries the header in its type
   */
  test(".header() adds key to tracked headers", () => {
    const builder = craft().from(simple("test")).header("x-foo", "bar");

    // After .header('x-foo', 'bar'), the builder should track x-foo.
    // We verify by chaining .process() and checking the exchange type.
    builder.process((exchange) => {
      // x-foo should be accessible
      expectTypeOf(exchange.headers["x-foo"]).toEqualTypeOf<HeaderValue>();
      return exchange;
    });
  });

  /**
   * @case Multiple .header() calls accumulate
   * @preconditions craft().from(source).header('x-a', 'a').header('x-b', 'b')
   * @expectedResult Both x-a and x-b are tracked
   */
  test("multiple .header() calls accumulate types", () => {
    craft()
      .from(simple("test"))
      .header("x-a", "val-a")
      .header("x-b", "val-b")
      .process((exchange) => {
        expectTypeOf(exchange.headers["x-a"]).toEqualTypeOf<HeaderValue>();
        expectTypeOf(exchange.headers["x-b"]).toEqualTypeOf<HeaderValue>();
        return exchange;
      });
  });

  /**
   * @case Headers are preserved across .process()
   * @preconditions .header('x-foo', ...).process(...).filter(...)
   * @expectedResult filter callback still sees x-foo
   */
  test("headers preserved across process and filter", () => {
    craft()
      .from(simple("test"))
      .header("x-trace", "abc")
      .process((exchange) => {
        expectTypeOf(exchange.headers["x-trace"]).toEqualTypeOf<HeaderValue>();
        return exchange;
      })
      .filter((exchange) => {
        expectTypeOf(exchange.headers["x-trace"]).toEqualTypeOf<HeaderValue>();
        return true;
      });
  });

  /**
   * @case Headers are preserved across .transform()
   * @preconditions .header('x-foo', ...).transform(...).tap(...)
   * @expectedResult tap callback still sees x-foo
   */
  test("headers preserved across transform", () => {
    craft()
      .from(simple("test"))
      .header("x-env", "prod")
      .transform((body) => ({ value: body }))
      .tap((exchange) => {
        expectTypeOf(exchange.headers["x-env"]).toEqualTypeOf<HeaderValue>();
      });
  });

  /**
   * @case Headers are preserved across .to()
   * @preconditions .header('x-foo', ...).to(log())
   * @expectedResult Builder still carries headers after to
   */
  test("headers preserved across to", () => {
    craft()
      .from(simple("test"))
      .header("x-foo", "bar")
      .to((exchange) => {
        expectTypeOf(exchange.headers["x-foo"]).toEqualTypeOf<HeaderValue>();
      })
      .to(log());
  });

  /**
   * @case Framework headers (RoutecraftHeaders) are always accessible
   * @preconditions Exchange with specific H
   * @expectedResult routecraft.operation, routecraft.route, routecraft.correlation_id available
   */
  test("framework headers always accessible regardless of H", () => {
    craft()
      .from(simple("test"))
      .header("x-custom", "val")
      .process((exchange) => {
        // Framework headers should always be available
        expectTypeOf(exchange.headers["routecraft.operation"]).toMatchTypeOf<
          HeaderValue | undefined
        >();
        expectTypeOf(exchange.headers["routecraft.route"]).toMatchTypeOf<
          HeaderValue | undefined
        >();
        expectTypeOf(
          exchange.headers["routecraft.correlation_id"],
        ).toMatchTypeOf<HeaderValue | undefined>();
        return exchange;
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
