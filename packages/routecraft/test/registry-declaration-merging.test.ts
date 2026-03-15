import { describe, test, expectTypeOf } from "vitest";
import {
  direct,
  type Destination,
  type ForwardFn,
  type RegisteredDirectEndpoint,
  type ResolveKey,
  type DirectEndpointRegistry,
} from "../src/index.ts";

/**
 * Augment the DirectEndpointRegistry via declaration merging.
 * This is the public API surface users will use to register endpoints.
 *
 * NOTE: This file is intentionally separate from registry-type-safety.test.ts
 * so that the augmentation does not pollute the empty-registry fallback tests.
 */
declare module "../src/index.ts" {
  interface DirectEndpointRegistry {
    "/payments": { amount: number };
    "/orders": { id: string };
  }
}

describe("Declaration merging: DirectEndpointRegistry", () => {
  /**
   * @case ResolveKey narrows to registered keys after augmentation
   * @preconditions DirectEndpointRegistry augmented with '/payments' and '/orders'
   * @expectedResult ResolveKey<DirectEndpointRegistry> equals '/payments' | '/orders'
   */
  test("ResolveKey resolves to registered key union", () => {
    expectTypeOf<ResolveKey<DirectEndpointRegistry>>().toEqualTypeOf<
      "/payments" | "/orders"
    >();
  });

  /**
   * @case RegisteredDirectEndpoint reflects augmented registry
   * @preconditions DirectEndpointRegistry augmented
   * @expectedResult RegisteredDirectEndpoint equals '/payments' | '/orders'
   */
  test("RegisteredDirectEndpoint matches augmented keys", () => {
    expectTypeOf<RegisteredDirectEndpoint>().toEqualTypeOf<
      "/payments" | "/orders"
    >();
  });

  /**
   * @case direct(endpoint) as destination constrains to registered keys
   * @preconditions DirectEndpointRegistry augmented
   * @expectedResult direct('/payments') compiles, return type is Destination
   */
  test("direct() constrains endpoint to registered keys", () => {
    expectTypeOf(direct("/payments")).toEqualTypeOf<
      Destination<{ amount: number }, unknown>
    >();
    expectTypeOf(direct("/orders")).toEqualTypeOf<
      Destination<{ id: string }, unknown>
    >();
  });

  /**
   * @case ForwardFn first parameter is constrained to registered keys
   * @preconditions DirectEndpointRegistry augmented
   * @expectedResult ForwardFn first param equals '/payments' | '/orders'
   */
  test("ForwardFn parameter is constrained to registered keys", () => {
    type FirstParam = Parameters<ForwardFn>[0];
    expectTypeOf<FirstParam>().toEqualTypeOf<"/payments" | "/orders">();
  });
});
