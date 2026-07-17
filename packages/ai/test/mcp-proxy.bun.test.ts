import { describe, test, expect, afterEach } from "bun:test";
import { craft, noop } from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";
import { McpServer } from "../src/mcp/server.ts";
import { McpToolRegistry } from "../src/mcp/tool-registry.ts";
import { mcp, mcpPlugin } from "../src/index.ts";
import {
  MCP_PLUGIN_REGISTERED,
  MCP_STDIO_MANAGERS,
  MCP_TOOL_REGISTRY,
} from "../src/mcp/types.ts";
import type { McpRawToolResult, McpTool } from "../src/mcp/types.ts";

type StoreKey = keyof import("@routecraft/routecraft").StoreRegistry;

const REGISTERED_KEY = MCP_PLUGIN_REGISTERED as StoreKey;
const REGISTRY_KEY = MCP_TOOL_REGISTRY as StoreKey;
const MANAGERS_KEY = MCP_STDIO_MANAGERS as StoreKey;

/** Private surface of McpServer used by these tests. */
type TestableServer = {
  handleToolCall(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{
    content: Array<{ type: string; text?: string; [key: string]: unknown }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  }>;
};

/** Recorded dispatches from the fake stdio managers. */
let dispatches: Array<{
  serverId: string;
  toolName: string;
  args: Record<string, unknown>;
}> = [];

/** Build a registry with remote tools for the "docs" and "billing" clients. */
function buildRegistry(): McpToolRegistry {
  const registry = new McpToolRegistry();
  registry.setToolsForSource("docs", "stdio", [
    {
      name: "get_document",
      title: "Get document",
      description: "Read one document by id",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      outputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
      },
      annotations: { readOnlyHint: true },
      icons: [{ src: "https://docs.example/icon.svg" }],
    },
    {
      name: "search",
      description: "Search documents",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
    },
  ]);
  registry.setToolsForSource("billing", "stdio", [
    {
      name: "search",
      description: "Search invoices",
      inputSchema: { type: "object" },
    },
  ]);
  return registry;
}

/** Fake stdio manager map recording calls and returning a raw MCP result. */
function buildManagers(rawResult?: McpRawToolResult): Map<
  string,
  {
    callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
    callToolRaw(
      name: string,
      args: Record<string, unknown>,
    ): Promise<McpRawToolResult>;
  }
> {
  const managers = new Map<
    string,
    {
      callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
      callToolRaw(
        name: string,
        args: Record<string, unknown>,
      ): Promise<McpRawToolResult>;
    }
  >();
  for (const serverId of ["docs", "billing"]) {
    managers.set(serverId, {
      async callTool(name, args) {
        dispatches.push({ serverId, toolName: name, args });
        return "extracted";
      },
      async callToolRaw(name, args) {
        dispatches.push({ serverId, toolName: name, args });
        return (
          rawResult ?? {
            content: [{ type: "text", text: `raw:${serverId}:${name}` }],
          }
        );
      },
    });
  }
  return managers;
}

