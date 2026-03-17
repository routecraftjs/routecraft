import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { BatchConsumer } from "../src/consumers/batch.ts";
import { CraftContext } from "../src/context.ts";
import { InMemoryProcessingQueue } from "../src/queue.ts";
import type { Exchange } from "../src/exchange.ts";
import type { RouteDefinition } from "../src/route.ts";
import type { Message } from "../src/types.ts";

function createRouteDefinition(id: string): RouteDefinition {
  return {
    id,
    source: { subscribe: async () => {} },
    steps: [],
    consumer: { type: BatchConsumer as never, options: {} },
  } as RouteDefinition;
}

describe("BatchConsumer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * @case Verifies batch timing starts when the first message is queued
   * @preconditions Batch consumer is registered before any messages arrive
   * @expectedResult batch:started is deferred until first enqueue and flushed waitTime excludes idle registration time
   */
  test("Starts timing and emits batch:started on first queued message", async () => {
    const ctx = new CraftContext();
    const queue = new InMemoryProcessingQueue<Message>();
    const consumer = new BatchConsumer(
      ctx,
      createRouteDefinition("batched-route"),
      queue,
      { size: 10, time: 50 },
    );
    const started: unknown[] = [];
    const flushed: unknown[] = [];

    ctx.on("route:batched-route:batch:started", ({ details }) => {
      started.push(details);
    });
    ctx.on("route:batched-route:batch:flushed", ({ details }) => {
      flushed.push(details);
    });

    await consumer.register(async (message) => {
      return {
        id: "exchange-id",
        body: message,
        headers: {},
        logger: ctx.logger,
      } as Exchange;
    });

    await vi.advanceTimersByTimeAsync(200);
    expect(started).toHaveLength(0);

    const exchangePromise = queue.enqueue({ message: "hello", headers: {} });

    expect(started).toHaveLength(1);
    expect(flushed).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(49);
    expect(flushed).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    await exchangePromise;

    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toMatchObject({
      routeId: "batched-route",
      batchSize: 1,
      reason: "time",
      waitTime: 50,
    });
  });
});
