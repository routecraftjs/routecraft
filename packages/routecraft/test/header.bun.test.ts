import { afterEach, describe, expect, test } from "bun:test";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import {
  craft,
  HeadersKeys,
  simple,
  type RoutecraftError,
} from "@routecraft/routecraft";

describe("Header operation", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) {
      await t.stop();
    }
  });

  /**
   * @case Verifies that header operation can set static header values
   * @preconditions Route with static header value
   * @expectedResult Header should be set with the static value
   */
  test("basic header operation works", async () => {
    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("header-basic")
          .from(simple("test"))
          .header("x-test", "value")
          .to(s),
      )
      .build();

    await t.test();

    expect(s.received).toHaveLength(1);
    expect(s.received[0].headers["x-test"]).toBe("value");
  });

  /**
   * @case Verifies that header operation can derive values from exchange body
   * @preconditions Route with header derived from body data
   * @expectedResult Header should contain value derived from body
   */
  test("derived header from body", async () => {
    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("header-derived")
          .from(simple({ id: "u1", name: "test" }))
          .header("user-id", (exchange) => exchange.body.id)
          .to(s),
      )
      .build();

    await t.test();

    expect(s.received).toHaveLength(1);
    expect(s.received[0].headers["user-id"]).toBe("u1");
  });

  /**
   * @case `.header()` rejects writes to the framework-owned identity key
   *       up front, instead of silently no-op-ing once `rewrap` restores
   *       `prev.id` over the user's value
   * @preconditions Builder pipeline tries to set `routecraft.id`
   * @expectedResult Constructor throws RC5003 with a clear message
   */
  test("rejects .header() writes to routecraft.id with RC5003", () => {
    expect(() =>
      craft()
        .id("header-rejects-id")
        .from(simple("test"))
        .header(HeadersKeys.ID, "fixed-id")
        .to(spy()),
    ).toThrow(/routecraft\.id/);
  });

  /**
   * @case `.header()` rejects writes to every engine-owned key (operation,
   *       route id, split hierarchy, correlation id, causation id) while
   *       still allowing other reserved `routecraft.*` keys
   * @preconditions Builder pipelines try to set each engine-owned key and a
   *                settable reserved key (the cache discriminator)
   * @expectedResult Engine-owned keys throw RC5003, the correlation and
   *                 causation keys pointing at `.correlate()`; the
   *                 discriminator builds fine
   */
  test("rejects engine-owned keys, correlation and causation included", () => {
    for (const key of [
      HeadersKeys.OPERATION,
      HeadersKeys.ROUTE_ID,
      HeadersKeys.SPLIT_HIERARCHY,
      HeadersKeys.CORRELATION_ID,
      HeadersKeys.CAUSATION_ID,
    ]) {
      expect(() =>
        craft()
          .id(`header-rejects-${key}`)
          .from(simple("test"))
          .header(key, "value")
          .to(spy()),
      ).toThrow(/framework-owned/);
    }
    for (const key of [HeadersKeys.CORRELATION_ID, HeadersKeys.CAUSATION_ID]) {
      let caught: unknown;
      try {
        craft()
          .id(`header-points-${key}`)
          .from(simple("test"))
          .header(key, "upstream-id")
          .to(spy());
      } catch (error) {
        caught = error;
      }
      expect((caught as RoutecraftError).meta.suggestion).toMatch(
        /\.correlate\(/,
      );
    }

    expect(() =>
      craft()
        .id("header-allows-discriminator")
        .from(simple("test"))
        .header(HeadersKeys.CACHE_DISCRIMINATOR, "tool-a")
        .to(spy()),
    ).not.toThrow();
  });

  /**
   * @case Custom header keys that collide with Object.prototype members
   *       ("toString", "constructor", "__proto__", ...) are legal and must
   *       not be misread as engine-owned via the prototype chain
   * @preconditions Builder pipelines set headers named after prototype members
   * @expectedResult Routes build without throwing
   */
  test("allows header keys named after Object.prototype members", () => {
    for (const key of [
      "toString",
      "constructor",
      "hasOwnProperty",
      "valueOf",
      "__proto__",
    ]) {
      expect(() =>
        craft()
          .id(`header-prototype-${key}`)
          .from(simple("test"))
          .header(key, "value")
          .to(spy()),
      ).not.toThrow();
    }
  });
});
