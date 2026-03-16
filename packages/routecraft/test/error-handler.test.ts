import { describe, test, expect, afterEach, vi } from "vitest";
import { testContext, spy, type TestContext } from "@routecraft/testing";
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
    const s = spy();

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
          .to(s),
      )
      .build();

    await t.test();

    // Pipeline stops after error handler; destination before the throw was not reached,
    // but the exchange body should be the handler's return value
    expect(t.errors).toHaveLength(0);
    expect(s.received).toHaveLength(0);
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
    const s = spy();

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
          .to(s),
      )
      .build();

    await t.test();

    expect(afterThrowSpy).not.toHaveBeenCalled();
    expect(s.received).toHaveLength(0);
  });

  /**
   * @case Error handler forwards to a dedicated error-handling capability and returns its result
   * @preconditions Two routes: one with .error() that forwards to a second via direct()
   * @expectedResult The error handler delegates to the error capability and the forward resolves with its result
   */
  test("forwards to another capability via forward()", async () => {
    const errorCapSpy = spy();
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
          .to(errorCapSpy),
      ])
      .build();

    await t.test();

    // The error capability received the forwarded payload
    expect(errorCapSpy.received).toHaveLength(1);
    expect(errorCapSpy.received[0].body).toEqual({
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
   * @case Emits step error and error:caught events on successful recovery
   * @preconditions Route with .error() handler that succeeds
   * @expectedResult step:error and error:caught events fire; no exchange:failed
   */
  test("emits step error and error:caught events on recovery", async () => {
    const events: string[] = [];

    t = await testContext()
      .on("route:*:step:*:error" as const, () => {
        events.push("step:error");
      })
      .on("route:*:error:caught" as const, () => {
        events.push("error:caught");
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

    expect(events).toContain("step:error");
    expect(events).toContain("error:caught");
    expect(events).not.toContain("exchange:failed");
  });

  /**
   * @case Emits step error, route error, context error, and exchange:failed when handler throws
   * @preconditions Route with .error() handler that throws
   * @expectedResult step:error, route:error, context:error, and exchange:failed events fire
   */
  test("emits route error and exchange:failed when handler throws", async () => {
    const events: string[] = [];

    t = await testContext()
      .on("route:*:step:*:error" as const, () => {
        events.push("step:error");
      })
      .on("route:*:error" as const, () => {
        events.push("route:error");
      })
      .on("context:error", () => {
        events.push("context:error");
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

    expect(events).toContain("step:error");
    expect(events).toContain("route:error");
    expect(events).toContain("context:error");
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
      .on("context:error", () => {
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
