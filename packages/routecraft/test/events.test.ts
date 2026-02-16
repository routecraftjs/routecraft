import { describe, test, expect, afterEach } from "vitest";
import {
  testContext,
  craft,
  simple,
  log,
  type TestContext,
} from "@routecraft/routecraft";

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
      .on("contextStarting", () => {
        events.push("contextStarting");
      })
      .on("contextStarted", () => {
        events.push("contextStarted");
      })
      // routeRegistered occurs during registerRoutes() in build(); test separately below
      .on("routeStarting", ({ details: { route } }) => {
        if (route.definition?.id ?? "evt-route") {
          events.push("routeStarting");
        }
      })
      .on("routeStarted", () => {
        events.push("routeStarted");
      })
      .on("routeStopping", () => {
        events.push("routeStopping");
      })
      .on("routeStopped", () => {
        events.push("routeStopped");
      })
      .on("contextStopping", () => {
        events.push("contextStopping");
      })
      .on("contextStopped", () => {
        events.push("contextStopped");
      })
      .routes(route)
      .build();

    await t.ctx.start();

    // Give event handlers microtask time to flush
    await new Promise((r) => setTimeout(r, 0));

    // Since the simple source completes immediately, the context should auto-stop
    expect(events).toContain("contextStarting");
    expect(events).toContain("contextStarted");
    expect(events).toContain("routeStarting");
    expect(events).toContain("routeStarted");
    expect(events).toContain("routeStopping");
    expect(events).toContain("routeStopped");
    expect(events).toContain("contextStopping");
    expect(events).toContain("contextStopped");
  });

  /**
   * @case Emits routeRegistered when a route is registered after build
   * @preconditions Empty context; route registered via registerRoutes()
   * @expectedResult routeRegistered event fires exactly once
   */
  test("emits routeRegistered when registering after build", async () => {
    const events: string[] = [];
    t = await testContext()
      .on("routeRegistered", () => {
        events.push("routeRegistered");
      })
      .build();
    const def = craft()
      .id("later-route")
      .from(simple([1]))
      .to(log())
      .build()[0];
    t.ctx.registerRoutes(def);
    expect(events).toContain("routeRegistered");
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
      .on("contextStarting", () => {
        throw new Error("startup fail");
      })
      .on("error", ({ details: { error } }) => {
        errors.push(error);
      })
      .build();

    await failingStartup.ctx.start();
    await new Promise((r) => setTimeout(r, 0));

    // 2) Route failure via source throwing
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

    await failingRouteT.ctx.start();
    await new Promise((r) => setTimeout(r, 0));

    // 3) Step failure in process()
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
    const hasStartError = t.errors.some(
      (e) =>
        (e as Error).message?.includes("route start fail") ||
        ((e as Error).cause instanceof Error &&
          (e as Error).cause?.message === "route start fail") ||
        String(e).includes("route start fail"),
    );
    expect(hasStartError).toBeTruthy();
  });

  /**
   * @case test() rejects with timeout when no route ever emits routeStarted
   * @preconditions Route with source that never calls onReady
   * @expectedResult test() rejects after timeout with "Timeout waiting for routes to start"
   */
  test("test() rejects with timeout when route never emits routeStarted", async () => {
    // Callable source that never resolves and never calls onReady
    const neverReady = () => new Promise<void>(() => {});
    t = await testContext()
      .routes(craft().id("never-ready").from(neverReady).to(log()))
      .build();

    await expect(t.test()).rejects.toThrow(
      "Timeout waiting for routes to start",
    );
  }, 15_000);
});
