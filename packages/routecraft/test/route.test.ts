import { type } from "arktype";
import { describe, test, expect, afterEach, vi, beforeEach } from "vitest";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import {
  craft,
  simple,
  log,
  noop,
  DefaultExchange,
  getExchangeContext,
} from "@routecraft/routecraft";
import { defaultAggregate } from "../src/operations/aggregate.ts";
import type { Exchange } from "@routecraft/routecraft";

describe("Route Behavior", () => {
  let t: TestContext;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    if (t) {
      await t.stop();
    }
  });

  /**
   * @case Verifies that a route processes messages through its pipeline
   * @preconditions Route with source, processor, and destination
   * @expectedResult Message should flow through entire pipeline
   */
  test("processes messages through pipeline", async () => {
    const transformerSpy = vi.fn((body) => body);
    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("test-pipeline")
          .from(simple("test-message"))
          .transform(transformerSpy)
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(transformerSpy).toHaveBeenCalled();
    expect(s.received).toHaveLength(1);
    expect(s.received[0].body).toBe("test-message");
  });

  /**
   * @case Verifies that a route can continue after a to step has been called.
   * @preconditions A route with a processor step after the to step.
   * @expectedResult The route can continue after the to step has been called.
   */
  test("route can continue after a to step has been called", async () => {
    const s1 = spy();
    const s2 = spy();
    const processorSpy = vi.fn((exchange) => exchange);

    t = await testContext()
      .routes(
        craft()
          .id("test-route")
          .from(simple("test-message"))
          .to(s1)
          .to(s2)
          .process(processorSpy),
      )
      .build();

    await t.ctx.start();

    expect(s1.received).toHaveLength(1);
    expect(s2.received).toHaveLength(1);
    expect(processorSpy).toHaveBeenCalled();
  });

  /**
   * @case Verifies that route stops when context is stopped
   * @preconditions Active route with continuous source
   * @expectedResult Route should stop processing when context stops
   */
  test("stops processing when context stops", async () => {
    const processorSpy = vi.fn((exchange) => exchange);

    t = await testContext()
      .routes(
        craft()
          .id("continuous-route")
          .from({
            subscribe: async (_, handler, controller) => {
              // Keep track of messages processed
              let messageCount = 0;
              while (!controller.signal.aborted && messageCount < 3) {
                await handler("test");
                messageCount++;
                // Smaller delay to speed up test
                await new Promise((resolve) => setTimeout(resolve, 1));
              }
            },
          })
          .process(processorSpy)
          .to(noop()),
      )
      .build();

    const execution = t.ctx.start();

    const initialCallCount = processorSpy.mock.calls.length;
    await t.stop();
    await execution;

    // Verify no new messages were processed after stopping
    expect(processorSpy.mock.calls.length).toBe(initialCallCount);
    expect(initialCallCount).toBeGreaterThan(0); // Verify some messages were processed
  }, 1000); // Increase timeout slightly but keep it reasonable

  /**
   * @case Verifies that route properly handles processor errors
   * @preconditions Route with failing processor
   * @expectedResult Should continue running and log error
   */
  test("handles processor errors gracefully", async () => {
    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("error-route")
          .from(simple("test"))
          .process(() => {
            throw new Error("Processor error");
          })
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(t.logger.error).toHaveBeenCalled();
    expect(s.received).toHaveLength(0);
    expect((t.logger.error as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe(
      "Processor error",
    );
  });

  /**
   * @case Returns final exchange to the source when route has multiple steps including a to step
   * @preconditions Custom source awaiting handler result
   * @expectedResult Source receives the final exchange after all steps complete
   */
  test("returns final exchange to source (with to)", async () => {
    let finalFromSource: any | undefined;

    t = await testContext()
      .routes(
        craft()
          .id("return-final-with-to")
          .from<string>({
            subscribe: async (_ctx, handler, controller) => {
              try {
                finalFromSource = await handler("hello");
              } finally {
                controller.abort();
              }
            },
          })
          .transform((body) => body.toUpperCase())
          .to(noop())
          .process((exchange) => {
            exchange.body = `${exchange.body}!`;
            return exchange;
          })
          .transform((body) => `${body} DONE`),
      )
      .build();

    await t.ctx.start();

    expect(finalFromSource).toBeDefined();
    expect(finalFromSource.body).toBe("HELLO! DONE");
  });

  /**
   * @case Returns final exchange to the source when route has no to step
   * @preconditions Custom source awaiting handler result
   * @expectedResult Source receives the final exchange after all steps complete
   */
  test("returns final exchange to source (without to)", async () => {
    let finalFromSource: any | undefined;

    t = await testContext()
      .routes(
        craft()
          .id("return-final-no-to")
          .from<string>({
            subscribe: async (_ctx, handler, controller) => {
              try {
                finalFromSource = await handler("start");
              } finally {
                controller.abort();
              }
            },
          })
          .transform((body) => `${body}-a`)
          .process((exchange) => {
            exchange.body = `${exchange.body}-b`;
            return exchange;
          })
          .transform((body: string) => `${body}-c`),
      )
      .build();

    await t.ctx.start();

    expect(finalFromSource).toBeDefined();
    expect(finalFromSource.body).toBe("start-a-b-c");
  });

  /**
   * @case Verifies that route properly maintains message correlation
   * @preconditions Route with multiple processors
   * @expectedResult Correlation ID should remain consistent through pipeline
   */
  test("maintains message correlation through pipeline", async () => {
    const capturedCorrelationIds: string[] = [];

    t = await testContext()
      .routes(
        craft()
          .id("correlation-test")
          .from(simple("test"))
          .process((exchange) => {
            capturedCorrelationIds.push(
              exchange.headers["routecraft.correlation_id"] as string,
            );
            return exchange;
          })
          .tap((exchange) => {
            capturedCorrelationIds.push(
              exchange.headers["routecraft.correlation_id"] as string,
            );
          })
          .to(noop()),
      )
      .build();
    await t.ctx.start();

    // Wait for async tap jobs to complete
    await t.drain();

    expect(capturedCorrelationIds[0]).toBeDefined();
    expect(capturedCorrelationIds[0]).toBe(capturedCorrelationIds[1]);
  });

  /**
   * @case Verifies that route continues processing after a message fails
   * @preconditions Route with processor that fails for specific message
   * @expectedResult Should continue processing subsequent messages
   */
  test("continues processing after message failure", async () => {
    const messages = ["success1", "fail", "success2"];
    const s = spy();
    let processedCount = 0;

    t = await testContext()
      .routes(
        craft()
          .from({
            subscribe: async (_, handler) => {
              for (const msg of messages) {
                try {
                  await handler(msg);
                } catch {
                  // Exchange error handled by route pipeline; continue.
                }
              }
            },
          })
          .id("fail-continue-route")
          .process((exchange) => {
            if (exchange.body === "fail") {
              throw new Error("Simulated failure");
            }
            processedCount++;
            return exchange;
          })
          .to(s),
      )
      .build();

    await t.ctx.start();

    // Verify error was logged for failed message
    expect(t.logger.error).toHaveBeenCalled();
    expect((t.logger.error as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe(
      "Simulated failure",
    );

    // Verify successful messages were processed
    expect(processedCount).toBe(2); // Both success1 and success2 should be processed
    expect(s.received).toHaveLength(2);
  });

  /**
   * @case Verifies that route headers are properly propagated through pipeline
   * @preconditions Route with custom headers in source
   * @expectedResult Headers should be available at each step
   */
  test("propagates headers through pipeline", async () => {
    const capturedHeaders: Record<string, unknown>[] = [];

    t = await testContext()
      .routes(
        craft()
          .from({
            subscribe: async (_, handler) => {
              await handler("test", { "custom.header": "test-value" });
            },
          })
          .id("headers-test")
          .process((exchange) => {
            capturedHeaders.push({ ...exchange.headers });
            exchange.headers["processor.header"] = "added-value";
            return exchange;
          })
          .to((exchange) => {
            capturedHeaders.push({ ...exchange.headers });
          }),
      )
      .build();

    await t.ctx.start();

    expect(capturedHeaders[0]["custom.header"]).toBe("test-value");
    expect(capturedHeaders[1]["processor.header"]).toBe("added-value");
  });

  /**
   * @case Verifies that route properly handles async processors
   * @preconditions Route with async processor operations
   * @expectedResult Should wait for async operations to complete
   */
  test("handles async processors correctly", async () => {
    const processingOrder: string[] = [];

    t = await testContext()
      .routes(
        craft()
          .id("async-test")
          .from(simple("test"))
          .process(async (exchange) => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            processingOrder.push("first");
            return exchange;
          })
          .tap(() => {
            processingOrder.push("second");
          })
          .to(noop()),
      )
      .build();

    await t.ctx.start();

    // Wait for async tap jobs to complete
    await t.drain();

    expect(processingOrder).toEqual(["first", "second"]);
  });

  /**
   * @case Verifies that route properly handles body transformations
   * @preconditions Route with processors that transform message body
   * @expectedResult Body should be correctly transformed through pipeline
   */
  test("handles body transformations", async () => {
    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("transform-test")
          .from(simple(() => ({ value: 1 })))
          .transform((body) => {
            return {
              value: (body as { value: number }).value + 1,
            };
          })
          .process((exchange) => {
            exchange.body = {
              value: (exchange.body as { value: number }).value * 2,
            };
            return exchange;
          })
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.receivedBodies()).toEqual([{ value: 4 }]);
  });

  /**
   * @case Verifies that route properly handles processor return values
   * @preconditions Route with processors returning different types
   * @expectedResult Should maintain type safety and handle transformations
   */
  test("handles processor return values correctly", async () => {
    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("processor-returns")
          .from(simple(() => ({ num: 1 })))
          .process((exchange) => {
            exchange.body = (exchange.body as { num: number }).num.toString();
            return exchange;
          })
          .transform((body) => {
            return `processed-${body}`;
          })
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.receivedBodies()).toEqual(["processed-1"]);
  });

  /**
   * @case Verifies that split step correctly splits a message into multiple exchanges.
   * @preconditions A message to split.
   * @expectedResult The message is split, processed, and all split exchanges (with new IDs) are sent downstream.
   */
  test("splits message into multiple exchanges", async () => {
    const tapSpy = spy();
    const destSpy = spy();

    t = await testContext()
      .routes(
        craft()
          .id("split-test")
          .from(simple("hello-world"))
          .split((exchange) => {
            const ctx = getExchangeContext(exchange)!;
            const body = exchange.body;
            const parts = typeof body === "string" ? body.split("-") : [];
            return parts.map(
              (b) =>
                new DefaultExchange(ctx, {
                  body: b,
                  headers: exchange.headers,
                }),
            );
          })
          .tap(tapSpy)
          .to(destSpy),
      )
      .build();

    await t.ctx.start();

    // Wait for async tap jobs to complete
    await t.drain();

    // Expect the original "hello-world" to be split into two parts: "hello" and "world".
    expect(tapSpy.receivedBodies()).toEqual(
      expect.arrayContaining(["hello", "world"]),
    );
    expect(destSpy.receivedBodies()).toEqual(
      expect.arrayContaining(["hello", "world"]),
    );

    // There should be at least two distinct exchange IDs (i.e. each split gets a new ID).
    const allIds = [
      ...tapSpy.received.map((e) => e.id),
      ...destSpy.received.map((e) => e.id),
    ];
    expect(new Set(allIds).size).toBeGreaterThan(1);

    // All captured correlation IDs should be identical.
    const correlationIds = tapSpy.received.map(
      (e) => e.headers["routecraft.correlation_id"],
    );
    expect(new Set(correlationIds).size).toBe(1);
  });

  /**
   * @case Verifies that a split step returning no exchanges leads to no downstream processing.
   * @preconditions A message to split.
   * @expectedResult No exchanges are sent to the destination.
   */
  test("handles empty split output gracefully", async () => {
    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("empty-split-test")
          .from(simple("unused-message"))
          .split(() => [])
          .to(s),
      )
      .build();

    await t.ctx.start();
    // Since splitter returns an empty array, send should not be called.
    expect(s.received).toHaveLength(0);
  });

  /**
   * @case Verifies that the correlation header is maintained across split exchanges.
   * @preconditions A message to split.
   * @expectedResult All exchanges produced by the split step have the same correlation ID.
   */
  test("maintains correlation ID across split exchanges", async () => {
    const tapSpy = spy();

    t = await testContext()
      .routes(
        craft()
          .id("correlation-split-test")
          .from(simple("part1,part2"))
          .split((exchange) => {
            const ctx = getExchangeContext(exchange)!;
            const body = exchange.body;
            const parts = typeof body === "string" ? body.split(",") : [];
            return parts.map(
              (b) =>
                new DefaultExchange(ctx, {
                  body: b,
                  headers: exchange.headers,
                }),
            );
          })
          .tap(tapSpy)
          .to(noop()),
      )
      .build();

    await t.ctx.start();

    // Wait for async tap jobs to complete
    await t.drain();

    expect(tapSpy.received).toHaveLength(2);
    const correlationIds = tapSpy.received.map(
      (e) => e.headers["routecraft.correlation_id"],
    );
    expect(new Set(correlationIds).size).toBe(1);
  });

  /**
   * @case Verifies that the aggregate step correctly aggregates multiple exchanges.
   * @preconditions A message is split into multiple exchanges.
   * @expectedResult The split exchanges are aggregated into a single exchange with the expected aggregated body.
   */
  test("aggregates split exchanges correctly", async () => {
    const s = spy();
    const split = {
      split: (exchange) => {
        const ctx = getExchangeContext(exchange)!;
        return exchange.body.split("-").map(
          (b) =>
            new DefaultExchange(ctx, {
              body: b,
              headers: exchange.headers,
            }),
        );
      },
    };
    const splitSpy = vi.spyOn(split, "split");
    const processorSpy = vi.fn((exchange) => exchange);
    const agg = {
      aggregate: (exchanges) => {
        const aggregatedBody = exchanges.map((e) => e.body).join(",");
        return { ...exchanges[0], body: aggregatedBody };
      },
    };
    const aggSpy = vi.spyOn(agg, "aggregate");

    t = await testContext()
      .routes(
        craft()
          .id("aggregate-test")
          .from(simple("a-b-c"))
          .split(split)
          .process(processorSpy)
          .aggregate(agg)
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(splitSpy).toHaveBeenCalledTimes(1);
    expect(processorSpy).toHaveBeenCalledTimes(3);
    expect(aggSpy).toHaveBeenCalledTimes(1);
    expect(s.received).toHaveLength(1);
    expect(s.receivedBodies()).toEqual(["a,b,c"]);
  });

  /**
   * @case Verifies that the aggregate step works correctly even if no preceding split occurs.
   * @preconditions A route with an aggregate step immediately following the source.
   * @expectedResult The aggregator receives a single exchange and modifies its body accordingly.
   */
  test("aggregate step with no preceding split", async () => {
    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("aggregate-direct-test")
          .from(simple("original"))
          .tap(log())
          .aggregate((exchanges) => {
            return {
              ...exchanges[0],
              body: exchanges[0].body + "-aggregated",
            };
          })
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.received).toHaveLength(1);
    expect(s.receivedBodies()).toEqual(["original-aggregated"]);
  });

  /**
   * @case Verifies that the default aggregator collects bodies into an array
   * @preconditions A split operation followed by aggregate without arguments
   * @expectedResult The default aggregator collects all exchange bodies into an array
   */
  test("default aggregate collects bodies into array", async () => {
    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("default-aggregate-test")
          .from(simple([[1, 2, 3]]))
          .split<number>()
          .process((exchange) => ({
            ...exchange,
            body: exchange.body * 2,
          }))
          .aggregate<number[]>() // No aggregator provided - use default
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.received).toHaveLength(1);
    expect(s.receivedBodies()).toEqual([[2, 4, 6]]);
  });

  /**
   * @case Verifies that the default aggregator flattens arrays when any body is an array
   * @preconditions Multiple exchanges where some bodies are arrays
   * @expectedResult Arrays are flattened and combined with scalar values into a single array
   */
  test("default aggregate flattens arrays when any body is an array", async () => {
    // Test the aggregator function directly
    const directT = await testContext().build();
    const exchange1 = new DefaultExchange(directT.ctx, { body: 1 });
    const exchange2 = new DefaultExchange(directT.ctx, { body: [2, 3] });
    const exchange3 = new DefaultExchange(directT.ctx, { body: 4 });
    const exchange4 = new DefaultExchange(directT.ctx, {
      body: [5, 6, 7],
    });

    const result = defaultAggregate([
      exchange1,
      exchange2,
      exchange3,
      exchange4,
    ] as Exchange<number | number[]>[]);

    expect(result.body).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  /**
   * @case Verifies that the default aggregator flattens multiple arrays
   * @preconditions Multiple exchanges where all bodies are arrays
   * @expectedResult All arrays are flattened into a single combined array
   */
  test("default aggregate flattens multiple arrays", async () => {
    const directT = await testContext().build();
    const exchange1 = new DefaultExchange(directT.ctx, { body: [1, 2] });
    const exchange2 = new DefaultExchange(directT.ctx, { body: [3, 4] });
    const exchange3 = new DefaultExchange(directT.ctx, { body: [5, 6] });

    const result = defaultAggregate([exchange1, exchange2, exchange3]);

    expect(result.body).toEqual([1, 2, 3, 4, 5, 6]);
  });

  /**
   * @case Verifies that the default aggregator handles single array with scalar values
   * @preconditions One array and multiple scalar values
   * @expectedResult Array is flattened and scalar values are added to the result
   */
  test("default aggregate handles single array with scalars", async () => {
    const directT = await testContext().build();
    const exchange1 = new DefaultExchange(directT.ctx, {
      body: [1, 2, 3],
    });
    const exchange2 = new DefaultExchange(directT.ctx, { body: 4 });
    const exchange3 = new DefaultExchange(directT.ctx, { body: 5 });

    const result = defaultAggregate([
      exchange1,
      exchange2,
      exchange3,
    ] as Exchange<number[] | number>[]);

    expect(result.body).toEqual([1, 2, 3, 4, 5]);
  });

  /**
   * @case Verifies that split exchanges maintain custom headers from original exchange
   * @preconditions A message with custom headers to split
   * @expectedResult All split exchanges should contain the original custom headers
   */
  test("split exchanges maintain custom headers", async () => {
    const tapSpy = spy();

    t = await testContext()
      .routes(
        craft()
          .id("split-headers-test")
          .from({
            subscribe: async (_, handler) => {
              await handler("one-two", { "custom.header": "test-value" });
            },
          })
          .split<string, string>((exchange) => {
            const ctx = getExchangeContext(exchange)!;
            return exchange.body.split("-").map(
              (b) =>
                new DefaultExchange(ctx, {
                  body: b,
                  headers: exchange.headers,
                }),
            );
          })
          .tap(tapSpy)
          .to(noop()),
      )
      .build();

    await t.ctx.start();

    // Wait for async tap jobs to complete
    await t.drain();

    // Both split exchanges should have the original custom header
    expect(tapSpy.received).toHaveLength(2);
    expect(tapSpy.received[0].headers["custom.header"]).toBe("test-value");
    expect(tapSpy.received[1].headers["custom.header"]).toBe("test-value");
  });

  /**
   * @case Verifies that split exchanges can be processed independently and aggregated correctly
   * @preconditions Split exchanges with individual processing
   * @expectedResult Aggregated result should reflect individual processing
   */
  test("split exchanges can be processed independently before aggregation", async () => {
    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("split-process-aggregate")
          .from(simple("1-2-3"))
          .split<string, number>((exchange) => {
            const ctx = getExchangeContext(exchange)!;
            return exchange.body
              .split("-")
              .map((part) => parseInt(part))
              .map(
                (b) =>
                  new DefaultExchange(ctx, {
                    body: b,
                    headers: exchange.headers,
                  }),
              );
          })
          .transform<number>((body) => {
            // Double each number
            return body * 2;
          })
          .aggregate((exchanges) => {
            // Join the processed numbers
            const aggregatedBody = exchanges
              .map((e) => e.body)
              .sort()
              .join(",");
            return { ...exchanges[0], body: aggregatedBody };
          })
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.received).toHaveLength(1);
    expect(s.receivedBodies()).toEqual(["2,4,6"]);
  });

  /**
   * @case Verifies that aggregation handles errors in individual exchanges correctly
   * @preconditions Split exchanges where some processing fails
   * @expectedResult Failed exchanges should not prevent aggregation of successful ones
   */
  test("aggregation handles failed split processing gracefully", async () => {
    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("split-error-aggregate")
          .from(simple("success1-error-success2"))
          .split<string, string>((exchange) => {
            const ctx = getExchangeContext(exchange)!;
            return exchange.body.split("-").map(
              (b) =>
                new DefaultExchange(ctx, {
                  body: b,
                  headers: exchange.headers,
                }),
            );
          })
          .process((exchange) => {
            if (exchange.body === "error") {
              throw new Error("Simulated processing error");
            }
            return exchange;
          })
          .aggregate((exchanges) => {
            const aggregatedBody = exchanges.map((e) => e.body).join(",");
            return { ...exchanges[0], body: aggregatedBody };
          })
          .to(s),
      )
      .build();

    await t.ctx.start();

    // Verify error was logged
    expect(t.logger.error).toHaveBeenCalled();
    expect((t.logger.error as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe(
      "Simulated processing error",
    );

    // Verify successful exchanges were aggregated
    expect(s.received).toHaveLength(1);
    expect(s.receivedBodies()).toEqual(["success1,success2"]);
  });

  /**
   * @case Verifies that nested split operations work correctly with aggreattion at each level
   * @preconditions A route with multiple split steps
   * @expectedResult Messages should be split correctly at each level and maintain correlation while aggregating into groups
   */
  test("handles nested split operations", async () => {
    const tapSpy = spy();
    const destSpy = spy();
    const processorSpy = vi.fn((exchange) => exchange);
    const processorSpy2 = vi.fn((exchange) => exchange);
    const processorSpy3 = vi.fn((exchange) => exchange);
    const processorSpy4 = vi.fn((exchange) => exchange);
    const agg = {
      aggregate: (exchanges) => {
        return {
          ...exchanges[0],
          body: exchanges.map((e) => e.body).join(","),
        };
      },
    };
    const aggSpy = vi.spyOn(agg, "aggregate");
    const agg2 = {
      aggregate: (exchanges) => {
        return {
          ...exchanges[0],
          body: exchanges.map((e) => e.body).join(","),
        };
      },
    };
    const aggSpy2 = vi.spyOn(agg2, "aggregate");

    t = await testContext()
      .routes(
        craft()
          .id("nested-split-test")
          .from(simple("A:1-2|B:3-4"))
          .split<string, string>((exchange) => {
            const ctx = getExchangeContext(exchange)!;
            return exchange.body.split("|").map(
              (b) =>
                new DefaultExchange(ctx, {
                  body: b,
                  headers: exchange.headers,
                }),
            );
          })
          .process(processorSpy)
          .split<string, string>((exchange) => {
            const ctx = getExchangeContext(exchange)!;
            return exchange.body.split(":").map(
              (b) =>
                new DefaultExchange(ctx, {
                  body: b,
                  headers: exchange.headers,
                }),
            );
          })
          .process(processorSpy2)
          .split<string, string>((exchange) => {
            const ctx = getExchangeContext(exchange)!;
            return exchange.body.split("-").map(
              (b) =>
                new DefaultExchange(ctx, {
                  body: b,
                  headers: exchange.headers,
                }),
            );
          })
          .process(processorSpy3)
          .tap(tapSpy)
          .aggregate(agg)
          .process(processorSpy4)
          .aggregate(agg2)
          .to(destSpy),
      )
      .build();

    await t.ctx.start();

    // Wait for async tap jobs to complete
    await t.drain();

    expect(processorSpy).toHaveBeenCalledTimes(2);
    expect(processorSpy2).toHaveBeenCalledTimes(4);
    expect(processorSpy3).toHaveBeenCalledTimes(6);

    // Should have split into individual numbers and letters
    const tapBodies = tapSpy.receivedBodies();
    expect(tapBodies).toContain("A");
    expect(tapBodies).toContain("1");
    expect(tapBodies).toContain("2");
    expect(tapBodies).toContain("B");
    expect(tapBodies).toContain("3");
    expect(tapBodies).toContain("4");

    expect(aggSpy).toHaveBeenCalledTimes(4);
    expect(processorSpy4).toHaveBeenCalledTimes(4);
    expect(aggSpy2).toHaveBeenCalledTimes(2);

    // All exchanges should share the same correlation ID
    const correlationIds = tapSpy.received.map(
      (e) => e.headers["routecraft.correlation_id"],
    );
    expect(new Set(correlationIds).size).toBe(1);

    expect(destSpy.received).toHaveLength(2);
  });

  /**
   * @case Verifies that filter step correctly filters out unwanted messages
   * @preconditions A route with a filter step
   * @expectedResult Only messages that pass the filter condition should reach the destination
   */
  test("filters messages based on condition", async () => {
    const tapSpy = spy();
    const destSpy = spy();
    const numbers = [1, 2, 3, 4, 5, 6];

    t = await testContext()
      .routes(
        craft()
          .id("filter-test")
          .from(simple(numbers))
          .filter<number>((exchange) => exchange.body % 2 === 0) // Only allow even numbers
          .tap(tapSpy)
          .to(destSpy),
      )
      .build();

    await t.ctx.start();

    // Wait for async tap jobs to complete
    await t.drain();

    // Should only have even numbers
    expect(tapSpy.receivedBodies()).toEqual([2, 4, 6]);
    expect(destSpy.received).toHaveLength(3);
    expect(destSpy.receivedBodies()).toEqual([2, 4, 6]);
  });

  /**
   * @case Verifies that schema step validates and rejects invalid types
   * @preconditions A route with a schema step using arktype, input is an array with mixed types
   * @expectedResult Only string messages reach the destination; non-string values produce RC5002 errors
   */
  test("validates messages using arktype", async () => {
    const messages = ["valid string", 123, "another string", { key: "value" }];
    const capturedMessages: unknown[] = [];

    t = await testContext()
      .routes(
        craft()
          .id("validate-test")
          .from(simple(messages))
          .schema(type("string"))
          .tap((exchange) => {
            capturedMessages.push(exchange.body);
          })
          .to(noop()),
      )
      .build();

    await t.ctx.start();

    // Wait for async tap jobs to complete
    await t.drain();

    // Should only have string messages
    expect(capturedMessages).toEqual(["valid string", "another string"]);

    // Non-string values should have thrown RC5002 (validation failure)
    const validationErrors = t.errors.filter((e) => e.rc === "RC5002");
    expect(validationErrors).toHaveLength(2);
  });

  /**
   * @case Verifies multiple .to() calls transform body sequentially
   * @preconditions Multiple .to() destinations in sequence with return values
   * @expectedResult Each .to() that returns data replaces the body
   */
  test("multiple .to() calls transform body", async () => {
    const dest1Spy = vi.fn(async () => ({ result: 1 }));
    const dest2Spy = vi.fn(async () => ({ result: 2 }));
    const dest3Spy = vi.fn(async () => ({ result: 3 }));
    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("multiple-to-test")
          .from(simple({ original: "value", count: 42 }))
          .to(dest1Spy)
          .to(dest2Spy)
          .to(dest3Spy)
          .to(s),
      )
      .build();

    await t.ctx.start();

    // All destinations should be called
    expect(dest1Spy).toHaveBeenCalledTimes(1);
    expect(dest2Spy).toHaveBeenCalledTimes(1);
    expect(dest3Spy).toHaveBeenCalledTimes(1);
    expect(s.received).toHaveLength(1);

    // Body should be the last result
    expect(s.received[0].body).toEqual({
      result: 3,
    });
  });
});
