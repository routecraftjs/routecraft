import { describe, test, expect, afterEach } from "vitest";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  craft,
  direct,
  noop,
  getExchangeContext,
  DefaultExchange,
  type Exchange,
} from "@routecraft/routecraft";

describe("CraftClient", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case Sends a message to a direct endpoint and returns the transformed result
   * @preconditions A route with a direct source and a transform step
   * @expectedResult The client receives the transformed body as the return value
   */
  test("send returns the route result", async () => {
    t = await testContext()
      .routes(
        craft()
          .id("greet")
          .from(direct("greet", {}))
          .transform((body) => `Hello, ${(body as { name: string }).name}!`)
          .to(noop()),
      )
      .build();

    await t.startAndWaitReady();
    const result = await t.client.send("greet", { name: "World" });
    expect(result).toBe("Hello, World!");
  });

  /**
   * @case Throws RC5004 when no route subscribes to the given endpoint
   * @preconditions A context with no route for the requested endpoint
   * @expectedResult client.send() rejects with a RoutecraftError containing code RC5004
   */
  test("send throws RC5004 for unknown endpoint", async () => {
    t = await testContext()
      .routes(craft().id("dummy").from(direct("exists", {})).to(noop()))
      .build();

    await t.startAndWaitReady();
    await expect(t.client.send("does-not-exist", {})).rejects.toThrow(
      "No direct channel",
    );
  });

  /**
   * @case Forwards custom headers through to the exchange
   * @preconditions A route that reads a header value via process() and returns it as the body
   * @expectedResult The result reflects the header value passed via client.send()
   */
  test("send forwards headers to the exchange", async () => {
    t = await testContext()
      .routes(
        craft()
          .id("echo-header")
          .from(direct("echo-header", {}))
          .process((ex: Exchange) => {
            const reqId = ex.headers["x-request-id"] ?? "missing";
            return new DefaultExchange(getExchangeContext(ex)!, {
              body: reqId,
            });
          })
          .to(noop()),
      )
      .build();

    await t.startAndWaitReady();
    const result = await t.client.send(
      "echo-header",
      {},
      { "x-request-id": "abc-123" },
    );
    expect(result).toBe("abc-123");
  });
});
