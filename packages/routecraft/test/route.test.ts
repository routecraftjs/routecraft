import { describe, test, expect, afterEach, vi, beforeEach } from "vitest";
import {
  context,
  routes,
  simple,
  type CraftContext,
  NoopAdapter,
  logger,
  log,
} from "routecraft";

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
   * @testCase TC-0010
   * @description Verifies that a route processes messages through its pipeline
   * @preconditions Route with source, processor, and destination
   * @expectedResult Message should flow through entire pipeline
   */
  test("processes messages through pipeline", async () => {
    const transformerSpy = vi.fn((body) => body);
    const noop = new NoopAdapter();
    const sendSpy = vi.spyOn(noop, "send");

    testContext = context()
      .routes(
        routes()
          .from([{ id: "test-pipeline" }, simple("test-message")])
          .transform(transformerSpy)
          .to(noop),
      )
      .build();

    await testContext.start();

    expect(transformerSpy).toHaveBeenCalled();
    expect(sendSpy).toHaveBeenCalled();
    const sentExchange = sendSpy.mock.calls[0][0];
    expect(sentExchange.body).toBe("test-message");
  });

  /**
   * @testCase TC-0028
   * @description Verifies that a route can continue after a to step has been called.
   * @preconditions A route with a processor step after the to step.
   * @expectedResult The route can continue after the to step has been called.
   */
  test("route can continue after a to step has been called", async () => {
    const noop = new NoopAdapter();
    const noop2 = new NoopAdapter();
    const sendSpy = vi.spyOn(noop, "send");
    const processorSpy = vi.fn((exchange) => exchange);
    const sendSpy2 = vi.spyOn(noop2, "send");

    testContext = context()
      .routes(
        routes()
          .from([{ id: "test-route" }, simple("test-message")])
          .to(noop)
          .to(noop2)
          .process(processorSpy),
      )
      .build();

    await testContext.start();

    expect(sendSpy).toHaveBeenCalled();
    expect(sendSpy2).toHaveBeenCalled();
    expect(processorSpy).toHaveBeenCalled();
  });

  /**
   * @testCase TC-0011
   * @description Verifies that route stops when context is stopped
   * @preconditions Active route with continuous source
   * @expectedResult Route should stop processing when context stops
   */
  test("stops processing when context stops", async () => {
    const processorSpy = vi.fn((exchange) => exchange);

    testContext = context()
      .routes(
        routes()
          .from([
            { id: "continuous-route" },
            {
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
            },
          ])
          .process(processorSpy)
          .to(new NoopAdapter()),
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
   * @testCase TC-0012
   * @description Verifies that route properly handles processor errors
   * @preconditions Route with failing processor
   * @expectedResult Should continue running and log error
   */
  test("handles processor errors gracefully", async () => {
    // @ts-expect-error Mocking logger.child
    vi.spyOn(logger, "child").mockReturnValue(logSpy);
    const noop = new NoopAdapter();
    const sendSpy = vi.spyOn(noop, "send");

    testContext = context()
      .routes(
        routes()
          .from([{ id: "error-route" }, simple("test")])
          .process(() => {
            throw new Error("Processor error");
          })
          .to(noop),
      )
      .build();

    await testContext.start();

    expect(logSpy.warn).toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
    expect(logSpy.warn.mock.calls[0][1]).toMatch(
      /Step process failed for exchange/,
    );
  });

  /**
   * @testCase TC-0013
   * @description Verifies that route properly maintains message correlation
   * @preconditions Route with multiple processors
   * @expectedResult Correlation ID should remain consistent through pipeline
   */
  test("maintains message correlation through pipeline", async () => {
    const capturedCorrelationIds: string[] = [];

    const testContext = context()
      .routes(
        routes()
          .from([{ id: "correlation-test" }, simple("test")])
          .process((exchange) => {
            capturedCorrelationIds.push(
              exchange.headers["routecraft.correlation_id"] as string,
            );
            return exchange;
          })
          .process((exchange) => {
            capturedCorrelationIds.push(
              exchange.headers["routecraft.correlation_id"] as string,
            );
            return exchange;
          })
          .to(new NoopAdapter()),
      )
      .build();

    await testContext.start();

    expect(capturedCorrelationIds[0]).toBeDefined();
    expect(capturedCorrelationIds[0]).toBe(capturedCorrelationIds[1]);
  });

  /**
   * @testCase TC-0014
   * @description Verifies that route continues processing after a message fails
   * @preconditions Route with processor that fails for specific message
   * @expectedResult Should continue processing subsequent messages
   */
  test("continues processing after message failure", async () => {
    // @ts-expect-error Mocking logger.child
    vi.spyOn(logger, "child").mockReturnValue(logSpy);
    const messages = ["success1", "fail", "success2"];
    const noop = new NoopAdapter();
    const sendSpy = vi.spyOn(noop, "send");
    let processedCount = 0;

    testContext = context()
      .routes(
        routes()
          .from([
            { id: "fail-continue-route" },
            {
              subscribe: async (_, handler) => {
                for (const msg of messages) {
                  await handler(msg);
                }
              },
            },
          ])
          .process((exchange) => {
            if (exchange.body === "fail") {
              throw new Error("Simulated failure");
            }
            processedCount++;
            return exchange;
          })
          .to(noop),
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
    expect(sendSpy).toHaveBeenCalledTimes(2);
  });

  /**
   * @testCase TC-0015
   * @description Verifies that route headers are properly propagated through pipeline
   * @preconditions Route with custom headers in source
   * @expectedResult Headers should be available at each step
   */
  test("propagates headers through pipeline", async () => {
    const capturedHeaders: Record<string, unknown>[] = [];

    testContext = context()
      .routes(
        routes()
          .from([
            { id: "headers-test" },
            {
              subscribe: async (_, handler) => {
                await handler("test", { "custom.header": "test-value" });
              },
            },
          ])
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
   * @testCase TC-0016
   * @description Verifies that route properly handles async processors
   * @preconditions Route with async processor operations
   * @expectedResult Should wait for async operations to complete
   */
  test("handles async processors correctly", async () => {
    const processingOrder: string[] = [];

    testContext = context()
      .routes(
        routes()
          .from([{ id: "async-test" }, simple("test")])
          .process(async (exchange) => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            processingOrder.push("first");
            return exchange;
          })
          .process(async (exchange) => {
            processingOrder.push("second");
            return exchange;
          })
          .to(new NoopAdapter()),
      )
      .build();

    await testContext.start();

    expect(processingOrder).toEqual(["first", "second"]);
  });

  /**
   * @testCase TC-0017
   * @description Verifies that route properly handles body transformations
   * @preconditions Route with processors that transform message body
   * @expectedResult Body should be correctly transformed through pipeline
   */
  test("handles body transformations", async () => {
    const transformedBodies: unknown[] = [];

    testContext = context()
      .routes(
        routes()
          .from([{ id: "transform-test" }, simple(() => ({ value: 1 }))])
          .transform((body) => {
            transformedBodies.push(body);
            return {
              value: (body as { value: number }).value + 1,
            };
          })
          .process((exchange) => {
            transformedBodies.push(exchange.body);
            exchange.body = {
              value: (exchange.body as { value: number }).value * 2,
            };
            return exchange;
          })
          .to((exchange) => {
            transformedBodies.push(exchange.body);
          }),
      )
      .build();

    await testContext.start();

    expect(transformedBodies).toEqual([
      { value: 1 },
      { value: 2 },
      { value: 4 },
    ]);
  });

  /**
   * @testCase TC-0018
   * @description Verifies that route properly handles processor return values
   * @preconditions Route with processors returning different types
   * @expectedResult Should maintain type safety and handle transformations
   */
  test("handles processor return values correctly", async () => {
    const results: unknown[] = [];

    testContext = context()
      .routes(
        routes()
          .from([{ id: "processor-returns" }, simple(() => ({ num: 1 }))])
          .process((exchange) => {
            exchange.body = (exchange.body as { num: number }).num.toString();
            return exchange;
          })
          .process((exchange) => {
            exchange.body = `processed-${exchange.body}`;
            return exchange;
          })
          .to((exchange) => {
            results.push(exchange.body);
          }),
      )
      .build();

    await testContext.start();

    expect(results[0]).toBe("processed-1");
  });

  /**
   * @testCase TC-0023
   * @description Verifies that split step correctly splits a message into multiple exchanges.
   * @preconditions A message to split.
   * @expectedResult The message is split, processed, and all split exchanges (with new IDs) are sent downstream.
   */
  test("splits message into multiple exchanges", async () => {
    const capturedBodies: string[] = [];
    const capturedIds: string[] = [];
    const capturedCorrelationIds: string[] = [];

    testContext = context()
      .routes(
        routes()
          .from([{ id: "split-test" }, simple("hello-world")])
          .split((exchange: any) => {
            // For a string message with '-' delimiter, split into parts.
            const parts =
              typeof exchange.body === "string" ? exchange.body.split("-") : [];
            return parts.map((part) => ({ ...exchange, body: part }));
          })
          .process<string>((exchange) => {
            capturedBodies.push(exchange.body);
            capturedIds.push(exchange.id);
            capturedCorrelationIds.push(
              exchange.headers["routecraft.correlation_id"] as string,
            );
            return exchange;
          })
          .to<string>((exchange) => {
            capturedBodies.push(exchange.body);
            capturedIds.push(exchange.id);
            capturedCorrelationIds.push(
              exchange.headers["routecraft.correlation_id"] as string,
            );
          }),
      )
      .build();

    await testContext.start();

    // Expect the original "hello-world" to be split into two parts: "hello" and "world".
    expect(capturedBodies).toEqual(expect.arrayContaining(["hello", "world"]));
    // There should be at least two distinct exchange IDs (i.e. each split gets a new ID).
    expect(new Set(capturedIds).size).toBeGreaterThan(1);
    // All captured correlation IDs should be identical.
    expect(new Set(capturedCorrelationIds).size).toBe(1);
  });

  /**
   * @testCase TC-0024
   * @description Verifies that a split step returning no exchanges leads to no downstream processing.
   * @preconditions A message to split.
   * @expectedResult No exchanges are sent to the destination.
   */
  test("handles empty split output gracefully", async () => {
    const sendSpy = vi.fn();

    testContext = context()
      .routes(
        routes()
          .from([{ id: "empty-split-test" }, simple("unused-message")])
          .split(() => {
            // Always return an empty array.
            return [];
          })
          .to({
            send: sendSpy,
          }),
      )
      .build();

    await testContext.start();
    // Since splitter returns an empty array, send should not be called.
    expect(sendSpy).not.toHaveBeenCalled();
  });

  /**
   * @testCase TC-0025
   * @description Verifies that the correlation header is maintained across split exchanges.
   * @preconditions A message to split.
   * @expectedResult All exchanges produced by the split step have the same correlation ID.
   */
  test("maintains correlation ID across split exchanges", async () => {
    const capturedCorrelation: string[] = [];

    testContext = context()
      .routes(
        routes()
          .from([{ id: "correlation-split-test" }, simple("part1,part2")])
          .split((exchange: any) => {
            // Using a comma as a delimiter.
            const parts =
              typeof exchange.body === "string" ? exchange.body.split(",") : [];
            return parts.map((part) => ({ ...exchange, body: part }));
          })
          .process<string>((exchange) => {
            capturedCorrelation.push(
              exchange.headers["routecraft.correlation_id"] as string,
            );
            return exchange;
          })
          .to(new NoopAdapter()),
      )
      .build();

    await testContext.start();
    expect(capturedCorrelation.length).toBe(2);
    expect(new Set(capturedCorrelation).size).toBe(1);
  });

  /**
   * @testCase TC-0026
   * @description Verifies that the aggregate step correctly aggregates multiple exchanges.
   * @preconditions A message is split into multiple exchanges.
   * @expectedResult The split exchanges are aggregated into a single exchange with the expected aggregated body.
   */
  test("aggregates split exchanges correctly", async () => {
    const noop = new NoopAdapter();
    const sendSpy = vi.spyOn(noop, "send");
    const split = {
      split: (exchange) =>
        exchange.body
          .split("-")
          .map((part: string) => ({ ...exchange, body: part })),
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
        routes()
          .from([{ id: "aggregate-test" }, simple("a-b-c")])
          .split(split)
          .process(processorSpy)
          .aggregate(agg)
          .to(noop),
      )
      .build();

    await testContext.start();

    expect(splitSpy).toHaveBeenCalledTimes(1);
    expect(processorSpy).toHaveBeenCalledTimes(3);
    expect(aggSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const sentExchange = sendSpy.mock.calls[0][0];
    expect(sentExchange.body).toBe("a,b,c");
  });

  /**
   * @testCase TC-0027
   * @description Verifies that the aggregate step works correctly even if no preceding split occurs.
   * @preconditions A route with an aggregate step immediately following the source.
   * @expectedResult The aggregator receives a single exchange and modifies its body accordingly.
   */
  test("aggregate step with no preceding split", async () => {
    const noop = new NoopAdapter();
    const sendSpy = vi.spyOn(noop, "send");

    testContext = context()
      .routes(
        routes()
          .from([{ id: "aggregate-direct-test" }, simple("original")])
          .to(log())
          .aggregate((exchanges) => {
            return {
              ...exchanges[0],
              body: exchanges[0].body + "-aggregated",
            };
          })
          .to(noop),
      )
      .build();

    await testContext.start();

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const sentExchange = sendSpy.mock.calls[0][0];
    expect(sentExchange.body).toBe("original-aggregated");
  });

  /**
   * @testCase TC-0029
   * @description Verifies that split exchanges maintain custom headers from original exchange
   * @preconditions A message with custom headers to split
   * @expectedResult All split exchanges should contain the original custom headers
   */
  test("split exchanges maintain custom headers", async () => {
    const capturedHeaders: Record<string, unknown>[] = [];

    testContext = context()
      .routes(
        routes()
          .from([
            { id: "split-headers-test" },
            {
              subscribe: async (_, handler) => {
                await handler("one-two", { "custom.header": "test-value" });
              },
            },
          ])
          .split<string, string>((exchange) =>
            exchange.body
              .split("-")
              .map((part) => ({ ...exchange, body: part })),
          )
          .process((exchange) => {
            capturedHeaders.push({ ...exchange.headers });
            return exchange;
          })
          .to(new NoopAdapter()),
      )
      .build();

    await testContext.start();

    // Both split exchanges should have the original custom header
    expect(capturedHeaders).toHaveLength(2);
    expect(capturedHeaders[0]["custom.header"]).toBe("test-value");
    expect(capturedHeaders[1]["custom.header"]).toBe("test-value");
  });

  /**
   * @testCase TC-0030
   * @description Verifies that split exchanges can be processed independently and aggregated correctly
   * @preconditions Split exchanges with individual processing
   * @expectedResult Aggregated result should reflect individual processing
   */
  test("split exchanges can be processed independently before aggregation", async () => {
    const noop = new NoopAdapter();
    const sendSpy = vi.spyOn(noop, "send");

    testContext = context()
      .routes(
        routes()
          .from([{ id: "split-process-aggregate" }, simple("1-2-3")])
          .split<string, number>((exchange) =>
            exchange.body
              .split("-")
              .map((part) => ({ ...exchange, body: parseInt(part) })),
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
          .to(noop),
      )
      .build();

    await testContext.start();

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const sentExchange = sendSpy.mock.calls[0][0];
    expect(sentExchange.body).toBe("2,4,6");
  });

  /**
   * @testCase TC-0031
   * @description Verifies that aggregation handles errors in individual exchanges correctly
   * @preconditions Split exchanges where some processing fails
   * @expectedResult Failed exchanges should not prevent aggregation of successful ones
   */
  test("aggregation handles failed split processing gracefully", async () => {
    // @ts-expect-error Mocking logger.child
    vi.spyOn(logger, "child").mockReturnValue(logSpy);
    const noop = new NoopAdapter();
    const sendSpy = vi.spyOn(noop, "send");

    testContext = context()
      .routes(
        routes()
          .from([
            { id: "split-error-aggregate" },
            simple("success1-error-success2"),
          ])
          .split<string, string>((exchange) =>
            exchange.body
              .split("-")
              .map((part) => ({ ...exchange, body: part })),
          )
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
          .to(noop),
      )
      .build();

    await testContext.start();

    // Verify error was logged
    expect(logSpy.warn).toHaveBeenCalled();
    expect(logSpy.warn.mock.calls[0][1]).toMatch(
      /Step process failed for exchange/,
    );

    // Verify successful exchanges were aggregated
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const sentExchange = sendSpy.mock.calls[0][0];
    expect(sentExchange.body).toBe("success1,success2");
  });

  /**
   * @testCase TC-0032
   * @description Verifies that nested split operations work correctly with aggreattion at each level
   * @preconditions A route with multiple split steps
   * @expectedResult Messages should be split correctly at each level and maintain correlation while aggregating into groups
   */
  test("handles nested split operations", async () => {
    const capturedBodies: string[] = [];
    const capturedCorrelationIds = new Set<string>();
    const noop = new NoopAdapter();
    const sendSpy = vi.spyOn(noop, "send");
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
        routes()
          .from([{ id: "nested-split-test" }, simple("A:1-2|B:3-4")])
          .split<string, string>((exchange) =>
            // First split by |
            exchange.body
              .split("|")
              .map((part) => ({ ...exchange, body: part })),
          )
          .process(processorSpy)
          .split<string, string>((exchange) =>
            // Then split by :
            exchange.body
              .split(":")
              .map((part) => ({ ...exchange, body: part })),
          )
          .process(processorSpy2)
          .split<string, string>((exchange) =>
            // Finally split by -
            exchange.body
              .split("-")
              .map((part) => ({ ...exchange, body: part })),
          )
          .process(processorSpy3)
          .process<string>((exchange) => {
            capturedBodies.push(exchange.body);
            capturedCorrelationIds.add(
              exchange.headers["routecraft.correlation_id"] as string,
            );
            return exchange;
          })
          .aggregate(agg)
          .process(processorSpy4)
          .aggregate(agg2)
          .to(noop),
      )
      .build();

    await testContext.start();

    expect(processorSpy).toHaveBeenCalledTimes(2);
    expect(processorSpy2).toHaveBeenCalledTimes(4);
    expect(processorSpy3).toHaveBeenCalledTimes(6);

    // Should have split into individual numbers and letters
    expect(capturedBodies).toContain("A");
    expect(capturedBodies).toContain("1");
    expect(capturedBodies).toContain("2");
    expect(capturedBodies).toContain("B");
    expect(capturedBodies).toContain("3");
    expect(capturedBodies).toContain("4");

    expect(aggSpy).toHaveBeenCalledTimes(4);
    expect(processorSpy4).toHaveBeenCalledTimes(4);
    expect(aggSpy2).toHaveBeenCalledTimes(2);

    // All exchanges should share the same correlation ID
    expect(capturedCorrelationIds.size).toBe(1);

    expect(sendSpy).toHaveBeenCalledTimes(2);
  });
});
