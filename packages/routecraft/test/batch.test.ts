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

  /**
   * @case Parse failures route through the registered handler with the parse fn (#187)
   * @preconditions Batch consumer; enqueue one item with a failing parse and one with a passing parse
   * @expectedResult Bad item invokes the registered handler with raw message + parse fn + parseFailureMode; good item is added to the batch and flushed normally with the parsed value
   */
  test("routes parse failures through the registered handler instead of swallowing them", async () => {
    const ctx = new CraftContext();
    const queue = new InMemoryProcessingQueue<Message>();
    const consumer = new BatchConsumer(
      ctx,
      createRouteDefinition("batched-parse"),
      queue,
      { size: 10, time: 50 },
    );

    type HandlerCall = {
      message: unknown;
      parseProvided: boolean;
      mode: string | undefined;
    };
    const calls: HandlerCall[] = [];

    await consumer.register(async (message, _headers, parse, mode) => {
      calls.push({
        message,
        parseProvided: typeof parse === "function",
        mode,
      });
      return {
        id: "exchange-id",
        body: message,
        headers: {},
        logger: ctx.logger,
      } as Exchange;
    });

    // Enqueue a good item first so the batch starts.
    const goodPromise = queue.enqueue({
      message: '{"id":1}',
      headers: {},
      parse: (raw) => JSON.parse(raw as string),
      parseFailureMode: "fail",
    });

    // Enqueue a bad item: pre-parse will throw and the consumer must
    // route through the registered handler with the parse fn so the
    // synthetic parse step (in the real route runtime) can fire RC5016.
    const badPromise = queue.enqueue({
      message: "not-json",
      headers: {},
      parse: (raw) => JSON.parse(raw as string),
      parseFailureMode: "fail",
    });

    // The bad item is routed immediately as its own per-item exchange:
    // the batch consumer calls handler(rawMessage, headers, parse, mode).
    await badPromise;
    expect(
      calls.some(
        (c) =>
          c.message === "not-json" &&
          c.parseProvided === true &&
          c.mode === "fail",
      ),
    ).toBe(true);

    // The good item stays in the batch until the timer fires.
    await vi.advanceTimersByTimeAsync(50);
    await goodPromise;
    expect(
      calls.some(
        (c) =>
          // After pre-parse the merged batch body is the parsed array.
          Array.isArray(c.message) &&
          c.message.length === 1 &&
          (c.message[0] as { id?: number }).id === 1,
      ),
    ).toBe(true);
  });

  /**
   * @case Per-item parse-failure path forwards `message.principal` so authz
   *       checks in `.error()` see the same identity the source resolved
   * @preconditions Bad item with a `principal` set on the queued Message
   * @expectedResult Handler is invoked with the principal as its 5th arg
   */
  test("forwards principal through the per-item parse-failure path", async () => {
    const ctx = new CraftContext();
    const queue = new InMemoryProcessingQueue<Message>();
    const consumer = new BatchConsumer(
      ctx,
      createRouteDefinition("batched-principal-parse-fail"),
      queue,
      { size: 10, time: 50 },
    );

    const calls: { principal: unknown }[] = [];

    await consumer.register(
      async (_message, _headers, _parse, _mode, principal) => {
        calls.push({ principal });
        return {
          id: "exchange-id",
          body: _message,
          headers: {},
          logger: ctx.logger,
        } as Exchange;
      },
    );

    const principal = {
      kind: "custom" as const,
      scheme: "bearer" as const,
      subject: "user-1",
    };

    const badPromise = queue.enqueue({
      message: "not-json",
      headers: {},
      parse: (raw) => JSON.parse(raw as string),
      parseFailureMode: "fail",
      principal,
    });

    await badPromise;
    expect(calls).toHaveLength(1);
    expect(calls[0].principal).toEqual(principal);
  });

  /**
   * @case Merged-batch path drops principals by design (multi-principal merge
   *       has no defined policy); contract is documented on `register()`
   * @preconditions Two queued items, each with a principal set
   * @expectedResult Handler is invoked once with `principal === undefined`
   *                 because the merged exchange does not carry per-item identity
   */
  test("does not forward principal through the merged batch path", async () => {
    const ctx = new CraftContext();
    const queue = new InMemoryProcessingQueue<Message>();
    const consumer = new BatchConsumer(
      ctx,
      createRouteDefinition("batched-principal-merged"),
      queue,
      { size: 10, time: 50 },
    );

    const calls: { principal: unknown }[] = [];

    await consumer.register(
      async (_message, _headers, _parse, _mode, principal) => {
        calls.push({ principal });
        return {
          id: "exchange-id",
          body: _message,
          headers: {},
          logger: ctx.logger,
        } as Exchange;
      },
    );

    const principalA = {
      kind: "custom" as const,
      scheme: "bearer" as const,
      subject: "user-a",
    };
    const principalB = {
      kind: "custom" as const,
      scheme: "bearer" as const,
      subject: "user-b",
    };

    const promiseA = queue.enqueue({
      message: 1,
      headers: {},
      principal: principalA,
    });
    const promiseB = queue.enqueue({
      message: 2,
      headers: {},
      principal: principalB,
    });

    await vi.advanceTimersByTimeAsync(50);
    await Promise.all([promiseA, promiseB]);

    // One merged invocation; principal arg is intentionally undefined.
    expect(calls).toHaveLength(1);
    expect(calls[0].principal).toBeUndefined();
  });
});
