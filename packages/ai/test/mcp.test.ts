import { describe, test, expect, afterEach, vi } from "vitest";
import { z } from "zod";
import {
  mcp,
  McpHeadersKeys,
  MCP_LOCAL_TOOL_REGISTRY,
  MCP_PLUGIN_REGISTERED,
  type McpLocalToolEntry,
} from "../src/index.ts";
import { testContext, type TestContext } from "@routecraft/testing";
import {
  craft,
  simple,
  direct,
  DefaultExchange,
  ADAPTER_DIRECT_REGISTRY,
} from "@routecraft/routecraft";

const MCP_LOCAL_KEY =
  MCP_LOCAL_TOOL_REGISTRY as keyof import("@routecraft/routecraft").StoreRegistry;
const MCP_PLUGIN_KEY =
  MCP_PLUGIN_REGISTERED as keyof import("@routecraft/routecraft").StoreRegistry;

/** Helper: invoke an mcp() route by calling its registered handler directly. */
async function invokeTool(
  t: TestContext,
  endpoint: string,
  body: unknown,
  headers: Record<string, string | string[] | undefined> = {},
): Promise<void> {
  const registry = t.ctx.getStore(MCP_LOCAL_KEY) as
    | Map<string, McpLocalToolEntry>
    | undefined;
  const entry = registry?.get(endpoint);
  if (!entry) throw new Error(`Tool not found: ${endpoint}`);
  const exchange = new DefaultExchange(t.ctx, { body, headers });
  await entry.handler(exchange);
}

