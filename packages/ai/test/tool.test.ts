import { describe, test, expect, afterEach, vi } from "vitest";
import { z } from "zod";
import { tool } from "../src/index.ts";
import {
  context,
  craft,
  simple,
  DirectAdapter,
  type CraftContext,
} from "@routecraft/routecraft";

describe("tool() DSL function", () => {
  let ctx: CraftContext;

  afterEach(async () => {
    if (ctx) await ctx.stop();
  });

  /**
   * @case tool() behaves like direct() for producer-consumer flow
   * @preconditions Two routes: producer sends to tool endpoint, consumer from same tool endpoint
   * @expectedResult Message delivered to consumer with same body
   */
  test("tool() is an alias for direct()", async () => {
    const consumer = vi.fn();

    ctx = context()
      .routes([
        craft()
          .id("producer")
          .from(simple({ message: "hello" }))
          .to(tool("my-tool")),
        craft()
          .id("consumer")
          .from(tool("my-tool", { description: "Receive messages" }))
          .to(consumer),
      ])
      .build();

    await ctx.start();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(consumer).toHaveBeenCalledTimes(1);
    expect(consumer.mock.calls[0][0].body).toEqual({ message: "hello" });
  });

  /**
   * @case Defining route has description only; producer sends with tool(name) no options
   * @preconditions One route defines tool with description, other sends to tool endpoint
   * @expectedResult Message delivered to defining route
   */
  test("docs pattern: define tool with description, producer sends with no options", async () => {
    const consumer = vi.fn();

    ctx = context()
      .routes([
        craft().id("my-tool").from(tool("my-tool")).to(consumer),
        craft()
          .id("producer")
          .from(simple({ query: "hello" }))
          .to(tool("my-tool")),
      ])
      .build();

    await ctx.start();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(consumer).toHaveBeenCalledTimes(1);
    expect(consumer.mock.calls[0][0].body).toEqual({ query: "hello" });
  });

  /**
   * @case tool() with schema option validates body at consumer
   * @preconditions Consumer uses tool() with schema; producer sends valid body
   * @expectedResult Message processed without error
   */
  test("tool() with schema validates input", async () => {
    const schema = z.object({
      url: z.string().url(),
    });

    const consumer = vi.fn();

    ctx = context()
      .routes([
        craft()
          .id("producer")
          .from(simple({ url: "https://example.com" }))
          .to(tool("fetch-tool")),
        craft()
          .id("consumer")
          .from(
            tool("fetch-tool", {
              description: "Fetch a URL",
              schema,
            }),
          )
          .to(consumer),
      ])
      .build();

    await ctx.start();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(consumer).toHaveBeenCalledTimes(1);
  });

  /**
   * @case tool() with schema rejects invalid body
   * @preconditions Consumer has schema; producer sends invalid body
   * @expectedResult RC5011 error emitted and error handler called
   */
  test("tool() with invalid input throws RC5011", async () => {
    const schema = z.object({
      url: z.string().url(),
    });

    const errorHandler = vi.fn();

    ctx = context()
      .on("error", errorHandler)
      .routes([
        craft()
          .id("producer")
          .from(simple({ url: "not-a-valid-url" }))
          .to(tool("fetch-tool")),
        craft()
          .id("consumer")
          .from(
            tool("fetch-tool", {
              description: "Fetch a URL",
              schema,
            }),
          )
          .to(vi.fn()),
      ])
      .build();

    await ctx.start();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(errorHandler).toHaveBeenCalled();
    const error = errorHandler.mock.calls[0][0].details.error;
    expect(error.rc).toBe("RC5011");
  });

  /**
   * @case tool() with description/keywords registers metadata
   * @preconditions Route uses tool() with description, schema, and keywords
   * @expectedResult Registry contains endpoint with metadata
   */
  test("tool() registers in discovery registry", async () => {
    ctx = context()
      .routes([
        craft()
          .id("my-tool-route")
          .from(
            tool("search-tool", {
              description: "Search for documents",
              schema: z.object({ query: z.string() }),
              keywords: ["search", "query", "find"],
            }),
          )
          .to(vi.fn()),
      ])
      .build();

    await ctx.start();

    const registry = ctx.getStore(DirectAdapter.ADAPTER_DIRECT_REGISTRY);
    expect(registry).toBeDefined();
    expect(registry?.has("search-tool")).toBe(true);

    const metadata = registry?.get("search-tool");
    expect(metadata?.description).toBe("Search for documents");
    expect(metadata?.keywords).toEqual(["search", "query", "find"]);
  });

  /**
   * @case tool() with function endpoint resolves at send time
   * @preconditions Producer uses tool((ex) => `handler-${ex.body.type}`); two handler routes
   * @expectedResult Message routed to correct handler by body.type
   */
  test("tool() works with dynamic endpoints (destination only)", async () => {
    const consumerA = vi.fn();
    const consumerB = vi.fn();

    ctx = context()
      .routes([
        craft()
          .id("producer")
          .from(simple({ type: "a", data: "test" }))
          .to(tool((ex) => `handler-${ex.body.type}`)),
        craft().id("handler-a").from(tool("handler-a")).to(consumerA),
        craft().id("handler-b").from(tool("handler-b")).to(consumerB),
      ])
      .build();

    await ctx.start();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(consumerA).toHaveBeenCalledTimes(1);
    expect(consumerB).not.toHaveBeenCalled();
  });
});
