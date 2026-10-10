import { describe, expect, expectTypeOf, test } from "bun:test";
import {
  type AnyRouteBuilder,
  type CraftContext,
  type Exchange,
  type Route,
  type RouteDefinition,
  type Project,
  type RoutecraftError,
  craft,
  simple,
  isCraftContext,
  isRoute,
  isRouteBuilder,
  isRouteDefinition,
  isRoutecraftError,
  isExchange,
  isProject,
  rcCodeOf,
  rcError,
} from "@routecraft/routecraft";
import { testContext } from "@routecraft/testing";

describe("Brand type guards (cross-instance identity)", () => {
  /**
   * @case Brand guard identifies CraftContext instance (cross-instance safe)
   * @preconditions Context built from testContext().routes().build()
   * @expectedResult isCraftContext true for context, false for null/plain object
   */
  test("isCraftContext returns true for CraftContext instance", async () => {
    const t = await testContext()
      .routes(
        craft()
          .from(simple(1))
          .to(() => {}),
      )
      .build();
    expect(isCraftContext(t.ctx)).toBe(true);
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
    const t = await testContext()
      .routes(
        craft()
          .from(simple(1))
          .to(() => {}),
      )
      .build();
    await t.startAndWaitReady();
    const routes = t.ctx.getRoutes();
    expect(routes.length).toBeGreaterThan(0);
    expect(isRoute(routes[0])).toBe(true);
    expect(isRoute(null)).toBe(false);
    expect(isRoute({})).toBe(false);
    await t.stop();
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
      isRouteDefinition({ id: "x", sources: [], steps: [], consumer: {} }),
    ).toBe(false);
  });

  /**
   * @case Brand guard identifies RoutecraftError instance (cross-instance safe)
   * @preconditions rcError() returns a RoutecraftError
   * @expectedResult isRoutecraftError true for RC error, false for plain Error
   */
  test("isRoutecraftError returns true for RoutecraftError instance", () => {
    const err = rcError("RC9901", new Error("cause"));
    expect(isRoutecraftError(err)).toBe(true);
    expect(isRoutecraftError(new Error("plain"))).toBe(false);
    expect(isRoutecraftError(null)).toBe(false);
  });

  /**
   * @case Brand guard identifies Exchange passed to .to() destination
   * @preconditions Route with .to((ex) => ...) captures exchange
   * @expectedResult isExchange true for captured exchange, false for plain object
   */
  test("isExchange returns true for exchange passed to destination", async () => {
    let captured: unknown;
    const t = await testContext()
      .routes(
        craft()
          .id("ex-test")
          .from(simple({ n: 1 }))
          .to((ex) => {
            captured = ex;
          }),
      )
      .build();
    await t.startAndWaitReady();
    expect(captured).toBeDefined();
    expect(isExchange(captured)).toBe(true);
    expect(isExchange({})).toBe(false);
    await t.stop();
  });

  /**
   * @case The guards narrow, so a caller reads the branded fields without a cast
   * @preconditions A RoutecraftError built by rcError, checked through isRoutecraftError
   * @expectedResult `rc` and `meta.message` are readable on the narrowed value, and
   *   rcCodeOf agrees with the field it reads
   */
  test("isRoutecraftError narrows to RoutecraftError", () => {
    const err: unknown = rcError("RC5001", undefined, { message: "boom" });
    if (!isRoutecraftError(err)) throw new Error("expected a RoutecraftError");
    expect(err.rc).toBe("RC5001");
    expect(err.meta.message).toBe("boom");
    expect(rcCodeOf(err)).toBe(err.rc);
  });

  /**
   * @case Each guard narrows its argument to the type its brand stands for
   * @preconditions An `unknown` value checked by each of the seven guards in turn
   * @expectedResult The true branch is typed as the branded class or contract, so a
   *   caller reads its fields without a cast; a regression to `boolean` fails to compile
   */
  test("the guards narrow to their branded types", () => {
    const value: unknown = undefined;
    if (isCraftContext(value))
      expectTypeOf(value).toEqualTypeOf<CraftContext>();
    if (isRoute(value)) expectTypeOf(value).toEqualTypeOf<Route>();
    if (isRouteBuilder(value))
      expectTypeOf(value).toEqualTypeOf<AnyRouteBuilder>();
    if (isRouteDefinition(value)) {
      expectTypeOf(value).toEqualTypeOf<RouteDefinition>();
    }
    if (isRoutecraftError(value)) {
      expectTypeOf(value).toEqualTypeOf<RoutecraftError>();
    }
    if (isExchange(value)) expectTypeOf(value).toEqualTypeOf<Exchange>();
    if (isProject(value)) expectTypeOf(value).toEqualTypeOf<Project<unknown>>();
    expect(isExchange(value)).toBe(false);
  });
});
