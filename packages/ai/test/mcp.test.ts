import { describe, test, expect, afterEach, vi } from "vitest";
import { z } from "zod";
import { mcp, mcpPlugin } from "../src/index.ts";
import { testContext, type TestContext } from "@routecraft/testing";
import { craft, simple, DirectAdapter } from "@routecraft/routecraft";

describe("mcp() DSL function", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case mcp() behaves like direct() for producer-consumer flow
   * @preconditions Two routes: producer sends to mcp endpoint, consumer from same mcp endpoint
   * @expectedResult Message delivered to consumer with same body
   */
  test("mcp() is an alias for direct()", async () => {
    const consumer = vi.fn();

    t = await testContext()
      .routes([
        craft()
          .id("producer")
          .from(simple({ message: "hello" }))
          .to(mcp("my-tool")),
        craft()
          .id("consumer")
          .from(mcp("my-tool", { description: "Receive messages" }))
          .to(consumer),
      ])
      .with({ plugins: [mcpPlugin()] })
      .build();

    await t.test();
    expect(consumer).toHaveBeenCalledTimes(1);
    expect(consumer.mock.calls[0][0].body).toEqual({ message: "hello" });
  });

  /**
   * @case Defining route has description only; producer sends with mcp(name) no options
   * @preconditions One route defines mcp with description, other sends to mcp endpoint
   * @expectedResult Message delivered to defining route
   */
  test("docs pattern: define mcp with description, producer sends with no options", async () => {
    const consumer = vi.fn();

    t = await testContext()
      .routes([
        craft()
          .id("my-tool")
          .from(mcp("my-tool", { description: "My tool" }))
          .to(consumer),
        craft()
          .id("producer")
          .from(simple({ query: "hello" }))
          .to(mcp("my-tool")),
      ])
      .with({ plugins: [mcpPlugin()] })
      .build();

    await t.test();
    expect(consumer).toHaveBeenCalledTimes(1);
    expect(consumer.mock.calls[0][0].body).toEqual({ query: "hello" });
  });

  /**
   * @case mcp() with schema option validates body at consumer
   * @preconditions Consumer uses mcp() with schema; producer sends valid body
   * @expectedResult Message processed without error
   */
  test("mcp() with schema validates input", async () => {
    const schema = z.object({
      url: z.string().url(),
    });

    const consumer = vi.fn();

    t = await testContext()
      .routes([
        craft()
          .id("producer")
          .from(simple({ url: "https://example.com" }))
          .to(mcp("fetch-tool")),
        craft()
          .id("consumer")
          .from(
            mcp("fetch-tool", {
              description: "Fetch a URL",
              schema,
            }),
          )
          .to(consumer),
      ])
      .with({ plugins: [mcpPlugin()] })
      .build();

    await t.test();
    expect(consumer).toHaveBeenCalledTimes(1);
  });

  /**
   * @case mcp() with schema rejects invalid body
   * @preconditions Consumer has schema; producer sends invalid body
   * @expectedResult RC5011 error emitted and error handler called
   */
  test("mcp() with invalid input throws RC5011", async () => {
    const schema = z.object({
      url: z.string().url(),
    });

    t = await testContext()
      .routes([
        craft()
          .id("producer")
          .from(simple({ url: "not-a-valid-url" }))
          .to(mcp("fetch-tool")),
        craft()
          .id("consumer")
          .from(
            mcp("fetch-tool", {
              description: "Fetch a URL",
              schema,
            }),
          )
          .to(vi.fn()),
      ])
      .with({ plugins: [mcpPlugin()] })
      .build();

    await t.test();
    expect(t.errors).toHaveLength(1);
    expect(t.errors[0].rc).toBe("RC5011");
  });

  /**
   * @case mcp() with description/keywords registers metadata
   * @preconditions Route uses mcp() with description, schema, and keywords
   * @expectedResult Registry contains endpoint with metadata
   */
  test("mcp() registers in discovery registry", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("my-tool-route")
          .from(
            mcp("search-tool", {
              description: "Search for documents",
              schema: z.object({ query: z.string() }),
              keywords: ["search", "query", "find"],
            }),
          )
          .to(vi.fn()),
      ])
      .with({ plugins: [mcpPlugin()] })
      .build();

    await t.test();
    const registry = t.ctx.getStore(DirectAdapter.ADAPTER_DIRECT_REGISTRY);
    expect(registry).toBeDefined();
    expect(registry?.has("search-tool")).toBe(true);
    const metadata = registry?.get("search-tool");
    expect(metadata?.description).toBe("Search for documents");
    expect(metadata?.keywords).toEqual(["search", "query", "find"]);
  });

  /**
   * @case mcp() with McpClientOptions returns MCP client adapter for remote server
   * @preconditions Call mcp({ url, tool })
   * @expectedResult Returns adapter with adapterId routecraft.adapter.mcp.client and send method
   */
  test("mcp({ url, tool }) returns MCP client adapter", () => {
    const adapter = mcp({
      url: "http://localhost:3001/mcp",
      tool: "my-remote-tool",
    });
    expect(adapter).toBeDefined();
    expect(adapter.adapterId).toBe("routecraft.adapter.mcp.client");
    expect(typeof adapter.send).toBe("function");
  });

  /**
   * @case mcp() with function endpoint resolves at send time
   * @preconditions Producer uses mcp((ex) => `handler-${ex.body.type}`); two handler routes
   * @expectedResult Message routed to correct handler by body.type
   */
  test("mcp() works with dynamic endpoints (destination only)", async () => {
    const consumerA = vi.fn();
    const consumerB = vi.fn();

    t = await testContext()
      .routes([
        craft()
          .id("producer")
          .from(simple({ type: "a", data: "test" }))
          .to(mcp((ex) => `handler-${ex.body.type}`)),
        craft()
          .id("handler-a")
          .from(mcp("handler-a", { description: "Handler A" }))
          .to(consumerA),
        craft()
          .id("handler-b")
          .from(mcp("handler-b", { description: "Handler B" }))
          .to(consumerB),
      ])
      .with({ plugins: [mcpPlugin()] })
      .build();

    await t.test();
    expect(consumerA).toHaveBeenCalledTimes(1);
    expect(consumerB).not.toHaveBeenCalled();
  });
});
