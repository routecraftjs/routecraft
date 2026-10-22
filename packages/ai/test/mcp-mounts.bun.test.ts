import { describe, test, expect, afterEach } from "bun:test";
import { craft, noop, type AnyRouteBuilder } from "@routecraft/routecraft";
import { testContext, type TestContext } from "@routecraft/testing";
import type { McpMount, McpServer } from "../src/mcp/server.ts";
import { mcpPort, mcpServerFor } from "./helpers/mcp-port.ts";
import { McpToolRegistry } from "../src/mcp/tool-registry.ts";
import { mcp, mcpPlugin } from "../src/index.ts";
import type { McpClientConfig } from "../src/mcp/port.ts";
import type { McpRawToolResult } from "../src/mcp/types.ts";
import { rpcBody } from "./fixtures/rpc-body.ts";

type ToolResult = {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
};

/** Private surface of McpServer these tests call with a mount. */
type Mounted = {
  handleToolCall(
    name: string,
    args: Record<string, unknown>,
    principal: undefined,
    mount: McpMount,
  ): Promise<ToolResult>;
};

let dispatches: Array<{ serverId: string; toolName: string }> = [];

function buildRegistry(): McpToolRegistry {
  const registry = new McpToolRegistry();
  registry.setToolsForSource("docs", "stdio", [
    {
      name: "get_document",
      description: "Read one document",
      inputSchema: { type: "object" },
    },
    {
      name: "search",
      description: "Search documents",
      inputSchema: { type: "object" },
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

function buildClients(): Map<string, McpClientConfig> {
  return new Map<string, McpClientConfig>([
    ["docs", { transport: "stdio", command: "docs-mcp" }],
    ["billing", { transport: "stdio", command: "billing-mcp" }],
  ]);
}

function buildManagers() {
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
      async callTool(name) {
        dispatches.push({ serverId, toolName: name });
        return "extracted";
      },
      async callToolRaw(name) {
        dispatches.push({ serverId, toolName: name });
        return { content: [{ type: "text", text: `raw:${serverId}:${name}` }] };
      },
    });
  }
  return managers;
}

const ROUTES: AnyRouteBuilder[] = [
  craft()
    .id("docs")
    .from(mcp({ proxy: "docs:*" }))
    .to(mcp("docs:*")),
  craft()
    .id("docs-get")
    .from(mcp({ proxy: "docs:get_document", name: "fetch_doc" }))
    .transform((args) => ({
      ...(args as Record<string, unknown>),
      via: "exact",
    }))
    .to(mcp("docs:get_document")),
  craft()
    .id("billing")
    .from(mcp({ proxy: "billing:*" }))
    .to(mcp("billing:*")),
  craft()
    .id("ping")
    .description("Liveness")
    .from(mcp())
    .transform(() => "pong")
    .to(noop()),
];

describe("MCP mounts", () => {
  let t: TestContext;
  let server: McpServer;

  afterEach(async () => {
    dispatches = [];
    if (server) await server.stop().catch(() => undefined);
    if (t) await t.stop();
  });

  async function serve(name?: string): Promise<void> {
    t = await testContext()
      .routes(ROUTES)
      .with({
        plugins: [
          mcpPort({
            tools: buildRegistry(),
            stdio: buildManagers(),
            clients: buildClients(),
          }),
        ],
      })
      .build();
    await t.startAndWaitReady();
    server = mcpServerFor(t.ctx, name === undefined ? {} : { name });
  }

  function names(mount?: string): string[] {
    return server
      .getAvailableTools(mount)
      .map((tool) => tool.name)
      .sort();
  }

  function call(mount: McpMount, name: string) {
    return (server as unknown as Mounted).handleToolCall(
      name,
      {},
      undefined,
      mount,
    );
  }

  /**
   * @case The root lists everything under the prefixed names, as before
   * @preconditions Star routes over docs and billing, an exact route renaming docs:get_document to fetch_doc, and a local route ping
   * @expectedResult The root carries billing_search, docs_search, fetch_doc and ping
   */
  test("the root serves every tool under its exposed name", async () => {
    await serve();
    expect(names()).toEqual([
      "billing_search",
      "docs_search",
      "fetch_doc",
      "ping",
    ]);
  });

  /**
   * @case A client mount lists that client's tools under their remote names, the exact route winning for its tool
   * @preconditions The same routes; the docs client lists get_document and search
   * @expectedResult /mcp/docs carries get_document and search; calling get_document runs the exact route; /mcp/billing carries search alone and reaches billing
   */
  test("a client mount serves the client's tools bare, exact route first", async () => {
    await serve();
    expect(names("docs")).toEqual(["get_document", "search"]);
    expect(names("billing")).toEqual(["search"]);
    const docs = { kind: "client" as const, segment: "docs", serverId: "docs" };
    await call(docs, "get_document");
    await call(docs, "search");
    const billing = {
      kind: "client" as const,
      segment: "billing",
      serverId: "billing",
    };
    await call(billing, "search");
    expect(dispatches).toEqual([
      { serverId: "docs", toolName: "get_document" },
      { serverId: "docs", toolName: "search" },
      { serverId: "billing", toolName: "search" },
    ]);
    const missing = await call(docs, "ping");
    expect(missing.isError).toBe(true);
  });

  /**
   * @case The own mount, named after the server, lists the application's own tools
   * @preconditions The same routes, server named eywa
   * @expectedResult /mcp/eywa carries fetch_doc and ping, not the star routes' tools; fetch_doc runs the exact route and docs_search is not found there
   */
  test("the own mount serves local routes and exact proxy routes", async () => {
    await serve("eywa");
    expect(names("eywa")).toEqual(["fetch_doc", "ping"]);
    const own = { kind: "own" as const, segment: "eywa" };
    const result = await call(own, "fetch_doc");
    expect(result.isError).toBeUndefined();
    expect(dispatches).toEqual([
      { serverId: "docs", toolName: "get_document" },
    ]);
    const missing = await call(own, "docs_search");
    expect(missing.isError).toBe(true);
    expect(missing.content[0]?.text).toContain("Tool not found");
  });

  /**
   * @case A call on a mount carries the mount on its events
   * @preconditions The same routes; one call on the docs mount and one on the root
   * @expectedResult The docs mount's called and completed events carry mount "docs" beside the provenance; the root's carry no mount
   */
  test("tool events name the mount a call arrived on", async () => {
    await serve();
    type Stamp = { tool: string; mount?: string; serverId?: string };
    const events: Stamp[] = [];
    for (const name of ["called", "completed"] as const) {
      t.ctx.on(`plugin:mcp:tool:${name}`, (event) => {
        events.push((event as { details: Stamp }).details);
      });
    }
    await call({ kind: "client", segment: "docs", serverId: "docs" }, "search");
    await call({ kind: "root", segment: "" }, "docs_search");
    expect(events.map((e) => [e.tool, e.mount, e.serverId])).toEqual([
      ["search", "docs", "docs"],
      ["search", "docs", "docs"],
      ["docs_search", undefined, "docs"],
      ["docs_search", undefined, "docs"],
    ]);
  });

  /**
   * @case An unknown mount is refused rather than listed empty
   * @preconditions The same routes
   * @expectedResult getAvailableTools("nope") throws
   */
  test("an unknown mount is refused", async () => {
    await serve();
    expect(() => server.getAvailableTools("nope")).toThrow(
      'no mount named "nope"',
    );
  });

  /**
   * @case A client that carries the server's own name is refused
   * @preconditions A client registered as "routecraft", the server's default name
   * @expectedResult Listing the mounts throws naming the clash
   */
  test("a client named after the server is refused", async () => {
    t = await testContext()
      .routes([ROUTES[3]!])
      .with({
        plugins: [
          mcpPort({
            tools: new McpToolRegistry(),
            clients: new Map([
              ["routecraft", { transport: "stdio", command: "x" }],
            ]),
          }),
        ],
      })
      .build();
    await t.startAndWaitReady();
    server = mcpServerFor(t.ctx);
    expect(() => server.getAvailableTools()).toThrow(
      "carries the server's own name",
    );
  });
});

describe("MCP mounts over HTTP", () => {
  let t: TestContext;
  let port = 0;

  afterEach(async () => {
    if (t) await t.stop();
  });

  async function start(resourceUrl?: string): Promise<void> {
    let resolveListening!: () => void;
    const listening = new Promise<void>((resolve) => {
      resolveListening = resolve;
    });
    t = await testContext()
      .on("server:listening", ({ details }) => {
        if (details.server === "default") {
          port = details.port;
          resolveListening();
        }
      })
      .routes([ROUTES[3]!])
      .with({
        servers: { default: { host: "127.0.0.1", port: 0 } },
        plugins: [
          mcpPlugin({
            transport: "http",
            name: "eywa",
            ...(resourceUrl === undefined
              ? {}
              : { resource: { url: resourceUrl } }),
          }),
        ],
      })
      .build();
    await t.startAndWaitReady();
    await listening;
  }

  async function rpc(
    path: string,
    method: string,
    id: number,
    params: unknown,
  ) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    const text = await response.text();
    return { status: response.status, body: text === "" ? "" : rpcBody(text) };
  }

  async function listTools(
    path: string,
  ): Promise<{ status: number; tools?: string[] | undefined }> {
    const init = await rpc(path, "initialize", 1, {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    });
    if (init.status !== 200) return { status: init.status };
    const listed = await rpc(path, "tools/list", 2, {});
    if (listed.status !== 200) return { status: listed.status };
    const parsed = JSON.parse(listed.body) as {
      result?: { tools: Array<{ name: string }> };
    };
    return {
      status: 200,
      tools: parsed.result?.tools.map((tool) => tool.name),
    };
  }

  /**
   * @case The own mount answers at <path>/<server name> with its own metadata document, and an unknown segment is not found
   * @preconditions HTTP server named eywa with one local route and no clients
   * @expectedResult tools/list on /mcp and /mcp/eywa both carry ping; /mcp/other answers 404; the metadata document for /mcp/eywa names that resource
   */
  test("the own mount is served beside the root", async () => {
    await start();
    expect((await listTools("/mcp")).tools).toEqual(["ping"]);
    expect((await listTools("/mcp/eywa")).tools).toEqual(["ping"]);
    expect((await listTools("/mcp/other")).status).toBe(404);
    const metadata = await fetch(
      `http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp/eywa`,
    );
    expect(metadata.status).toBe(200);
    const document = (await metadata.json()) as { resource: string };
    expect(document.resource).toBe(`http://127.0.0.1:${port}/mcp/eywa`);
  });

  /**
   * @case A configured resource.url names the root, and a mount's document appends its segment to it
   * @preconditions HTTP server named eywa with resource.url set to a public URL whose path differs from the mount path
   * @expectedResult the root document names the configured URL unchanged; the own mount's document names it with /eywa appended
   */
  test("a mount's metadata document derives from the configured resource URL", async () => {
    await start("http://mcp.example.com/api/");
    const read = async (segment: string) => {
      const response = await fetch(
        `http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp${segment}`,
      );
      expect(response.status).toBe(200);
      return ((await response.json()) as { resource: string }).resource;
    };
    expect(await read("")).toBe("http://mcp.example.com/api/");
    expect(await read("/eywa")).toBe("http://mcp.example.com/api/eywa");
  });

  /**
   * @case A client named after the server fails the build, not the first listing
   * @preconditions HTTP server named eywa with a client registered as eywa
   * @expectedResult building the context rejects at the plugin's bind, naming the clash
   */
  test("a clashing client name fails the build", async () => {
    await expect(
      testContext()
        .routes([ROUTES[3]!])
        .with({
          servers: { default: { host: "127.0.0.1", port: 0 } },
          plugins: [
            mcpPlugin({
              transport: "http",
              name: "eywa",
              clients: { eywa: { transport: "stdio", command: "x" } },
            }),
          ],
        })
        .build(),
    ).rejects.toThrow("carries the server's own name");
  });
});
