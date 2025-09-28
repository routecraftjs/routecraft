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
});
