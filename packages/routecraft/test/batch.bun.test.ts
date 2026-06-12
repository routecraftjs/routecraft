import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import FakeTimers from "@sinonjs/fake-timers";
import { BatchConsumer } from "../src/consumers/batch.ts";
import { CraftContext } from "../src/context.ts";
import { InMemoryProcessingQueue } from "../src/queue.ts";
import type { Exchange } from "../src/exchange.ts";
import type { RouteDefinition } from "../src/route.ts";
import type { Message } from "../src/types.ts";

function createRouteDefinition(id: string): RouteDefinition {
  return {
    id,
    sources: [{ subscribe: async () => {} }],
    steps: [],
    preParseFilters: [],
    postParseFilters: [],
    postFromFilters: [],
    consumer: { type: BatchConsumer, options: {} },
  } as RouteDefinition;
}

let clock: ReturnType<typeof FakeTimers.install> | undefined;

describe("BatchConsumer", () => {
  beforeEach(() => {
    clock = FakeTimers.install({
      now: new Date("2026-01-01T00:00:00.000Z"),
      shouldAdvanceTime: false,
      toFake: ["setTimeout", "setInterval", "Date", "setImmediate"],
    });
  });

  afterEach(() => {
    clock?.uninstall();
    clock = undefined;
  });

  /**
   * @case Verifies batch timing starts when the first message is queued
   * @preconditions Batch consumer is registered before any messages arrive
   * @expectedResult batch:started is deferred until first enqueue and flushed waitTime excludes idle registration time
   */
  test("Starts timing and emits batch:started on first queued message", async () => {
    const ctx = new CraftContext();
    const queue = new InMemoryProcessingQueue<Message>();
    const consumer = new BatchConsumer({
      context: ctx,
      definition: createRouteDefinition("batched-route"),
      channel: queue,
      options: { size: 10, time: 50 },
    });
    const started: unknown[] = [];
    const flushed: unknown[] = [];

    ctx.on("route:batch:started", ({ details }) => {
      started.push(details);
    });
    ctx.on("route:batch:flushed", ({ details }) => {
      flushed.push(details);
    });

    consumer.register(async ({ message }) => {
      return {
        id: "exchange-id",
        body: message,
        headers: {},
        logger: ctx.logger,
      } as Exchange;
    });

    await clock!.tickAsync(200);
    expect(started).toHaveLength(0);

    const exchangePromise = queue.enqueue({ message: "hello", headers: {} });

    expect(started).toHaveLength(1);
    expect(flushed).toHaveLength(0);

    await clock!.tickAsync(49);
    expect(flushed).toHaveLength(0);

    await clock!.tickAsync(1);
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
    const consumer = new BatchConsumer({
      context: ctx,
      definition: createRouteDefinition("batched-parse"),
      channel: queue,
      options: { size: 10, time: 50 },
    });

    type HandlerCall = {
      message: unknown;
      parseProvided: boolean;
      mode: string | undefined;
    };
    const calls: HandlerCall[] = [];

    consumer.register(async ({ message, parse, parseFailureMode }) => {
      calls.push({
        message,
        parseProvided: typeof parse === "function",
        mode: parseFailureMode,
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
    // the batch consumer hands the handler an envelope carrying the raw
    // message plus a parse fn that rethrows the captured error.
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
    await clock!.tickAsync(50);
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
   * @case Per-item parse-failure path forwards the source-supplied headers
   *       (including `routecraft.auth.principal`) so authz checks in
   *       `.error()` see the same identity the source resolved
   * @preconditions Bad item with `routecraft.auth.principal` set on the
   *                queued Message's headers
   * @expectedResult Handler is invoked with the same headers, principal intact
   */
  test("forwards principal header through the per-item parse-failure path", async () => {
    const ctx = new CraftContext();
    const queue = new InMemoryProcessingQueue<Message>();
    const consumer = new BatchConsumer({
      context: ctx,
      definition: createRouteDefinition("batched-principal-parse-fail"),
      channel: queue,
      options: { size: 10, time: 50 },
    });

    const calls: { principal: unknown }[] = [];

    consumer.register(async ({ message, headers }) => {
      calls.push({ principal: headers?.["routecraft.auth.principal"] });
      return {
        id: "exchange-id",
        body: message,
        headers: {},
        logger: ctx.logger,
      } as Exchange;
    });

    const principal = {
      kind: "custom" as const,
      scheme: "bearer" as const,
      subject: "user-1",
    };

    const badPromise = queue.enqueue({
      message: "not-json",
      headers: { "routecraft.auth.principal": principal },
      parse: (raw) => JSON.parse(raw as string),
      parseFailureMode: "fail",
    });

    await badPromise;
    expect(calls).toHaveLength(1);
    expect(calls[0].principal).toEqual(principal);
  });

  /**
   * @case Merged-batch path uses last-write-wins semantics for headers,
   *       including `routecraft.auth.principal`; multi-identity batches
   *       resolve to the last item's principal. Documented on `register()`;
   *       routes needing per-item identity should use the simple consumer
   *       or supply a custom `merge`.
   * @preconditions Two queued items, each with a different principal in headers
   * @expectedResult Handler is invoked once with the second item's principal
   */
  test("merges principal header with last-write-wins semantics", async () => {
    const ctx = new CraftContext();
    const queue = new InMemoryProcessingQueue<Message>();
    const consumer = new BatchConsumer({
      context: ctx,
      definition: createRouteDefinition("batched-principal-merged"),
      channel: queue,
      options: { size: 10, time: 50 },
    });

    const calls: { principal: unknown }[] = [];

    consumer.register(async ({ message, headers }) => {
      calls.push({ principal: headers?.["routecraft.auth.principal"] });
      return {
        id: "exchange-id",
        body: message,
        headers: {},
        logger: ctx.logger,
      } as Exchange;
    });

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
      headers: { "routecraft.auth.principal": principalA },
    });
    const promiseB = queue.enqueue({
      message: 2,
      headers: { "routecraft.auth.principal": principalB },
    });

    await clock!.tickAsync(50);
    await Promise.all([promiseA, promiseB]);

    // One merged invocation; last-wins on the principal header.
    expect(calls).toHaveLength(1);
    expect(calls[0].principal).toEqual(principalB);
  });

  /**
   * @case batch:stopped is emitted when the route stopping signal fires
   * @preconditions BatchConsumer registered; route:stopping emitted for the same route id
   * @expectedResult batch:stopped event fires with routeId and batchId
   */
  test("emits batch:stopped when route:stopping fires for the same route", async () => {
    const routeId = "batched-stopped-route";
    const ctx = new CraftContext();
    const queue = new InMemoryProcessingQueue<Message>();
    const consumer = new BatchConsumer({
      context: ctx,
      definition: createRouteDefinition(routeId),
      channel: queue,
      options: { size: 10, time: 50 },
    });

    const stopped: unknown[] = [];
    ctx.on("route:batch:stopped", ({ details }) => {
      stopped.push(details);
    });

    consumer.register(async ({ message }) => {
      return {
        id: "exchange-id",
        body: message,
        headers: {},
        logger: ctx.logger,
      } as Exchange;
    });

    ctx.emit("route:stopping", {
      route: { definition: { id: routeId } },
    } as never);

    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toMatchObject({ routeId });
  });
});
