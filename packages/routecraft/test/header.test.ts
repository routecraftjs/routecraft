import { describe, test, expect, afterEach } from "vitest";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import { craft, simple } from "@routecraft/routecraft";

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
});
