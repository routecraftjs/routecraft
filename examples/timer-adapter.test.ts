import { describe, test, expect, vi, beforeEach } from "vitest";
import { testContext } from "@routecraft/testing";
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

    // delayBeforeDrainMs gives the timer time to fire (≥2 ticks at 50ms) before drain/stop
    await t.test({ delayBeforeDrainMs: 120 });

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
