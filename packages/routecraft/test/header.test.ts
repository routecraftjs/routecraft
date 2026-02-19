import { describe, test, expect, afterEach, vi } from "vitest";
import { testContext, type TestContext } from "@routecraft/testing";
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
    const destSpy = vi.fn();

    t = await testContext()
      .routes(
        craft()
          .id("header-basic")
          .from(simple("test"))
          .header("x-test", "value")
          .to(destSpy),
      )
      .build();

    await t.test();

    expect(destSpy).toHaveBeenCalledTimes(1);
    const sentExchange = destSpy.mock.calls[0][0];
    expect(sentExchange.headers["x-test"]).toBe("value");
  });

  /**
   * @case Verifies that header operation can derive values from exchange body
   * @preconditions Route with header derived from body data
   * @expectedResult Header should contain value derived from body
   */
  test("derived header from body", async () => {
    const destSpy = vi.fn();

    t = await testContext()
      .routes(
        craft()
          .id("header-derived")
          .from(simple({ id: "u1", name: "test" }))
          .header("user-id", (exchange) => exchange.body.id)
          .to(destSpy),
      )
      .build();

    await t.test();

    expect(destSpy).toHaveBeenCalledTimes(1);
    const sentExchange = destSpy.mock.calls[0][0];
    expect(sentExchange.headers["user-id"]).toBe("u1");
  });
});
