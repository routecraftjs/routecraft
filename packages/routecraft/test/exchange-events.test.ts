import { describe, test, expect, afterEach } from "vitest";
import { testContext, type TestContext } from "@routecraft/testing";
import { craft, simple, log } from "@routecraft/routecraft";

describe("Exchange and Step Lifecycle Events", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) {
      await t.stop();
    }
  });

  /**
   * @case Fires exchange lifecycle events for each message
   * @preconditions Route with simple source and log destination
   * @expectedResult exchange:started, exchange:completed events fire for each message
   */
  test("fires exchange:started and exchange:completed events", async () => {
    const events: Array<{ type: string; routeId: string; duration?: number }> =
      [];

    const route = craft()
      .id("exchange-evt-route")
      .from(simple([1, 2, 3]))
      .to(log());

    t = await testContext()
      .on("exchange:started", ({ details }) => {
        events.push({
          type: "exchange:started",
          routeId: details.routeId,
        });
      })
      .on("exchange:completed", ({ details }) => {
        events.push({
          type: "exchange:completed",
          routeId: details.routeId,
          duration: details.duration,
        });
      })
      .routes(route)
      .build();

    await t.test();

    // Should have 3 started and 3 completed (one per message)
    const started = events.filter((e) => e.type === "exchange:started");
    const completed = events.filter((e) => e.type === "exchange:completed");

    expect(started).toHaveLength(3);
    expect(completed).toHaveLength(3);

    // All should have routeId
    started.forEach((e) => {
      expect(e.routeId).toBe("exchange-evt-route");
    });

    // Completed events should have duration
    completed.forEach((e) => {
      expect(e.routeId).toBe("exchange-evt-route");
      expect(e.duration).toBeTypeOf("number");
      expect(e.duration).toBeGreaterThanOrEqual(0);
    });
  });

  /**
   * @case Fires exchange:failed event when exchange processing fails
   * @preconditions Route with step that throws error
   * @expectedResult exchange:started and exchange:failed events fire
   */
  test("fires exchange:failed when processing fails", async () => {
    const events: Array<{
      type: string;
      routeId: string;
      duration?: number;
      error?: unknown;
    }> = [];

    t = await testContext()
      .on("exchange:started", ({ details }) => {
        events.push({
          type: "exchange:started",
          routeId: details.routeId,
        });
      })
      .on("exchange:failed", ({ details }) => {
        events.push({
          type: "exchange:failed",
          routeId: details.routeId,
          duration: details.duration,
          error: details.error,
        });
      })
      .routes(
        craft()
          .id("failing-route")
          .from(simple([1]))
          .process(() => {
            throw new Error("step fail");
          }),
      )
      .build();

    await t.test();

    const started = events.filter((e) => e.type === "exchange:started");
    const failed = events.filter((e) => e.type === "exchange:failed");

    expect(started).toHaveLength(1);
    expect(failed).toHaveLength(1);

    expect(failed[0].routeId).toBe("failing-route");
    expect(failed[0].duration).toBeTypeOf("number");
    expect(failed[0].duration).toBeGreaterThanOrEqual(0);
    expect(failed[0].error).toBeDefined();
  });

  /**
   * @case Fires step lifecycle events for each processing step
   * @preconditions Route with multiple processing steps
   * @expectedResult step:started and step:completed events fire for each step
   */
  test("fires step:started and step:completed events", async () => {
    const events: Array<{
      type: string;
      routeId: string;
      operation: string;
      duration?: number;
    }> = [];

    const route = craft()
      .id("step-evt-route")
      .from(simple([1, 2]))
      .process((ex) => {
        // simple() emits each array element separately as individual messages
        const num = ex.body as unknown as number;
        (ex.body as unknown) = num * 2;
        return ex;
      })
      .process((ex) => {
        const num = ex.body as unknown as number;
        (ex.body as unknown) = num + 10;
        return ex;
      })
      .to(log());

    t = await testContext()
      .on("step:started", ({ details }) => {
        events.push({
          type: "step:started",
          routeId: details.routeId,
          operation: details.operation,
        });
      })
      .on("step:completed", ({ details }) => {
        events.push({
          type: "step:completed",
          routeId: details.routeId,
          operation: details.operation,
          duration: details.duration,
        });
      })
      .routes(route)
      .build();

    await t.test();

    const started = events.filter((e) => e.type === "step:started");
    const completed = events.filter((e) => e.type === "step:completed");

    // 2 messages * 3 steps each (process, process, log) = 6 events each
    expect(started).toHaveLength(6);
    expect(completed).toHaveLength(6);

    // All should have routeId and operation
    started.forEach((e) => {
      expect(e.routeId).toBe("step-evt-route");
      expect(e.operation).toBeDefined();
    });

    // Completed events should have duration
    completed.forEach((e) => {
      expect(e.routeId).toBe("step-evt-route");
      expect(e.operation).toBeDefined();
      expect(e.duration).toBeTypeOf("number");
      expect(e.duration).toBeGreaterThanOrEqual(0);
    });
  });

  /**
   * @case Event payloads include contextId and timestamp from EventPayload wrapper
   * @preconditions Route with simple source
   * @expectedResult Events include ts and contextId from payload wrapper
   */
  test("event payloads include contextId and timestamp", async () => {
    let exchangePayload: unknown = null;
    let stepPayload: unknown = null;

    const route = craft()
      .id("payload-test")
      .from(simple([1]))
      .to(log());

    t = await testContext()
      .on("exchange:started", (payload) => {
        exchangePayload = payload;
      })
      .on("step:started", (payload) => {
        stepPayload = payload;
      })
      .routes(route)
      .build();

    await t.test();

    expect(exchangePayload).toBeDefined();
    expect(stepPayload).toBeDefined();

    // Check EventPayload wrapper fields
    expect((exchangePayload as { ts: string }).ts).toBeDefined();
    expect((exchangePayload as { contextId: string }).contextId).toBeDefined();
    expect((exchangePayload as { details: unknown }).details).toBeDefined();

    expect((stepPayload as { ts: string }).ts).toBeDefined();
    expect((stepPayload as { contextId: string }).contextId).toBeDefined();
    expect((stepPayload as { details: unknown }).details).toBeDefined();
  });

  /**
   * @case Event payloads include correlationId for tracing
   * @preconditions Route with simple source
   * @expectedResult Events include correlationId in details
   */
  test("event payloads include correlationId", async () => {
    const correlationIds = new Set<string>();

    const route = craft()
      .id("correlation-test")
      .from(simple([1, 2]))
      .to(log());

    t = await testContext()
      .on("exchange:started", ({ details }) => {
        correlationIds.add(details.correlationId);
      })
      .routes(route)
      .build();

    await t.test();

    // Should have 2 unique correlation IDs (one per message)
    expect(correlationIds.size).toBe(2);
    correlationIds.forEach((id) => {
      expect(id).toBeTruthy();
      expect(typeof id).toBe("string");
    });
  });
});
