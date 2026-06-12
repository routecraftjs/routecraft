import { describe, test, expect, afterEach } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  craft,
  simple,
  log,
  type AnyRouteBuilder,
} from "@routecraft/routecraft";
import { forRoute } from "../src/types.ts";
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
      .on("route:starting", (() => {
        events.push("route:starting");
      }) as EventHandler<EventName>)
      .on("route:started", (() => {
        events.push("route:started");
      }) as EventHandler<EventName>)
      .on("route:stopping", (() => {
        events.push("route:stopping");
      }) as EventHandler<EventName>)
      .on("route:stopped", (() => {
        events.push("route:stopped");
      }) as EventHandler<EventName>)
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
      .on("route:registered", (() => {
        events.push("route:registered");
      }) as EventHandler<EventName>)
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
    const neverReady = (sub: { signal: AbortSignal }) =>
      new Promise<void>((resolve) => {
        sub.signal.addEventListener("abort", () => resolve(), {
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
   * @case Legacy wildcard patterns are rejected loudly at subscribe time
   * @preconditions Fixed-name event model; identity lives in the payload
   * @expectedResult ctx.on with any pattern containing * (other than the
   *   bare catch-all) throws RC2001 with migration guidance
   */
  test("rejects legacy wildcard patterns with migration guidance", async () => {
    t = await testContext().build();

    for (const pattern of [
      "route:*",
      "route:**",
      "route:*:exchange:*",
      "route:payment:*",
      "plugin:*:*",
    ]) {
      expect(() => t.ctx.on(pattern as never, () => {})).toThrow(
        /identity lives in the payload/,
      );
    }
  });

  /**
   * @case The catch-all "*" observes every emitted event
   * @preconditions Subscription via ctx.on("*")
   * @expectedResult Handler receives all events with _event set to the
   *   exact fixed name
   */
  test('catch-all "*" observes every event', async () => {
    const seen: string[] = [];
    t = await testContext().build();
    t.ctx.on("*", (payload) => {
      seen.push((payload as { _event: string })._event);
    });

    t.ctx.emit("route:started", { routeId: "r", route: {} as never });
    t.ctx.emit("route:exchange:started", {
      routeId: "r",
      exchangeId: "e",
      correlationId: "c",
    });
    t.ctx.emit("context:error", { error: new Error("x") });

    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([
      "route:started",
      "route:exchange:started",
      "context:error",
    ]);
  });

  /**
   * @case forRoute filters exact-name subscriptions by payload routeId
   * @preconditions Two routes' events emitted on the same fixed name
   * @expectedResult Only the matching route's events reach the handler
   */
  test("forRoute filters by payload routeId", async () => {
    const seen: string[] = [];
    t = await testContext().build();
    t.ctx.on(
      "route:exchange:started",
      forRoute("orders", ({ details }) => {
        seen.push(details.exchangeId);
      }),
    );

    t.ctx.emit("route:exchange:started", {
      routeId: "orders",
      exchangeId: "e1",
      correlationId: "c1",
    });
    t.ctx.emit("route:exchange:started", {
      routeId: "billing",
      exchangeId: "e2",
      correlationId: "c2",
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual(["e1"]);
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
      "*" as EventName,
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
    route: AnyRouteBuilder,
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
      "route:starting",
      "route:started",
      "route:stopping",
      "route:stopped",
    ]) {
      const d = one(ev);
      expect(d, `${ev} missing 'route'`).toHaveProperty("route");
    }

    // -- Exchange events --
    // Match against shallow clones because bun:test's toMatchObject mutates
    // the actual object, replacing matched fields with matcher refs. We
    // need to read exchangeId/correlationId AFTER asserting shape.
    const exStarted = one("route:exchange:started");
    expect({ ...exStarted }).toMatchObject({
      routeId: "r",
      exchangeId: expect.any(String),
      correlationId: expect.any(String),
    });

    const exCompleted = one("route:exchange:completed");
    expect({ ...exCompleted }).toMatchObject({
      routeId: "r",
      exchangeId: expect.any(String),
      correlationId: expect.any(String),
      duration: expect.any(Number),
    });

    // exchangeId is consistent across all exchange events
    expect(exStarted["exchangeId"]).toBe(exCompleted["exchangeId"]);
    expect(exStarted["correlationId"]).toBe(exCompleted["correlationId"]);

    // -- Step events: must carry routeId, exchangeId, correlationId, operation --
    const stepStarted = byName("route:step:started");
    expect(stepStarted).toHaveLength(2); // transform + to
    for (const step of stepStarted) {
      expect({ ...step.details }).toMatchObject({
        routeId: "r",
        exchangeId: expect.any(String),
        correlationId: expect.any(String),
        operation: expect.any(String),
      });
      // exchangeId matches the exchange
      expect(step.details["exchangeId"]).toBe(exStarted["exchangeId"]);
    }

    const stepCompleted = byName("route:step:completed");
    expect(stepCompleted).toHaveLength(2);
    for (const step of stepCompleted) {
      expect({ ...step.details }).toMatchObject({
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
    const failed = failEvents.find((e) => e.event === "route:exchange:failed");
    expect(failed).toBeDefined();
    expect({ ...failed!.details }).toMatchObject({
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
      (e) => e.event === "route:exchange:dropped",
    );
    expect(dropped).toBeDefined();
    expect({ ...dropped!.details }).toMatchObject({
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
      "route:starting",
      "route:started",
      "route:exchange:started",
      "route:step:started", // transform
      "route:step:completed", // transform
      "route:step:started", // to
      "route:step:completed", // to
      "route:exchange:completed",
      "route:stopping",
      "route:stopped",
      "context:stopping",
      "context:stopped",
    ]);
    // Verify step details
    const steps = events.filter((e) => e.event === "route:step:started");
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
      "route:starting",
      "route:started",
      "route:exchange:started",
      "route:step:started", // transform
      "route:step:error",
      "route:error",
      "context:error",
      "route:exchange:failed",
      "route:stopping",
      "route:stopped",
      "context:stopping",
      "context:stopped",
    ]);
    // No step:completed for the failed step
    const completed = events.filter((e) => e.event === "route:step:completed");
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
      "route:starting",
      "route:started",
      // Parent exchange
      "route:exchange:started",
      "route:step:started", // transform (parent)
      "route:step:completed", // transform (parent)
      "route:step:started", // split
      "route:step:completed", // split (meta={childCount:2})
      // Child 1
      "route:exchange:started",
      "route:step:started", // transform (child 1)
      "route:step:completed", // transform (child 1)
      // Child 2
      "route:exchange:started",
      "route:step:started", // transform (child 2)
      "route:step:completed", // transform (child 2)
      // Aggregate restores parent
      "route:step:started", // aggregate
      "route:exchange:completed", // child 1
      "route:exchange:completed", // child 2
      "route:step:completed", // aggregate (meta={inputCount:2})
      // Parent continues
      "route:step:started", // to
      "route:step:completed", // to
      "route:exchange:completed", // parent
      "route:stopping",
      "route:stopped",
      "context:stopping",
      "context:stopped",
    ]);
    // Verify split metadata
    const splitCompleted = events.find(
      (e) =>
        e.event === "route:step:completed" &&
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
        e.event === "route:step:completed" &&
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
      "route:starting",
      "route:started",
      // Parent
      "route:exchange:started",
      "route:step:started", // transform (parent)
      "route:step:completed", // transform (parent)
      "route:step:started", // split
      "route:step:completed", // split (meta={childCount:2})
      // Child 1 (filtered)
      "route:exchange:started",
      "route:step:started", // filter (child 1)
      "route:step:completed", // filter (child 1)
      "route:exchange:dropped", // child 1 dropped
      // Child 2 (passes filter)
      "route:exchange:started",
      "route:step:started", // filter (child 2)
      "route:step:completed", // filter (child 2)
      "route:step:started", // transform (child 2)
      "route:step:completed", // transform (child 2)
      // Aggregate
      "route:step:started", // aggregate
      "route:exchange:completed", // child 2
      "route:step:completed", // aggregate (meta={inputCount:1})
      // Parent continues
      "route:step:started", // to
      "route:step:completed", // to
      "route:exchange:completed", // parent
      "route:stopping",
      "route:stopped",
      "context:stopping",
      "context:stopped",
    ]);
    // Verify dropped reason
    const dropped = events.find((e) => e.event === "route:exchange:dropped");
    expect(dropped!.details["reason"]).toBe("filtered");
    // Aggregate only got 1 child
    const aggCompleted = events.find(
      (e) =>
        e.event === "route:step:completed" &&
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
      "route:starting",
      "route:started",
      // Parent
      "route:exchange:started",
      "route:step:started", // transform (parent)
      "route:step:completed", // transform (parent)
      "route:step:started", // split
      "route:step:completed", // split (meta={childCount:2})
      // Child 1 (fails)
      "route:exchange:started",
      "route:step:started", // transform (child 1)
      "route:step:error",
      "route:error",
      "context:error",
      "route:exchange:failed",
      // Child 2 (succeeds)
      "route:exchange:started",
      "route:step:started", // transform (child 2)
      "route:step:completed", // transform (child 2)
      // Aggregate
      "route:step:started", // aggregate
      "route:exchange:completed", // child 2
      "route:step:completed", // aggregate (meta={inputCount:1})
      // Parent continues
      "route:step:started", // to
      "route:step:completed", // to
      "route:exchange:completed", // parent
      "route:stopping",
      "route:stopped",
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
      "route:starting",
      "route:started",
      // Parent
      "route:exchange:started",
      "route:step:started", // transform (parent)
      "route:step:completed", // transform (parent)
      "route:step:started", // split
      "route:step:completed", // split (meta={childCount:3})
      // Child 1 (filtered)
      "route:exchange:started",
      "route:step:started", // filter (child 1)
      "route:step:completed", // filter (child 1)
      "route:exchange:dropped",
      // Child 2 (passes filter, fails transform)
      "route:exchange:started",
      "route:step:started", // filter (child 2)
      "route:step:completed", // filter (child 2)
      // Child 3 (passes filter)
      "route:exchange:started",
      "route:step:started", // filter (child 3)
      "route:step:completed", // filter (child 3)
      // Child 2 transform fails
      "route:step:started", // transform (child 2)
      "route:step:error",
      "route:error",
      "context:error",
      "route:exchange:failed",
      // Child 3 transform succeeds
      "route:step:started", // transform (child 3)
      "route:step:completed", // transform (child 3)
      // Aggregate
      "route:step:started", // aggregate
      "route:exchange:completed", // child 3
      "route:step:completed", // aggregate (meta={inputCount:1})
      // Parent continues
      "route:step:started", // to
      "route:step:completed", // to
      "route:exchange:completed", // parent
      "route:stopping",
      "route:stopped",
      "context:stopping",
      "context:stopped",
    ]);
    // Verify all three child terminal events present
    expect(
      events.filter((e) => e.event === "route:exchange:dropped"),
    ).toHaveLength(1);
    expect(
      events.filter((e) => e.event === "route:exchange:failed"),
    ).toHaveLength(1);
    // 3 completed: child 2 (non-filtered survivor) + parent + child 3
    // Actually: child 3 completed + parent completed = 2
    // Child 2 failed, child 1 dropped
    expect(
      events.filter((e) => e.event === "route:exchange:completed"),
    ).toHaveLength(2);
  });
});
