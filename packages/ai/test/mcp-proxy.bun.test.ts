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
import type { FnHandlerContext } from "../src/fn/types.ts";
import http from "node:http";

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
   * @case A raw JSON-string arguments payload is normalized before reaching the proxied dispatch
   * @preconditions handleToolCall invoked with args as a JSON string (as the SDK may deliver); proxy is ["docs:get_document"]
   * @expectedResult The remote receives the parsed object, matching the normalization the local path applies
   */
  test("string arguments are normalized on the proxied path", async () => {
    t = await testContext()
      .store(REGISTRY_KEY, buildRegistry())
      .store(MANAGERS_KEY, buildManagers())
      .build();
    server = new McpServer(t.ctx, { proxy: ["docs:get_document"] });

    await (
      server as unknown as {
        handleToolCall(name: string, args: unknown): Promise<unknown>;
      }
    ).handleToolCall("get_document", '{"id":"42"}');
    expect(dispatches).toEqual([
      { serverId: "docs", toolName: "get_document", args: { id: "42" } },
    ]);
  });

  /**
   * @case Non-object arguments are coerced to the safe fallback before proxied dispatch
   * @preconditions handleToolCall invoked with an actual array and with a JSON primitive string; proxy is ["docs:get_document"]
   * @expectedResult The remote receives {} for the array and { input } for a primitive string, never a raw array or primitive
   */
  test("non-object arguments normalize to a safe object on the proxied path", async () => {
    t = await testContext()
      .store(REGISTRY_KEY, buildRegistry())
      .store(MANAGERS_KEY, buildManagers())
      .build();
    server = new McpServer(t.ctx, { proxy: ["docs:get_document"] });

    const call = (args: unknown) =>
      (
        server as unknown as {
          handleToolCall(name: string, args: unknown): Promise<unknown>;
        }
      ).handleToolCall("get_document", args);

    await call([1, 2, 3]); // a non-string, non-object value
    await call("42"); // valid JSON primitive string
    expect(dispatches.map((d) => d.args)).toEqual([
      {}, // array is not a plain object -> {}
      { input: "42" }, // primitive JSON string kept as raw input
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
   * @case A passing guard runs before dispatch and receives the raw args and a handler context
   * @preconditions Proxy entry with a guard that records its input and context; fake manager dispatches normally
   * @expectedResult Guard sees the call args, a logger, and an abort signal; the call dispatches and succeeds
   */
  test("guard runs before dispatch with args and handler context", async () => {
    const seen: Array<{ input: unknown; ctx: FnHandlerContext }> = [];
    t = await testContext()
      .store(REGISTRY_KEY, buildRegistry())
      .store(MANAGERS_KEY, buildManagers())
      .build();
    server = new McpServer(t.ctx, {
      proxy: [
        {
          ref: "docs:get_document",
          guard: (input, ctx) => {
            seen.push({ input, ctx });
          },
        },
      ],
    });

    const result = await (server as unknown as TestableServer).handleToolCall(
      "get_document",
      { id: "42" },
    );
    expect(result.isError).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0].input).toEqual({ id: "42" });
    expect(seen[0].ctx.logger).toBeDefined();
    expect(seen[0].ctx.abortSignal).toBeInstanceOf(AbortSignal);
    expect(dispatches).toHaveLength(1);
  });

  /**
   * @case A throwing guard rejects the call before any dispatch happens
   * @preconditions Proxy entry whose guard always throws; fake manager would dispatch normally
   * @expectedResult handleToolCall returns isError with the guard's message and the manager is never called
   */
  test("guard rejection blocks dispatch and surfaces as isError", async () => {
    t = await testContext()
      .store(REGISTRY_KEY, buildRegistry())
      .store(MANAGERS_KEY, buildManagers())
      .build();
    server = new McpServer(t.ctx, {
      proxy: [
        {
          ref: "docs:get_document",
          guard: () => {
            throw new Error("admins only");
          },
        },
      ],
    });

    const result = await (server as unknown as TestableServer).handleToolCall(
      "get_document",
      { id: "42" },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("admins only");
    expect(dispatches).toHaveLength(0);
  });

  /**
   * @case A wildcard ref's guard is attached to every expanded tool
   * @preconditions Proxy entry { ref: "docs:*", guard } rejecting every call; docs advertises two tools
   * @expectedResult Both expanded tools reject with the guard's message and nothing dispatches
   */
  test("wildcard guard applies to every expanded tool", async () => {
    t = await testContext()
      .store(REGISTRY_KEY, buildRegistry())
      .store(MANAGERS_KEY, buildManagers())
      .build();
    server = new McpServer(t.ctx, {
      proxy: [
        {
          ref: "docs:*",
          guard: () => {
            throw new Error("blocked by wildcard guard");
          },
        },
      ],
    });

    for (const tool of ["get_document", "search"]) {
      const result = await (server as unknown as TestableServer).handleToolCall(
        tool,
        {},
      );
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("blocked by wildcard guard");
    }
    expect(dispatches).toHaveLength(0);
  });

  /**
   * @case Dispatch failures surface as isError with a generic message, not the framework error detail
   * @preconditions No stdio manager and no HTTP config for "docs" (dispatch throws RC5003 whose message names the server)
   * @expectedResult handleToolCall returns isError true; the client text is the generic proxied-failure message and does not leak the RC5003 dispatch detail
   */
  test("dispatch failure returns a generic isError result without leaking detail", async () => {
    t = await testContext().store(REGISTRY_KEY, buildRegistry()).build();
    server = new McpServer(t.ctx, { proxy: ["docs:get_document"] });

    const result = await (server as unknown as TestableServer).handleToolCall(
      "get_document",
      { id: "42" },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      'Proxied tool "get_document" could not be called',
    );
    // The RC5003 dispatch message ("... server \"docs\" is not registered ...")
    // must not reach the caller.
    expect(result.content[0]?.text).not.toContain("not registered");
    expect(result.content[0]?.text).not.toContain("mcp dispatch");
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
   * @case An exact entry's guard and overrides survive an overlapping wildcard in either order
   * @preconditions Guarded exact ref for docs:search plus docs:* wildcard, in both config orders
   * @expectedResult The guard runs (rejecting the call) and the exact description is listed, regardless of order
   */
  test("exact entry wins over overlapping wildcard in both orders", async () => {
    const orders: Array<
      Array<string | import("../src/mcp/types.ts").McpProxyToolConfig>
    > = [
      ["docs:*", { ref: "docs:search", description: "exact", guard: deny }],
      [{ ref: "docs:search", description: "exact", guard: deny }, "docs:*"],
    ];
    function deny(): void {
      throw new Error("guard ran");
    }
    for (const proxy of orders) {
      t = await testContext()
        .store(REGISTRY_KEY, buildRegistry())
        .store(MANAGERS_KEY, buildManagers())
        .build();
      server = new McpServer(t.ctx, { proxy });

      const listed = server
        .getAvailableTools()
        .find((tool) => tool.name === "search");
      expect(listed?.description).toBe("exact");

      const result = await (server as unknown as TestableServer).handleToolCall(
        "search",
        {},
      );
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("guard ran");
      expect(dispatches).toHaveLength(0);

      await server.stop();
      await t.stop();
      dispatches = [];
    }
  });

  /**
   * @case A remote tool advertising icons: [] is listed without icons instead of inheriting the server icon
   * @preconditions Registry entry for docs:search carries icons: []; proxy exposes it
   * @expectedResult The listed tool has no icons field (empty array is the documented "no icon" opt-out)
   */
  test("remote icons opt-out ([]) is honored on proxied tools", async () => {
    const registry = new McpToolRegistry();
    registry.setToolsForSource("docs", "stdio", [
      {
        name: "search",
        description: "Search documents",
        inputSchema: { type: "object" },
        icons: [],
      },
    ]);
    t = await testContext().store(REGISTRY_KEY, registry).build();
    server = new McpServer(t.ctx, { proxy: ["docs:search"] });

    const tools = server.getAvailableTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].icons).toBeUndefined();
  });

  /**
   * @case Guard rejections emit plugin:mcp:tool:failed with the proxied metadata fields
   * @preconditions Proxy entry whose guard throws; listener captures tool events
   * @expectedResult The failed event carries proxied: true, serverId, and remoteTool alongside tool and error
   */
  test("guard rejection failed event carries proxied metadata", async () => {
    const failures: Array<Record<string, unknown>> = [];
    t = await testContext()
      .store(REGISTRY_KEY, buildRegistry())
      .store(MANAGERS_KEY, buildManagers())
      .build();
    t.ctx.on("plugin:mcp:tool:failed", (event) => {
      failures.push((event as { details: Record<string, unknown> }).details);
    });
    server = new McpServer(t.ctx, {
      proxy: [
        {
          ref: "docs:get_document",
          guard: () => {
            throw new Error("denied");
          },
        },
      ],
    });

    await (server as unknown as TestableServer).handleToolCall("get_document", {
      id: "42",
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      tool: "get_document",
      proxied: true,
      serverId: "docs",
      remoteTool: "get_document",
    });
    expect(String(failures[0]["error"])).toContain("denied");
  });

  /**
   * @case Remote tool names that violate the MCP name pattern are skipped unless renamed
   * @preconditions Registry has a tool named "bad.name"; proxied via wildcard, then via exact ref with a name override
   * @expectedResult The wildcard skips it; the renamed exact entry exposes and dispatches it
   */
  test("non-conforming remote names are skipped unless renamed", async () => {
    const registry = new McpToolRegistry();
    registry.setToolsForSource("docs", "stdio", [
      {
        name: "bad.name",
        description: "Dotted name",
        inputSchema: { type: "object" },
      },
    ]);
    t = await testContext()
      .store(REGISTRY_KEY, registry)
      .store(MANAGERS_KEY, buildManagers())
      .build();

    server = new McpServer(t.ctx, { proxy: ["docs:*"] });
    expect(server.getAvailableTools()).toHaveLength(0);
    await server.stop();

    server = new McpServer(t.ctx, {
      proxy: [{ ref: "docs:bad.name", name: "bad_name" }],
    });
    expect(server.getAvailableTools().map((tool) => tool.name)).toEqual([
      "bad_name",
    ]);
    await (server as unknown as TestableServer).handleToolCall("bad_name", {});
    expect(dispatches).toEqual([
      { serverId: "docs", toolName: "bad.name", args: {} },
    ]);
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

describe("MCP tool proxying over HTTP with auth", () => {
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

  /** POST a JSON-RPC body to /mcp on the given port. */
  function post(
    port: number,
    body: string,
    headers: Record<string, string>,
  ): Promise<{ statusCode: number; body: string; sessionId?: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/mcp",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Connection: "close",
            ...headers,
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            const sid = res.headers["mcp-session-id"];
            resolve({
              statusCode: res.statusCode ?? 0,
              body: data,
              ...(sid ? { sessionId: Array.isArray(sid) ? sid[0] : sid } : {}),
            });
          });
        },
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  /** Extract the JSON-RPC result payload from a JSON or SSE response body. */
  function parseRpcResult(body: string): Record<string, unknown> {
    const jsonLine = body.startsWith("event:")
      ? (body
          .split("\n")
          .find((line) => line.startsWith("data:"))
          ?.slice(5) ?? "{}")
      : body;
    return (JSON.parse(jsonLine) as { result: Record<string, unknown> }).result;
  }

  /**
   * @case Guard sees the authenticated MCP caller's principal and can authorise by role
   * @preconditions HTTP server with a token validator mapping admin-token to an admin-role principal; proxied tool guarded on the admin role
   * @expectedResult The admin token's call dispatches and succeeds; the user token's call returns an isError result without dispatching
   */
  test("guard authorises proxied calls by caller principal over HTTP", async () => {
    t = await testContext()
      .store(REGISTRY_KEY, buildRegistry())
      .store(MANAGERS_KEY, buildManagers())
      .build();
    server = new McpServer(t.ctx, {
      transport: "http",
      port: 0,
      host: "127.0.0.1",
      auth: {
        validator: (token: string) => ({
          kind: "custom" as const,
          subject: token === "admin-token" ? "admin-1" : "user-1",
          scheme: "bearer" as const,
          roles: token === "admin-token" ? ["admin"] : ["user"],
        }),
      },
      proxy: [
        {
          ref: "docs:get_document",
          guard: (_input, ctx) => {
            if (!ctx.principal?.roles?.includes("admin")) {
              throw new Error("admin role required");
            }
          },
        },
      ],
    });
    await server.start();
    const port = server.getHttpPort()!;

    async function callTool(token: string): Promise<Record<string, unknown>> {
      const auth = { Authorization: `Bearer ${token}` };
      const init = await post(
        port,
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "test", version: "1.0.0" },
          },
        }),
        auth,
      );
      expect(init.statusCode).toBe(200);
      const call = await post(
        port,
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "get_document", arguments: { id: "42" } },
        }),
        { ...auth, "mcp-session-id": init.sessionId! },
      );
      expect(call.statusCode).toBe(200);
      return parseRpcResult(call.body);
    }

    const adminResult = await callTool("admin-token");
    expect(adminResult["isError"]).toBeUndefined();
    expect(dispatches).toHaveLength(1);

    const userResult = await callTool("user-token");
    expect(userResult["isError"]).toBe(true);
    expect(JSON.stringify(userResult["content"])).toContain(
      "admin role required",
    );
    expect(dispatches).toHaveLength(1);
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
   * @case Malformed refs fail at plugin creation; extra colons stay in the tool segment
   * @preconditions Refs with empty parts; a ref with a colon-containing tool name
   * @expectedResult Empty segments throw a TypeError; "docs:a:b" is accepted (tool "a:b", matching the agent ref grammar)
   */
  test("malformed refs throw; colons in the tool segment parse", () => {
    const clients = {
      docs: { transport: "stdio", command: "docs-mcp" },
    } as const;
    expect(() => mcpPlugin({ clients, proxy: [":tool"] })).toThrow("malformed");
    expect(() => mcpPlugin({ clients, proxy: ["docs:"] })).toThrow("malformed");
    expect(() => mcpPlugin({ clients, proxy: [""] })).toThrow(
      "non-empty string",
    );
    // Colons beyond the first split are part of the remote tool name,
    // matching parseMcpRef's grammar for agent tool refs.
    expect(() =>
      mcpPlugin({
        clients,
        proxy: [{ ref: "docs:a:b", name: "a_b" }],
      }),
    ).not.toThrow();
  });

  /**
   * @case A ref naming an inherited Object property is rejected as an unknown client
   * @preconditions proxy ref "constructor:tool"; clients only registers "docs"
   * @expectedResult mcpPlugin throws unknown-client (own-property check, not `in`)
   */
  test("inherited property names are not accepted as clients", () => {
    expect(() =>
      mcpPlugin({
        clients: { docs: { transport: "stdio", command: "docs-mcp" } },
        proxy: ["constructor:tool"],
      }),
    ).toThrow('unknown client "constructor"');
  });

  /**
   * @case A non-string name override is rejected before the pattern test
   * @preconditions proxy entry with name set to a number (untyped-JS caller)
   * @expectedResult mcpPlugin throws instead of coercing the number to a string that passes the pattern
   */
  test("non-string name override throws", () => {
    expect(() =>
      mcpPlugin({
        clients: { docs: { transport: "stdio", command: "docs-mcp" } },
        proxy: [{ ref: "docs:tool", name: 42 as unknown as string }],
      }),
    ).toThrow("must be a string");
  });

  /**
   * @case Non-function guard values fail at plugin creation
   * @preconditions proxy entry with guard set to a string
   * @expectedResult mcpPlugin throws a TypeError about the guard
   */
  test("non-function guard throws", () => {
    expect(() =>
      mcpPlugin({
        clients: { docs: { transport: "stdio", command: "docs-mcp" } },
        proxy: [
          {
            ref: "docs:tool",
            guard: "nope" as unknown as () => void,
          },
        ],
      }),
    ).toThrow("guard");
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
