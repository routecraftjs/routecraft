import { describe, test, expect, afterEach, vi } from "vitest";
import { testContext, type TestContext } from "@routecraft/testing";
import { craft, simple, direct, type Source } from "@routecraft/routecraft";
import type { CallableDestination } from "../src/operations/to.ts";

describe("Direct adapter", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case Verifies basic direct endpoint communication
   * @preconditions Simple producer and consumer setup
   * @expectedResult Should process message synchronously without errors
   */
  test("basic direct communication", async () => {
    const consumer = vi.fn();

    t = await testContext()
      .routes([
        craft()
          .id("producer")
          .from(simple("test-message"))
          .to(direct("endpoint")),
        craft().id("consumer").from(direct("endpoint", {})).to(consumer),
      ])
      .build();

    await t.test();
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

    t = await testContext()
      .routes([
        craft()
          .id("producerA")
          .from(simple("messageA"))
          .to(direct("endpointA")),
        craft()
          .id("producerB")
          .from(simple("messageB"))
          .to(direct("endpointB")),
        craft().id("consumerA").from(direct("endpointA", {})).to(consumerA),
        craft().id("consumerB").from(direct("endpointB", {})).to(consumerB),
      ])
      .build();

    await t.test();
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

    t = await testContext()
      .routes([
        craft().id("producer").from(simple("message")).to(direct("shared")),
        craft().id("consumer1").from(direct("shared", {})).to(consumer1),
        craft().id("consumer2").from(direct("shared", {})).to(consumer2), // This should win
      ])
      .build();

    await t.test();
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

    t = await testContext()
      .routes([
        craft()
          .id("dynamic-producer")
          .from(
            simple([
              { type: "a", data: "message-a" },
              { type: "b", data: "message-b" },
            ]),
          )
          .split()
          .to(direct((ex) => `handler-${ex.body.type}`)),
        craft().id("handler-a").from(direct("handler-a", {})).to(handlerA),
        craft().id("handler-b").from(direct("handler-b", {})).to(handlerB),
      ])
      .build();

    await t.test();
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

    t = await testContext()
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
          .from(direct("processing-high", {}))
          .to(highPriorityHandler),
        craft()
          .id("normal-priority")
          .from(direct("processing-normal", {}))
          .to(normalPriorityHandler),
      ])
      .build();

    await t.test();
    expect(highPriorityHandler).toHaveBeenCalledTimes(1);
    expect(normalPriorityHandler).toHaveBeenCalledTimes(1);
    expect(highPriorityHandler.mock.calls[0][0].body).toBe("msg1");
    expect(normalPriorityHandler.mock.calls[0][0].body).toBe("msg2");
  });

  /**
   * @case Verifies endpoint sanitization works with dynamic endpoints
   * @preconditions Dynamic endpoint that returns special characters
   * @expectedResult Special characters should be URL-encoded for collision-free routing
   */
  test("dynamic endpoint sanitization", async () => {
    const consumer = vi.fn();

    t = await testContext()
      .routes([
        craft()
          .id("producer")
          .from(simple({ namespace: "com.example", action: "process" }))
          .to(direct((ex) => `${ex.body.namespace}:${ex.body.action}`)),
        craft()
          .id("consumer")
          .from(direct("com.example:process", {}))
          .to(consumer),
      ])
      .build();

    await t.test();
    expect(consumer).toHaveBeenCalledTimes(1);
    expect(consumer.mock.calls[0][0].body).toEqual({
      namespace: "com.example",
      action: "process",
    });
  });

  /**
   * @case Verifies error is thrown when dynamic endpoint used with from()
   * @preconditions Attempt to use dynamic endpoint as source
   * @expectedResult Should throw RC1001 error (invalid-consumer) during build
   */
  test("throws error for dynamic endpoint as source", async () => {
    // With the refactored adapter, build() now throws RC1001 (invalid-consumer)
    // because DirectDestinationAdapter doesn't have a subscribe method.
    // This is actually better - fail fast at build time rather than runtime.
    await expect(async () => {
      await testContext()
        .routes([
          craft()
            .id("invalid-consumer")
            .from(
              direct(() => "dynamic-endpoint") as unknown as Source<unknown>,
            )
            .to(vi.fn() as CallableDestination<unknown, void>),
        ])
        .build();
    }).rejects.toThrow("invalid-consumer");
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

    t = await testContext()
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
          .split()
          .to(direct((ex) => `${ex.body.type}-handler`)),
        craft()
          .id("order-consumer")
          .from(direct("order-handler", {}))
          .to(orderHandler),
        craft()
          .id("user-consumer")
          .from(direct("user-handler", {}))
          .to(userHandler),
        craft()
          .id("product-consumer")
          .from(direct("product-handler", {}))
          .to(productHandler),
      ])
      .build();

    await t.test();
    expect(orderHandler).toHaveBeenCalledTimes(2);
    expect(userHandler).toHaveBeenCalledTimes(1);
    expect(productHandler).toHaveBeenCalledTimes(1);

    expect(orderHandler.mock.calls[0][0].body).toEqual({
      type: "order",
      id: 1,
    });
    expect(orderHandler.mock.calls[1][0].body).toEqual({
      type: "order",
      id: 4,
    });
    expect(userHandler.mock.calls[0][0].body).toEqual({
      type: "user",
      id: 2,
    });
    expect(productHandler.mock.calls[0][0].body).toEqual({
      type: "product",
      id: 3,
    });
  });
});
