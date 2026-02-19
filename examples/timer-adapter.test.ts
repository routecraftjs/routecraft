import { describe, test, expect, vi, beforeEach } from "vitest";
import { testContext } from "@routecraft/routecraft";
import timerRoutes from "./timer-adapter.mjs";

describe("Timer Adapter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * @case Verifies that timer emits messages at specified interval
   * @preconditions Timer route with 50ms interval
   * @expectedResult Should emit multiple messages before being stopped
   */
  test("emits messages at specified interval", async () => {
    const t = await testContext().routes(timerRoutes).build();

    // Start the timer and wait for a few intervals
    const execution = t.ctx.start();
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Stop the timer and wait for execution to complete
    await t.ctx.stop();
    await execution;

    // Should have logged multiple times
    expect(t.logger.info).toHaveBeenCalled();
    expect(
      (t.logger.info as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeGreaterThanOrEqual(2);
  });

  /**
   * @case Verifies that timer stops when context is stopped
   * @preconditions Active timer route
   * @expectedResult Should stop emitting after context stop
   */
  test("stops emitting when context stops", async () => {
    const logSpy = vi.spyOn(console, "log");
    const t = await testContext().routes(timerRoutes).build();

    // Start and immediately stop
    const execution = t.ctx.start();
    await t.ctx.stop();
    await execution;

    const initialCallCount = logSpy.mock.calls.length;

    // Wait to verify no more messages
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Call count should not have increased
    expect(logSpy.mock.calls.length).toBe(initialCallCount);
  }, 1000); // Add timeout to prevent test from hanging
});