describe("MCP tool proxying", () => {
  let t: TestContext;
  let server: McpServer;

  afterEach(async () => {
    dispatches = [];
    if (server) {
      try {
        await server.stop();
      } catch {
        // ignore
      }
    }
    if (t) {
      await t.stop();
    }
  });

  /**
   * @case Exact proxy ref exposes the remote tool in tools/list with metadata passthrough
   * @preconditions Registry has docs:get_document with schema, title, description, annotations, output schema, and icons; proxy is ["docs:get_document"]
   * @expectedResult getAvailableTools() lists "get_document" carrying the remote inputSchema, outputSchema, title, description, annotations, and icons verbatim
   */
  test("exact ref passes remote tool metadata through to tools/list", async () => {
    t = await testContext().store(REGISTRY_KEY, buildRegistry()).build();
    server = new McpServer(t.ctx, { proxy: ["docs:get_document"] });

    const tools = server.getAvailableTools();
    expect(tools.map((tool) => tool.name)).toEqual(["get_document"]);
    const tool = tools[0] as McpTool;
    expect(tool.description).toBe("Read one document by id");
    expect(tool.title).toBe("Get document");
    expect(tool.inputSchema).toEqual({
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    });
    expect(tool.outputSchema).toEqual({
      type: "object",
      properties: { text: { type: "string" } },
    });
    expect(tool.annotations).toEqual({ readOnlyHint: true });
    expect(tool.icons).toEqual([{ src: "https://docs.example/icon.svg" }]);
  });

  /**
   * @case Wildcard and bare-server refs expose every tool of the client
   * @preconditions Registry has two docs tools; proxy is ["docs:*"] then ["docs"]
   * @expectedResult Both forms list get_document and search
   */
  test("wildcard and bare-server refs expose all client tools", async () => {
    t = await testContext().store(REGISTRY_KEY, buildRegistry()).build();

    server = new McpServer(t.ctx, { proxy: ["docs:*"] });
    expect(
      server
        .getAvailableTools()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(["get_document", "search"]);
    await server.stop();

    server = new McpServer(t.ctx, { proxy: ["docs"] });
    expect(
      server
        .getAvailableTools()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(["get_document", "search"]);
  });

  /**
   * @case Per-entry overrides rename the tool and replace description / merge annotations
   * @preconditions Proxy entry { ref: "docs:get_document", name: "read_doc", description: "override", annotations: { idempotentHint: true } }
   * @expectedResult Listed tool is "read_doc" with the override description and merged annotations (remote readOnlyHint kept)
   */
  test("overrides apply to name, description, and annotations", async () => {
    t = await testContext().store(REGISTRY_KEY, buildRegistry()).build();
    server = new McpServer(t.ctx, {
      proxy: [
        {
          ref: "docs:get_document",
          name: "read_doc",
          description: "override",
          annotations: { idempotentHint: true },
        },
      ],
    });

    const tools = server.getAvailableTools();
    expect(tools.map((tool) => tool.name)).toEqual(["read_doc"]);
    expect(tools[0].description).toBe("override");
    expect(tools[0].annotations).toEqual({
      readOnlyHint: true,
      idempotentHint: true,
    });
  });

  /**
   * @case Proxied tool call dispatches to the client and passes the raw result through
   * @preconditions Fake stdio manager returns a raw result with content, structuredContent, and no error; proxy is ["docs:get_document"]
   * @expectedResult handleToolCall returns content and structuredContent verbatim and dispatched with the remote tool name and args
   */
  test("proxied call dispatches raw and passes result through", async () => {
    const raw: McpRawToolResult = {
      content: [{ type: "text", text: "the doc" }],
      structuredContent: { text: "the doc" },
    };
    t = await testContext()
      .store(REGISTRY_KEY, buildRegistry())
      .store(MANAGERS_KEY, buildManagers(raw))
      .build();
    server = new McpServer(t.ctx, {
      proxy: [{ ref: "docs:get_document", name: "read_doc" }],
    });

    const result = await (server as unknown as TestableServer).handleToolCall(
      "read_doc",
      { id: "42" },
    );
    expect(result.content).toEqual([{ type: "text", text: "the doc" }]);
    expect(result.structuredContent).toEqual({ text: "the doc" });
    expect(result.isError).toBeUndefined();
    expect(dispatches).toEqual([
      { serverId: "docs", toolName: "get_document", args: { id: "42" } },
    ]);
  });

  /**
   * @case Remote isError results pass through instead of being swallowed
   * @preconditions Fake stdio manager returns { isError: true, content: [error text] }
   * @expectedResult handleToolCall returns isError true with the remote error content
   */
  test("remote error results pass through with isError", async () => {
    const raw: McpRawToolResult = {
      isError: true,
      content: [{ type: "text", text: "remote boom" }],
    };
    t = await testContext()
      .store(REGISTRY_KEY, buildRegistry())
      .store(MANAGERS_KEY, buildManagers(raw))
      .build();
    server = new McpServer(t.ctx, { proxy: ["docs:get_document"] });

    const result = await (server as unknown as TestableServer).handleToolCall(
      "get_document",
      { id: "42" },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "remote boom" }]);
  });

  /**
   * @case Dispatch failures surface as isError text results, not thrown errors
   * @preconditions No stdio manager and no HTTP config for "docs" (dispatch throws RC5003)
   * @expectedResult handleToolCall returns isError true with an error message
   */
  test("dispatch failure returns an isError result", async () => {
    t = await testContext().store(REGISTRY_KEY, buildRegistry()).build();
    server = new McpServer(t.ctx, { proxy: ["docs:get_document"] });

    const result = await (server as unknown as TestableServer).handleToolCall(
      "get_document",
      { id: "42" },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Error");
  });

  /**
   * @case Local mcp() route wins a name collision with a proxied tool
   * @preconditions Route id get_document with mcp() source; registry proxies docs:get_document under the same name
   * @expectedResult tools/list has one get_document (the route's description), and calling it runs the route rather than dispatching to the client
   */
  test("local route tool wins name collision over proxied tool", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("get_document")
          .description("Local route doc reader")
          .from(mcp())
          .to(noop()),
      ])
      .store(REGISTERED_KEY, true)
      .store(REGISTRY_KEY, buildRegistry())
      .store(MANAGERS_KEY, buildManagers())
      .build();
    server = new McpServer(t.ctx, { proxy: ["docs:get_document"] });
    await t.startAndWaitReady();

    const tools = server.getAvailableTools();
    const matches = tools.filter((tool) => tool.name === "get_document");
    expect(matches).toHaveLength(1);
    expect(matches[0].description).toBe("Local route doc reader");

    await (server as unknown as TestableServer).handleToolCall("get_document", {
      id: "42",
    });
    expect(dispatches).toHaveLength(0);
  });

  /**
   * @case Proxied tools from two clients colliding on a name resolve first-wins in config order
   * @preconditions docs and billing both advertise "search"; proxy is ["docs:search", "billing:search"] without overrides
   * @expectedResult One "search" tool is listed and it dispatches to docs
   */
  test("proxied name collision resolves first-wins in config order", async () => {
    t = await testContext()
      .store(REGISTRY_KEY, buildRegistry())
      .store(MANAGERS_KEY, buildManagers())
      .build();
    server = new McpServer(t.ctx, {
      proxy: ["docs:search", { ref: "billing:search" }],
    });

    const matches = server
      .getAvailableTools()
      .filter((tool) => tool.name === "search");
    expect(matches).toHaveLength(1);
    expect(matches[0].description).toBe("Search documents");

    await (server as unknown as TestableServer).handleToolCall("search", {
      q: "x",
    });
    expect(dispatches).toEqual([
      { serverId: "docs", toolName: "search", args: { q: "x" } },
    ]);
  });

  /**
   * @case Name overrides let two same-named remote tools be exposed side by side
   * @preconditions proxy renames docs:search to docs_search and billing:search to billing_search
   * @expectedResult Both renamed tools are listed and dispatch to their own client
   */
  test("name overrides disambiguate colliding remote tools", async () => {
    t = await testContext()
      .store(REGISTRY_KEY, buildRegistry())
      .store(MANAGERS_KEY, buildManagers())
      .build();
    server = new McpServer(t.ctx, {
      proxy: [
        { ref: "docs:search", name: "docs_search" },
        { ref: "billing:search", name: "billing_search" },
      ],
    });

    const names = server.getAvailableTools().map((tool) => tool.name);
    expect(names.sort()).toEqual(["billing_search", "docs_search"]);

    await (server as unknown as TestableServer).handleToolCall(
      "billing_search",
      { q: "inv" },
    );
    expect(dispatches).toEqual([
      { serverId: "billing", toolName: "search", args: { q: "inv" } },
    ]);
  });

  /**
   * @case Unresolved proxy refs are skipped without breaking tools/list
   * @preconditions Registry has docs tools only; proxy references a client with no registered tools and a missing tool name
   * @expectedResult tools/list still returns the resolvable entries
   */
  test("unresolved refs skip gracefully", async () => {
    t = await testContext().store(REGISTRY_KEY, buildRegistry()).build();
    server = new McpServer(t.ctx, {
      proxy: ["ghost:*", "docs:missing_tool", "docs:get_document"],
    });

    const names = server.getAvailableTools().map((tool) => tool.name);
    expect(names).toEqual(["get_document"]);
  });

  /**
   * @case Wildcard selection follows registry refresh
   * @preconditions proxy is ["docs:*"]; a tool is added to the docs source after the first tools/list
   * @expectedResult The newly registered tool appears on the next tools/list without restart
   */
  test("wildcard selection is dynamic across registry refresh", async () => {
    const registry = buildRegistry();
    t = await testContext().store(REGISTRY_KEY, registry).build();
    server = new McpServer(t.ctx, { proxy: ["docs:*"] });

    expect(server.getAvailableTools()).toHaveLength(2);

    registry.setToolsForSource("docs", "stdio", [
      {
        name: "get_document",
        description: "Read one document by id",
        inputSchema: { type: "object" },
      },
      {
        name: "search",
        description: "Search documents",
        inputSchema: { type: "object" },
      },
      {
        name: "list_documents",
        description: "List documents",
        inputSchema: { type: "object" },
      },
    ]);
    expect(
      server
        .getAvailableTools()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(["get_document", "list_documents", "search"]);
  });

  /**
   * @case tools filter hides local tools from tools/call as well as tools/list
   * @preconditions Two mcp() routes; tools filter allows only tool1
   * @expectedResult Calling tool2 returns a tool-not-found error result
   */
  test("tools filter applies to tool calls, not just listing", async () => {
    t = await testContext()
      .routes([
        craft().id("tool1").description("First").from(mcp()).to(noop()),
        craft().id("tool2").description("Second").from(mcp()).to(noop()),
      ])
      .store(REGISTERED_KEY, true)
      .build();
    server = new McpServer(t.ctx, { tools: ["tool1"] });
    await t.startAndWaitReady();

    expect(server.getAvailableTools().map((tool) => tool.name)).toEqual([
      "tool1",
    ]);
    const result = await (server as unknown as TestableServer).handleToolCall(
      "tool2",
      {},
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Tool not found");
  });
});

