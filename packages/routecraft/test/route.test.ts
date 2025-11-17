import { type } from "arktype";
import { describe, test, expect, afterEach, vi, beforeEach } from "vitest";
import {
  context,
  craft,
  simple,
  type CraftContext,
  logger,
  log,
  noop,
} from "@routecraft/routecraft";

const logSpy = {
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
};

describe("Route Behavior", () => {
  let testContext: CraftContext;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    if (testContext) {
      await testContext.stop();
    }
  });

  /**
   * @case Verifies that a route processes messages through its pipeline
   * @preconditions Route with source, processor, and destination
   * @expectedResult Message should flow through entire pipeline
   */
  test("processes messages through pipeline", async () => {
    const transformerSpy = vi.fn((body) => body);
    const destSpy = vi.fn();

    testContext = context()
      .routes(
        craft()
          .id("test-pipeline")
          .from(simple("test-message"))
          .transform(transformerSpy)
          .to(destSpy),
      )
      .build();

    await testContext.start();

    expect(transformerSpy).toHaveBeenCalled();
    expect(destSpy).toHaveBeenCalledTimes(1);
    const sentExchange = destSpy.mock.calls[0][0];
    expect(sentExchange.body).toBe("test-message");
  });

  /**
   * @case Verifies that a route can continue after a to step has been called.
   * @preconditions A route with a processor step after the to step.
   * @expectedResult The route can continue after the to step has been called.
   */
  test("route can continue after a to step has been called", async () => {
    const destSpy1 = vi.fn();
    const destSpy2 = vi.fn();
    const processorSpy = vi.fn((exchange) => exchange);

    testContext = context()
      .routes(
        craft()
          .id("test-route")
          .from(simple("test-message"))
          .to(destSpy1)
          .to(destSpy2)
          .process(processorSpy),
      )
      .build();

    await testContext.start();

    expect(destSpy1).toHaveBeenCalledTimes(1);
    expect(destSpy2).toHaveBeenCalledTimes(1);
    expect(processorSpy).toHaveBeenCalled();
  });

  /**
   * @case Verifies that route stops when context is stopped
   * @preconditions Active route with continuous source
   * @expectedResult Route should stop processing when context stops
   */
  test("stops processing when context stops", async () => {
    const processorSpy = vi.fn((exchange) => exchange);

    testContext = context()
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

    const execution = testContext.start();

    const initialCallCount = processorSpy.mock.calls.length;
    await testContext.stop();
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
    // @ts-expect-error Mocking logger.child
    vi.spyOn(logger, "child").mockReturnValue(logSpy);
    const spyDest = vi.fn();

    testContext = context()
      .routes(
        craft()
          .id("error-route")
          .from(simple("test"))
          .process(() => {
            throw new Error("Processor error");
          })
          .to(spyDest),
      )
      .build();

    await testContext.start();

    expect(logSpy.warn).toHaveBeenCalled();
    expect(spyDest).toHaveBeenCalledTimes(0);
    expect(logSpy.warn.mock.calls[0][1]).toMatch(
      /Step process failed for exchange/,
    );
  });

  /**
   * @case Returns final exchange to the source when route has multiple steps including a to step
   * @preconditions Custom source awaiting handler result
   * @expectedResult Source receives the final exchange after all steps complete
   */
  test("returns final exchange to source (with to)", async () => {
    let finalFromSource: any | undefined;

    testContext = context()
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

    await testContext.start();

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

    testContext = context()
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

    await testContext.start();

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

    const testContext = context()
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
    await testContext.start();

    expect(capturedCorrelationIds[0]).toBeDefined();
    expect(capturedCorrelationIds[0]).toBe(capturedCorrelationIds[1]);
  });

  /**
   * @case Verifies that route continues processing after a message fails
   * @preconditions Route with processor that fails for specific message
   * @expectedResult Should continue processing subsequent messages
   */
  test("continues processing after message failure", async () => {
    // @ts-expect-error Mocking logger.child
    vi.spyOn(logger, "child").mockReturnValue(logSpy);
    const messages = ["success1", "fail", "success2"];
    const spyDest = vi.fn();
    let processedCount = 0;

    testContext = context()
      .routes(
        craft()
          .from({
            subscribe: async (_, handler) => {
              for (const msg of messages) {
                await handler(msg);
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
          .to(spyDest),
      )
      .build();

    await testContext.start();

    // Verify error was logged for failed message
    expect(logSpy.warn).toHaveBeenCalled();
    expect(logSpy.warn.mock.calls[0][1]).toMatch(
      /Step process failed for exchange/,
    );

    // Verify successful messages were processed
    expect(processedCount).toBe(2); // Both success1 and success2 should be processed
    expect(spyDest).toHaveBeenCalledTimes(2);
  });

  /**
   * @case Verifies that route headers are properly propagated through pipeline
   * @preconditions Route with custom headers in source
   * @expectedResult Headers should be available at each step
   */
  test("propagates headers through pipeline", async () => {
    const capturedHeaders: Record<string, unknown>[] = [];

    testContext = context()
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

    await testContext.start();

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

    testContext = context()
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

    await testContext.start();

    expect(processingOrder).toEqual(["first", "second"]);
  });

  /**
   * @case Verifies that route properly handles body transformations
   * @preconditions Route with processors that transform message body
   * @expectedResult Body should be correctly transformed through pipeline
   */
  test("handles body transformations", async () => {
    const spyDest = vi.fn();

    testContext = context()
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
          .to(spyDest),
      )
      .build();

    await testContext.start();

    const receivedBodies = spyDest.mock.calls.map((call) => call[0].body);
    expect(receivedBodies).toEqual([{ value: 4 }]);
  });

  /**
   * @case Verifies that route properly handles processor return values
   * @preconditions Route with processors returning different types
   * @expectedResult Should maintain type safety and handle transformations
   */
  test("handles processor return values correctly", async () => {
    const spyDest = vi.fn();

    testContext = context()
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
          .to(spyDest),
      )
      .build();

    await testContext.start();

    const receivedBodies = spyDest.mock.calls.map((call) => call[0].body);
    expect(receivedBodies).toEqual(["processed-1"]);
  });

  /**
   * @case Verifies that split step correctly splits a message into multiple exchanges.
   * @preconditions A message to split.
   * @expectedResult The message is split, processed, and all split exchanges (with new IDs) are sent downstream.
   */
  test("splits message into multiple exchanges", async () => {
    const spyTap = vi.fn();
    const spyDest = vi.fn();

    testContext = context()
      .routes(
        craft()
          .id("split-test")
          .from(simple("hello-world"))
          .split((body: any) => {
            // For a string message with '-' delimiter, split into parts.
            return typeof body === "string" ? body.split("-") : [];
          })
          .tap(spyTap)
          .to(spyDest),
      )
      .build();

    await testContext.start();

    // Expect the original "hello-world" to be split into two parts: "hello" and "world".
    const tapBodies = spyTap.mock.calls.map((call) => call[0].body);
    expect(tapBodies).toEqual(expect.arrayContaining(["hello", "world"]));
    const destBodies = spyDest.mock.calls.map((call) => call[0].body);
    expect(destBodies).toEqual(expect.arrayContaining(["hello", "world"]));

    // There should be at least two distinct exchange IDs (i.e. each split gets a new ID).
    const allIds = [
      ...spyTap.mock.calls.map((call) => call[0].id),
      ...spyDest.mock.calls.map((call) => call[0].id),
    ];
    expect(new Set(allIds).size).toBeGreaterThan(1);

    // All captured correlation IDs should be identical.
    const correlationIds = spyTap.mock.calls.map(
      (call) => call[0].headers["routecraft.correlation_id"],
    );
    expect(new Set(correlationIds).size).toBe(1);
  });

  /**
   * @case Verifies that a split step returning no exchanges leads to no downstream processing.
   * @preconditions A message to split.
   * @expectedResult No exchanges are sent to the destination.
   */
  test("handles empty split output gracefully", async () => {
    const spyDest = vi.fn();

    testContext = context()
      .routes(
        craft()
          .id("empty-split-test")
          .from(simple("unused-message"))
          .split(() => {
            // Always return an empty array.
            return [];
          })
          .to(spyDest),
      )
      .build();

    await testContext.start();
    // Since splitter returns an empty array, send should not be called.
    expect(spyDest).toHaveBeenCalledTimes(0);
  });

  /**
   * @case Verifies that the correlation header is maintained across split exchanges.
   * @preconditions A message to split.
   * @expectedResult All exchanges produced by the split step have the same correlation ID.
   */
  test("maintains correlation ID across split exchanges", async () => {
    const spyTap = vi.fn();

    testContext = context()
      .routes(
        craft()
          .id("correlation-split-test")
          .from(simple("part1,part2"))
          .split((body: any) => {
            // Using a comma as a delimiter.
            return typeof body === "string" ? body.split(",") : [];
          })
          .tap(spyTap)
          .to(noop()),
      )
      .build();

    await testContext.start();
    expect(spyTap).toHaveBeenCalledTimes(2);
    const correlationIds = spyTap.mock.calls.map(
      (call) => call[0].headers["routecraft.correlation_id"],
    );
    expect(new Set(correlationIds).size).toBe(1);
  });

  /**
   * @case Verifies that the aggregate step correctly aggregates multiple exchanges.
   * @preconditions A message is split into multiple exchanges.
   * @expectedResult The split exchanges are aggregated into a single exchange with the expected aggregated body.
   */
  test("aggregates split exchanges correctly", async () => {
    const spyDest = vi.fn();
    const split = {
      split: (body) => body.split("-"),
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

    testContext = context()
      .routes(
        craft()
          .id("aggregate-test")
          .from(simple("a-b-c"))
          .split(split)
          .process(processorSpy)
          .aggregate(agg)
          .to(spyDest),
      )
      .build();

    await testContext.start();

    expect(splitSpy).toHaveBeenCalledTimes(1);
    expect(processorSpy).toHaveBeenCalledTimes(3);
    expect(aggSpy).toHaveBeenCalledTimes(1);
    expect(spyDest).toHaveBeenCalledTimes(1);
    const receivedBodies = spyDest.mock.calls.map((call) => call[0].body);
    expect(receivedBodies).toEqual(["a,b,c"]);
  });

  /**
   * @case Verifies that the aggregate step works correctly even if no preceding split occurs.
   * @preconditions A route with an aggregate step immediately following the source.
   * @expectedResult The aggregator receives a single exchange and modifies its body accordingly.
   */
  test("aggregate step with no preceding split", async () => {
    const spyDest = vi.fn();

    testContext = context()
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
          .to(spyDest),
      )
      .build();

    await testContext.start();

    expect(spyDest).toHaveBeenCalledTimes(1);
    const receivedBodies = spyDest.mock.calls.map((call) => call[0].body);
    expect(receivedBodies).toEqual(["original-aggregated"]);
  });

  /**
   * @case Verifies that the default aggregator collects bodies into an array
   * @preconditions A split operation followed by aggregate without arguments
   * @expectedResult The default aggregator collects all exchange bodies into an array
   */
  test("default aggregate collects bodies into array", async () => {
    const spyDest = vi.fn();

    testContext = context()
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
          .to(spyDest),
      )
      .build();

    await testContext.start();

    expect(spyDest).toHaveBeenCalledTimes(1);
    const receivedBodies = spyDest.mock.calls.map((call) => call[0].body);
    expect(receivedBodies).toEqual([[2, 4, 6]]);
  });

  /**
   * @case Verifies that split exchanges maintain custom headers from original exchange
   * @preconditions A message with custom headers to split
   * @expectedResult All split exchanges should contain the original custom headers
   */
  test("split exchanges maintain custom headers", async () => {
    const spyTap = vi.fn();

    testContext = context()
      .routes(
        craft()
          .id("split-headers-test")
          .from({
            subscribe: async (_, handler) => {
              await handler("one-two", { "custom.header": "test-value" });
            },
          })
          .split<string, string>((body) => body.split("-"))
          .tap(spyTap)
          .to(noop()),
      )
      .build();

    await testContext.start();

    // Both split exchanges should have the original custom header
    expect(spyTap).toHaveBeenCalledTimes(2);
    expect(spyTap.mock.calls[0][0].headers["custom.header"]).toBe("test-value");
    expect(spyTap.mock.calls[1][0].headers["custom.header"]).toBe("test-value");
  });

  /**
   * @case Verifies that split exchanges can be processed independently and aggregated correctly
   * @preconditions Split exchanges with individual processing
   * @expectedResult Aggregated result should reflect individual processing
   */
  test("split exchanges can be processed independently before aggregation", async () => {
    const spyDest = vi.fn();

    testContext = context()
      .routes(
        craft()
          .id("split-process-aggregate")
          .from(simple("1-2-3"))
          .split<string, number>((body) =>
            body.split("-").map((part) => parseInt(part)),
          )
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
          .to(spyDest),
      )
      .build();

    await testContext.start();

    expect(spyDest).toHaveBeenCalledTimes(1);
    const receivedBodies = spyDest.mock.calls.map((call) => call[0].body);
    expect(receivedBodies).toEqual(["2,4,6"]);
  });

  /**
   * @case Verifies that aggregation handles errors in individual exchanges correctly
   * @preconditions Split exchanges where some processing fails
   * @expectedResult Failed exchanges should not prevent aggregation of successful ones
   */
  test("aggregation handles failed split processing gracefully", async () => {
    // @ts-expect-error Mocking logger.child
    vi.spyOn(logger, "child").mockReturnValue(logSpy);
    const spyDest = vi.fn();

    testContext = context()
      .routes(
        craft()
          .id("split-error-aggregate")
          .from(simple("success1-error-success2"))
          .split<string, string>((body) => body.split("-"))
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
          .to(spyDest),
      )
      .build();

    await testContext.start();

    // Verify error was logged
    expect(logSpy.warn).toHaveBeenCalled();
    expect(logSpy.warn.mock.calls[0][1]).toMatch(
      /Step process failed for exchange/,
    );

    // Verify successful exchanges were aggregated
    expect(spyDest).toHaveBeenCalledTimes(1);
    const receivedBodies = spyDest.mock.calls.map((call) => call[0].body);
    expect(receivedBodies).toEqual(["success1,success2"]);
  });

  /**
   * @case Verifies that nested split operations work correctly with aggreattion at each level
   * @preconditions A route with multiple split steps
   * @expectedResult Messages should be split correctly at each level and maintain correlation while aggregating into groups
   */
  test("handles nested split operations", async () => {
    const spyTap = vi.fn();
    const spyDest = vi.fn();
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

    testContext = context()
      .routes(
        craft()
          .id("nested-split-test")
          .from(simple("A:1-2|B:3-4"))
          .split<string, string>((body) =>
            // First split by |
            body.split("|"),
          )
          .process(processorSpy)
          .split<string, string>((body) =>
            // Then split by :
            body.split(":"),
          )
          .process(processorSpy2)
          .split<string, string>((body) =>
            // Finally split by -
            body.split("-"),
          )
          .process(processorSpy3)
          .tap(spyTap)
          .aggregate(agg)
          .process(processorSpy4)
          .aggregate(agg2)
          .to(spyDest),
      )
      .build();

    await testContext.start();

    expect(processorSpy).toHaveBeenCalledTimes(2);
    expect(processorSpy2).toHaveBeenCalledTimes(4);
    expect(processorSpy3).toHaveBeenCalledTimes(6);

    // Should have split into individual numbers and letters
    const tapBodies = spyTap.mock.calls.map((call) => call[0].body);
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
    const correlationIds = spyTap.mock.calls.map(
      (call) => call[0].headers["routecraft.correlation_id"],
    );
    expect(new Set(correlationIds).size).toBe(1);

    expect(spyDest).toHaveBeenCalledTimes(2);
  });

  /**
   * @case Verifies that filter step correctly filters out unwanted messages
   * @preconditions A route with a filter step
   * @expectedResult Only messages that pass the filter condition should reach the destination
   */
  test("filters messages based on condition", async () => {
    const spyTap = vi.fn();
    const spyDest = vi.fn();
    const numbers = [1, 2, 3, 4, 5, 6];

    testContext = context()
      .routes(
        craft()
          .id("filter-test")
          .from(simple(numbers))
          .filter<number>((exchange) => exchange.body % 2 === 0) // Only allow even numbers
          .tap(spyTap)
          .to(spyDest),
      )
      .build();

    await testContext.start();

    // Should only have even numbers
    const tapBodies = spyTap.mock.calls.map((call) => call[0].body);
    expect(tapBodies).toEqual([2, 4, 6]);
    expect(spyDest).toHaveBeenCalledTimes(3);
    const receivedBodies = spyDest.mock.calls.map((call) => call[0].body);
    expect(receivedBodies).toEqual([2, 4, 6]);
  });

  /**
   * @case Verifies that validate step correctly validates message types
   * @preconditions A route with a validate step using arktype
   * @expectedResult Only messages that match the type definition should reach the destination
   */
  test("validates messages using arktype", async () => {
    const messages = ["valid string", 123, "another string", { key: "value" }];
    const capturedMessages: unknown[] = [];

    testContext = context()
      .routes(
        craft()
          .id("validate-test")
          .from(simple(messages))
          .validate(type("string"))
          .tap((exchange) => {
            capturedMessages.push(exchange.body);
          })
          .to(noop()),
      )
      .build();

    await testContext.start();

    // Should only have string messages
    expect(capturedMessages).toEqual(["valid string", "another string"]);
  });
});
