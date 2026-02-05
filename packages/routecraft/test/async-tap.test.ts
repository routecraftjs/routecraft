import { describe, test, expect, afterEach, vi } from "vitest";
import {
  context,
  craft,
  simple,
  type CraftContext,
} from "@routecraft/routecraft";

describe("Async Tap Execution", () => {
  let testContext: CraftContext;

  afterEach(async () => {
    if (testContext) {
      await testContext.stop();
    }
    vi.restoreAllMocks();
  });

  /**
   * @case Verify tap runs asynchronously (fire-and-forget)
   * @preconditions Route with tap operation
   * @expectedResult Route completes without waiting for tap
   */
  test("tap executes asynchronously", async () => {
    const tapCompleted = vi.fn();
    const routeCompleted = vi.fn();
    let tapExecutionTime = 0;
    let routeExecutionTime = 0;

    const startTime = Date.now();

    testContext = context()
      .routes(
        craft()
          .id("test-async-tap")
          .from(simple({ data: "test" }))
          .tap(async () => {
            // Simulate slow tap operation
            await new Promise((resolve) => setTimeout(resolve, 100));
            tapExecutionTime = Date.now() - startTime;
            tapCompleted();
          })
          .to(() => {
            routeExecutionTime = Date.now() - startTime;
            routeCompleted();
          }),
      )
      .build();

    await testContext.start();

    // Route should complete before tap
    expect(routeCompleted).toHaveBeenCalledTimes(1);
    expect(routeExecutionTime).toBeLessThan(50); // Route finishes quickly

    // Wait for tap to complete
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(tapCompleted).toHaveBeenCalledTimes(1);
    expect(tapExecutionTime).toBeGreaterThanOrEqual(100); // Tap took its time
  });

  /**
   * @case Verify tap receives exchange snapshot with correlation
   * @preconditions Route with tap operation
   * @expectedResult Tap receives new ID and preserves correlation ID
   */
  test("tap receives exchange snapshot with correlation", async () => {
    const tapSpy = vi.fn();
    let originalCorrelationId: string | undefined;

    testContext = context()
      .routes(
        craft()
          .id("test-tap-snapshot")
          .from(simple({ data: "test" }))
          .to((ex) => {
            originalCorrelationId = ex.headers["routecraft.correlation_id"] as
              | string
              | undefined;
          })
          .tap(tapSpy)
          .to(() => {}),
      )
      .build();

    await testContext.start();

    // Wait for tap to execute
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(tapSpy).toHaveBeenCalledTimes(1);
    const tapExchange = tapSpy.mock.calls[0][0];

    // Tap exchange should have new ID (snapshot)
    expect(tapExchange.id).toBeDefined();
    expect(typeof tapExchange.id).toBe("string");

    // Correlation ID is preserved in snapshot
    expect(tapExchange.headers["routecraft.correlation_id"]).toBe(
      originalCorrelationId,
    );
  });

  /**
   * @case Verify tap errors don't affect main route
   * @preconditions Tap that throws an error
   * @expectedResult Route completes successfully despite tap error
   */
  test("tap errors don't affect main route", async () => {
    const routeCompleted = vi.fn();

    testContext = context()
      .routes(
        craft()
          .id("test-tap-error")
          .from(simple({ data: "test" }))
          .tap(async () => {
            throw new Error("Tap failed");
          })
          .to(routeCompleted),
      )
      .build();

    await testContext.start();

    // Route should complete successfully
    expect(routeCompleted).toHaveBeenCalledTimes(1);
  });

  /**
   * @case Verify tap return values are ignored
   * @preconditions Tap that returns a value
   * @expectedResult Body unchanged, return value discarded
   */
  test("tap return values are ignored", async () => {
    const destSpy = vi.fn();

    testContext = context()
      .routes(
        craft()
          .id("test-tap-return")
          .from(simple({ original: "data" }))
          .tap(async () => {
            return { tapResult: "ignored" };
          })
          .to(destSpy),
      )
      .build();

    await testContext.start();

    expect(destSpy).toHaveBeenCalledTimes(1);
    const finalBody = destSpy.mock.calls[0][0].body;
    expect(finalBody).toEqual({ original: "data" });
  });

  /**
   * @case Verify context.stop() waits for tap jobs (route drain)
   * @preconditions Multiple slow tap operations
   * @expectedResult stop() drains routes and waits for all taps to complete
   */
  test("context.stop() waits for tap jobs via route drain", async () => {
    const tap1Completed = vi.fn();
    const tap2Completed = vi.fn();
    const tap3Completed = vi.fn();

    testContext = context()
      .routes(
        craft()
          .id("test-drain")
          .from(simple([1, 2, 3]))
          .tap(async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
            tap1Completed();
          })
          .tap(async () => {
            await new Promise((resolve) => setTimeout(resolve, 75));
            tap2Completed();
          })
          .tap(async () => {
            await new Promise((resolve) => setTimeout(resolve, 100));
            tap3Completed();
          })
          .to(() => {}),
      )
      .build();

    await testContext.start();

    // stop() aborts sources then drains routes (waits for handlers + taps)
    await testContext.stop();

    // All taps should be completed after stop
    expect(tap1Completed).toHaveBeenCalledTimes(3); // 3 messages
    expect(tap2Completed).toHaveBeenCalledTimes(3);
    expect(tap3Completed).toHaveBeenCalledTimes(3);
  });

  /**
   * @case Verify context.stop() drains before stopping
   * @preconditions Route with tap operations
   * @expectedResult stop() waits for all tap jobs
   */
  test("context.stop() drains before stopping", async () => {
    const tapCompleted = vi.fn();

    testContext = context()
      .routes(
        craft()
          .id("test-stop-drain")
          .from(simple({ data: "test" }))
          .tap(async () => {
            await new Promise((resolve) => setTimeout(resolve, 100));
            tapCompleted();
          })
          .to(() => {}),
      )
      .build();

    await testContext.start();

    // Stop should wait for tap to complete
    await testContext.stop();

    // Tap should be completed after stop
    expect(tapCompleted).toHaveBeenCalledTimes(1);
  });

  /**
   * @case Verify multiple taps execute in parallel
   * @preconditions Multiple tap operations in sequence
   * @expectedResult All taps execute without blocking each other
   */
  test("multiple taps execute in parallel", async () => {
    const tapOrder: number[] = [];

    testContext = context()
      .routes(
        craft()
          .id("test-parallel-taps")
          .from(simple({ data: "test" }))
          .tap(async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
            tapOrder.push(1);
          })
          .tap(async () => {
            await new Promise((resolve) => setTimeout(resolve, 25));
            tapOrder.push(2);
          })
          .tap(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            tapOrder.push(3);
          })
          .to(() => {}),
      )
      .build();

    await testContext.start();
    await testContext.stop();

    // Taps should complete in order of their duration (shortest first)
    // since they run in parallel
    expect(tapOrder).toEqual([3, 2, 1]);
  });
});
