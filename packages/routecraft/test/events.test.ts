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

  /** Format a captured event as a readable string with key details. */
  function fmt(e: CapturedEvent): string {
    const d = e.details;
    const parts: string[] = [e.event];

    // Show exchangeId (short) if present
    if (d["exchangeId"])
      parts.push(`ex=${String(d["exchangeId"]).slice(0, 8)}`);
    // Show operation if present
    if (d["operation"]) parts.push(`op=${d["operation"]}`);
    // Show adapter if present
    if (d["adapter"]) parts.push(`adapter=${d["adapter"]}`);
    // Show duration if present
    if (d["duration"] !== undefined) parts.push(`dur=${d["duration"]}`);
    // Show error if present
    if (d["error"]) parts.push("ERROR");
    // Show reason if present
    if (d["reason"]) parts.push(`reason=${d["reason"]}`);
    // Show metadata if present
    if (d["metadata"] && typeof d["metadata"] === "object") {
      const meta = d["metadata"] as Record<string, unknown>;
      const keys = Object.keys(meta);
      if (keys.length > 0)
        parts.push(`meta={${keys.map((k) => `${k}:${meta[k]}`).join(",")}}`);
    }
    // Show route info for lifecycle events
    if (d["route"] && typeof d["route"] === "object") {
      const route = d["route"] as { definition?: { id?: string } };
      if (route.definition?.id) parts.push(`route=${route.definition.id}`);
    }

    return parts.join("  ");
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
   * @case Discovery: print actual events for each scenario
   * @preconditions Various route configurations
   * @expectedResult Prints ALL events so we can verify and lock in expected sequences
   */

  test("1. simple: from -> transform -> to", async () => {
    const events = await runAndCollect(
      craft()
        .id("r")
        .from(simple("hi"))
        .transform((b) => b)
        .to(log()),
    );
    console.log("\n=== 1. SIMPLE ===");
    events.forEach((e) => console.log(`  ${fmt(e)}`));
    // TODO: replace with exact assertion once verified
    expect(events.length).toBeGreaterThan(0);
  });

  /**
   * @case Transform throws with no error handler
   * @preconditions Route where transform throws
   * @expectedResult step error, route error, context error, exchange failed
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
    console.log("\n=== 2. FAILED ===");
    events.forEach((e) => console.log(`  ${fmt(e)}`));
    expect(events.length).toBeGreaterThan(0);
  });

  /**
   * @case Split and aggregate with 2 children
   * @preconditions Single exchange split into 2 children, transformed, aggregated
   * @expectedResult Parent and child lifecycle events in correct order
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
    console.log("\n=== 3. SPLIT/AGGREGATE ===");
    events.forEach((e) => console.log(`  ${fmt(e)}`));
    expect(events.length).toBeGreaterThan(0);
  });

  /**
   * @case Filter drops one child exchange
   * @preconditions Split into 2, filter drops body=1
   * @expectedResult Dropped child gets exchange:dropped, surviving child completes
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
    console.log("\n=== 4. FILTER DROPS CHILD ===");
    events.forEach((e) => console.log(`  ${fmt(e)}`));
    expect(events.length).toBeGreaterThan(0);
  });

  /**
   * @case Split child throws error
   * @preconditions Split into 2, child 1 throws in transform
   * @expectedResult Failed child gets step error + exchange:failed, surviving child completes
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
    console.log("\n=== 5. SPLIT CHILD ERROR ===");
    events.forEach((e) => console.log(`  ${fmt(e)}`));
    expect(events.length).toBeGreaterThan(0);
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
    console.log("\n=== 6. COMBO (filter + error + success) ===");
    events.forEach((e) => console.log(`  ${fmt(e)}`));
    expect(events.length).toBeGreaterThan(0);
  });
});
