import { describe, test, expect, afterEach, vi } from "vitest";
import { context, craft, simple } from "../src/index.ts";

describe("Header operation", () => {
  let testContext: any;

  afterEach(async () => {
    if (testContext) {
      await testContext.stop();
    }
  });

  /**
   * @case Verifies that header operation can set static header values
   * @preconditions Route with static header value
   * @expectedResult Header should be set with the static value
   */
  test("basic header operation works", async () => {
    const destSpy = vi.fn();

    testContext = context()
      .routes(
        craft()
          .id("header-basic")
          .from(simple("test"))
          .header("x-test", "value")
          .to(destSpy),
      )
      .build();

    await testContext.start();

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

    testContext = context()
      .routes(
        craft()
          .id("header-derived")
          .from(simple({ id: "u1", name: "test" }))
          .header("user-id", (exchange) => exchange.body.id)
          .to(destSpy),
      )
      .build();

    await testContext.start();

    expect(destSpy).toHaveBeenCalledTimes(1);
    const sentExchange = destSpy.mock.calls[0][0];
    expect(sentExchange.headers["user-id"]).toBe("u1");
  });
});
