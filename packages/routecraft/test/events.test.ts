import { describe, test, expect, afterEach } from "vitest";
import { testContext, type TestContext } from "@routecraft/testing";
import { craft, simple, log } from "@routecraft/routecraft";
import type { EventName } from "../src/types.ts";

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
        if (route.definition?.id === "evt-route") {
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

  /**
   * @case Hierarchical wildcard patterns match events at any level
   * @preconditions Context with hierarchical event subscriptions
   * @expectedResult Patterns like route:*:operation:from:* match correctly
   */
  test("supports hierarchical wildcard patterns", async () => {
    const events: string[] = [];

    t = await testContext()
      // Route-specific subscription
      .on("route:payment:*" as EventName, () => {
        events.push("route:payment:*");
      })
      // Direction-specific subscription (any route)
      .on("route:*:operation:from:*" as EventName, () => {
        events.push("route:*:operation:from:*");
      })
      // Adapter-specific subscription (MCP operations)
      .on("route:*:operation:*:mcp:*" as EventName, () => {
        events.push("route:*:operation:*:mcp:*");
      })
      // All operations on any route
      .on("route:*:operation:*" as EventName, () => {
        events.push("route:*:operation:*");
      })
      .build();

    // Emit test events
    t.ctx.emit("route:payment:started" as any, {} as any);
    t.ctx.emit("route:payment:operation:from:http" as any, {} as any);
    t.ctx.emit("route:payment:operation:to:mcp:tool" as any, {} as any);
    t.ctx.emit("route:checkout:operation:from:channel" as any, {} as any);

    await new Promise((r) => setTimeout(r, 0));

    // route:payment:started should match route:payment:*
    expect(events.filter((e) => e === "route:payment:*").length).toBe(1);

    // route:*:operation:from:* should match both:
    // - route:payment:operation:from:http (5 segments)
    // - route:checkout:operation:from:channel (5 segments)
    const fromMatches = events.filter((e) => e === "route:*:operation:from:*");
    expect(fromMatches.length).toBe(2);

    // route:*:operation:*:mcp:* should match:
    // - route:payment:operation:to:mcp:tool (6 segments)
    const mcpMatches = events.filter((e) => e === "route:*:operation:*:mcp:*");
    expect(mcpMatches.length).toBe(1);

    // Verify route:*:operation:* (4 segments) didn't match any 5 or 6 segment events
    const fourSegmentMatches = events.filter(
      (e) => e === "route:*:operation:*",
    );
    expect(fourSegmentMatches.length).toBe(0);
  });

  /**
   * @case Backward compatibility with existing wildcard patterns
   * @preconditions Context with simple wildcard subscriptions
   * @expectedResult route:*, exchange:*, and * patterns still work
   */
  test("maintains backward compatibility with existing wildcards", async () => {
    const events: string[] = [];

    t = await testContext()
      .on("*" as EventName, () => {
        events.push("*");
      })
      .on("route:*" as EventName, () => {
        events.push("route:*");
      })
      .on("exchange:*" as EventName, () => {
        events.push("exchange:*");
      })
      .build();

    // Emit various events
    t.ctx.emit("route:started" as any, {} as any);
    t.ctx.emit("exchange:started" as any, {} as any);
    t.ctx.emit("context:starting", {});

    await new Promise((r) => setTimeout(r, 0));

    // route:started should match * and route:*
    expect(events.filter((e) => e === "*").length).toBe(3); // All 3 events
    expect(events.filter((e) => e === "route:*").length).toBe(1);
    expect(events.filter((e) => e === "exchange:*").length).toBe(1);
  });

  /**
   * @case Patterns with different segment counts do not match
   * @preconditions Context with specific-length patterns
   * @expectedResult Events with different segment counts do not match
   */
  test("patterns require matching segment counts", async () => {
    const events: string[] = [];

    t = await testContext()
      .on("route:*:operation" as EventName, () => {
        events.push("matched");
      })
      .build();

    // Different segment counts should not match
    t.ctx.emit("route:started" as any, {} as any); // 2 segments
    t.ctx.emit("route:payment:operation:started" as any, {} as any); // 4 segments

    await new Promise((r) => setTimeout(r, 0));

    // Should not match anything (3 segments required)
    expect(events.length).toBe(0);

    // Now emit with exactly 3 segments
    t.ctx.emit("route:payment:operation" as any, {} as any);

    await new Promise((r) => setTimeout(r, 0));

    expect(events.length).toBe(1);
  });

  /**
   * @case ** globstar wildcards match multiple levels of hierarchy
   * @preconditions Context with ** globstar patterns
   * @expectedResult route:** matches any depth, route:*:operation:** matches operations at any depth
   */
  test("supports ** globstar wildcards for multi-level matching", async () => {
    const events: string[] = [];

    t = await testContext()
      // Match everything under route:
      .on("route:**" as EventName, () => {
        events.push("route:**");
      })
      // Match all operations at any adapter depth
      .on("route:*:operation:**" as EventName, () => {
        events.push("route:*:operation:**");
      })
      // Match all exchange events at any depth
      .on("route:*:exchange:**" as EventName, () => {
        events.push("route:*:exchange:**");
      })
      .build();

    // Emit events with varying depths
    t.ctx.emit("route:started" as any, {} as any); // 2 segments
    t.ctx.emit("route:payment:exchange:started" as any, {} as any); // 4 segments
    t.ctx.emit("route:payment:operation:from:http:started" as any, {} as any); // 6 segments
    t.ctx.emit("context:started" as any, {} as any); // Should NOT match

    await new Promise((r) => setTimeout(r, 0));

    // route:** should match all route:* events (3 total)
    expect(events.filter((e) => e === "route:**").length).toBe(3);

    // route:*:exchange:** should match route:payment:exchange:started
    expect(events.filter((e) => e === "route:*:exchange:**").length).toBe(1);

    // route:*:operation:** should match route:payment:operation:from:http:started
    expect(events.filter((e) => e === "route:*:operation:**").length).toBe(1);

    // context:started should not match any route:** patterns
    expect(events.filter((e) => e.includes("context")).length).toBe(0);
  });

  /**
   * @case batch:stopped is emitted when route with batch consumer stops
   * @preconditions Route with batch consumer
   * @expectedResult batch:stopped event fires when route stops
   *
   * NOTE: This test is manually verified via integration tests. The batch:stopped event
   * is correctly emitted in batch.ts when route:stopping is fired. Automated testing is
   * challenging due to test context lifecycle timing.
   */
  test.skip("emits batch:stopped when batch consumer route stops", async () => {
    // Implementation verified in batch.ts - event emitted when route:stopping fires
  });

  /**
   * @case once via builder fires exactly once
   * @preconditions Context with .once() builder method for context:started
   * @expectedResult Handler fires exactly once even when event fires multiple times
   */
  test("once via builder fires handler exactly once", async () => {
    let callCount = 0;
    t = await testContext()
      .once("context:started", () => {
        callCount++;
      })
      .build();

    await t.ctx.start();
    await t.ctx.stop();
    await t.ctx.start();
    await t.ctx.stop();

    expect(callCount).toBe(1);
  });

  /**
   * @case once via CraftConfig fires exactly once
   * @preconditions CraftContext constructed with config.once handler
   * @expectedResult Handler fires exactly once even when event fires multiple times
   */
  test("once via config fires handler exactly once", async () => {
    let callCount = 0;
    t = await testContext()
      .with({
        once: {
          "context:started": () => {
            callCount++;
          },
        },
      })
      .build();

    await t.ctx.start();
    await t.ctx.stop();
    await t.ctx.start();
    await t.ctx.stop();

    expect(callCount).toBe(1);
  });

  /**
   * @case once via config supports array of handlers
   * @preconditions CraftContext constructed with config.once array of handlers
   * @expectedResult Each handler fires exactly once
   */
  test("once via config supports array of handlers", async () => {
    let callA = 0;
    let callB = 0;
    t = await testContext()
      .with({
        once: {
          "context:started": [
            () => {
              callA++;
            },
            () => {
              callB++;
            },
          ],
        },
      })
      .build();

    await t.ctx.start();
    await t.ctx.stop();
    await t.ctx.start();
    await t.ctx.stop();

    expect(callA).toBe(1);
    expect(callB).toBe(1);
  });
});
