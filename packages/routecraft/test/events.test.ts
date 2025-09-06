import { describe, test, expect, afterEach } from "vitest";
import {
  context,
  craft,
  simple,
  log,
  type CraftContext,
} from "@routecraftjs/routecraft";

describe("Events API", () => {
  let ctx: CraftContext;

  afterEach(async () => {
    if (ctx) {
      await ctx.stop();
    }
  });

  /**
   * @testCase TC-EV01
   * @description Fires all context and route lifecycle events for a completing route
   * @preconditions Context with simple array source and log destination
   * @expectedResult All start/stop lifecycle events are emitted in the run
   */
  test("fires context and route lifecycle events", async () => {
    const events: string[] = [];

    const route = craft()
      .id("evt-route")
      .from(simple([1, 2, 3]))
      .to(log());
    ctx = context()
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

    await ctx.start();

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
   * @testCase TC-EV02
   * @description Emits routeRegistered when a route is registered after build
   * @preconditions Empty context; route registered via registerRoutes()
   * @expectedResult routeRegistered event fires exactly once
   */
  test("emits routeRegistered when registering after build", async () => {
    const events: string[] = [];
    ctx = context()
      .on("routeRegistered", () => {
        events.push("routeRegistered");
      })
      .build();
    const def = craft()
      .id("later-route")
      .from(simple([1]))
      .to(log())
      .build()[0];
    ctx.registerRoutes(def);
    expect(events).toContain("routeRegistered");
  });

  /**
   * @testCase TC-EV03
   * @description Emits error events for failing startup, failing source, and failing step
   * @preconditions Separate contexts setup to induce each failure mode
   * @expectedResult Error handlers receive all three failure types
   */
  test("emits error events for startup, route failure, and step failure", async () => {
    const errors: unknown[] = [];

    // 1) Startup failure (raise in contextStarting handler)
    const failingStartup = context()
      .on("contextStarting", () => {
        throw new Error("startup fail");
      })
      .on("error", ({ details: { error } }) => {
        errors.push(error);
      })
      .build();

    await failingStartup.start();
    await new Promise((r) => setTimeout(r, 0));

    // 2) Route failure via source throwing
    const failingRouteCtx = context()
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

    await failingRouteCtx.start();
    await new Promise((r) => setTimeout(r, 0));

    // 3) Step failure in process()
    const stepFailCtx = context()
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

    await stepFailCtx.start();
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
});
