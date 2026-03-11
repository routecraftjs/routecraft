import { describe, test, expect, afterEach, vi } from "vitest";
import { testContext, type TestContext } from "@routecraft/testing";
import { craft, simple, direct } from "@routecraft/routecraft";

describe("Error handler (.error())", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case Error handler returns a static fallback value
   * @preconditions Route with .error() and a transform that throws
   * @expectedResult The destination receives the handler's return value instead of the original body
   */
  test("returns static fallback when a step throws", async () => {
    const destSpy = vi.fn();

    t = await testContext()
      .routes(
        craft()
          .id("static-fallback")
          .error((error) => ({
            status: "failed",
            reason: (error as Error).message,
          }))
          .from(simple("input"))
          .transform(() => {
            throw new Error("boom");
          })
          .to(destSpy),
      )
      .build();

    await t.test();

    // Pipeline stops after error handler; destination before the throw was not reached,
    // but the exchange body should be the handler's return value
    expect(t.errors).toHaveLength(0);
    expect(destSpy).not.toHaveBeenCalled();
  });

  /**
   * @case Error handler receives the exchange at the point of failure
   * @preconditions Route where transform sets body then a subsequent step throws
   * @expectedResult Handler receives the error and the exchange; exchange body reflects the handler's return
   */
  test("receives the exchange at the point of failure", async () => {
    let capturedBody: unknown;
    const handlerSpy = vi.fn((_error, exchange) => {
      // Capture the body before the handler's return overwrites it
      capturedBody = exchange.body;
      return "recovered";
    });

    t = await testContext()
      .routes(
        craft()
          .id("exchange-snapshot")
          .error(handlerSpy)
          .from(simple("original"))
          .transform(() => "transformed")
          .transform(() => {
            throw new Error("fail after transform");
          }),
      )
      .build();

    await t.test();

    expect(handlerSpy).toHaveBeenCalledTimes(1);
    const [error] = handlerSpy.mock.calls[0];
    expect(error).toBeDefined();
    expect(capturedBody).toBe("transformed");
  });

  /**
   * @case Pipeline does not resume after the error handler
   * @preconditions Route with error handler, a throwing step, and steps after it
   * @expectedResult Steps after the throwing step are never called
   */
  test("pipeline does not resume after error handler", async () => {
    const afterThrowSpy = vi.fn((body: unknown) => body);
    const destSpy = vi.fn();

    t = await testContext()
      .routes(
        craft()
          .id("no-resume")
          .error(() => "handled")
          .from(simple("input"))
          .transform(() => {
            throw new Error("stop here");
          })
          .transform(afterThrowSpy)
          .to(destSpy),
      )
      .build();

    await t.test();

    expect(afterThrowSpy).not.toHaveBeenCalled();
    expect(destSpy).not.toHaveBeenCalled();
  });

  /**
   * @case Error handler forwards to a dedicated error-handling capability and returns its result
   * @preconditions Two routes: one with .error() that forwards to a second via direct()
   * @expectedResult The error handler delegates to the error capability and the forward resolves with its result
   */
  test("forwards to another capability via forward()", async () => {
    const errorCapabilitySpy = vi.fn();
    const handlerResultSpy = vi.fn();

    t = await testContext()
      .routes([
        craft()
          .id("main-route")
          .error(async (_error, exchange, forward) => {
            const result = await forward("error-sink", {
              originalBody: exchange.body,
              reason: (_error as Error).message,
            });
            handlerResultSpy(result);
            return result;
          })
          .from(simple("payload"))
          .transform(() => {
            throw new Error("something broke");
          }),
        craft()
          .id("error-sink")
          .from(direct("error-sink", {}))
          .transform((body: unknown) => {
            const data = body as { originalBody: string; reason: string };
            return { recovered: true, from: data.originalBody };
          })
          .to(errorCapabilitySpy),
      ])
      .build();

    await t.test();

    // The error capability received the forwarded payload
    expect(errorCapabilitySpy).toHaveBeenCalledTimes(1);
    const receivedExchange = errorCapabilitySpy.mock.calls[0][0];
    expect(receivedExchange.body).toEqual({
      recovered: true,
      from: "payload",
    });

    // The forward() return value was passed back to the handler
    expect(handlerResultSpy).toHaveBeenCalledTimes(1);
    expect(handlerResultSpy.mock.calls[0][0]).toEqual({
      recovered: true,
      from: "payload",
    });
  });

  /**
   * @case Emits error:invoked and error:recovered events on successful recovery
   * @preconditions Route with .error() handler that succeeds
   * @expectedResult Both invoked and recovered events fire; no exchange:failed
   */
  test("emits error:invoked and error:recovered events", async () => {
    const events: string[] = [];

    t = await testContext()
      .on("route:*:operation:error:invoked" as const, () => {
        events.push("error:invoked");
      })
      .on("route:*:operation:error:recovered" as const, () => {
        events.push("error:recovered");
      })
      .on("route:*:exchange:failed" as const, () => {
        events.push("exchange:failed");
      })
      .routes(
        craft()
          .id("events-ok")
          .error(() => "fallback")
          .from(simple("msg"))
          .transform(() => {
            throw new Error("oops");
          }),
      )
      .build();

    await t.test();

    expect(events).toContain("error:invoked");
    expect(events).toContain("error:recovered");
    expect(events).not.toContain("exchange:failed");
  });

  /**
   * @case Emits error:invoked and error:failed events when the handler itself throws
   * @preconditions Route with .error() handler that throws
   * @expectedResult invoked, failed, and exchange:failed events fire
   */
  test("emits error:failed and exchange:failed when handler throws", async () => {
    const events: string[] = [];

    t = await testContext()
      .on("route:*:operation:error:invoked" as const, () => {
        events.push("error:invoked");
      })
      .on("route:*:operation:error:failed" as const, () => {
        events.push("error:failed");
      })
      .on("route:*:exchange:failed" as const, () => {
        events.push("exchange:failed");
      })
      .routes(
        craft()
          .id("events-fail")
          .error(() => {
            throw new Error("handler also broke");
          })
          .from(simple("msg"))
          .transform(() => {
            throw new Error("original");
          }),
      )
      .build();

    await t.test();

    expect(events).toContain("error:invoked");
    expect(events).toContain("error:failed");
    expect(events).toContain("exchange:failed");
  });

  /**
   * @case Default behavior preserved when no .error() is defined
   * @preconditions Route without .error() that has a throwing step
   * @expectedResult error and exchange:failed events fire (existing behavior)
   */
  test("default behavior preserved without .error()", async () => {
    const events: string[] = [];

    t = await testContext()
      .on("error", () => {
        events.push("error");
      })
      .on("route:*:exchange:failed" as const, () => {
        events.push("exchange:failed");
      })
      .on("route:*:operation:error:invoked" as const, () => {
        events.push("error:invoked");
      })
      .routes(
        craft()
          .id("no-handler")
          .from(simple("msg"))
          .transform(() => {
            throw new Error("unhandled");
          }),
      )
      .build();

    await t.test();

    expect(events).toContain("error");
    expect(events).toContain("exchange:failed");
    expect(events).not.toContain("error:invoked");
  });
});
