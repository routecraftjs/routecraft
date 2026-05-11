import { afterEach, describe, expect, test } from "bun:test";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import { craft, HeadersKeys, simple } from "@routecraft/routecraft";

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
});
