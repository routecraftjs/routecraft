import { describe, test, expect, afterEach } from "vitest";
import { testContext, type TestContext } from "@routecraft/testing";
import { craft, event, log, simple } from "@routecraft/routecraft";
import { EventSourceAdapter } from "../../src/adapters/sources/event/index.ts";

describe("Event Source Adapter", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) {
      await t.stop();
    }
  });

  /**
   * @case Event adapter subscribes to single event and receives payloads
   * @preconditions Route using event('route:started') as source
   * @expectedResult Handler receives route:started event payload
   */
  test("subscribes to single event", async () => {
    const events: any[] = [];

    const eventRoute = craft()
      .id("event-listener")
      .from(event("route:started"))
      .to((ex) => {
        events.push(ex.body);
      });

    const triggerRoute = craft()
      .id("trigger-route")
      .from(simple("test"))
      .to(log());

    t = await testContext().routes([eventRoute, triggerRoute]).build();

    // Start context and wait for routes to be ready
    const started = t.ctx.start();
    await new Promise((r) => setTimeout(r, 100));

    // Stop the context (this will abort the event route)
    await t.stop();
    await started;

    // Should have received route:started event for both routes
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(
      events.some((e) => e.details?.route?.definition?.id === "trigger-route"),
    ).toBe(true);
  });

  /**
   * @case Event adapter subscribes to multiple events using array
   * @preconditions Route using event(['route:started', 'route:stopped']) as source
   * @expectedResult Handler receives both event types
   */
  test("subscribes to multiple events", async () => {
    const events: any[] = [];

    const eventRoute = craft()
      .id("multi-event-listener")
      .from(event(["route:started", "route:stopped"]))
      .to((ex) => {
        events.push(ex.body);
      });

    const triggerRoute = craft()
      .id("trigger-route-2")
      .from(simple("test"))
      .to(log());

    t = await testContext().routes([eventRoute, triggerRoute]).build();

    const started = t.ctx.start();
    await new Promise((r) => setTimeout(r, 100));
    await t.stop();
    await started;

    // Should have received both route:started and route:stopped
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.some((e) => e.details?.route)).toBe(true);
  });

  /**
   * @case Event adapter supports 'route:*' wildcard to match all route events
   * @preconditions Route using event('route:*') as source
   * @expectedResult Handler receives route:started, route:stopped, etc.
   */
  test("supports route:* wildcard", async () => {
    const events: any[] = [];

    const eventRoute = craft()
      .id("route-wildcard-listener")
      .from(event("route:*"))
      .to((ex) => {
        events.push(ex.body);
      });

    const triggerRoute = craft()
      .id("trigger-route-3")
      .from(simple("test"))
      .to(log());

    t = await testContext().routes([eventRoute, triggerRoute]).build();

    const started = t.ctx.start();
    await new Promise((r) => setTimeout(r, 100));
    await t.stop();
    await started;

    // Should have received route lifecycle events
    expect(events.length).toBeGreaterThanOrEqual(1);
    // All events should be route-related (have route in details)
    expect(
      events.every((e) => e.details?.route || e.details === undefined),
    ).toBe(true);
  });

  /**
   * @case Event adapter supports multiple patterns to match lifecycle events
   * @preconditions Route using event(['context:*', 'route:*']) to avoid circular routes
   * @expectedResult Handler receives context and route lifecycle events safely
   */
  test("supports multiple patterns for lifecycle events", async () => {
    const events: any[] = [];

    const eventRoute = craft()
      .id("lifecycle-listener")
      .from(
        event([
          "context:*",
          "route:registered",
          "route:starting",
          "route:started",
          "route:stopping",
          "route:stopped",
        ]),
      )
      .to((ex) => {
        events.push(ex.body);
      });

    const triggerRoute = craft()
      .id("trigger-route-4")
      .from(simple("test"))
      .to(log());

    t = await testContext().routes([eventRoute, triggerRoute]).build();

    const started = t.ctx.start();
    await new Promise((r) => setTimeout(r, 100));
    await t.stop();
    await started;

    // Should have received context + route lifecycle events (no operation/exchange events to prevent loops)
    expect(events.length).toBeGreaterThanOrEqual(2);
  });

  /**
   * @case Event adapter unsubscribes when route stops
   * @preconditions Route with event source, manually stopped
   * @expectedResult No events received after route stops
   */
  test("unsubscribes on route stop", async () => {
    const events: any[] = [];

    const eventRoute = craft()
      .id("unsubscribe-test")
      .from(event("route:started"))
      .to((ex) => {
        events.push(ex.body);
      });

    t = await testContext().routes(eventRoute).build();

    const started = t.ctx.start();
    await new Promise((r) => setTimeout(r, 100));
    await t.stop();
    await started;

    const beforeCount = events.length;

    // Stop the event route
    const route = t.ctx["routes"].find(
      (r: any) => r.definition.id === "unsubscribe-test",
    );
    if (route) {
      route.stop();
    }

    await new Promise((r) => setTimeout(r, 50));

    // Should not have received new events after stopping
    expect(events.length).toBe(beforeCount);
  });

  /**
   * @case Event adapter provides event payload with timestamp, context, and details
   * @preconditions Route using event source
   * @expectedResult Exchange body contains ts, context, and details fields
   */
  test("provides complete event payload", async () => {
    let payload: any;

    const eventRoute = craft()
      .id("payload-test")
      .from(event("route:started"))
      .to((ex) => {
        if (!payload) {
          payload = ex.body;
        }
      });

    const triggerRoute = craft()
      .id("trigger-route-5")
      .from(simple("test"))
      .to(log());

    t = await testContext().routes([eventRoute, triggerRoute]).build();

    const started = t.ctx.start();
    await new Promise((r) => setTimeout(r, 100));
    await t.stop();
    await started;

    expect(payload).toBeDefined();
    expect(payload.ts).toBeDefined();
    expect(typeof payload.ts).toBe("string");
    expect(payload.contextId).toBeDefined();
    expect(typeof payload.contextId).toBe("string");
    expect(payload.details).toBeDefined();
    expect(payload.details.route).toBeDefined();
  });

  /**
   * @case Event adapter works in real-world monitoring scenario
   * @preconditions Event listener routing to log destination
   * @expectedResult Events flow through and are logged
   */
  test("integration: event monitoring route", async () => {
    const logged: any[] = [];

    const monitorRoute = craft()
      .id("event-monitor")
      .from(event(["error", "route:started", "route:stopped"]))
      .to((ex) => {
        const payload = ex.body;
        logged.push({
          eventType: "route" in payload.details ? "route" : "system",
          timestamp: payload.ts,
          routeId:
            "route" in payload.details
              ? (payload.details as { route: { definition: { id: string } } })
                  .route?.definition?.id
              : undefined,
        });
      });

    const workRoute = craft()
      .id("work-route")
      .from(simple([1, 2, 3]))
      .to(log());

    t = await testContext().routes([monitorRoute, workRoute]).build();

    const started = t.ctx.start();
    await new Promise((r) => setTimeout(r, 100));
    await t.stop();
    await started;

    expect(logged.length).toBeGreaterThanOrEqual(1);
    expect(logged.some((l) => l.routeId === "work-route")).toBe(true);
  });

  /**
   * @case Event source adapter logs handler failures at warn level
   * @preconditions Direct EventSourceAdapter subscription with a throwing handler
   * @expectedResult Adapter catches the rejection, logs a warn entry, and avoids error-level logging for that failure
   */
  test("handles errors in event handlers", async () => {
    t = await testContext().build();

    const adapter = new EventSourceAdapter("context:started");
    const abortController = new AbortController();
    const subscription = adapter.subscribe(
      t.ctx,
      async () => {
        throw new Error("Handler error");
      },
      abortController,
    );

    t.ctx.emit("context:started", {});
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      t.logger.warn.mock.calls.some(
        ([fields, message]) =>
          message === "Handler error" &&
          (fields as { adapter?: string; err?: { message?: string } })
            .adapter === "event" &&
          (fields as { adapter?: string; err?: { message?: string } }).err
            ?.message === "Handler error",
      ),
    ).toBe(true);
    expect(
      t.logger.error.mock.calls.some(
        ([, message]) => message === "Handler error",
      ),
    ).toBe(false);

    abortController.abort();
    await subscription;
  });

  /**
   * @case Event source adapter prefers Routecraft-style meta.message in warn logs
   * @preconditions Direct EventSourceAdapter subscription with a throwing handler object containing both meta.message and message
   * @expectedResult Warn log uses meta.message while preserving the original error object in bindings
   */
  test("prefers meta.message when event handler errors include it", async () => {
    t = await testContext().build();

    const adapter = new EventSourceAdapter("context:started");
    const abortController = new AbortController();
    const subscription = adapter.subscribe(
      t.ctx,
      async () => {
        throw {
          meta: { message: "Routecraft handler error" },
          message: "Plain handler error",
        };
      },
      abortController,
    );

    t.ctx.emit("context:started", {});
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      t.logger.warn.mock.calls.some(
        ([fields, message]) =>
          message === "Routecraft handler error" &&
          (
            fields as {
              err?: { meta?: { message?: string }; message?: string };
            }
          ).err?.meta?.message === "Routecraft handler error" &&
          (
            fields as {
              err?: { meta?: { message?: string }; message?: string };
            }
          ).err?.message === "Plain handler error",
      ),
    ).toBe(true);

    abortController.abort();
    await subscription;
  });

  /**
   * @case Event adapter can filter context events specifically
   * @preconditions Route using event('context:*') pattern
   * @expectedResult Only receives context lifecycle events
   */
  test("filters context events with wildcard", async () => {
    const events: any[] = [];

    const eventRoute = craft()
      .id("context-events")
      .from(event("context:*"))
      .to((ex) => {
        events.push(ex.body);
      });

    const triggerRoute = craft()
      .id("trigger-route-6")
      .from(simple("test"))
      .to(log());

    t = await testContext().routes([eventRoute, triggerRoute]).build();

    const started = t.ctx.start();
    await new Promise((r) => setTimeout(r, 100));
    await t.stop();
    await started;

    // Should have received context events (context:starting, context:started, etc.)
    expect(events.length).toBeGreaterThanOrEqual(1);
  });
});
