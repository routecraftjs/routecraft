import { describe, test, expect, afterEach } from "bun:test";
import {
  craft,
  noop,
  type AnyRouteBuilder,
  type Principal,
} from "@routecraft/routecraft";
import { bootServer, testContext, type TestContext } from "@routecraft/testing";
import type { McpMount, McpServer } from "../src/mcp/server.ts";
import {
  mcpPort,
  mcpServerFor,
  mcpServerPlugin,
  type McpSeed,
} from "./helpers/mcp-port.ts";
import { McpToolRegistry } from "../src/mcp/tool-registry.ts";
import { mcp, mcpPlugin } from "../src/index.ts";
import type { McpClientConfig } from "../src/mcp/port.ts";
import type { McpPluginOptions, McpRawToolResult } from "../src/mcp/types.ts";
import { callTool } from "./helpers/mcp-tool-call.ts";
import { listToolsOver, MCP_INIT_PARAMS, postRpc } from "./helpers/mcp-http.ts";

let dispatches: Array<{
  serverId: string;
  toolName: string;
  args: Record<string, unknown>;
}> = [];

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
      async callTool(name, args) {
        dispatches.push({ serverId, toolName: name, args });
        return "extracted";
      },
      async callToolRaw(name, args) {
        dispatches.push({ serverId, toolName: name, args });
        return { content: [{ type: "text", text: `raw:${serverId}:${name}` }] };
      },
    });
  }
  return managers;
}

function seed(): McpSeed {
  return {
    tools: buildRegistry(),
    stdio: buildManagers(),
    clients: buildClients(),
  };
}

const PING_ROUTE = craft()
  .id("ping")
  .description("Liveness")
  .from(mcp())
  .transform(() => "pong")
  .to(noop());

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
  PING_ROUTE,
];

const DOCS_MOUNT: McpMount = { kind: "client", segment: "docs" };

/** The code and message a build rejected with. */
async function refusalOf(
  build: Promise<unknown>,
): Promise<{ code: string | undefined; message: string }> {
  try {
    await build;
  } catch (error) {
    const { rc, message } = error as { rc?: string; message: string };
    return { code: rc, message };
  }
  throw new Error("the build was expected to reject");
}

