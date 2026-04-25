import { describe, test, expect } from "vitest";
import { z } from "zod";
import { craft, simple, noop } from "@routecraft/routecraft";

describe("RouteBuilder strict metadata positioning", () => {
  /**
   * @case .input() throws when called twice on the same route
   * @preconditions craft().input(s).input(s2).from(simple)
   * @expectedResult Second .input() throws RC2001 with a message about duplicate input
   */
  test(".input() throws on duplicate call before .from()", () => {
    const s1 = z.object({ a: z.string() });
    const s2 = z.object({ b: z.string() });
    expect(() =>
      craft()
        .id("dup-input")
        .input(s1)
        .input(s2)
        .from(simple("x"))
        .to(noop())
        .build(),
    ).toThrow(/input/i);
  });

  /**
   * @case .output() throws when called twice on the same route
   * @preconditions craft().output(s).output(s2).from(simple)
   * @expectedResult Second .output() throws RC2001 with a message about duplicate output
   */
  test(".output() throws on duplicate call before .from()", () => {
    const s1 = z.object({ a: z.string() });
    const s2 = z.object({ b: z.string() });
    expect(() =>
      craft()
        .id("dup-output")
        .output(s1)
        .output(s2)
        .from(simple("x"))
        .to(noop())
        .build(),
    ).toThrow(/output/i);
  });

  /**
   * @case Pipeline operation on the orphaned-staged path throws
   * @preconditions craft().id("a").from(x).to(y).id("b").to(z) — second .to() runs while id "b" is staged but no second .from() has consumed it
   * @expectedResult Second .to(z) throws RC2001 with a message about staged metadata
   */
  test("pipeline op throws when metadata is staged after a previous .from() with no consuming .from()", () => {
    expect(() =>
      craft()
        .id("first")
        .from(simple("a"))
        .to(noop())
        .id("second")
        .to(noop())
        .build(),
    ).toThrow(/staged|metadata/i);
  });

  /**
   * @case .build() throws when route metadata is staged but never consumed
   * @preconditions craft().id("orphan").build()
   * @expectedResult RC2001 thrown describing the orphan
   */
  test(".build() throws when metadata is staged with no .from()", () => {
    expect(() =>
      craft().id("orphan").description("never built").build(),
    ).toThrow(/staged|never consumed/i);
  });

  /**
   * @case Chained-routes pattern still works — .id("a").from().to().id("b").from().to()
   * @preconditions Two routes defined sequentially, each with metadata above its own .from()
   * @expectedResult Both routes built without error; descriptions and ids preserved
   */
  test("chained-routes pattern with metadata between .from() calls still works", () => {
    const routes = craft()
      .id("a")
      .description("first route")
      .from(simple("a"))
      .to(noop())
      .id("b")
      .description("second route")
      .from(simple("b"))
      .to(noop())
      .build();

    expect(routes).toHaveLength(2);
    expect(routes[0].id).toBe("a");
    expect(routes[0].discovery?.description).toBe("first route");
    expect(routes[1].id).toBe("b");
    expect(routes[1].discovery?.description).toBe("second route");
  });

  /**
   * @case Single .input() on a route is accepted and stored on the route definition
   * @preconditions craft().input({ body: schema }).from(simple)
   * @expectedResult RouteDefinition.discovery.input.body is the schema; build succeeds
   */
  test("single .input() on a route stores the schema in discovery", () => {
    const schema = z.object({ name: z.string() });
    const [route] = craft()
      .id("with-input")
      .input(schema)
      .from(simple("x"))
      .to(noop())
      .build();

    expect(route.discovery?.input?.body).toBe(schema);
  });
});
