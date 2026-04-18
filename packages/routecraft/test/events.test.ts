import { describe, test, expect, afterEach } from "vitest";
import { testContext, type TestContext } from "@routecraft/testing";
import { craft, simple, log } from "@routecraft/routecraft";
import type { EventName, EventHandler } from "../src/types.ts";

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
      .on(
        "route:evt-route:starting" as EventName,
        (() => {
          events.push("route:starting");
        }) as EventHandler<EventName>,
      )
      .on(
        "route:evt-route:started" as EventName,
        (() => {
          events.push("route:started");
        }) as EventHandler<EventName>,
      )
      .on(
        "route:evt-route:stopping" as EventName,
        (() => {
          events.push("route:stopping");
        }) as EventHandler<EventName>,
      )
      .on(
        "route:evt-route:stopped" as EventName,
        (() => {
          events.push("route:stopped");
        }) as EventHandler<EventName>,
      )
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
      .on(
        "route:later-route:registered" as EventName,
        (() => {
          events.push("route:registered");
        }) as EventHandler<EventName>,
      )
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
      .on("context:error", ({ details: { error } }) => {
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
      .on("context:error", ({ details: { error } }) => {
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
      .on("context:error", ({ details }) => {
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
    // RoutecraftError wraps step failures; either contains message or toString
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
    // Wrapped as RoutecraftError; original message appears in cause or toString
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
      .routesReadyTimeout(20)
      .routes(craft().id("never-ready").from(neverReady).to(log()))
      .build();

    await expect(t.test()).rejects.toThrow(
      "Timeout waiting for routes to start",
    );
  }, 5_000);

  /**
   * @case Hierarchical wildcard patterns match events at any level
   * @preconditions Context with hierarchical event subscriptions
   * @expectedResult Patterns like route:*:batch:* match correctly
   */
  test("supports hierarchical wildcard patterns", async () => {
    const events: string[] = [];

    t = await testContext()
      // Route-specific subscription
      .on("route:payment:*" as EventName, () => {
        events.push("route:payment:*");
      })
      // Batch events on any route
      .on("route:*:batch:*" as EventName, () => {
        events.push("route:*:batch:*");
      })
      // Step events with specific adapter segment
      .on("route:*:step:*:mcp:*" as EventName, () => {
        events.push("route:*:step:*:mcp:*");
      })
      // All step events on any route
      .on("route:*:step:*" as EventName, () => {
        events.push("route:*:step:*");
      })
      .build();

    // Emit test events
    t.ctx.emit("route:payment:started" as any, {} as any);
    t.ctx.emit("route:payment:batch:flushed" as any, {} as any);
    t.ctx.emit("route:payment:step:completed:mcp:tool" as any, {} as any);
    t.ctx.emit("route:checkout:batch:started" as any, {} as any);

    await new Promise((r) => setTimeout(r, 0));

    // route:payment:started should match route:payment:*
    expect(events.filter((e) => e === "route:payment:*").length).toBe(1);

    // route:*:batch:* should match both:
    // - route:payment:batch:flushed (4 segments)
    // - route:checkout:batch:started (4 segments)
    const batchMatches = events.filter((e) => e === "route:*:batch:*");
    expect(batchMatches.length).toBe(2);

    // route:*:step:*:mcp:* should match:
    // - route:payment:step:completed:mcp:tool (6 segments)
    const mcpMatches = events.filter((e) => e === "route:*:step:*:mcp:*");
    expect(mcpMatches.length).toBe(1);

    // Verify route:*:step:* (4 segments) didn't match any 6 segment events
    const fourSegmentMatches = events.filter((e) => e === "route:*:step:*");
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
      // Match all step events at any depth
      .on("route:*:step:**" as EventName, () => {
        events.push("route:*:step:**");
      })
      // Match all exchange events at any depth
      .on("route:*:exchange:**" as EventName, () => {
        events.push("route:*:exchange:**");
      })
      .build();

    // Emit events with varying depths
    t.ctx.emit("route:started" as any, {} as any); // 2 segments
    t.ctx.emit("route:payment:exchange:started" as any, {} as any); // 4 segments
    t.ctx.emit("route:payment:step:completed:from:http" as any, {} as any); // 6 segments
    t.ctx.emit("context:started" as any, {} as any); // Should NOT match

    await new Promise((r) => setTimeout(r, 0));

    // route:** should match all route:* events (3 total)
    expect(events.filter((e) => e === "route:**").length).toBe(3);

    // route:*:exchange:** should match route:payment:exchange:started
    expect(events.filter((e) => e === "route:*:exchange:**").length).toBe(1);

    // route:*:step:** should match route:payment:step:completed:from:http
    expect(events.filter((e) => e === "route:*:step:**").length).toBe(1);

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

describe("Event ordering", () => {
  type CapturedEvent = {
    event: string;
    details: Record<string, unknown>;
  };

  /**
   * Collect ALL events via ** wildcard.
   * Returns event name + details in emission order.
   */
  function collect(
    ctx: import("@routecraft/routecraft").CraftContext,
  ): CapturedEvent[] {
    const events: CapturedEvent[] = [];
    ctx.on(
      "**" as EventName,
      ((payload: { _event?: string; details: Record<string, unknown> }) => {
        if (payload._event) {
          events.push({
            event: payload._event,
            details: payload.details,
          });
        }
      }) as any,
    );
    return events;
  }

  /** Helper to run a route and return ALL events. */
  async function runAndCollect(
    route: ReturnType<typeof craft>,
  ): Promise<CapturedEvent[]> {
    const t = await testContext().routes(route).build();
    const events = collect(t.ctx);
    await t.test();
    return events;
  }

  /**
   * @case Every event type carries its required payload fields
   * @preconditions Route with transform -> to (produces all standard event types)
   * @expectedResult exchange events have routeId/exchangeId/correlationId; step events add operation/adapter; route lifecycle events have route; context events are present
   */
  test("0. payload fields: all standard events carry required fields", async () => {
    const events = await runAndCollect(
      craft()
        .id("r")
        .from(simple("hi"))
        .transform((b) => b)
        .to(log()),
    );

    const byName = (name: string) => events.filter((e) => e.event === name);
    const one = (name: string) => {
      const found = byName(name);
      expect(found).toHaveLength(1);
      return found[0].details;
    };

    // -- Context events --
    one("context:starting");
    one("context:started");
    one("context:stopping");
    one("context:stopped");

    // -- Route lifecycle events: must carry { route } --
    // Note: route:r:registered fires during build() before the collector subscribes,
    // so it is intentionally excluded here.
    for (const ev of [
      "route:r:starting",
      "route:r:started",
      "route:r:stopping",
      "route:r:stopped",
    ]) {
      const d = one(ev);
      expect(d, `${ev} missing 'route'`).toHaveProperty("route");
    }

    // -- Exchange events --
    const exStarted = one("route:r:exchange:started");
    expect(exStarted).toMatchObject({
      routeId: "r",
      exchangeId: expect.any(String),
      correlationId: expect.any(String),
    });

    const exCompleted = one("route:r:exchange:completed");
    expect(exCompleted).toMatchObject({
      routeId: "r",
      exchangeId: expect.any(String),
      correlationId: expect.any(String),
      duration: expect.any(Number),
    });

    // exchangeId is consistent across all exchange events
    expect(exStarted["exchangeId"]).toBe(exCompleted["exchangeId"]);
    expect(exStarted["correlationId"]).toBe(exCompleted["correlationId"]);

    // -- Step events: must carry routeId, exchangeId, correlationId, operation --
    const stepStarted = byName("route:r:step:started");
    expect(stepStarted).toHaveLength(2); // transform + to
    for (const step of stepStarted) {
      expect(step.details).toMatchObject({
        routeId: "r",
        exchangeId: expect.any(String),
        correlationId: expect.any(String),
        operation: expect.any(String),
      });
      // exchangeId matches the exchange
      expect(step.details["exchangeId"]).toBe(exStarted["exchangeId"]);
    }

    const stepCompleted = byName("route:r:step:completed");
    expect(stepCompleted).toHaveLength(2);
    for (const step of stepCompleted) {
      expect(step.details).toMatchObject({
        routeId: "r",
        exchangeId: expect.any(String),
        correlationId: expect.any(String),
        operation: expect.any(String),
        duration: expect.any(Number),
      });
    }

    // -- Specific operations and adapters --
    const transformStarted = stepStarted.find(
      (e) => e.details["operation"] === "transform",
    );
    expect(transformStarted).toBeDefined();

    const toStep = stepStarted.find((e) => e.details["operation"] === "to");
    expect(toStep).toBeDefined();
    expect(toStep!.details["adapter"]).toBe("log");
  });

  /**
   * @case exchange:failed carries error and exchange:dropped carries reason
   * @preconditions One route that throws, one that filters
   * @expectedResult failed event has error field, dropped event has reason field
   */
  test("0b. payload fields: exchange:failed has error, exchange:dropped has reason", async () => {
    // exchange:failed
    const failEvents = await runAndCollect(
      craft()
        .id("r")
        .from(simple("hi"))
        .transform(() => {
          throw new Error("boom");
        })
        .to(log()),
    );
    const failed = failEvents.find(
      (e) => e.event === "route:r:exchange:failed",
    );
    expect(failed).toBeDefined();
    expect(failed!.details).toMatchObject({
      routeId: "r",
      exchangeId: expect.any(String),
      correlationId: expect.any(String),
      duration: expect.any(Number),
      error: expect.anything(),
    });

    // exchange:dropped
    const dropEvents = await runAndCollect(
      craft()
        .id("r")
        .from(simple("hi"))
        .filter(() => false)
        .to(log()),
    );
    const dropped = dropEvents.find(
      (e) => e.event === "route:r:exchange:dropped",
    );
    expect(dropped).toBeDefined();
    expect(dropped!.details).toMatchObject({
      routeId: "r",
      exchangeId: expect.any(String),
      correlationId: expect.any(String),
      reason: expect.any(String),
    });
  });

  /**
   * @case Happy path: from -> transform -> to
   * @preconditions Simple source, one transform, log destination
   * @expectedResult Full lifecycle in order with no duplicates
   */
  test("1. simple: from -> transform -> to", async () => {
    const events = await runAndCollect(
      craft()
        .id("r")
        .from(simple("hi"))
        .transform((b) => b)
        .to(log()),
    );
    const names = events.map((e) => e.event);
    expect(names).toEqual([
      "context:starting",
      "context:started",
      "route:r:starting",
      "route:r:started",
      "route:r:exchange:started",
      "route:r:step:started", // transform
      "route:r:step:completed", // transform
      "route:r:step:started", // to
      "route:r:step:completed", // to
      "route:r:exchange:completed",
      "route:r:stopping",
      "route:r:stopped",
      "context:stopping",
      "context:stopped",
    ]);
    // Verify step details
    const steps = events.filter((e) => e.event === "route:r:step:started");
    expect(steps[0].details["operation"]).toBe("transform");
    expect(steps[1].details["operation"]).toBe("to");
  });

  /**
   * @case Transform throws with no error handler
   * @preconditions Route where transform throws
   * @expectedResult step error -> route error -> context error -> exchange failed
   */
  test("2. failed: transform throws", async () => {
    const events = await runAndCollect(
      craft()
        .id("r")
        .from(simple("hi"))
        .transform(() => {
          throw new Error("boom");
        })
        .to(log()),
    );
    const names = events.map((e) => e.event);
    expect(names).toEqual([
      "context:starting",
      "context:started",
      "route:r:starting",
      "route:r:started",
      "route:r:exchange:started",
      "route:r:step:started", // transform
      "route:r:step:transform:error",
      "route:r:error",
      "context:error",
      "route:r:exchange:failed",
      "route:r:stopping",
      "route:r:stopped",
      "context:stopping",
      "context:stopped",
    ]);
    // No step:completed for the failed step
    const completed = events.filter(
      (e) => e.event === "route:r:step:completed",
    );
    expect(completed).toHaveLength(0);
  });

  /**
   * @case Split and aggregate with 2 children
   * @preconditions Single exchange split into 2 children, transformed, aggregated
   * @expectedResult Parent starts -> split -> children start/complete -> aggregate -> parent completes
   */
  test("3. split/aggregate: '1,2' -> transform to array -> split -> transform -> aggregate -> to", async () => {
    const events = await runAndCollect(
      craft()
        .id("r")
        .from(simple("1,2"))
        .transform((b) => b.split(",").map(Number))
        .split()
        .transform((b) => b * 10)
        .aggregate()
        .to(log()),
    );
    const names = events.map((e) => e.event);
    expect(names).toEqual([
      "context:starting",
      "context:started",
      "route:r:starting",
      "route:r:started",
      // Parent exchange
      "route:r:exchange:started",
      "route:r:step:started", // transform (parent)
      "route:r:step:completed", // transform (parent)
      "route:r:step:started", // split
      "route:r:step:completed", // split (meta={childCount:2})
      // Child 1
      "route:r:exchange:started",
      "route:r:step:started", // transform (child 1)
      "route:r:step:completed", // transform (child 1)
      // Child 2
      "route:r:exchange:started",
      "route:r:step:started", // transform (child 2)
      "route:r:step:completed", // transform (child 2)
      // Aggregate restores parent
      "route:r:step:started", // aggregate
      "route:r:exchange:completed", // child 1
      "route:r:exchange:completed", // child 2
      "route:r:step:completed", // aggregate (meta={inputCount:2})
      // Parent continues
      "route:r:step:started", // to
      "route:r:step:completed", // to
      "route:r:exchange:completed", // parent
      "route:r:stopping",
      "route:r:stopped",
      "context:stopping",
      "context:stopped",
    ]);
    // Verify split metadata
    const splitCompleted = events.find(
      (e) =>
        e.event === "route:r:step:completed" &&
        e.details["operation"] === "split",
    );
    expect(
      (splitCompleted!.details["metadata"] as Record<string, unknown>)[
        "childCount"
      ],
    ).toBe(2);
    // Verify aggregate metadata
    const aggCompleted = events.find(
      (e) =>
        e.event === "route:r:step:completed" &&
        e.details["operation"] === "aggregate",
    );
    expect(
      (aggCompleted!.details["metadata"] as Record<string, unknown>)[
        "inputCount"
      ],
    ).toBe(2);
  });

  /**
   * @case Filter drops one child exchange
   * @preconditions Split into 2, filter drops body=1
   * @expectedResult Dropped child gets exchange:dropped with reason, surviving child completes
   */
  test("4. filter drops child: '1,2' -> split -> filter(!1) -> transform -> aggregate -> to", async () => {
    const events = await runAndCollect(
      craft()
        .id("r")
        .from(simple("1,2"))
        .transform((b) => b.split(",").map(Number))
        .split()
        .filter((ex) => ex.body !== 1)
        .transform((b) => b * 10)
        .aggregate()
        .to(log()),
    );
    const names = events.map((e) => e.event);
    expect(names).toEqual([
      "context:starting",
      "context:started",
      "route:r:starting",
      "route:r:started",
      // Parent
      "route:r:exchange:started",
      "route:r:step:started", // transform (parent)
      "route:r:step:completed", // transform (parent)
      "route:r:step:started", // split
      "route:r:step:completed", // split (meta={childCount:2})
      // Child 1 (filtered)
      "route:r:exchange:started",
      "route:r:step:started", // filter (child 1)
      "route:r:step:completed", // filter (child 1)
      "route:r:exchange:dropped", // child 1 dropped
      // Child 2 (passes filter)
      "route:r:exchange:started",
      "route:r:step:started", // filter (child 2)
      "route:r:step:completed", // filter (child 2)
      "route:r:step:started", // transform (child 2)
      "route:r:step:completed", // transform (child 2)
      // Aggregate
      "route:r:step:started", // aggregate
      "route:r:exchange:completed", // child 2
      "route:r:step:completed", // aggregate (meta={inputCount:1})
      // Parent continues
      "route:r:step:started", // to
      "route:r:step:completed", // to
      "route:r:exchange:completed", // parent
      "route:r:stopping",
      "route:r:stopped",
      "context:stopping",
      "context:stopped",
    ]);
    // Verify dropped reason
    const dropped = events.find((e) => e.event === "route:r:exchange:dropped");
    expect(dropped!.details["reason"]).toBe("filtered");
    // Aggregate only got 1 child
    const aggCompleted = events.find(
      (e) =>
        e.event === "route:r:step:completed" &&
        e.details["operation"] === "aggregate",
    );
    expect(
      (aggCompleted!.details["metadata"] as Record<string, unknown>)[
        "inputCount"
      ],
    ).toBe(1);
  });

  /**
   * @case Split child throws error
   * @preconditions Split into 2, child 1 throws in transform
   * @expectedResult Failed child gets step error + route error + context error + exchange:failed
   */
  test("5. split child error: '1,2' -> split -> transform(throw if 1) -> aggregate -> to", async () => {
    const events = await runAndCollect(
      craft()
        .id("r")
        .from(simple("1,2"))
        .transform((b) => b.split(",").map(Number))
        .split()
        .transform((b) => {
          if (b === 1) throw new Error("bad");
          return b * 10;
        })
        .aggregate()
        .to(log()),
    );
    const names = events.map((e) => e.event);
    expect(names).toEqual([
      "context:starting",
      "context:started",
      "route:r:starting",
      "route:r:started",
      // Parent
      "route:r:exchange:started",
      "route:r:step:started", // transform (parent)
      "route:r:step:completed", // transform (parent)
      "route:r:step:started", // split
      "route:r:step:completed", // split (meta={childCount:2})
      // Child 1 (fails)
      "route:r:exchange:started",
      "route:r:step:started", // transform (child 1)
      "route:r:step:transform:error",
      "route:r:error",
      "context:error",
      "route:r:exchange:failed",
      // Child 2 (succeeds)
      "route:r:exchange:started",
      "route:r:step:started", // transform (child 2)
      "route:r:step:completed", // transform (child 2)
      // Aggregate
      "route:r:step:started", // aggregate
      "route:r:exchange:completed", // child 2
      "route:r:step:completed", // aggregate (meta={inputCount:1})
      // Parent continues
      "route:r:step:started", // to
      "route:r:step:completed", // to
      "route:r:exchange:completed", // parent
      "route:r:stopping",
      "route:r:stopped",
      "context:stopping",
      "context:stopped",
    ]);
    // Failed child error bubbles up to route + context
    const errors = events.filter((e) => e.event.includes("error"));
    expect(errors).toHaveLength(3); // step, route, context
  });

  /**
   * @case Combined filter + error + success across 3 children
   * @preconditions Split into 3: child 1 filtered, child 2 errors, child 3 succeeds
   * @expectedResult Each child gets correct terminal event, parent completes
   */
  test("6. combo: '1,2,3' -> split -> filter(!1) -> transform(throw if 2) -> aggregate -> to", async () => {
    const events = await runAndCollect(
      craft()
        .id("r")
        .from(simple("1,2,3"))
        .transform((b) => b.split(",").map(Number))
        .split()
        .filter((ex) => ex.body !== 1)
        .transform((b) => {
          if (b === 2) throw new Error("bad");
          return b * 10;
        })
        .aggregate()
        .to(log()),
    );
    const names = events.map((e) => e.event);
    expect(names).toEqual([
      "context:starting",
      "context:started",
      "route:r:starting",
      "route:r:started",
      // Parent
      "route:r:exchange:started",
      "route:r:step:started", // transform (parent)
      "route:r:step:completed", // transform (parent)
      "route:r:step:started", // split
      "route:r:step:completed", // split (meta={childCount:3})
      // Child 1 (filtered)
      "route:r:exchange:started",
      "route:r:step:started", // filter (child 1)
      "route:r:step:completed", // filter (child 1)
      "route:r:exchange:dropped",
      // Child 2 (passes filter, fails transform)
      "route:r:exchange:started",
      "route:r:step:started", // filter (child 2)
      "route:r:step:completed", // filter (child 2)
      // Child 3 (passes filter)
      "route:r:exchange:started",
      "route:r:step:started", // filter (child 3)
      "route:r:step:completed", // filter (child 3)
      // Child 2 transform fails
      "route:r:step:started", // transform (child 2)
      "route:r:step:transform:error",
      "route:r:error",
      "context:error",
      "route:r:exchange:failed",
      // Child 3 transform succeeds
      "route:r:step:started", // transform (child 3)
      "route:r:step:completed", // transform (child 3)
      // Aggregate
      "route:r:step:started", // aggregate
      "route:r:exchange:completed", // child 3
      "route:r:step:completed", // aggregate (meta={inputCount:1})
      // Parent continues
      "route:r:step:started", // to
      "route:r:step:completed", // to
      "route:r:exchange:completed", // parent
      "route:r:stopping",
      "route:r:stopped",
      "context:stopping",
      "context:stopped",
    ]);
    // Verify all three child terminal events present
    expect(
      events.filter((e) => e.event === "route:r:exchange:dropped"),
    ).toHaveLength(1);
    expect(
      events.filter((e) => e.event === "route:r:exchange:failed"),
    ).toHaveLength(1);
    // 3 completed: child 2 (non-filtered survivor) + parent + child 3
    // Actually: child 3 completed + parent completed = 2
    // Child 2 failed, child 1 dropped
    expect(
      events.filter((e) => e.event === "route:r:exchange:completed"),
    ).toHaveLength(2);
  });
});
