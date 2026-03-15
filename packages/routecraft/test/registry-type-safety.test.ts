import { describe, test, expectTypeOf } from "vitest";
import {
  craft,
  direct,
  simple,
  type Exchange,
  type HeaderValue,
  type ForwardFn,
  type RegisteredDirectEndpoint,
  type ResolveKey,
  type ResolveBody,
  type DirectEndpointRegistry,
} from "../src/index.ts";
import type { RouteBuilder } from "../src/builder.ts";

/**
 * Type-level tests for the declaration merging registry system.
 *
 * These tests verify that:
 * 1. Empty registries fall back to `string` (no breaking change)
 * 2. When registries are populated via declaration merging, adapter
 *    parameters are constrained to registered keys
 * 3. ResolveBody resolves body types from populated registries
 * 4. to() preserves body type when destination returns void
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

// -- Phase 2: ResolveBody utility type --

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

// -- Phase 3: to() preserves body when destination returns void --

describe("to() body type preservation", () => {
  /**
   * @case to() with void destination preserves Current body type
   * @preconditions .from(simple("test")).to(sideEffect)
   * @expectedResult RouteBuilder<string> (not RouteBuilder<void>)
   */
  test("to() with void callback preserves body type", () => {
    const route = craft()
      .from(simple("test"))
      .to(() => {
        /* side effect */
      });
    expectTypeOf(route).toEqualTypeOf<RouteBuilder<string>>();
  });

  /**
   * @case to() with non-void destination replaces body type
   * @preconditions .from(simple("test")).to(() => 42)
   * @expectedResult RouteBuilder<number>
   */
  test("to() with non-void callback replaces body type", () => {
    const route = craft()
      .from(simple("test"))
      .to(() => 42);
    expectTypeOf(route).toEqualTypeOf<RouteBuilder<number>>();
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

// -- Phase 4: Exchange defaults --

describe("Exchange type defaults", () => {
  /**
   * @case Exchange with default headers allows any header key
   * @preconditions Exchange<string> with default ExchangeHeaders
   * @expectedResult headers allows arbitrary string keys
   */
  test("Exchange<T> headers allows any header key", () => {
    type DefaultHeaders = Exchange<string>["headers"];
    expectTypeOf<DefaultHeaders>().toMatchTypeOf<Record<string, HeaderValue>>();
  });
});