describe("mcp() DSL function", () => {
  let t: TestContext;

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case mcp() consumer receives invocations through MCP_LOCAL_TOOL_REGISTRY
   * @preconditions One route defines .from(mcp("my-tool", { description })); entry looked up in the local tool registry
   * @expectedResult Handler forwards the body to the route consumer
   */
  test("invoking mcp() entry delivers body to consumer", async () => {
    const consumer = vi.fn();

    t = await testContext()
      .routes([
        craft()
          .id("consumer")
          .from(mcp("my-tool", { description: "Receive messages" }))
          .to(consumer),
      ])
      .store(MCP_PLUGIN_KEY, true)
      .build();

    await t.startAndWaitReady();
    await invokeTool(t, "my-tool", { message: "hello" });

    expect(consumer).toHaveBeenCalledTimes(1);
    expect(consumer.mock.calls[0][0].body).toEqual({ message: "hello" });
  });

  /**
   * @case .from(mcp("foo")) and .from(direct("foo")) coexist without collision
   * @preconditions One mcp() and one direct() source share the same endpoint string
   * @expectedResult Direct send reaches the direct consumer; invoking the mcp entry reaches the mcp consumer
   */
  test("mcp() and direct() coexist with identical endpoint", async () => {
    const mcpConsumer = vi.fn();
    const directConsumer = vi.fn();

    t = await testContext()
      .routes([
        craft()
          .id("mcp-consumer")
          .from(mcp("shared", { description: "Shared endpoint via MCP" }))
          .to(mcpConsumer),
        craft()
          .id("direct-consumer")
          .from(direct("shared", {}))
          .to(directConsumer),
        craft()
          .id("direct-producer")
          .from(simple({ origin: "direct" }))
          .to(direct("shared")),
      ])
      .store(MCP_PLUGIN_KEY, true)
      .build();

    await t.startAndWaitReady();
    await t.ctx.drain();
    await invokeTool(t, "shared", { origin: "mcp" });

    expect(directConsumer).toHaveBeenCalledTimes(1);
    expect(directConsumer.mock.calls[0][0].body).toEqual({ origin: "direct" });
    expect(mcpConsumer).toHaveBeenCalledTimes(1);
    expect(mcpConsumer.mock.calls[0][0].body).toEqual({ origin: "mcp" });
  });

  /**
   * @case mcp() with schema validates body at consumer
   * @preconditions Consumer uses mcp() with schema; valid body invoked
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
          .id("consumer")
          .from(
            mcp("fetch-tool", {
              description: "Fetch a URL",
              input: { body: schema },
            }),
          )
          .to(consumer),
      ])
      .store(MCP_PLUGIN_KEY, true)
      .build();

    await t.startAndWaitReady();
    await invokeTool(t, "fetch-tool", { url: "https://example.com" });

    expect(consumer).toHaveBeenCalledTimes(1);
  });

  /**
   * @case mcp() with schema rejects invalid body as RC5002
   * @preconditions Consumer has schema; invoked with invalid body
   * @expectedResult RC5002 error is thrown
   */
  test("mcp() with invalid input throws RC5002", async () => {
    const schema = z.object({
      url: z.string().url(),
    });

    t = await testContext()
      .routes([
        craft()
          .id("consumer")
          .from(
            mcp("fetch-tool", {
              description: "Fetch a URL",
              input: { body: schema },
            }),
          )
          .to(vi.fn()),
      ])
      .store(MCP_PLUGIN_KEY, true)
      .build();

    await t.startAndWaitReady();

    await expect(
      invokeTool(t, "fetch-tool", { url: "not-a-valid-url" }),
    ).rejects.toMatchObject({ rc: "RC5002" });
  });

  /**
   * @case mcp() registers entry in MCP_LOCAL_TOOL_REGISTRY with the full tool shape
   * @preconditions Route uses mcp() with title, description, schema, outputSchema, annotations, and icons
   * @expectedResult Registry contains entry with every tool-shape field
   */
  test("mcp() registers in local tool registry", async () => {
    const icons = [{ src: "https://example.com/icon.svg", sizes: "48x48" }];

    t = await testContext()
      .routes([
        craft()
          .id("my-tool-route")
          .from(
            mcp("search-tool", {
              title: "Document search",
              description: "Search for documents",
              input: { body: z.object({ query: z.string() }) },
              output: { body: z.object({ hits: z.number() }) },
              annotations: { readOnlyHint: true },
              icons,
            }),
          )
          .to(vi.fn()),
      ])
      .store(MCP_PLUGIN_KEY, true)
      .build();

    await t.startAndWaitReady();
    const registry = t.ctx.getStore(MCP_LOCAL_KEY) as
      | Map<string, McpLocalToolEntry>
      | undefined;
    expect(registry).toBeDefined();
    expect(registry?.has("search-tool")).toBe(true);
    const entry = registry?.get("search-tool");
    expect(entry?.title).toBe("Document search");
    expect(entry?.description).toBe("Search for documents");
    expect(entry?.input?.body).toBeDefined();
    expect(entry?.output?.body).toBeDefined();
    expect(entry?.annotations).toEqual({ readOnlyHint: true });
    expect(entry?.icons).toEqual(icons);
    expect(typeof entry?.handler).toBe("function");
  });

  /**
   * @case input.headers schema must not strip MCP-injected headers (tool, session, auth principal)
   * @preconditions mcp() route declares input.headers that only validates `x-tenant`; invoke with tool + auth headers present
   * @expectedResult Route consumer still sees `routecraft.mcp.tool` and any MCP-set headers alongside the validated user header
   */
  test("input.headers schema preserves MCP-injected headers", async () => {
    const consumer = vi.fn();

    t = await testContext()
      .routes([
        craft()
          .id("merge-consumer")
          .from(
            mcp("merge-tool", {
              description: "Header merge test",
              input: {
                headers: z.looseObject({ "x-tenant": z.string() }),
              },
            }),
          )
          .to(consumer),
      ])
      .store(MCP_PLUGIN_KEY, true)
      .build();

    await t.startAndWaitReady();
    await invokeTool(
      t,
      "merge-tool",
      { op: "ping" },
      {
        [McpHeadersKeys.TOOL]: "merge-tool",
        [McpHeadersKeys.SESSION]: "sess-1",
        [McpHeadersKeys.AUTH_SUBJECT]: "user-42",
        "x-tenant": "acme",
      },
    );

    expect(consumer).toHaveBeenCalledTimes(1);
    const headers = consumer.mock.calls[0][0].headers as Record<string, string>;
    expect(headers[McpHeadersKeys.TOOL]).toBe("merge-tool");
    expect(headers[McpHeadersKeys.SESSION]).toBe("sess-1");
    expect(headers[McpHeadersKeys.AUTH_SUBJECT]).toBe("user-42");
    expect(headers["x-tenant"]).toBe("acme");
  });

  /**
   * @case mcp() with annotations registers them in the registry entry
   * @preconditions Route uses mcp() with description and annotations
   * @expectedResult Registry entry carries the annotations object
   */
  test("mcp() with annotations registers them", async () => {
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
      .store(MCP_PLUGIN_KEY, true)
      .build();

    await t.startAndWaitReady();
    const registry = t.ctx.getStore(MCP_LOCAL_KEY) as
      | Map<string, McpLocalToolEntry>
      | undefined;
    const entry = registry?.get("list-items");
    expect(entry?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  /**
   * @case mcp() without annotations omits the field from the registry entry
   * @preconditions Route uses mcp() with description but no annotations
   * @expectedResult Registry entry has no annotations property
   */
  test("mcp() without annotations omits field from entry", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("no-annot-tool")
          .from(mcp("plain-tool", { description: "A plain tool" }))
          .to(vi.fn()),
      ])
      .store(MCP_PLUGIN_KEY, true)
      .build();

    await t.startAndWaitReady();
    const registry = t.ctx.getStore(MCP_LOCAL_KEY) as
      | Map<string, McpLocalToolEntry>
      | undefined;
    const entry = registry?.get("plain-tool");
    expect(entry?.annotations).toBeUndefined();
  });

  /**
   * @case direct() routes never appear in the MCP local tool registry
   * @preconditions One direct() route and one mcp() route coexist
   * @expectedResult MCP_LOCAL_TOOL_REGISTRY contains only the mcp() entry; ADAPTER_DIRECT_REGISTRY holds the direct entry
   */
  test("direct() routes are absent from MCP_LOCAL_TOOL_REGISTRY", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("mcp-tool")
          .from(mcp("exposed", { description: "Exposed tool" }))
          .to(vi.fn()),
        craft().id("internal").from(direct("internal", {})).to(vi.fn()),
      ])
      .store(MCP_PLUGIN_KEY, true)
      .build();

    await t.startAndWaitReady();

    const mcpRegistry = t.ctx.getStore(MCP_LOCAL_KEY) as
      | Map<string, McpLocalToolEntry>
      | undefined;
    expect(Array.from(mcpRegistry?.keys() ?? [])).toEqual(["exposed"]);

    const directRegistry = t.ctx.getStore(ADAPTER_DIRECT_REGISTRY);
    expect(directRegistry?.has("internal")).toBe(true);
    expect(directRegistry?.has("exposed")).toBe(false);
  });

  /**
   * @case Two .from(mcp("foo")) routes in the same context fail at registration
   * @preconditions Two routes register the same mcp() endpoint
   * @expectedResult Second subscription raises RC5003 (duplicate endpoint) through the context error channel
   */
  test("duplicate mcp() endpoint throws RC5003", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("tool-a")
          .from(mcp("dup", { description: "First" }))
          .to(vi.fn()),
        craft()
          .id("tool-b")
          .from(mcp("dup", { description: "Second" }))
          .to(vi.fn()),
      ])
      .store(MCP_PLUGIN_KEY, true)
      .build();

    await expect(t.test()).rejects.toMatchObject({ rc: "RC5003" });
  });

  /**
   * @case Aborting an mcp() subscription removes the entry from the registry
   * @preconditions mcp() route is started, then context is stopped
   * @expectedResult After stop, the entry is gone from MCP_LOCAL_TOOL_REGISTRY
   */
  test("aborting mcp() subscription clears the registry entry", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("ephemeral")
          .from(mcp("ephemeral", { description: "Short-lived" }))
          .to(vi.fn()),
      ])
      .store(MCP_PLUGIN_KEY, true)
      .build();

    await t.startAndWaitReady();
    const before = t.ctx.getStore(MCP_LOCAL_KEY) as
      | Map<string, McpLocalToolEntry>
      | undefined;
    expect(before?.has("ephemeral")).toBe(true);

    await t.stop();
    const after = t.ctx.getStore(MCP_LOCAL_KEY) as
      | Map<string, McpLocalToolEntry>
      | undefined;
    expect(after?.has("ephemeral")).toBe(false);
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
