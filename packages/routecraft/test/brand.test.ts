import { describe, test, expect } from "vitest";
import {
  craft,
  simple,
  context,
  isCraftContext,
  isRoute,
  isRouteBuilder,
  isRouteDefinition,
  isRouteCraftError,
  isExchange,
  error as rcError,
} from "@routecraft/routecraft";

describe("Brand type guards (cross-instance identity)", () => {
  /**
   * @case Brand guard identifies CraftContext instance (cross-instance safe)
   * @preconditions Context built from context().routes().build()
   * @expectedResult isCraftContext true for context, false for null/plain object
   */
  test("isCraftContext returns true for CraftContext instance", async () => {
    const ctx = await context()
      .routes(
        craft()
          .from(simple(1))
          .to(() => {}),
      )
      .build();
    expect(isCraftContext(ctx)).toBe(true);
    expect(isCraftContext(null)).toBe(false);
    expect(isCraftContext({})).toBe(false);
    expect(isCraftContext(undefined)).toBe(false);
  });

  /**
   * @case Brand guard identifies DefaultRoute instance (cross-instance safe)
   * @preconditions Context started, getRoutes() returns at least one route
   * @expectedResult isRoute true for route instance, false for null/plain object
   */
  test("isRoute returns true for DefaultRoute instance", async () => {
    const ctx = await context()
      .routes(
        craft()
          .from(simple(1))
          .to(() => {}),
      )
      .build();
    await ctx.start();
    const routes = ctx.getRoutes();
    expect(routes.length).toBeGreaterThan(0);
    expect(isRoute(routes[0])).toBe(true);
    expect(isRoute(null)).toBe(false);
    expect(isRoute({})).toBe(false);
    await ctx.stop();
  });

  /**
   * @case Brand guard identifies RouteBuilder instance; plain object with .build() is not accepted
   * @preconditions craft() returns a RouteBuilder
   * @expectedResult isRouteBuilder true for builder, false for plain object
   */
  test("isRouteBuilder returns true for RouteBuilder instance", () => {
    const builder = craft();
    expect(isRouteBuilder(builder)).toBe(true);
    expect(isRouteBuilder(null)).toBe(false);
    expect(isRouteBuilder({ build: () => [] })).toBe(false); // no brand
  });

  /**
   * @case Brand guard identifies RouteDefinition from RouteBuilder.build()
   * @preconditions craft().id().from().to().build() returns RouteDefinition[]
   * @expectedResult isRouteDefinition true for first element, false for plain object
   */
  test("isRouteDefinition returns true for built route definition", async () => {
    const def = craft()
      .id("def-test")
      .from(simple(1))
      .to(() => {})
      .build();
    expect(Array.isArray(def)).toBe(true);
    expect(def.length).toBe(1);
    expect(isRouteDefinition(def[0])).toBe(true);
    expect(isRouteDefinition(null)).toBe(false);
    expect(
      isRouteDefinition({ id: "x", source: {}, steps: [], consumer: {} }),
    ).toBe(false);
  });

  /**
   * @case Brand guard identifies RouteCraftError instance (cross-instance safe)
   * @preconditions rcError() returns a RouteCraftError
   * @expectedResult isRouteCraftError true for RC error, false for plain Error
   */
  test("isRouteCraftError returns true for RouteCraftError instance", () => {
    const err = rcError("RC9901", new Error("cause"));
    expect(isRouteCraftError(err)).toBe(true);
    expect(isRouteCraftError(new Error("plain"))).toBe(false);
    expect(isRouteCraftError(null)).toBe(false);
  });

  /**
   * @case Brand guard identifies Exchange passed to .to() destination
   * @preconditions Route with .to((ex) => ...) captures exchange
   * @expectedResult isExchange true for captured exchange, false for plain object
   */
  test("isExchange returns true for exchange passed to destination", async () => {
    let captured: unknown;
    const ctx = await context()
      .routes(
        craft()
          .id("ex-test")
          .from(simple({ n: 1 }))
          .to((ex) => {
            captured = ex;
          }),
      )
      .build();
    await ctx.start();
    expect(captured).toBeDefined();
    expect(isExchange(captured)).toBe(true);
    expect(isExchange({})).toBe(false);
    await ctx.stop();
  });
});
