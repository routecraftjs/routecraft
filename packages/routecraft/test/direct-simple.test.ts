import { describe, test, expect, afterEach, vi } from "vitest";
import { context, craft, simple, direct } from "../src/index.ts";

describe("Direct adapter", () => {
  let ctx: any;

  afterEach(async () => {
    if (ctx) await ctx.stop();
  });

  /**
   * @case Verifies basic direct endpoint communication
   * @preconditions Simple producer and consumer setup
   * @expectedResult Should process message synchronously without errors
   */
  test("basic direct communication", async () => {
    const consumer = vi.fn();

    ctx = context()
      .routes([
        craft()
          .id("producer")
          .from(simple("test-message"))
          .to(direct("endpoint")),
        craft().id("consumer").from(direct("endpoint")).to(consumer),
      ])
      .build();

    await ctx.start();

    // Allow processing to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(consumer).toHaveBeenCalledTimes(1);
    expect(consumer.mock.calls[0][0].body).toBe("test-message");
  });

  /**
   * @case Verifies that different direct endpoints are isolated
   * @preconditions Multiple producers and consumers on different endpoints
   * @expectedResult Each consumer should only receive messages from its endpoint
   */
  test("endpoint isolation", async () => {
    const consumerA = vi.fn();
    const consumerB = vi.fn();

    ctx = context()
      .routes([
        craft()
          .id("producerA")
          .from(simple("messageA"))
          .to(direct("endpointA")),
        craft()
          .id("producerB")
          .from(simple("messageB"))
          .to(direct("endpointB")),
        craft().id("consumerA").from(direct("endpointA")).to(consumerA),
        craft().id("consumerB").from(direct("endpointB")).to(consumerB),
      ])
      .build();

    await ctx.start();

    // Allow processing to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(consumerA).toHaveBeenCalledTimes(1);
    expect(consumerB).toHaveBeenCalledTimes(1);
    expect(consumerA.mock.calls[0][0].body).toBe("messageA");
    expect(consumerB.mock.calls[0][0].body).toBe("messageB");
  });

  /**
   * @case Verifies single consumer semantics (last one wins)
   * @preconditions Multiple consumers registered for same endpoint
   * @expectedResult Only the last registered consumer should receive messages
   */
  test("single consumer semantics", async () => {
    const consumer1 = vi.fn();
    const consumer2 = vi.fn();

    ctx = context()
      .routes([
        craft().id("producer").from(simple("message")).to(direct("shared")),
        craft().id("consumer1").from(direct("shared")).to(consumer1),
        craft().id("consumer2").from(direct("shared")).to(consumer2), // This should win
      ])
      .build();

    await ctx.start();

    // Allow processing to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Only the last registered consumer should receive the message
    expect(consumer1).toHaveBeenCalledTimes(0);
    expect(consumer2).toHaveBeenCalledTimes(1);
    expect(consumer2.mock.calls[0][0].body).toBe("message");
  });

  /**
   * @case Verifies dynamic endpoint routing based on body
   * @preconditions Producer with dynamic endpoint function based on body
   * @expectedResult Messages should route to correct endpoints based on body
   */
  test("dynamic endpoint based on body", async () => {
    const handlerA = vi.fn();
    const handlerB = vi.fn();

    ctx = context()
      .routes([
        craft()
          .id("dynamic-producer")
          .from(
            simple([
              { type: "a", data: "message-a" },
              { type: "b", data: "message-b" },
            ]),
          )
          .to(direct((ex) => `handler-${ex.body.type}`)),
        craft().id("handler-a").from(direct("handler-a")).to(handlerA),
        craft().id("handler-b").from(direct("handler-b")).to(handlerB),
      ])
      .build();

    await ctx.start();

    // Allow processing to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(handlerA).toHaveBeenCalledTimes(1);
    expect(handlerB).toHaveBeenCalledTimes(1);
    expect(handlerA.mock.calls[0][0].body).toEqual({
      type: "a",
      data: "message-a",
    });
    expect(handlerB.mock.calls[0][0].body).toEqual({
      type: "b",
      data: "message-b",
    });
  });

  /**
   * @case Verifies dynamic endpoint routing based on headers
   * @preconditions Producer with dynamic endpoint function based on headers
   * @expectedResult Messages should route to correct endpoints based on headers
   */
  test("dynamic endpoint based on headers", async () => {
    const highPriorityHandler = vi.fn();
    const normalPriorityHandler = vi.fn();

    ctx = context()
      .routes([
        craft()
          .id("priority-producer-high")
          .from(simple("msg1"))
          .header("priority", "high")
          .to(
            direct((ex) => {
              const priority = ex.headers["priority"] || "normal";
              return `processing-${priority}`;
            }),
          ),
        craft()
          .id("priority-producer-normal")
          .from(simple("msg2"))
          .header("priority", "normal")
          .to(
            direct((ex) => {
              const priority = ex.headers["priority"] || "normal";
              return `processing-${priority}`;
            }),
          ),
        craft()
          .id("high-priority")
          .from(direct("processing-high"))
          .to(highPriorityHandler),
        craft()
          .id("normal-priority")
          .from(direct("processing-normal"))
          .to(normalPriorityHandler),
      ])
      .build();

    await ctx.start();

    // Allow processing to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(highPriorityHandler).toHaveBeenCalledTimes(1);
    expect(normalPriorityHandler).toHaveBeenCalledTimes(1);
    expect(highPriorityHandler.mock.calls[0][0].body).toBe("msg1");
    expect(normalPriorityHandler.mock.calls[0][0].body).toBe("msg2");
  });

  /**
   * @case Verifies endpoint sanitization works with dynamic endpoints
   * @preconditions Dynamic endpoint that returns special characters
   * @expectedResult Special characters should be sanitized to dashes
   */
  test("dynamic endpoint sanitization", async () => {
    const consumer = vi.fn();

    ctx = context()
      .routes([
        craft()
          .id("producer")
          .from(simple({ namespace: "com.example", action: "process" }))
          .to(direct((ex) => `${ex.body.namespace}:${ex.body.action}`)),
        craft().id("consumer").from(direct("com-example-process")).to(consumer),
      ])
      .build();

    await ctx.start();

    // Allow processing to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(consumer).toHaveBeenCalledTimes(1);
    expect(consumer.mock.calls[0][0].body).toEqual({
      namespace: "com.example",
      action: "process",
    });
  });

  /**
   * @case Verifies error is thrown when dynamic endpoint used with from()
   * @preconditions Attempt to use dynamic endpoint as source
   * @expectedResult Should throw RC5010 error
   */
  test("throws error for dynamic endpoint as source", async () => {
    expect(() => {
      context()
        .routes([
          craft()
            .id("invalid-consumer")
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            .from(direct((ex) => "dynamic-endpoint"))
            .to(vi.fn()),
        ])
        .build();
    }).not.toThrow(); // Building doesn't throw

    // Set up error listener
    const errorListener = vi.fn();
    ctx = context()
      .routes([
        craft()
          .id("invalid-consumer")
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          .from(direct((ex) => "dynamic-endpoint"))
          .to(vi.fn()),
      ])
      .on("error", errorListener)
      .build();

    // Start returns a promise that uses allSettled, so errors are caught
    await ctx.start();

    // Check that the error event was emitted
    expect(errorListener).toHaveBeenCalled();
    const { details } = errorListener.mock.calls[0][0];
    expect(details.error).toBeDefined();

    // Check the error message (RouteCarftError has meta.message)
    const errorMessage = details.error.meta?.message || details.error.message;
    expect(errorMessage).toContain(
      "Dynamic endpoints cannot be used as source",
    );
  });

  /**
   * @case Verifies multiple messages route correctly to different dynamic endpoints
   * @preconditions Producer sends multiple messages with different routing keys
   * @expectedResult Each handler receives only its designated messages
   */
  test("multiple dynamic routes with complex routing", async () => {
    const orderHandler = vi.fn();
    const userHandler = vi.fn();
    const productHandler = vi.fn();

    ctx = context()
      .routes([
        craft()
          .id("multi-producer")
          .from(
            simple([
              { type: "order", id: 1 },
              { type: "user", id: 2 },
              { type: "product", id: 3 },
              { type: "order", id: 4 },
            ]),
          )
          .to(direct((ex) => `${ex.body.type}-handler`)),
        craft()
          .id("order-consumer")
          .from(direct("order-handler"))
          .to(orderHandler),
        craft()
          .id("user-consumer")
          .from(direct("user-handler"))
          .to(userHandler),
        craft()
          .id("product-consumer")
          .from(direct("product-handler"))
          .to(productHandler),
      ])
      .build();

    await ctx.start();

    // Allow processing to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(orderHandler).toHaveBeenCalledTimes(2);
    expect(userHandler).toHaveBeenCalledTimes(1);
    expect(productHandler).toHaveBeenCalledTimes(1);

    // Verify correct messages were received
    expect(orderHandler.mock.calls[0][0].body).toEqual({
      type: "order",
      id: 1,
    });
    expect(orderHandler.mock.calls[1][0].body).toEqual({
      type: "order",
      id: 4,
    });
    expect(userHandler.mock.calls[0][0].body).toEqual({ type: "user", id: 2 });
    expect(productHandler.mock.calls[0][0].body).toEqual({
      type: "product",
      id: 3,
    });
  });
});