describe("MCP mounts", () => {
  let t: TestContext;
  let server: McpServer;

  afterEach(async () => {
    dispatches = [];
    if (server) await server.stop().catch(() => undefined);
    if (t) await t.stop();
  });

  async function serve(options: McpPluginOptions = {}): Promise<void> {
    t = await testContext()
      .routes(ROUTES)
      .with({ plugins: [mcpPort(seed())] })
      .build();
    await t.startAndWaitReady();
    server = mcpServerFor(t.ctx, options);
  }

  function names(mount?: string): string[] {
    return server
      .getAvailableTools(mount)
      .map((tool) => tool.name)
      .sort();
  }

  const call = (mount: McpMount, name: string) =>
    callTool(server, name, {}, undefined, mount);

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
   * @preconditions The same routes
   * @expectedResult /mcp/docs carries get_document and search; calling get_document there runs the exact route (its transform marks the arguments), search the star route, and a local tool is not there
   */
  test("a client mount serves the client's tools bare, exact route first", async () => {
    await serve();
    expect(names("docs")).toEqual(["get_document", "search"]);
    expect(names("billing")).toEqual(["search"]);
    const viaExact = await call(DOCS_MOUNT, "get_document");
    expect(viaExact.isError).toBeUndefined();
    const viaStar = await call(DOCS_MOUNT, "search");
    expect(viaStar.isError).toBeUndefined();
    expect(dispatches).toEqual([
      { serverId: "docs", toolName: "get_document", args: { via: "exact" } },
      { serverId: "docs", toolName: "search", args: {} },
    ]);
    const missing = await call(DOCS_MOUNT, "ping");
    expect(missing.isError).toBe(true);
    expect(missing.content[0]?.text).toContain("Tool not found");
  });

  /**
   * @case The own mount, named after the server, lists the application's own tools
   * @preconditions The same routes, server named eywa
   * @expectedResult /mcp/eywa carries fetch_doc and ping, not the star routes' tools; fetch_doc runs the exact route and docs_search is not found there
   */
  test("the own mount serves local routes and exact proxy routes", async () => {
    await serve({ name: "eywa" });
    expect(names("eywa")).toEqual(["fetch_doc", "ping"]);
    const own: McpMount = { kind: "own", segment: "eywa" };
    const result = await call(own, "fetch_doc");
    expect(result.isError).toBeUndefined();
    expect(dispatches).toEqual([
      { serverId: "docs", toolName: "get_document", args: { via: "exact" } },
    ]);
    const missing = await call(own, "docs_search");
    expect(missing.isError).toBe(true);
    expect(missing.content[0]?.text).toContain("Tool not found");
  });

  /**
   * @case The tools filter judges a client mount's tool by the name the root lists it under
   * @preconditions A function filter hiding docs_search, then an allowlist naming only docs_search
   * @expectedResult The filter hides search on /mcp/docs for listing and calling alike; the allowlist shows search there and nothing else
   */
  test("the tools filter means the same on a client mount as at the root", async () => {
    await serve({ tools: (meta) => meta.endpoint !== "docs_search" });
    expect(names()).toEqual(["billing_search", "fetch_doc", "ping"]);
    expect(names("docs")).toEqual(["get_document"]);
    const hidden = await call(DOCS_MOUNT, "search");
    expect(hidden.isError).toBe(true);
    expect(hidden.content[0]?.text).toContain("Tool not found");
    expect(dispatches).toEqual([]);
    await server.stop();
    server = mcpServerFor(t.ctx, { tools: ["docs_search"] });
    expect(names()).toEqual(["docs_search"]);
    expect(names("docs")).toEqual(["search"]);
    expect(names("billing")).toEqual([]);
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
    await call(DOCS_MOUNT, "search");
    await call({ kind: "root", segment: "" }, "docs_search");
    expect(events.map((e) => [e.tool, e.mount, e.serverId])).toEqual([
      ["search", "docs", "docs"],
      ["search", "docs", "docs"],
      ["docs_search", undefined, "docs"],
      ["docs_search", undefined, "docs"],
    ]);
  });

  /**
   * @case A client mount drops its tools when the last proxy route unregisters
   * @preconditions The same routes, then the context stopped so every proxy route unregisters
   * @expectedResult /mcp/docs listed two tools and lists none afterwards, and the root lists none either
   */
  test("a client mount follows the registrations", async () => {
    await serve();
    expect(names("docs")).toEqual(["get_document", "search"]);
    await t.stop();
    expect(names("docs")).toEqual([]);
    expect(names()).toEqual([]);
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
   * @case Over stdio a client named after the server is served, since nothing is mounted there to clash
   * @preconditions A client registered as "routecraft", the server's default name, stdio transport
   * @expectedResult The root lists ping and the client's mount lists nothing
   */
  test("stdio keeps serving a client named after the server", async () => {
    t = await testContext()
      .routes([PING_ROUTE])
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
    expect(names()).toEqual(["ping"]);
  });
});

describe("MCP mounts over HTTP", () => {
  let t: TestContext | undefined;
  let port = 0;

  afterEach(async () => {
    dispatches = [];
    if (t) await t.stop();
    t = undefined;
  });

  const principal: Principal = {
    kind: "custom",
    scheme: "bearer",
    subject: "user-7",
  };

  async function start(
    options: Partial<McpPluginOptions> = {},
    routes: AnyRouteBuilder[] = ROUTES,
  ): Promise<void> {
    ({ ctx: t, port } = await bootServer((b) =>
      b.routes(routes).with({
        servers: { default: { host: "127.0.0.1", port: 0 } },
        plugins: [
          mcpServerPlugin(seed(), {
            transport: "http",
            name: "eywa",
            ...options,
          }),
        ],
      }),
    ));
  }

  async function metadata(
    segment: string,
  ): Promise<{ status: number; resource?: string }> {
    const response = await fetch(
      `http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp${segment}`,
    );
    if (response.status !== 200) return { status: response.status };
    return {
      status: 200,
      resource: ((await response.json()) as { resource: string }).resource,
    };
  }

  /**
   * @case Every mount answers beside the root, with or without a trailing slash, and an unknown segment is not found
   * @preconditions HTTP server named eywa over the docs and billing clients and the ping route
   * @expectedResult /mcp lists the prefixed names; /mcp/eywa and /mcp/eywa/ list fetch_doc and ping; /mcp/docs lists the bare remote names and a tools/call there runs the exact route to the client; /mcp/other answers 404
   */
  test("the mounts are served beside the root", async () => {
    await start();
    expect((await listToolsOver(port, "/mcp")).tools?.sort()).toEqual([
      "billing_search",
      "docs_search",
      "fetch_doc",
      "ping",
    ]);
    expect((await listToolsOver(port, "/mcp/eywa")).tools?.sort()).toEqual([
      "fetch_doc",
      "ping",
    ]);
    expect((await listToolsOver(port, "/mcp/eywa/")).tools?.sort()).toEqual([
      "fetch_doc",
      "ping",
    ]);
    expect((await listToolsOver(port, "/mcp/docs")).tools?.sort()).toEqual([
      "get_document",
      "search",
    ]);
    expect((await listToolsOver(port, "/mcp/other")).status).toBe(404);
    const called = await postRpc(port, "/mcp/docs", {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_document", arguments: { id: "1" } },
    });
    expect(called.status).toBe(200);
    const result = JSON.parse(called.body) as {
      result?: { isError?: boolean; content: Array<{ text?: string }> };
    };
    expect(result.result?.isError).toBeUndefined();
    expect(result.result?.content[0]?.text).toBe("raw:docs:get_document");
    expect(dispatches).toEqual([
      {
        serverId: "docs",
        toolName: "get_document",
        args: { id: "1", via: "exact" },
      },
    ]);
  });

  /**
   * @case Each mount has its own metadata document, derived from resource.url when one is configured
   * @preconditions HTTP server first without resource.url, then with one whose path differs from the mount path
   * @expectedResult Without it the documents name the bound address with the mount path; with it the root names the configured URL and the mounts append their segment; an unknown segment is not found
   */
  test("a mount's metadata document names that mount", async () => {
    await start();
    expect((await metadata("/eywa")).resource).toBe(
      `http://127.0.0.1:${port}/mcp/eywa`,
    );
    expect((await metadata("/docs")).resource).toBe(
      `http://127.0.0.1:${port}/mcp/docs`,
    );
    expect((await metadata("/other")).status).toBe(404);
    await t!.stop();
    await start({ resource: { url: "http://mcp.example.com/api/" } });
    expect((await metadata("")).resource).toBe("http://mcp.example.com/api/");
    expect((await metadata("/eywa")).resource).toBe(
      "http://mcp.example.com/api/eywa",
    );
    expect((await metadata("/docs")).resource).toBe(
      "http://mcp.example.com/api/docs",
    );
  });

  /**
   * @case A mount shares the root's wall and challenges with its own metadata URL
   * @preconditions HTTP server with a validator admitting the token "good"
   * @expectedResult Anonymous on /mcp/docs is 401 with resource_metadata ending in /mcp/docs; the metadata document is served anonymously; the token lists the client's tools
   */
  test("a mount is walled like the root and points at its own document", async () => {
    await start({
      auth: {
        validator: (token: string) => {
          if (token !== "good") throw new Error("bad token");
          return principal;
        },
      },
    });
    const anonymous = await postRpc(port, "/mcp/docs", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: MCP_INIT_PARAMS,
    });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("WWW-Authenticate")).toMatch(
      /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp\/docs"/,
    );
    expect((await metadata("/docs")).status).toBe(200);
    expect(
      (
        await listToolsOver(port, "/mcp/docs", { Authorization: "Bearer good" })
      ).tools?.sort(),
    ).toEqual(["get_document", "search"]);
  });

  /**
   * @case A mount runs the shared Host gate before anything else
   * @preconditions HTTP server bound to the loopback address
   * @expectedResult A request to /mcp/docs carrying a foreign Host is refused with 403
   */
  test("a mount refuses a foreign Host", async () => {
    await start();
    const refused = await postRpc(
      port,
      "/mcp/docs",
      { jsonrpc: "2.0", id: 1, method: "initialize", params: MCP_INIT_PARAMS },
      { Host: "attacker.example" },
    );
    expect(refused.status).toBe(403);
  });

  /**
   * @case A client named after the server fails the build, not the first listing
   * @preconditions HTTP server named eywa with a client registered as eywa
   * @expectedResult Building the context rejects with RC5003 at the plugin's bind, naming the clash
   */
  test("a clashing client name fails the build", async () => {
    const refusal = await refusalOf(
      testContext()
        .routes([PING_ROUTE])
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
    );
    expect(refusal.code).toBe("RC5003");
    expect(refusal.message).toContain("carries the server's own name");
  });

  /**
   * @case A name that is not one path segment fails the build over HTTP
   * @preconditions A server named "..", then a client registered as "my client"
   * @expectedResult Each build rejects with RC5003 saying the name cannot name a mount
   */
  test("a name that cannot be a path segment fails the build", async () => {
    for (const options of [
      { name: ".." },
      {
        clients: { "my client": { transport: "stdio" as const, command: "x" } },
      },
    ]) {
      const refusal = await refusalOf(
        testContext()
          .routes([PING_ROUTE])
          .with({
            servers: { default: { host: "127.0.0.1", port: 0 } },
            plugins: [mcpPlugin({ transport: "http", ...options })],
          })
          .build(),
      );
      expect(refusal.code).toBe("RC5003");
      expect(refusal.message).toContain("cannot name a mount");
    }
  });
});
