import { afterEach, describe, expect, test } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  craft,
  direct,
  noop,
  recovery,
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
  test("sendDirect returns the route result", async () => {
    t = await testContext()
      .routes(
        craft()
          .id("greet")
          .from(direct())
          .transform((body) => `Hello, ${(body as { name: string }).name}!`)
          .to(noop()),
      )
      .build();

    await t.startAndWaitReady();
    const result = await t.client.sendDirect("greet", { name: "World" });
    expect(result as unknown).toBe("Hello, World!");
  });

  /**
   * @case Throws RC5004 when no route subscribes to the given endpoint
   * @preconditions A context with no route for the requested endpoint
   * @expectedResult client.sendDirect() rejects with a RoutecraftError containing code RC5004
   */
  test("sendDirect throws RC5004 for unknown endpoint", async () => {
    t = await testContext()
      .routes(craft().id("exists").from(direct()).to(noop()))
      .build();

    await t.startAndWaitReady();
    await expect(
      t.client.sendDirect("does-not-exist", {}),
    ).rejects.toMatchObject({ rc: "RC5004" });
  });

  /**
   * @case Forwards custom headers through to the exchange
   * @preconditions A route that reads a header value via process() and returns it as the body
   * @expectedResult The result reflects the header value passed via client.sendDirect()
   */
  test("sendDirect forwards headers to the exchange", async () => {
    t = await testContext()
      .routes(
        craft()
          .id("echo-header")
          .from(direct())
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
    const result = await t.client.sendDirect(
      "echo-header",
      {},
      { "x-request-id": "abc-123" },
    );
    expect(result).toBe("abc-123");
  });

  /**
   * @case sendDirect rejects with RC5031 when the route drops the exchange
   * @preconditions Direct route whose .error() handler returns recovery.drop()
   * @expectedResult The promise rejects with RC5031 instead of resolving with
   *                 the caller's own request body
   */
  test("sendDirect rejects with RC5031 when the exchange is dropped", async () => {
    t = await testContext()
      .routes(
        craft()
          .id("drops-request")
          .error(() => recovery.drop("poison"))
          .from(direct())
          .transform(() => {
            throw new Error("boom");
          }),
      )
      .build();
    await t.startAndWaitReady();

    await expect(
      t.client.sendDirect("drops-request", { id: 1 }),
    ).rejects.toMatchObject({ rc: "RC5031" });
  });

  /**
   * @case sendDirect rejects with RC5031 when a filter drops the exchange
   * @preconditions Direct route with a .filter() that rejects the request
   * @expectedResult The promise rejects with RC5031 (a drop is not a response)
   */
  test("sendDirect rejects with RC5031 when a filter drops the exchange", async () => {
    t = await testContext()
      .routes(
        craft()
          .id("filters-request")
          .from(direct())
          .filter(() => false)
          .to(noop()),
      )
      .build();
    await t.startAndWaitReady();

    await expect(
      t.client.sendDirect("filters-request", { id: 1 }),
    ).rejects.toMatchObject({ rc: "RC5031" });
  });
});
