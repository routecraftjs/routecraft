import { describe, test, expect, afterEach, vi } from "vitest";
import { context, craft, simple, NoopAdapter } from "../src/mod.ts";

describe("Header operation", () => {
  let testContext: any;

  afterEach(async () => {
    if (testContext) {
      await testContext.stop();
    }
  });

  /**
   * @testCase TC-HDR1
   * @description Verifies that header operation can set static header values
   * @preconditions Route with static header value
   * @expectedResult Header should be set with the static value
   */
  test("basic header operation works", async () => {
    const noop = new NoopAdapter();
    const sendSpy = vi.spyOn(noop, "send");

    testContext = context()
      .routes(
        craft()
          .id("header-basic")
          .from(simple("test"))
          .header("x-test", "value")
          .to(noop),
      )
      .build();

    await testContext.start();

    expect(sendSpy).toHaveBeenCalled();
    const sentExchange = sendSpy.mock.calls[0][0];
    expect(sentExchange.headers["x-test"]).toBe("value");
  });

  /**
   * @testCase TC-HDR2
   * @description Verifies that header operation can derive values from exchange body
   * @preconditions Route with header derived from body data
   * @expectedResult Header should contain value derived from body
   */
  test("derived header from body", async () => {
    const noop = new NoopAdapter();
    const sendSpy = vi.spyOn(noop, "send");

    testContext = context()
      .routes(
        craft()
          .id("header-derived")
          .from(simple({ id: "u1", name: "test" }))
          .header("user-id", (exchange) => exchange.body.id)
          .to(noop),
      )
      .build();

    await testContext.start();

    expect(sendSpy).toHaveBeenCalled();
    const sentExchange = sendSpy.mock.calls[0][0];
    expect(sentExchange.headers["user-id"]).toBe("u1");
  });
});
