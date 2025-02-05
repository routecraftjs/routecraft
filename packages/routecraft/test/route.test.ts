import { describe, test, expect, afterEach, vi, beforeEach } from "vitest";
import {
  context,
  routes,
  simple,
  processor,
  type CraftContext,
  NoopAdapter,
  logger,
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
    const processorSpy = vi.fn((exchange) => exchange);
    const noop = new NoopAdapter();
    const sendSpy = vi.spyOn(noop, "send");

    testContext = context()
      .routes(
        routes()
          .from(
            { id: "test-pipeline" },
            simple(() => "test-message"),
          )
          .process(processor(processorSpy))
          .to(noop),
      )
      .build();

    await testContext.start();

    expect(processorSpy).toHaveBeenCalled();
    expect(sendSpy).toHaveBeenCalled();
    const sentExchange = sendSpy.mock.calls[0][0];
    expect(sentExchange.body).toBe("test-message");
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
          .from(
            { id: "continuous-route" },
            {
              adapterId: "test.continuous",
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
          )
          .process(processor(processorSpy))
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
    vi.spyOn(logger, "child").mockReturnValue(logSpy);
    const noop = new NoopAdapter();
    const sendSpy = vi.spyOn(noop, "send");

    testContext = context()
      .routes(
        routes()
          .from(
            { id: "error-route" },
            simple(() => "test"),
          )
          .process(
            processor(() => {
              throw new Error("Processor error");
            }),
          )
          .to(noop),
      )
      .build();

    await testContext.start();

    expect(logSpy.warn).toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
    expect(logSpy.warn.mock.calls[0][0]).toMatch(/Failed to process message/);
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
          .from(
            { id: "correlation-test" },
            simple(() => "test"),
          )
          .process(
            processor((exchange) => {
              capturedCorrelationIds.push(
                exchange.headers["routecraft.correlation_id"] as string,
              );
              return exchange;
            }),
          )
          .process(
            processor((exchange) => {
              capturedCorrelationIds.push(
                exchange.headers["routecraft.correlation_id"] as string,
              );
              return exchange;
            }),
          )
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
    vi.spyOn(logger, "child").mockReturnValue(logSpy);
    const messages = ["success1", "fail", "success2"];
    let processedCount = 0;

    testContext = context()
      .routes(
        routes()
          .from(
            { id: "fail-continue-route" },
            {
              adapterId: "test.sequence",
              subscribe: async (_, handler) => {
                for (const msg of messages) {
                  await handler(msg);
                }
              },
            },
          )
          .process(
            processor((exchange) => {
              if (exchange.body === "fail") {
                throw new Error("Simulated failure");
              }
              processedCount++;
              return exchange;
            }),
          )
          .to(new NoopAdapter()),
      )
      .build();

    await testContext.start();

    // Verify error was logged for failed message
    expect(logSpy.warn).toHaveBeenCalled();
    expect(logSpy.warn.mock.calls[0][0]).toMatch(/Failed to process message/);

    // Verify successful messages were processed
    expect(processedCount).toBe(2); // Both success1 and success2 should be processed
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
          .from(
            { id: "headers-test" },
            {
              adapterId: "test.headers",
              subscribe: async (_, handler) => {
                await handler("test", { "custom.header": "test-value" });
              },
            },
          )
          .process(
            processor((exchange) => {
              capturedHeaders.push({ ...exchange.headers });
              exchange.headers["processor.header"] = "added-value";
              return exchange;
            }),
          )
          .to({
            adapterId: "test.destination",
            send: async (exchange) => {
              capturedHeaders.push({ ...exchange.headers });
            },
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
          .from(
            { id: "async-test" },
            simple(() => "test"),
          )
          .process(
            processor(async (exchange) => {
              await new Promise((resolve) => setTimeout(resolve, 10));
              processingOrder.push("first");
              return exchange;
            }),
          )
          .process(
            processor(async (exchange) => {
              processingOrder.push("second");
              return exchange;
            }),
          )
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
          .from(
            { id: "transform-test" },
            simple(() => ({ value: 1 })),
          )
          .process(
            processor((exchange) => {
              transformedBodies.push(exchange.body);
              exchange.body = {
                value: (exchange.body as { value: number }).value + 1,
              };
              return exchange;
            }),
          )
          .process(
            processor((exchange) => {
              transformedBodies.push(exchange.body);
              exchange.body = {
                value: (exchange.body as { value: number }).value * 2,
              };
              return exchange;
            }),
          )
          .to({
            adapterId: "test.capture",
            send: async (exchange) => {
              transformedBodies.push(exchange.body);
            },
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
          .from(
            { id: "processor-returns" },
            simple(() => ({ num: 1 })),
          )
          .process(
            processor((exchange) => {
              exchange.body = (exchange.body as { num: number }).num.toString();
              return exchange;
            }),
          )
          .process(
            processor((exchange) => {
              exchange.body = `processed-${exchange.body}`;
              return exchange;
            }),
          )
          .to({
            adapterId: "test.capture",
            send: async (exchange) => {
              results.push(exchange.body);
            },
          }),
      )
      .build();

    await testContext.start();

    expect(results[0]).toBe("processed-1");
  });
});
