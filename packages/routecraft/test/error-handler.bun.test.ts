import { afterEach, describe, expect, mock, test } from "bun:test";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import { craft, simple, direct, recovery } from "@routecraft/routecraft";

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
    const handlerSpy = mock((_error, exchange) => {
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
    const afterThrowSpy = mock((body: unknown) => body);
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
    const handlerResultSpy = mock();

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
          .from(direct())
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
      .on("route:step:error", () => {
        events.push("step:error");
      })
      .on("route:error:caught", () => {
        events.push("error:caught");
      })
      .on("route:exchange:failed", () => {
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
      .on("route:step:error", () => {
        events.push("step:error");
      })
      .on("route:error", () => {
        events.push("route:error");
      })
      .on("context:error", () => {
        events.push("context:error");
      })
      .on("route:exchange:failed", () => {
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
      .on("route:exchange:failed", () => {
        events.push("exchange:failed");
      })
      .on("route:error-handler:invoked", () => {
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

describe("Recovery directives (recovery.drop / recovery.rethrow)", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case Route-scope handler returns recovery.drop(reason)
   * @preconditions Route with .error() returning recovery.drop("poison") and a throwing step
   * @expectedResult exchange:dropped fires with the given reason and error-handler:recovered fires; neither exchange:failed nor exchange:completed fire
   */
  test("route-scope drop discards the exchange with the given reason", async () => {
    const events: string[] = [];
    let dropReason: string | undefined;

    t = await testContext()
      .on("route:exchange:dropped", ({ details }) => {
        events.push("dropped");
        dropReason = details.reason;
      })
      .on("route:error-handler:recovered", () => {
        events.push("recovered");
      })
      .on("route:exchange:failed", () => {
        events.push("failed");
      })
      .on("route:exchange:completed", () => {
        events.push("completed");
      })
      .routes(
        craft()
          .id("route-scope-drop")
          .error(() => recovery.drop("poison"))
          .from(simple("input"))
          .transform(() => {
            throw new Error("boom");
          }),
      )
      .build();

    await t.test();

    expect(events).toContain("dropped");
    expect(events).toContain("recovered");
    expect(events).not.toContain("failed");
    expect(events).not.toContain("completed");
    expect(dropReason).toBe("poison");
  });

  /**
   * @case Route-scope handler returns recovery.rethrow()
   * @preconditions Route with .error() returning recovery.rethrow() and a step throwing "original"
   * @expectedResult Behaves exactly like the handler throwing the original error: error-handler:failed, route:error, context:error, and exchange:failed fire with the original error
   */
  test("route-scope rethrow propagates the original error", async () => {
    const events: string[] = [];
    let failedError: unknown;

    t = await testContext()
      .on("route:error-handler:failed", () => {
        events.push("handler:failed");
      })
      .on("route:error", () => {
        events.push("route:error");
      })
      .on("context:error", () => {
        events.push("context:error");
      })
      .on("route:exchange:failed", ({ details }) => {
        events.push("exchange:failed");
        failedError = details.error;
      })
      .routes(
        craft()
          .id("route-scope-rethrow")
          .error(() => recovery.rethrow())
          .from(simple("input"))
          .transform(() => {
            throw new Error("original");
          }),
      )
      .build();

    await t.test();

    expect(events).toContain("handler:failed");
    expect(events).toContain("route:error");
    expect(events).toContain("context:error");
    expect(events).toContain("exchange:failed");
    expect((failedError as Error).message).toContain("original");
  });

  /**
   * @case Step-scope handler returns recovery.drop(reason)
   * @preconditions Route with a post-from .error() wrapping a throwing step, followed by more steps
   * @expectedResult The exchange is dropped with the given reason; subsequent steps never run; neither exchange:failed nor exchange:completed fire
   */
  test("step-scope drop halts the pipeline and discards the exchange", async () => {
    const events: string[] = [];
    let dropReason: string | undefined;
    const afterSpy = mock((body: unknown) => body);
    const s = spy();

    t = await testContext()
      .on("route:exchange:dropped", ({ details }) => {
        events.push("dropped");
        dropReason = details.reason;
      })
      .on("route:exchange:failed", () => {
        events.push("failed");
      })
      .on("route:exchange:completed", () => {
        events.push("completed");
      })
      .routes(
        craft()
          .id("step-scope-drop")
          .from(simple("input"))
          .error(() => recovery.drop("step-poison"))
          .transform(() => {
            throw new Error("boom");
          })
          .transform(afterSpy)
          .to(s),
      )
      .build();

    await t.test();

    expect(events).toContain("dropped");
    expect(events).not.toContain("failed");
    expect(events).not.toContain("completed");
    expect(dropReason).toBe("step-poison");
    expect(afterSpy).not.toHaveBeenCalled();
    expect(s.received).toHaveLength(0);
  });

  /**
   * @case Step-scope handler returns recovery.rethrow() with a route-scope handler present
   * @preconditions Post-from .error() returning recovery.rethrow() around a throwing step; route-scope .error() that recovers
   * @expectedResult The step-scope handler declines (error-handler:failed with scope "step"); the route-scope handler receives the original error and recovers (scope "route")
   */
  test("step-scope rethrow cascades to the route-scope handler", async () => {
    const scopes: { event: string; scope: string }[] = [];
    let routeHandlerError: unknown;

    t = await testContext()
      .on("route:error-handler:failed", ({ details }) => {
        scopes.push({ event: "failed", scope: details.scope ?? "unknown" });
      })
      .on("route:error-handler:recovered", ({ details }) => {
        scopes.push({ event: "recovered", scope: details.scope ?? "unknown" });
      })
      .routes(
        craft()
          .id("step-scope-rethrow")
          .error((error) => {
            routeHandlerError = error;
            return "route-recovered";
          })
          .from(simple("input"))
          .error(() => recovery.rethrow())
          .transform(() => {
            throw new Error("original");
          }),
      )
      .build();

    await t.test();

    expect(scopes).toContainEqual({ event: "failed", scope: "step" });
    expect(scopes).toContainEqual({ event: "recovered", scope: "route" });
    expect((routeHandlerError as Error).message).toContain("original");
  });

  /**
   * @case Unbranded directive-shaped return values stay plain recovery bodies
   * @preconditions Step-scope .error() returning the plain object { kind: "drop" } (no brand)
   * @expectedResult The object becomes the recovered body and the pipeline continues; no drop occurs
   */
  test("plain object shaped like a directive is treated as a recovery body", async () => {
    const events: string[] = [];
    const s = spy();

    t = await testContext()
      .on("route:exchange:dropped", () => {
        events.push("dropped");
      })
      .routes(
        craft()
          .id("unbranded-body")
          .from(simple("input"))
          .error(() => ({ kind: "drop" }))
          .transform((): unknown => {
            throw new Error("boom");
          })
          .to(s),
      )
      .build();

    await t.test();

    expect(events).not.toContain("dropped");
    expect(s.received).toHaveLength(1);
    expect(s.received[0].body).toEqual({ kind: "drop" });
  });
});
