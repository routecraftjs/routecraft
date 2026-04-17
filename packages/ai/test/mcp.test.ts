import { describe, test, expect, afterEach, vi } from "vitest";
import { z } from "zod";
import { mcp, mcpPlugin } from "../src/index.ts";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  craft,
  simple,
  direct,
  ADAPTER_DIRECT_REGISTRY,
} from "@routecraft/routecraft";

describe("mcp() DSL function", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case In-process: producer uses direct(), consumer uses mcp() with description
   * @preconditions Two routes: producer sends via direct, consumer from mcp with description
   * @expectedResult Message delivered to consumer with same body
   */
  test("in-process producer uses direct(), consumer uses mcp() with description", async () => {
    const consumer = vi.fn();

    t = await testContext()
      .routes([
        craft()
          .id("producer")
          .from(simple({ message: "hello" }))
          .to(direct("my-tool")),
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
   * @case Defining route has description; producer sends via direct()
   * @preconditions One route defines mcp with description, other sends via direct to same endpoint
   * @expectedResult Message delivered to defining route
   */
  test("docs pattern: define mcp with description, producer sends via direct()", async () => {
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
          .to(direct("my-tool")),
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
          .to(direct("fetch-tool")),
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
   * @expectedResult RC5002 error emitted and error handler called
   */
  test("mcp() with invalid input throws RC5002", async () => {
    const schema = z.object({
      url: z.string().url(),
    });

    t = await testContext()
      .routes([
        craft()
          .id("producer")
          .from(simple({ url: "not-a-valid-url" }))
          .to(direct("fetch-tool")),
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
    expect(t.errors[0].rc).toBe("RC5002");
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
    const registry = t.ctx.getStore(ADAPTER_DIRECT_REGISTRY);
    expect(registry).toBeDefined();
    expect(registry?.has("search-tool")).toBe(true);
    const metadata = registry?.get("search-tool");
    expect(metadata?.description).toBe("Search for documents");
    expect(metadata?.keywords).toEqual(["search", "query", "find"]);
  });

  /**
   * @case mcp() with annotations registers them in route metadata
   * @preconditions Route uses mcp() with description and annotations
   * @expectedResult Registry contains endpoint with annotations
   */
  test("mcp() with annotations registers them in metadata", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("read-only-tool")
          .from(
            mcp("list-items", {
              description: "List items",
              annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
              },
            }),
          )
          .to(vi.fn()),
      ])
      .with({ plugins: [mcpPlugin()] })
      .build();

    await t.test();
    const registry = t.ctx.getStore(ADAPTER_DIRECT_REGISTRY);
    expect(registry).toBeDefined();
    const metadata = registry?.get("list-items");
    expect(metadata?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  /**
   * @case mcp() without annotations omits the field from metadata
   * @preconditions Route uses mcp() with description but no annotations
   * @expectedResult Registry entry has no annotations property
   */
  test("mcp() without annotations omits field from metadata", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("no-annot-tool")
          .from(mcp("plain-tool", { description: "A plain tool" }))
          .to(vi.fn()),
      ])
      .with({ plugins: [mcpPlugin()] })
      .build();

    await t.test();
    const registry = t.ctx.getStore(ADAPTER_DIRECT_REGISTRY);
    const metadata = registry?.get("plain-tool");
    expect(metadata?.annotations).toBeUndefined();
  });

  /**
   * @case mcp() with McpClientOptions returns McpAdapter (facade) for remote server
   * @preconditions Call mcp({ url, tool })
   * @expectedResult Returns adapter with adapterId routecraft.adapter.mcp and send method
   */
  test("mcp({ url, tool }) returns McpAdapter with send", () => {
    const adapter = mcp({
      url: "http://localhost:3001/mcp",
      tool: "my-remote-tool",
    });
    expect(adapter).toBeDefined();
    expect(adapter.adapterId).toBe("routecraft.adapter.mcp");
    expect(typeof adapter.send).toBe("function");
  });

  /**
   * @case direct() with function endpoint resolves at send time
   * @preconditions Producer uses direct((ex) => `handler-${ex.body.type}`); two handler routes with mcp()
   * @expectedResult Message routed to correct handler by body.type
   */
  test("direct() works with dynamic endpoints (destination only)", async () => {
    const consumerA = vi.fn();
    const consumerB = vi.fn();

    t = await testContext()
      .routes([
        craft()
          .id("producer")
          .from(simple({ type: "a", data: "test" }))
          .to(direct((ex) => `handler-${ex.body.type}`)),
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

  /**
   * @case mcp(endpoint) with no options throws (direct not supported; use direct())
   * @preconditions Call mcp("endpoint") with no second argument
   * @expectedResult Throws with message about using direct() for in-process
   */
  test("mcp(endpoint) with no options throws", () => {
    expect(() => mcp("my-tool")).toThrow(
      /direct\(.*endpoint.*\) for in-process|mcp\(\) with only an endpoint is not supported/,
    );
  });
});
