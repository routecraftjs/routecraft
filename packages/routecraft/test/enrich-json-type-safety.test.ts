import { describe, test, expectTypeOf } from "vitest";
import { z } from "zod";
import { craft, simple, only, json } from "../src/index.ts";
import type { RouteBuilder } from "../src/builder.ts";

describe("schema() type safety", () => {
  const nameSchema = z.object({ name: z.string() });

  /**
   * @case schema(standardSchema) narrows body type to schema output
   * @preconditions .from(simple({ id: 0 })).schema(nameSchema)
   * @expectedResult RouteBuilder<{ name: string }> (StandardSchemaV1.InferOutput of schema)
   */
  test("schema(standardSchema) infers RouteBuilder with schema output type", () => {
    const route = craft()
      .from(simple({ id: 0 }))
      .schema(nameSchema);
    expectTypeOf(route).toEqualTypeOf<RouteBuilder<{ name: string }>>();
  });
});

describe("validate() type safety", () => {
  /**
   * @case validate(callable) narrows body type via generic R
   * @preconditions .from(simple("42")).validate<number>(...)
   * @expectedResult RouteBuilder<number>
   */
  test("validate(callable) infers RouteBuilder with return type R", () => {
    const route = craft()
      .from(simple("42"))
      .validate<number>((exchange) => Number(exchange.body));
    expectTypeOf(route).toEqualTypeOf<RouteBuilder<number>>();
  });

  /**
   * @case validate(Validator adapter) narrows body type via generic R
   * @preconditions .from(simple("hello")).validate<string>({ validate: ... })
   * @expectedResult RouteBuilder<string>
   */
  test("validate(adapter) infers RouteBuilder with return type R", () => {
    const route = craft()
      .from(simple("hello"))
      .validate<string>({ validate: (ex) => ex.body.toUpperCase() });
    expectTypeOf(route).toEqualTypeOf<RouteBuilder<string>>();
  });
});

describe("enrich() without aggregator type safety", () => {
  /**
   * @case enrich(dest) with no aggregator infers Current & R from destination
   * @preconditions .from(simple({ userId: 1 })).enrich(async () => ({ links: [...] }))
   * @expectedResult RouteBuilder<{ userId: number } & { links: string[] }>
   */
  test("enrich(destination) infers Current & R from destination result type", () => {
    const route = craft()
      .from(simple({ userId: 1 }))
      .enrich(async () => ({ links: ["a", "b"] as string[] }));
    expectTypeOf(route).toEqualTypeOf<
      RouteBuilder<{ userId: number } & { links: string[] }>
    >();
  });
});

describe("only() and json() type safety", () => {
  /**
   * @case only(getValue, into) with string literal into: enrich infers body type as Current & { [into]: V }
   * @preconditions only((r) => r.links, "links") with r typed
   * @expectedResult Route after .enrich(..., only(..., "links")) is RouteBuilder<{ userId: number } & { links: string[] }>
   */
  test("enrich with only(..., literal into) infers merged body type", () => {
    const enricher = async () => ({ links: ["a", "b"] as string[] });
    const route = craft()
      .from(simple({ userId: 1 }))
      .enrich(
        enricher,
        only((r: { links: string[] }) => r.links, "links"),
      );

    expectTypeOf(route).toEqualTypeOf<
      RouteBuilder<{ userId: number } & { links: string[] }>
    >();
  });

  /**
   * @case json({ getValue }) without to: output type is V inferred from getValue return
   * @preconditions getValue returns { name: string }
   * @expectedResult Transformer output type is { name: string }
   */
  test("json({ getValue }) infers output type from getValue", () => {
    const adapter = json({
      getValue: (parsed: unknown) =>
        typeof parsed === "object" && parsed !== null && "name" in parsed
          ? { name: (parsed as { name: string }).name }
          : { name: "" },
    });
    expectTypeOf(adapter).toMatchTypeOf<
      import("../src/operations/transform.ts").Transformer<
        unknown,
        { name: string }
      >
    >();
  });
});
