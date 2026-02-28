import { describe, test, expectTypeOf } from "vitest";
import { craft, simple, only, json } from "../src/index.ts";
import type { RouteBuilder } from "../src/builder.ts";

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
