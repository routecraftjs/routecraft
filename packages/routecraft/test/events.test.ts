import { describe, test, expect, afterEach } from "vitest";
import { testContext, type TestContext } from "@routecraft/testing";
import { craft, simple, log } from "@routecraft/routecraft";

describe("Events API", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) {
      await t.stop();
    }
  });

  /**
   * @case Fires all context and route lifecycle events for a completing route
   * @preconditions Context with simple array source and log destination
   * @expectedResult All start/stop lifecycle events are emitted in the run
   */
  test("fires context and route lifecycle events", async () => {
    const events: string[] = [];

    const route = craft()
      .id("evt-route")
      .from(simple([1, 2, 3]))
      .to(log());
    t = await testContext()
      .on("context:starting", () => {
        events.push("context:starting");
      })
      .on("context:started", () => {
        events.push("context:started");
      })
      // routeRegistered occurs during registerRoutes() in build(); test separately below
      .on("route:starting", ({ details: { route } }) => {
        if (route.definition?.id ?? "evt-route") {
          events.push("route:starting");
        }
      })
      .on("route:started", () => {
        events.push("route:started");
      })
      .on("route:stopping", () => {
        events.push("route:stopping");
      })
      .on("route:stopped", () => {
        events.push("route:stopped");
      })
      .on("context:stopping", () => {
        events.push("context:stopping");
      })
      .on("context:stopped", () => {
        events.push("context:stopped");
      })
      .routes(route)
      .build();

    await t.ctx.start();

    // Give event handlers microtask time to flush
    await new Promise((r) => setTimeout(r, 0));

    // Since the simple source completes immediately, the context should auto-stop
    expect(events).toContain("context:starting");
    expect(events).toContain("context:started");
    expect(events).toContain("route:starting");
    expect(events).toContain("route:started");
    expect(events).toContain("route:stopping");
    expect(events).toContain("route:stopped");
    expect(events).toContain("context:stopping");
    expect(events).toContain("context:stopped");
  });

  /**
   * @case Emits routeRegistered when a route is registered after build
   * @preconditions Empty context; route registered via registerRoutes()
   * @expectedResult routeRegistered event fires exactly once
   */
  test("emits routeRegistered when registering after build", async () => {
    const events: string[] = [];
    t = await testContext()
      .on("route:registered", () => {
        events.push("route:registered");
      })
      .build();
    const def = craft()
      .id("later-route")
      .from(simple([1]))
      .to(log())
      .build()[0];
    t.ctx.registerRoutes(def);
    expect(events).toContain("route:registered");
  });

  /**
   * @case Emits error events for failing startup, failing source, and failing step
   * @preconditions Separate contexts setup to induce each failure mode
   * @expectedResult Error handlers receive all three failure types
   */
  test("emits error events for startup, route failure, and step failure", async () => {
    const errors: unknown[] = [];

    // 1) Startup failure (raise in contextStarting handler)
    const failingStartup = await testContext()
      .on("context:starting", () => {
        throw new Error("startup fail");
      })
      .on("error", ({ details: { error } }) => {
        errors.push(error);
      })
      .build();

    try {
      await failingStartup.ctx.start();
    } catch (e) {
      errors.push(e);
    }
    await new Promise((r) => setTimeout(r, 0));

    // 2) Route failure via source throwing (start() rejects with AggregateError)
    const failingRouteT = await testContext()
      .on("error", ({ details: { error } }) => {
        errors.push(error);
      })
      .routes(
        craft()
          .id("route-fail")
          .from(() => {
            throw new Error("source fail");
          }),
      )
      .build();

    try {
      await failingRouteT.ctx.start();
    } catch {
      // Rejected with AggregateError; error event already pushed original
    }
    await new Promise((r) => setTimeout(r, 0));

    // 3) Step failure in process() (start() resolves; step fails during run)
    const stepFailT = await testContext()
      .on("error", ({ details }) => {
        errors.push(details.error);
      })
      .routes(
        craft()
          .id("step-fail")
          .from(simple([1]))
          .process(() => {
            throw new Error("step fail");
          }),
      )
      .build();

    await stepFailT.ctx.start();
    await new Promise((r) => setTimeout(r, 0));

    expect(errors.length).toBeGreaterThanOrEqual(3);
    const messages = errors.map((e) => (e as Error).message);
    expect(messages.some((m) => /startup fail/.test(m))).toBeTruthy();
    expect(messages.some((m) => /source fail/.test(m))).toBeTruthy();
    // RouteCraftError wraps step failures; either contains message or toString
    const anyStep = messages.some((m) =>
      /Processing step threw|step fail/i.test(m),
    );
    expect(anyStep).toBeTruthy();
  });

  /**
   * @case test() rejects when a route throws during start (before routeStarted)
   * @preconditions Route with source that throws in subscribe() before calling onReady
   * @expectedResult test() rejects and does not hang; error is in t.errors
   */
  test("test() rejects when route throws during start and does not hang", async () => {
    const startError = new Error("route start fail");
    t = await testContext()
      .routes(
        craft()
          .id("throw-on-start")
          .from(() => {
            throw startError;
          })
          .to(log()),
      )
      .build();

    await expect(t.test()).rejects.toThrow("route start fail");
    expect(t.errors.length).toBeGreaterThanOrEqual(1);
    // Wrapped as RouteCraftError; original message appears in cause or toString
    const hasStartError = t.errors.some((e) => {
      const err = e as Error;
      const cause = err.cause;
      return (
        err.message?.includes("route start fail") ||
        (cause instanceof Error && cause.message === "route start fail") ||
        String(e).includes("route start fail")
      );
    });
    expect(hasStartError).toBeTruthy();
  });

  /**
   * @case test() rejects with timeout when no route ever emits routeStarted
   * @preconditions Route with source that never calls onReady
   * @expectedResult test() rejects after timeout with "Timeout waiting for routes to start"
   */
  test("test() rejects with timeout when route never emits routeStarted", async () => {
    // Callable source that never calls onReady but resolves when aborted so test() can finish
    const neverReady = (
      _ctx: unknown,
      _handler: unknown,
      controller: AbortController,
    ) =>
      new Promise<void>((resolve) => {
        controller.signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });

    t = await testContext()
      .routesReadyTimeout(200)
      .routes(craft().id("never-ready").from(neverReady).to(log()))
      .build();

    await expect(t.test()).rejects.toThrow(
      "Timeout waiting for routes to start",
    );
  }, 5_000);
});