describe("mcpPlugin proxy option validation", () => {
  /**
   * @case Proxy refs referencing unregistered clients fail at plugin creation
   * @preconditions proxy references "ghost:tool" while clients only registers "docs"
   * @expectedResult mcpPlugin throws a TypeError naming the unknown client
   */
  test("unknown client in proxy ref throws", () => {
    expect(() =>
      mcpPlugin({
        clients: { docs: { transport: "stdio", command: "docs-mcp" } },
        proxy: ["ghost:tool"],
      }),
    ).toThrow('unknown client "ghost"');
  });

  /**
   * @case Proxy without any clients fails at plugin creation
   * @preconditions proxy is set but clients is absent
   * @expectedResult mcpPlugin throws a TypeError
   */
  test("proxy without clients throws", () => {
    expect(() => mcpPlugin({ proxy: ["docs:tool"] })).toThrow(
      'unknown client "docs"',
    );
  });

  /**
   * @case Wildcard refs cannot carry name or description overrides
   * @preconditions proxy entry { ref: "docs:*", name: "renamed" }
   * @expectedResult mcpPlugin throws a TypeError about wildcard overrides
   */
  test("wildcard with name override throws", () => {
    expect(() =>
      mcpPlugin({
        clients: { docs: { transport: "stdio", command: "docs-mcp" } },
        proxy: [{ ref: "docs:*", name: "renamed" }],
      }),
    ).toThrow("wildcard");
  });

  /**
   * @case Name overrides must match the MCP tool name pattern
   * @preconditions proxy entry with name "bad name!" (space and punctuation)
   * @expectedResult mcpPlugin throws a TypeError about the allowed pattern
   */
  test("invalid name override throws", () => {
    expect(() =>
      mcpPlugin({
        clients: { docs: { transport: "stdio", command: "docs-mcp" } },
        proxy: [{ ref: "docs:tool", name: "bad name!" }],
      }),
    ).toThrow("A-Za-z0-9_-");
  });

  /**
   * @case Statically duplicate exposed names fail at plugin creation
   * @preconditions Two exact refs from different clients resolve to the same exposed name
   * @expectedResult mcpPlugin throws a TypeError suggesting name overrides
   */
  test("duplicate exposed names throw", () => {
    expect(() =>
      mcpPlugin({
        clients: {
          docs: { transport: "stdio", command: "docs-mcp" },
          billing: { transport: "stdio", command: "billing-mcp" },
        },
        proxy: ["docs:search", "billing:search"],
      }),
    ).toThrow("more than once");
  });

  /**
   * @case Duplicate refs fail at plugin creation
   * @preconditions The same ref appears twice, once as string and once as config object
   * @expectedResult mcpPlugin throws a TypeError about the duplicate ref
   */
  test("duplicate refs throw", () => {
    expect(() =>
      mcpPlugin({
        clients: { docs: { transport: "stdio", command: "docs-mcp" } },
        proxy: ["docs:tool", { ref: "docs:tool", name: "other" }],
      }),
    ).toThrow("duplicate proxy ref");
  });

  /**
   * @case Malformed refs fail at plugin creation
   * @preconditions Refs with empty parts or extra colons
   * @expectedResult mcpPlugin throws a TypeError for each malformed form
   */
  test("malformed refs throw", () => {
    const clients = {
      docs: { transport: "stdio", command: "docs-mcp" },
    } as const;
    expect(() => mcpPlugin({ clients, proxy: [":tool"] })).toThrow("malformed");
    expect(() => mcpPlugin({ clients, proxy: ["docs:"] })).toThrow("malformed");
    expect(() => mcpPlugin({ clients, proxy: ["docs:a:b"] })).toThrow(
      "malformed",
    );
    expect(() => mcpPlugin({ clients, proxy: [""] })).toThrow(
      "non-empty string",
    );
  });

  /**
   * @case Non-array proxy and non-string/object entries fail at plugin creation
   * @preconditions proxy is an object; then an array containing a number
   * @expectedResult mcpPlugin throws a TypeError in both cases
   */
  test("invalid proxy shapes throw", () => {
    expect(() =>
      mcpPlugin({
        clients: { docs: { transport: "stdio", command: "docs-mcp" } },
        proxy: { ref: "docs:tool" } as unknown as string[],
      }),
    ).toThrow("must be an array");
    expect(() =>
      mcpPlugin({
        clients: { docs: { transport: "stdio", command: "docs-mcp" } },
        proxy: [42 as unknown as string],
      }),
    ).toThrow("ref string");
  });
});
