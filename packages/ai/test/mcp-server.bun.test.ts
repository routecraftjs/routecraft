import { describe, test, expect, afterEach } from "bun:test";
import { McpServer } from "../src/mcp/server.ts";
import { suspending, testContext, type TestContext } from "@routecraft/testing";
import {
  craft,
  DefaultExchange,
  direct,
  jwks,
  noop,
  rcError,
  type AnyRouteBuilder,
  type Principal,
} from "@routecraft/routecraft";
import { mcp, mcpPlugin } from "../src/index.ts";
import {
  MCP_LOCAL_TOOL_REGISTRY,
  MCP_PLUGIN_REGISTERED,
  type McpLocalToolEntry,
} from "../src/mcp/types.ts";
import { ROUTECRAFT_DEFAULT_ICONS } from "../src/mcp/default-icon.ts";
import { buildAuthHeaders } from "../src/mcp/build-auth-headers.ts";
import { z } from "zod";
import http from "node:http";
import { rpcBody } from "./fixtures/rpc-body.ts";

const MCP_STORE_KEY =
  MCP_PLUGIN_REGISTERED as keyof import("@routecraft/routecraft").StoreRegistry;

/** Shared JSON-RPC params for MCP tests. */
const INIT_PARAMS = {
  protocolVersion: "2024-11-05" as const,
  capabilities: {},
  clientInfo: { name: "test", version: "1.0.0" },
};

describe("McpServer", () => {
  let t: TestContext;
  let server: McpServer;

  afterEach(async () => {
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
   * Build a context holding `routes`, start it, and return an McpServer
   * reading from it. The server is constructed after start because the local
   * tool registry is read per call rather than captured at construction, so a
   * tool registered later is still callable.
   */
  async function serve(
    routes: AnyRouteBuilder[] = [],
    options?: ConstructorParameters<typeof McpServer>[1],
  ): Promise<McpServer> {
    t = await testContext().routes(routes).store(MCP_STORE_KEY, true).build();
    await t.startAndWaitReady();
    server = new McpServer(t.ctx, options);
    return server;
  }

  /**
   * @case McpServer construction with default and custom options
   * @preconditions Context built; create server with no options then with name/version
   * @expectedResult Both servers are defined
   */
  test("initializes with default and custom options", async () => {
    t = await testContext().build();
    server = new McpServer(t.ctx);
    expect(server).toBeDefined();
    await server.stop();
    server = new McpServer(t.ctx, {
      name: "custom-server",
      version: "2.0.0",
    });
    expect(server).toBeDefined();
  });

  /**
   * @case Tool filtering by name array and by predicate
   * @preconditions Routes for tool1, tool2, public-tool (readOnly), private-tool; filter by name then by annotation
   * @expectedResult Only allowed tools appear in getAvailableTools()
   */
  test("respects tool filtering by name and by function", async () => {
    t = await testContext()
      .routes([
        craft().id("tool1").description("First tool").from(mcp()).to(noop()),
        craft().id("tool2").description("Second tool").from(mcp()).to(noop()),
        craft()
          .id("public-tool")
          .description("Public")
          .from(mcp({ annotations: { readOnlyHint: true } }))
          .to(noop()),
        craft()
          .id("private-tool")
          .description("Private")
          .from(mcp({ annotations: { destructiveHint: true } }))
          .to(noop()),
      ])
      .store(MCP_STORE_KEY, true)
      .build();

    server = new McpServer(t.ctx, { tools: ["tool1"] });
    expect(server).toBeDefined();
    await t.startAndWaitReady();
    let names = server.getAvailableTools().map((tool) => tool.name);
    expect(names).toEqual(["tool1"]);
    await server.stop();

    server = new McpServer(t.ctx, {
      tools: (entry) => entry.annotations?.readOnlyHint === true,
    });
    await server.start();
    names = server.getAvailableTools().map((tool) => tool.name);
    expect(names).toEqual(["public-tool"]);
  });

  /**
   * @case Tools with and without Zod schema are accepted
   * @preconditions One route with Zod schema, one without
   * @expectedResult Server initializes and lists both tools
   */
  test("handles tools with and without schema", async () => {
    const schema = z.object({
      name: z.string().describe("User name"),
      age: z.number().int().min(0),
    });
    t = await testContext()
      .routes([
        craft()
          .id("schema-tool")
          .description("Tool with schema")
          .input({ body: schema })
          .from(mcp())
          .to(noop()),
        craft()
          .id("no-schema-tool")
          .description("Tool without schema")
          .from(mcp())
          .to(noop()),
      ])
      .store(MCP_STORE_KEY, true)
      .build();

    server = new McpServer(t.ctx);
    expect(server).toBeDefined();
    await t.startAndWaitReady();
    const names = server.getAvailableTools().map((tool) => tool.name);
    expect(names).toContain("schema-tool");
    expect(names).toContain("no-schema-tool");
  });

  /**
   * @case Only mcp() routes with description are exposed; direct() without description is ignored
   * @preconditions mcp() route with description and direct() route without
   * @expectedResult Only the mcp() tool is in getAvailableTools()
   */
  test("exposes only mcp() routes with description", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("exposed-tool")
          .description("Exposed")
          .from(mcp())
          .to(noop()),
        craft().id("internal-direct").from(direct()).to(noop()),
      ])
      .store(MCP_STORE_KEY, true)
      .build();
    server = new McpServer(t.ctx);
    expect(server).toBeDefined();
    await t.startAndWaitReady();
    const names = server.getAvailableTools().map((tool) => tool.name);
    expect(names).toEqual(["exposed-tool"]);
  });

  /**
   * @case Annotations from mcp() options are included in getAvailableTools() output
   * @preconditions Route uses mcp() with annotations
   * @expectedResult Tool listing includes the annotations object
   */
  test("includes annotations in tool listing", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("annotated")
          .description("An annotated tool")
          .from(
            mcp({
              annotations: {
                readOnlyHint: true,
                destructiveHint: false,
              },
            }),
          )
          .to(noop()),
      ])
      .store(MCP_STORE_KEY, true)
      .build();
    server = new McpServer(t.ctx);
    await t.startAndWaitReady();
    const tools = server.getAvailableTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
    });
  });

  /**
   * @case Tools without annotations omit the field from getAvailableTools()
   * @preconditions Route uses mcp() without annotations
   * @expectedResult Tool listing has no annotations key
   */
  test("omits annotations when not provided", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("plain")
          .description("No annotations")
          .from(mcp())
          .to(noop()),
      ])
      .store(MCP_STORE_KEY, true)
      .build();
    server = new McpServer(t.ctx);
    await t.startAndWaitReady();
    const tools = server.getAvailableTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]).not.toHaveProperty("annotations");
  });

  /**
   * @case Route tags derive the MCP tool annotation hints
   * @preconditions Route uses .tag(["read-only", "open-world"]) and .from(mcp()) with no annotations option
   * @expectedResult getAvailableTools() reports readOnlyHint and openWorldHint derived from the tags
   */
  test("derives annotation hints from route tags", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("tagged")
          .description("A tagged tool")
          .tag(["read-only", "open-world"])
          .from(mcp())
          .to(noop()),
      ])
      .store(MCP_STORE_KEY, true)
      .build();
    server = new McpServer(t.ctx);
    await t.startAndWaitReady();
    const tools = server.getAvailableTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].annotations).toEqual({
      readOnlyHint: true,
      openWorldHint: true,
    });
  });

  /**
   * @case All four well-known tags map to their annotation hints
   * @preconditions Route tagged read-only, destructive, idempotent, open-world with .from(mcp())
   * @expectedResult getAvailableTools() reports all four hints as true
   */
  test("maps all four well-known tags to annotation hints", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("all-hints")
          .description("Every hint")
          .tag(["read-only", "destructive", "idempotent", "open-world"])
          .from(mcp())
          .to(noop()),
      ])
      .store(MCP_STORE_KEY, true)
      .build();
    server = new McpServer(t.ctx);
    await t.startAndWaitReady();
    const tools = server.getAvailableTools();
    expect(tools[0].annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  /**
   * @case Explicit mcp() annotations override the tag-derived hints per-key
   * @preconditions Route tagged read-only but mcp({ annotations: { readOnlyHint: false } })
   * @expectedResult The explicit readOnlyHint: false wins over the tag-derived true
   */
  test("explicit annotations override tag-derived hints", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("override")
          .description("Override hint")
          .tag("read-only")
          .from(mcp({ annotations: { readOnlyHint: false } }))
          .to(noop()),
      ])
      .store(MCP_STORE_KEY, true)
      .build();
    server = new McpServer(t.ctx);
    await t.startAndWaitReady();
    const tools = server.getAvailableTools();
    expect(tools[0].annotations).toEqual({ readOnlyHint: false });
  });

  /**
   * @case A tool without its own icons inherits the default Routecraft server icons
   * @preconditions Default server options; route uses mcp() without icons
   * @expectedResult getAvailableTools() reports the tool carrying ROUTECRAFT_DEFAULT_ICONS
   */
  test("tools inherit the default server icons", async () => {
    t = await testContext()
      .routes([
        craft().id("plain").description("No icons").from(mcp()).to(noop()),
      ])
      .store(MCP_STORE_KEY, true)
      .build();
    server = new McpServer(t.ctx);
    await t.startAndWaitReady();
    const tools = server.getAvailableTools();
    expect(tools[0].icons).toEqual(ROUTECRAFT_DEFAULT_ICONS);
  });

  /**
   * @case A tool inherits custom server-level icons when it declares none of its own
   * @preconditions Server configured with custom icons; route uses mcp() without icons
   * @expectedResult The tool carries the custom server icons
   */
  test("tools inherit custom server icons", async () => {
    const serverIcons = [
      { src: "https://acme.example.com/logo.svg", mimeType: "image/svg+xml" },
    ];
    t = await testContext()
      .routes([
        craft().id("plain").description("No icons").from(mcp()).to(noop()),
      ])
      .store(MCP_STORE_KEY, true)
      .build();
    server = new McpServer(t.ctx, { icons: serverIcons });
    await t.startAndWaitReady();
    const tools = server.getAvailableTools();
    expect(tools[0].icons).toEqual(serverIcons);
  });

  /**
   * @case A tool's own icons take precedence over inherited server icons
   * @preconditions Server with custom icons; route uses mcp({ icons })
   * @expectedResult The tool keeps its own icons, not the server's
   */
  test("tool icons override inherited server icons", async () => {
    const toolIcons = [
      { src: "https://acme.example.com/tool.svg", mimeType: "image/svg+xml" },
    ];
    t = await testContext()
      .routes([
        craft()
          .id("custom")
          .description("Has icons")
          .from(mcp({ icons: toolIcons }))
          .to(noop()),
      ])
      .store(MCP_STORE_KEY, true)
      .build();
    server = new McpServer(t.ctx, {
      icons: [{ src: "https://acme.example.com/server.svg" }],
    });
    await t.startAndWaitReady();
    const tools = server.getAvailableTools();
    expect(tools[0].icons).toEqual(toolIcons);
  });

  /**
   * @case An empty per-tool icons array opts the tool out of inheriting any icon
   * @preconditions Default server icons; route uses mcp({ icons: [] })
   * @expectedResult The tool omits the icons field
   */
  test("empty tool icons suppress inheritance", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("bare")
          .description("Suppressed")
          .from(mcp({ icons: [] }))
          .to(noop()),
      ])
      .store(MCP_STORE_KEY, true)
      .build();
    server = new McpServer(t.ctx);
    await t.startAndWaitReady();
    const tools = server.getAvailableTools();
    expect(tools[0]).not.toHaveProperty("icons");
  });

  /**
   * @case Suppressing server icons removes branding from inheriting tools too
   * @preconditions Server with icons: []; route uses mcp() without icons
   * @expectedResult The tool omits the icons field
   */
  test("server icons: [] disables default branding for tools", async () => {
    t = await testContext()
      .routes([
        craft().id("plain").description("No icons").from(mcp()).to(noop()),
      ])
      .store(MCP_STORE_KEY, true)
      .build();
    server = new McpServer(t.ctx, { icons: [] });
    await t.startAndWaitReady();
    const tools = server.getAvailableTools();
    expect(tools[0]).not.toHaveProperty("icons");
  });

  describe("HTTP transport", () => {
    /** Start HTTP server with given route builders; returns post helper and port. Call initHandshake() to run the 2025-era handshake. */
    async function startHttpServer(
      routes: AnyRouteBuilder[],
      serverOptions: {
        auth?: import("../src/mcp/types.ts").McpHttpAuthOptions;
        resource?: import("../src/mcp/types.ts").McpResourceOptions;
        title?: string;
        description?: string;
        websiteUrl?: string;
        instructions?: string;
        icons?: import("../src/mcp/types.ts").McpIcon[];
        userinfo?: import("../src/mcp/userinfo.ts").UserinfoOption;
        cors?: false | import("../src/mcp/cors.ts").McpCorsOptions;
      } = {},
    ) {
      let port = 0;
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
        .routes(routes)
        .with({
          servers: { default: { host: "127.0.0.1", port: 0 } },
          plugins: [mcpPlugin({ transport: "http", ...serverOptions })],
        })
        .build();
      await t.startAndWaitReady();
      await listening;
      expect(port).toBeDefined();
      expect(Number.isInteger(port) && port > 0).toBe(true);

      function post(
        body: string,
        extraHeaders?: Record<string, string>,
      ): Promise<{
        statusCode: number;
        body: string;
        headers: Record<string, string | string[] | undefined>;
      }> {
        return new Promise((resolve, reject) => {
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Connection: "close",
          };
          if (extraHeaders) Object.assign(headers, extraHeaders);
          const req = http.request(
            {
              host: "127.0.0.1",
              port,
              path: "/mcp",
              method: "POST",
              headers,
            },
            (res) => {
              let data = "";
              res.on("data", (chunk) => (data += chunk));
              res.on("end", () =>
                resolve({
                  statusCode: res.statusCode ?? 0,
                  body: rpcBody(data),
                  headers: res.headers as Record<
                    string,
                    string | string[] | undefined
                  >,
                }),
              );
            },
          );
          req.on("error", reject);
          req.write(body);
          req.end();
        });
      }

      function get(
        path: string,
        extraHeaders?: Record<string, string>,
      ): Promise<{
        statusCode: number;
        body: string;
        headers: Record<string, string | string[] | undefined>;
      }> {
        return new Promise((resolve, reject) => {
          const headers: Record<string, string> = { Connection: "close" };
          if (extraHeaders) Object.assign(headers, extraHeaders);
          const req = http.request(
            {
              host: "127.0.0.1",
              port,
              path,
              method: "GET",
              headers,
            },
            (res) => {
              let data = "";
              res.on("data", (chunk) => (data += chunk));
              res.on("end", () =>
                resolve({
                  statusCode: res.statusCode ?? 0,
                  body: data,
                  headers: res.headers as Record<
                    string,
                    string | string[] | undefined
                  >,
                }),
              );
            },
          );
          req.on("error", reject);
          req.end();
        });
      }

      function options(
        path: string,
        extraHeaders?: Record<string, string>,
      ): Promise<{
        statusCode: number;
        headers: Record<string, string | string[] | undefined>;
      }> {
        return new Promise((resolve, reject) => {
          const headers: Record<string, string> = { Connection: "close" };
          if (extraHeaders) Object.assign(headers, extraHeaders);
          const req = http.request(
            {
              host: "127.0.0.1",
              port,
              path,
              method: "OPTIONS",
              headers,
            },
            (res) => {
              res.on("data", () => {
                /* drain */
              });
              res.on("end", () =>
                resolve({
                  statusCode: res.statusCode ?? 0,
                  headers: res.headers as Record<
                    string,
                    string | string[] | undefined
                  >,
                }),
              );
            },
          );
          req.on("error", reject);
          req.end();
        });
      }

      /**
       * Perform the 2025-era `initialize` handshake and assert the server
       * answers it without minting a session. Protocol revision 2026-07-28
       * removed `Mcp-Session-Id`, and the SDK's stateless serving of 2025-era
       * traffic mints none either, so callers thread `undefined` onward and
       * every later request stands alone.
       */
      async function initHandshake(
        authHeaders?: Record<string, string>,
      ): Promise<void> {
        const initBody = JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: INIT_PARAMS,
        });
        const res = await post(initBody, authHeaders);
        expect(res.statusCode).toBe(200);
        expect(res.headers["mcp-session-id"]).toBeUndefined();
      }

      return { post, get, options, port, initHandshake };
    }

    /**
     * @case HTTP server responds to initialize and tools/list
     * @preconditions McpServer http with one mcp() route; initialize then tools/list
     * @expectedResult HTTP 200 and tools array contains the route
     */
    test("listens and responds to POST /mcp tools/list", async () => {
      const { post, initHandshake } = await startHttpServer([
        craft()
          .id("http-tool")
          .description("Tool exposed over HTTP")
          .from(mcp())
          .to(noop()),
      ]);

      await initHandshake();
      const listBody = JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      });
      const response = await post(listBody);
      expect(response.statusCode).toBe(200);
      const parsed = JSON.parse(response.body);
      expect(parsed.result).toBeDefined();
      expect(Array.isArray(parsed.result.tools)).toBe(true);
      const toolNames = (parsed.result.tools as { name: string }[]).map(
        (t) => t.name,
      );
      expect(toolNames).toContain("http-tool");
    });

    /**
     * @case initialize returns the default Routecraft server identity
     * @preconditions HTTP server with default options; send initialize
     * @expectedResult serverInfo carries the default description, websiteUrl, and icons; no instructions
     */
    test("initialize returns the default server identity", async () => {
      const { post } = await startHttpServer([
        craft().id("id-tool").description("Tool").from(mcp()).to(noop()),
      ]);
      const res = await post(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: INIT_PARAMS,
        }),
      );
      expect(res.statusCode).toBe(200);
      const result = JSON.parse(res.body).result;
      expect(result.serverInfo.description).toBe("Powered by Routecraft.dev");
      expect(result.serverInfo.websiteUrl).toBe("https://routecraft.dev");
      expect(result.serverInfo.icons).toEqual(ROUTECRAFT_DEFAULT_ICONS);
      expect(result.instructions).toBeUndefined();
    });

    /**
     * @case initialize reflects custom server identity and instructions
     * @preconditions HTTP server with custom description/websiteUrl/instructions/icons
     * @expectedResult serverInfo and instructions carry the configured values
     */
    test("initialize reflects custom server identity", async () => {
      const icons = [
        { src: "https://acme.example.com/logo.svg", mimeType: "image/svg+xml" },
      ];
      const { post } = await startHttpServer(
        [craft().id("id-tool").description("Tool").from(mcp()).to(noop())],
        {
          description: "Acme over MCP",
          websiteUrl: "https://acme.example.com",
          instructions: "Call id-tool first.",
          icons,
        },
      );
      const res = await post(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: INIT_PARAMS,
        }),
      );
      const result = JSON.parse(res.body).result;
      expect(result.serverInfo.description).toBe("Acme over MCP");
      expect(result.serverInfo.websiteUrl).toBe("https://acme.example.com");
      expect(result.serverInfo.icons).toEqual(icons);
      expect(result.instructions).toBe("Call id-tool first.");
    });

    /**
     * @case Empty-string identity fields, empty icons, and empty instructions are omitted
     * @preconditions HTTP server with description:"", websiteUrl:"", icons:[], instructions:""
     * @expectedResult serverInfo omits description, websiteUrl, and icons; result omits instructions
     */
    test("initialize omits suppressed identity fields", async () => {
      const { post } = await startHttpServer(
        [craft().id("id-tool").description("Tool").from(mcp()).to(noop())],
        { description: "", websiteUrl: "", icons: [], instructions: "" },
      );
      const res = await post(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: INIT_PARAMS,
        }),
      );
      const result = JSON.parse(res.body).result;
      expect(result.serverInfo).not.toHaveProperty("description");
      expect(result.serverInfo).not.toHaveProperty("websiteUrl");
      expect(result.serverInfo).not.toHaveProperty("icons");
      expect(result.instructions).toBeUndefined();
    });

    /**
     * @case tools/list JSON-RPC response includes annotations forwarded on the wire
     * @preconditions HTTP server with a route declaring annotations; initialize then tools/list
     * @expectedResult The parsed response body contains the annotations object on the matching tool
     */
    test("tools/list forwards annotations on the wire", async () => {
      const { post, initHandshake } = await startHttpServer([
        craft()
          .id("annotated-http-tool")
          .description("Tool with annotations over HTTP")
          .from(
            mcp({
              annotations: {
                title: "Annotated Tool",
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
              },
            }),
          )
          .to(noop()),
      ]);

      await initHandshake();
      const listBody = JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      });
      const response = await post(listBody);
      expect(response.statusCode).toBe(200);
      const parsed = JSON.parse(response.body);
      const tools = parsed.result.tools as Array<{
        name: string;
        annotations?: Record<string, unknown>;
      }>;
      const annotated = tools.find((t) => t.name === "annotated-http-tool");
      expect(annotated).toBeDefined();
      expect(annotated?.annotations).toEqual({
        title: "Annotated Tool",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    });

    /**
     * @case tools/call request body is passed into the exchange as an object
     * @preconditions HTTP server with capture route; initialize then tools/call with JSON arguments
     * @expectedResult Exchange body is an object with the argument keys
     */
    test("tools/call passes arguments as object in exchange body", async () => {
      let receivedBody: unknown;
      const { post, initHandshake } = await startHttpServer([
        craft()
          .id("capture-tool")
          .description("Capture body for test")
          .input({ body: z.object({ user: z.string() }) })
          .from(mcp())
          .tap((ex) => {
            receivedBody = ex.body;
          })
          .to(noop()),
      ]);

      await initHandshake();
      const callBody = JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "capture-tool", arguments: { user: "World" } },
      });
      const callRes = await post(callBody);
      expect(callRes.statusCode).toBe(200);
      const callParsed = JSON.parse(callRes.body);
      if (callParsed.error) {
        throw new Error(
          `tools/call failed: ${JSON.stringify(callParsed.error)}`,
        );
      }
      expect(typeof receivedBody).toBe("object");
      expect(receivedBody).not.toBeNull();
      expect(receivedBody).toHaveProperty("user", "World");
    });

    /**
     * @case tools/call returns structuredContent when the route declares .output()
     * @preconditions HTTP server with a route declaring .output(); initialize then tools/call
     * @expectedResult Result carries structuredContent equal to the body, with a mirrored text content block, so spec-compliant clients that require structuredContent for tools advertising an outputSchema accept the response
     */
    test("tools/call returns structuredContent for a route with .output()", async () => {
      const { post, initHandshake } = await startHttpServer([
        craft()
          .id("structured-echo")
          .description("Echoes the value back with a declared output schema")
          .input({ body: z.object({ value: z.string() }) })
          .output({ body: z.object({ value: z.string() }) })
          .from<{ value: string }>(mcp())
          .transform((body) => ({ value: body.value })),
      ]);

      await initHandshake();
      const callBody = JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "structured-echo", arguments: { value: "hi" } },
      });
      const callRes = await post(callBody);
      expect(callRes.statusCode).toBe(200);
      const callParsed = JSON.parse(callRes.body);
      if (callParsed.error) {
        throw new Error(
          `tools/call failed: ${JSON.stringify(callParsed.error)}`,
        );
      }
      const result = callParsed.result as Record<string, unknown>;
      expect(result["structuredContent"]).toEqual({ value: "hi" });
      const content = result["content"] as Array<{
        type: string;
        text: string;
      }>;
      expect(JSON.parse(content[0].text)).toEqual({ value: "hi" });
    });

    /**
     * @case tools/call omits structuredContent when the route declares no .output()
     * @preconditions HTTP server with a route without .output(); initialize then tools/call
     * @expectedResult Result has only the text content block; structuredContent is absent because no outputSchema is advertised
     */
    test("tools/call omits structuredContent without .output()", async () => {
      const { post, initHandshake } = await startHttpServer([
        craft()
          .id("plain-echo")
          .description("Echoes the value back without an output schema")
          .input({ body: z.object({ value: z.string() }) })
          .from<{ value: string }>(mcp())
          .transform((body) => ({ value: body.value })),
      ]);

      await initHandshake();
      const callBody = JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "plain-echo", arguments: { value: "hi" } },
      });
      const callRes = await post(callBody);
      expect(callRes.statusCode).toBe(200);
      const callParsed = JSON.parse(callRes.body);
      if (callParsed.error) {
        throw new Error(
          `tools/call failed: ${JSON.stringify(callParsed.error)}`,
        );
      }
      const result = callParsed.result as Record<string, unknown>;
      expect(result["structuredContent"]).toBeUndefined();
      const content = result["content"] as Array<{
        type: string;
        text: string;
      }>;
      expect(JSON.parse(content[0].text)).toEqual({ value: "hi" });
    });

    /**
     * @case tools/call passes string and object args with correct types
     * @preconditions HTTP server with echo-args route; initialize then tools/call with str and obj
     * @expectedResult Route receives str as string and obj as object (not stringified)
     */
    test("tools/call passes string and object args with correct types", async () => {
      const { post, initHandshake } = await startHttpServer([
        craft()
          .id("echo-args")
          .description("Echo argument types and values for test")
          .input({
            body: z.object({
              str: z.string(),
              obj: z.record(z.string(), z.any()),
            }),
          })
          .from<{ str: string; obj: Record<string, unknown> }>(mcp())
          .transform((body) => ({
            strType: typeof body.str,
            objType: typeof body.obj,
            strVal: body.str,
            objVal: body.obj,
          }))
          .to(noop()),
      ]);

      await initHandshake();
      const toolArgs = { str: "hello", obj: { a: 1, b: 2 } };
      const callBody = JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "echo-args", arguments: toolArgs },
      });
      const callRes = await post(callBody);
      expect(callRes.statusCode).toBe(200);
      const callParsed = JSON.parse(callRes.body);
      if (callParsed.error) {
        throw new Error(
          `tools/call failed: ${JSON.stringify(callParsed.error)}`,
        );
      }
      const result = callParsed.result as Record<string, unknown>;
      const content = result?.["content"] as Array<{
        type: string;
        text: string;
      }>;
      expect(Array.isArray(content) && content[0]?.text).toBeTruthy();
      const resultText = content[0].text;
      if (resultText.startsWith("Error:")) {
        throw new Error(`Tool call returned error: ${resultText}`);
      }
      const echoed = JSON.parse(resultText) as {
        strType: string;
        objType: string;
        strVal: string;
        objVal: unknown;
      };
      expect(echoed.strType).toBe("string");
      expect(echoed.objType).toBe("object");
      expect(echoed.strVal).toBe("hello");
      expect(echoed.objVal).toEqual({ a: 1, b: 2 });
      expect(typeof echoed.objVal).toBe("object");
      expect(echoed.objVal).not.toBe(null);
    });

    describe("auth", () => {
      const validPrincipal = {
        kind: "custom" as const,
        subject: "user-1",
        scheme: "bearer" as const,
      };

      /**
       * @case Request without Authorization header returns 401 when auth is configured
       * @preconditions McpServer with auth.validator set; POST /mcp without Authorization header
       * @expectedResult 401 status code with WWW-Authenticate header including realm and resource_metadata (RFC 9728)
       */
      test("returns 401 when no Authorization header and auth is configured", async () => {
        const { post } = await startHttpServer([], {
          auth: { validator: () => validPrincipal },
        });

        const initBody = JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: INIT_PARAMS,
        });
        const res = await post(initBody);
        expect(res.statusCode).toBe(401);
        const wwwAuth = res.headers["www-authenticate"];
        expect(wwwAuth).toMatch(/Bearer/);
        expect(wwwAuth).toMatch(/realm="mcp"/);
        // RFC 9728 §5.1: resource_metadata SHOULD be an absolute URL so a
        // reverse proxy with a path prefix resolves it against the right
        // origin. The validator path now derives the URL from the
        // resolved `resource.url` (or bound fallback), matching what the
        // OAuth path emits.
        expect(wwwAuth).toMatch(
          /resource_metadata="https?:\/\/[^"]+\/\.well-known\/oauth-protected-resource\/mcp"/,
        );
      });

      /**
       * @case Request with rejected token returns 401
       * @preconditions McpServer with auth.validator that throws; POST /mcp with token
       * @expectedResult 401 status code
       */
      test("returns 401 when validator throws", async () => {
        const { post } = await startHttpServer([], {
          auth: {
            validator: () => {
              throw new Error("invalid token");
            },
          },
        });

        const initBody = JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: INIT_PARAMS,
        });
        const res = await post(initBody, {
          Authorization: "Bearer wrong-token",
        });
        expect(res.statusCode).toBe(401);
      });

      /**
       * @case Request with valid token returns 200
       * @preconditions McpServer with auth.validator returning principal; POST /mcp with bearer token
       * @expectedResult 200 status code and MCP session established
       */
      test("accepts request when validator returns principal", async () => {
        const { post } = await startHttpServer([], {
          auth: {
            validator: (token) => {
              if (token !== "valid-token") throw new Error("invalid token");
              return validPrincipal;
            },
          },
        });

        const initBody = JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: INIT_PARAMS,
        });
        const res = await post(initBody, {
          Authorization: "Bearer valid-token",
        });
        expect(res.statusCode).toBe(200);
      });

      /**
       * @case Lowercase "bearer" scheme is accepted (RFC 9110 case-insensitive)
       * @preconditions McpServer with auth; POST /mcp with "bearer" (lowercase) scheme
       * @expectedResult 200 status code (auth passes)
       */
      test("accepts lowercase bearer scheme per RFC 9110", async () => {
        const { post } = await startHttpServer([], {
          auth: {
            validator: (token) => {
              if (token !== "valid-token") throw new Error("invalid token");
              return validPrincipal;
            },
          },
        });

        const initBody = JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: INIT_PARAMS,
        });
        const res = await post(initBody, {
          Authorization: "bearer valid-token",
        });
        expect(res.statusCode).toBe(200);
      });

      /**
       * @case Requests pass through unchanged when no auth option is configured
       * @preconditions McpServer without auth option; POST /mcp without Authorization header
       * @expectedResult 200 status code (backward compatible)
       */
      test("passes requests through when auth is not configured", async () => {
        const { post } = await startHttpServer([]);

        const initBody = JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: INIT_PARAMS,
        });
        const res = await post(initBody);
        expect(res.statusCode).toBe(200);
      });

      /**
       * @case Async validator that resolves to principal allows access
       * @preconditions McpServer with async auth.validator resolving to AuthPrincipal
       * @expectedResult 200 status code
       */
      test("accepts request when async validator resolves principal", async () => {
        const { post } = await startHttpServer([], {
          auth: {
            validator: async (token) => {
              if (token !== "async-valid") throw new Error("invalid token");
              return validPrincipal;
            },
          },
        });

        const initBody = JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: INIT_PARAMS,
        });
        const res = await post(initBody, {
          Authorization: "Bearer async-valid",
        });
        expect(res.statusCode).toBe(200);
      });

      /**
       * @case Async validator that rejects access by throwing
       * @preconditions McpServer with async auth.validator that always throws
       * @expectedResult 401 status code
       */
      test("returns 401 when async validator throws", async () => {
        const { post } = await startHttpServer([], {
          auth: {
            validator: async () => {
              throw new Error("invalid token");
            },
          },
        });

        const initBody = JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: INIT_PARAMS,
        });
        const res = await post(initBody, {
          Authorization: "Bearer any-token",
        });
        expect(res.statusCode).toBe(401);
      });

      describe("rejection log levels (validator mode)", () => {
        const initBody = JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: INIT_PARAMS,
        });

        /**
         * @case A tokenless request (the MCP OAuth discovery probe) logs at debug, not warn
         * @preconditions McpServer with validator auth; POST /mcp with no Authorization header
         * @expectedResult 401; debug logged with reason "missing_header"; no warn for that message; auth:rejected emitted
         */
        test("logs the no-token discovery probe at debug, not warn", async () => {
          const rejections: Array<Record<string, unknown>> = [];
          const { post } = await startHttpServer([], {
            auth: { validator: () => validPrincipal },
          });
          t.ctx.on("auth:rejected", (payload) => {
            rejections.push(payload.details as Record<string, unknown>);
          });

          const res = await post(initBody);
          expect(res.statusCode).toBe(401);

          const msg =
            "Auth rejected: missing or malformed Authorization header";
          const debugCall = t.logger.debug.mock.calls.find((c) => c[1] === msg);
          expect(debugCall).toBeDefined();
          expect(debugCall?.[0]).toMatchObject({
            reason: "missing_header",
            scheme: "bearer",
            source: "mcp",
          });
          expect(t.logger.warn.mock.calls.some((c) => c[1] === msg)).toBe(
            false,
          );
          expect(rejections.some((r) => r["reason"] === "missing_header")).toBe(
            true,
          );
        });

        /**
         * @case auth is configured but resolves no verifier, so every request is refused
         * @preconditions McpServer constructed directly (bypassing the mcpPlugin validation that requires a `validator`) with an auth object that has none; POST /mcp with a valid-looking bearer
         * @expectedResult 401, and the refusal is observable: an error log naming the misconfiguration and an auth:rejected event with reason "no_verifier". A blanket 401 with no log and no event is indistinguishable from a server nobody holds a token for
         */
        test("emits when auth resolves no verifier", async () => {
          await expect(
            startHttpServer([], {
              auth: {} as import("../src/mcp/types.ts").McpHttpAuthOptions,
            }),
          ).rejects.toThrow(/validator/);
        });

        /**
         * @case A non-bearer scheme (client not yet authenticated) logs at debug, not warn
         * @preconditions McpServer with validator auth; POST /mcp with a Basic Authorization header
         * @expectedResult 401; debug logged with reason "unsupported_scheme"; no warn for that message
         */
        test("logs an unsupported auth scheme at debug, not warn", async () => {
          const { post } = await startHttpServer([], {
            auth: { validator: () => validPrincipal },
          });

          const res = await post(initBody, {
            Authorization: "Basic dXNlcjpwYXNz",
          });
          expect(res.statusCode).toBe(401);

          const msg = "Auth rejected: unsupported authorization scheme";
          const debugCall = t.logger.debug.mock.calls.find((c) => c[1] === msg);
          expect(debugCall).toBeDefined();
          expect(debugCall?.[0]).toMatchObject({
            reason: "unsupported_scheme",
          });
          expect(t.logger.warn.mock.calls.some((c) => c[1] === msg)).toBe(
            false,
          );
        });

        /**
         * @case An expired token (routine refresh cycle) logs at debug, not warn
         * @preconditions McpServer with a validator that throws jose's ERR_JWT_EXPIRED; POST /mcp with a bearer token
         * @expectedResult 401; debug logged as "Auth rejected: token expired"; no "token validation failed" warn
         */
        test("logs an expired token at debug, not warn", async () => {
          const rejections: Array<Record<string, unknown>> = [];
          const expiredError = Object.assign(
            new Error('"exp" claim timestamp check failed'),
            { code: "ERR_JWT_EXPIRED" },
          );
          const { post } = await startHttpServer([], {
            auth: {
              validator: () => {
                throw expiredError;
              },
            },
          });
          t.ctx.on("auth:rejected", ({ details }) => {
            rejections.push(details as Record<string, unknown>);
          });

          const res = await post(initBody, {
            Authorization: "Bearer expired-token",
          });
          expect(res.statusCode).toBe(401);

          const expiredMsg = "Auth rejected: token expired";
          const debugCall = t.logger.debug.mock.calls.find(
            (c) => c[1] === expiredMsg,
          );
          expect(debugCall).toBeDefined();
          expect(debugCall?.[0]).toMatchObject({
            reason: "expired",
            scheme: "bearer",
            source: "mcp",
          });
          expect(
            t.logger.warn.mock.calls.some(
              (c) => c[1] === "Auth rejected: token validation failed",
            ),
          ).toBe(false);
          expect(rejections).toContainEqual({
            reason: "expired",
            scheme: "bearer",
            source: "mcp",
          });
        });

        /**
         * @case A genuinely invalid token (bad signature) stays at warn
         * @preconditions McpServer with a validator that throws a generic Error; POST /mcp with a bearer token
         * @expectedResult 401; warn logged as "token validation failed"; no "token expired" debug
         */
        test("logs a genuinely invalid token at warn", async () => {
          const { post } = await startHttpServer([], {
            auth: {
              validator: () => {
                throw new Error("invalid signature");
              },
            },
          });

          const res = await post(initBody, {
            Authorization: "Bearer bad-token",
          });
          expect(res.statusCode).toBe(401);

          const failedMsg = "Auth rejected: token validation failed";
          const warnCall = t.logger.warn.mock.calls.find(
            (c) => c[1] === failedMsg,
          );
          expect(warnCall).toBeDefined();
          expect(warnCall?.[0]).toMatchObject({
            reason: "invalid_token",
            scheme: "bearer",
            source: "mcp",
          });
          expect(
            t.logger.debug.mock.calls.some(
              (c) => c[1] === "Auth rejected: token expired",
            ),
          ).toBe(false);
        });
      });
    });

    describe("RFC 9728 protected-resource metadata (validator mode)", () => {
      const validPrincipal = {
        kind: "custom" as const,
        subject: "user-1",
        scheme: "bearer" as const,
      };

      /**
       * @case Discovery endpoint is served at /.well-known/oauth-protected-resource without auth
       * @preconditions McpServer with validator auth configured; GET without Authorization header
       * @expectedResult 200 with application/json content-type and a non-zero Cache-Control max-age (RFC 9728 §3.3)
       */
      test("GET /.well-known/oauth-protected-resource returns 200 JSON without auth", async () => {
        const { get } = await startHttpServer([], {
          auth: { validator: () => validPrincipal },
        });
        const res = await get("/.well-known/oauth-protected-resource/mcp");
        expect(res.statusCode).toBe(200);
        expect(res.headers["content-type"]).toMatch(/application\/json/);
        expect(res.headers["cache-control"]).toMatch(/max-age=\d+/);
        expect(() => JSON.parse(res.body)).not.toThrow();
      });

      /**
       * @case Discovery ignores credentials because it is a public protocol exemption
       * @preconditions Validator auth rejects one bearer; fetch metadata anonymously, with Basic auth, and with the rejected bearer
       * @expectedResult Every request returns 200 with byte-identical metadata so a stale-token client can discover how to re-authenticate
       */
      test("serves identical metadata despite malformed or rejected credentials", async () => {
        let verifierCalls = 0;
        const { get } = await startHttpServer([], {
          auth: {
            validator: (token) => {
              verifierCalls++;
              if (token === "valid") return validPrincipal;
              throw new Error("rejected");
            },
          },
        });
        const path = "/.well-known/oauth-protected-resource/mcp";
        const anonymous = await get(path);
        const malformed = await get(path, { Authorization: "Basic abc" });
        const rejected = await get(path, {
          Authorization: "Bearer rejected",
        });

        expect([
          anonymous.statusCode,
          malformed.statusCode,
          rejected.statusCode,
        ]).toEqual([200, 200, 200]);
        expect(malformed.body).toBe(anonymous.body);
        expect(rejected.body).toBe(anonymous.body);
        expect(verifierCalls).toBe(0);
      });

      /**
       * @case Metadata document carries the explicit `resource.url` when configured
       * @preconditions resource.url is set to "https://mcp.example.com"
       * @expectedResult `resource` field equals the configured value
       */
      test("resource field uses configured resource.url", async () => {
        const { get } = await startHttpServer([], {
          auth: { validator: () => validPrincipal },
          resource: { url: "https://mcp.example.com" },
        });
        const res = await get("/.well-known/oauth-protected-resource/mcp");
        const doc = JSON.parse(res.body) as { resource: string };
        expect(doc.resource).toBe("https://mcp.example.com");
      });

      /**
       * @case Metadata document falls back to bound URL when resource.url is unset
       * @preconditions No resource.url; server bound on 127.0.0.1:{port}
       * @expectedResult `resource` field is http://127.0.0.1:{port}/mcp
       */
      test("resource field falls back to http://host:port/mcp when unset", async () => {
        const { get, port } = await startHttpServer([], {
          auth: { validator: () => validPrincipal },
        });
        const res = await get("/.well-known/oauth-protected-resource/mcp");
        const doc = JSON.parse(res.body) as { resource: string };
        expect(doc.resource).toBe(`http://127.0.0.1:${port}/mcp`);
      });

      /**
       * @case A spoofed Host header cannot influence RFC 9728 resource identity
       * @preconditions Shared MCP listener bound to loopback; metadata request carries an attacker-controlled Host
       * @expectedResult SDK Host validation rejects the request with 403 before metadata is generated
       */
      test("rejects a spoofed Host header", async () => {
        const { get } = await startHttpServer([], {
          auth: { validator: () => validPrincipal },
        });
        const res = await get("/.well-known/oauth-protected-resource/mcp", {
          Host: "attacker.example",
        });
        expect(res.statusCode).toBe(403);
        expect(res.headers["www-authenticate"]).toBeUndefined();
      });

      /**
       * @case bearer_methods_supported is always ["header"]
       * @preconditions Any validator-mode configuration
       * @expectedResult Metadata `bearer_methods_supported` array is exactly ["header"]
       */
      test('bearer_methods_supported is ["header"]', async () => {
        const { get } = await startHttpServer([], {
          auth: { validator: () => validPrincipal },
        });
        const res = await get("/.well-known/oauth-protected-resource/mcp");
        const doc = JSON.parse(res.body) as {
          bearer_methods_supported: string[];
        };
        expect(doc.bearer_methods_supported).toEqual(["header"]);
      });

      /**
       * @case authorization_servers is populated from the validator's `issuer` field
       * @preconditions Validator carries issuer: "https://idp.example.com" (mirrors what jwks()/jwt() produce)
       * @expectedResult Metadata `authorization_servers` is ["https://idp.example.com"]
       */
      test("authorization_servers is [validator.issuer] when present", async () => {
        const { get } = await startHttpServer([], {
          auth: {
            validator: () => validPrincipal,
            issuer: "https://idp.example.com",
          },
        });
        const res = await get("/.well-known/oauth-protected-resource/mcp");
        const doc = JSON.parse(res.body) as {
          authorization_servers?: string[];
        };
        expect(doc.authorization_servers).toEqual(["https://idp.example.com"]);
      });

      /**
       * @case authorization_servers forwards array issuers as-is
       * @preconditions Validator carries issuer: ["https://a.example.com", "https://b.example.com"]
       * @expectedResult Metadata `authorization_servers` contains both entries
       */
      test("authorization_servers forwards array issuers", async () => {
        const { get } = await startHttpServer([], {
          auth: {
            validator: () => validPrincipal,
            issuer: ["https://a.example.com", "https://b.example.com"],
          },
        });
        const res = await get("/.well-known/oauth-protected-resource/mcp");
        const doc = JSON.parse(res.body) as {
          authorization_servers?: string[];
        };
        expect(doc.authorization_servers).toEqual([
          "https://a.example.com",
          "https://b.example.com",
        ]);
      });

      /**
       * @case authorization_servers is omitted when the validator has no issuer
       * @preconditions Plain `{ validator }` with no `issuer` field (custom verifier)
       * @expectedResult `authorization_servers` is absent from the metadata document
       */
      test("authorization_servers is omitted when validator has no issuer", async () => {
        const { get } = await startHttpServer([], {
          auth: { validator: () => validPrincipal },
        });
        const res = await get("/.well-known/oauth-protected-resource/mcp");
        const doc = JSON.parse(res.body) as Record<string, unknown>;
        expect(doc["authorization_servers"]).toBeUndefined();
      });

      /**
       * @case resource_name derives from title when set, else falls back to name
       * @preconditions title: "Eywa MCP" is set on the plugin options
       * @expectedResult Metadata `resource_name` equals "Eywa MCP"
       */
      test("resource_name uses title when set", async () => {
        const { get } = await startHttpServer([], {
          auth: { validator: () => validPrincipal },
          title: "Eywa MCP",
        });
        const res = await get("/.well-known/oauth-protected-resource/mcp");
        const doc = JSON.parse(res.body) as { resource_name?: string };
        expect(doc.resource_name).toBe("Eywa MCP");
      });

      /**
       * @case resource_name falls back to name when title is unset
       * @preconditions No title; default name "routecraft" is used
       * @expectedResult Metadata `resource_name` equals "routecraft"
       */
      test("resource_name falls back to name when title is unset", async () => {
        const { get } = await startHttpServer([], {
          auth: { validator: () => validPrincipal },
        });
        const res = await get("/.well-known/oauth-protected-resource/mcp");
        const doc = JSON.parse(res.body) as { resource_name?: string };
        expect(doc.resource_name).toBe("routecraft");
      });

      /**
       * @case scopes_supported and resource_documentation come from resource: {...}
       * @preconditions resource: { scopesSupported: ["read","write"], documentationUrl: "https://docs.example.com" }
       * @expectedResult Both fields appear in the metadata document
       */
      test("scopes_supported and resource_documentation pass through from resource: {...}", async () => {
        const { get } = await startHttpServer([], {
          auth: { validator: () => validPrincipal },
          resource: {
            scopesSupported: ["read", "write"],
            documentationUrl: "https://docs.example.com",
          },
        });
        const res = await get("/.well-known/oauth-protected-resource/mcp");
        const doc = JSON.parse(res.body) as {
          scopes_supported?: string[];
          resource_documentation?: string;
        };
        expect(doc.scopes_supported).toEqual(["read", "write"]);
        expect(doc.resource_documentation).toBe("https://docs.example.com");
      });

      /**
       * @case Metadata endpoint is served even when no auth is configured (baseline document)
       * @preconditions No auth, no resource options; default plugin config
       * @expectedResult Discovery returns 200 with at least `resource` and `bearer_methods_supported`
       */
      test("metadata endpoint is served without auth configured", async () => {
        const { get, port } = await startHttpServer([]);
        const res = await get("/.well-known/oauth-protected-resource/mcp");
        expect(res.statusCode).toBe(200);
        const doc = JSON.parse(res.body) as {
          resource: string;
          bearer_methods_supported: string[];
        };
        expect(doc.resource).toBe(`http://127.0.0.1:${port}/mcp`);
        expect(doc.bearer_methods_supported).toEqual(["header"]);
      });

      /**
       * @case End-to-end: `auth: jwks(...)` surfaces issuer into authorization_servers
       * @preconditions auth is the actual `jwks()` result with issuer "https://idp.example.com"
       * @expectedResult Metadata `authorization_servers` is ["https://idp.example.com"] -- the integration is exercised end-to-end, not via an inline `{ validator, issuer }` stub
       */
      test("authorization_servers is populated end-to-end from jwks()", async () => {
        const { get } = await startHttpServer([], {
          auth: jwks({
            jwksUrl: "http://example.invalid/jwks.json",
            issuer: "https://idp.example.com",
            audience: "https://mcp.example.com",
          }),
        });
        const res = await get("/.well-known/oauth-protected-resource/mcp");
        const doc = JSON.parse(res.body) as {
          authorization_servers?: string[];
        };
        expect(doc.authorization_servers).toEqual(["https://idp.example.com"]);
      });

      /**
       * @case HTTPS-in-production guard fires eagerly when `resource.url` is http:// in production
       * @preconditions NODE_ENV=production; resource.url is an http URL; validator auth
       * @expectedResult `new McpServer(...)` (via startHttpServer) throws TypeError at construction; no request is ever served
       */
      test("HTTPS guard rejects http:// resource.url at construction in production", async () => {
        const prev = process.env["NODE_ENV"];
        process.env["NODE_ENV"] = "production";
        try {
          await expect(
            startHttpServer([], {
              auth: { validator: () => validPrincipal },
              resource: { url: "http://insecure.example.com" },
            }),
          ).rejects.toThrow(/HTTPS/);
        } finally {
          if (prev === undefined) delete process.env["NODE_ENV"];
          else process.env["NODE_ENV"] = prev;
        }
      });

      /**
       * @case Shared HTTP transport requires an explicit public resource URL in production
       * @preconditions NODE_ENV=production; resource.url unset
       * @expectedResult Construction fails before binding because a proxy-facing resource identity cannot be inferred safely
       */
      test("production HTTP transport requires resource.url", async () => {
        const prev = process.env["NODE_ENV"];
        process.env["NODE_ENV"] = "production";
        try {
          await expect(
            startHttpServer([], {
              auth: { validator: () => validPrincipal },
            }),
          ).rejects.toThrow(/resource\.url is required/);
        } finally {
          if (prev === undefined) delete process.env["NODE_ENV"];
          else process.env["NODE_ENV"] = prev;
        }
      });

      /**
       * @case An unset environment fails closed like production
       * @preconditions NODE_ENV is absent; HTTP transport has no resource.url
       * @expectedResult Construction rejects instead of advertising a private bind address
       */
      test("unset NODE_ENV requires resource.url", async () => {
        const previous = process.env["NODE_ENV"];
        delete process.env["NODE_ENV"];
        try {
          await expect(
            startHttpServer([], {
              auth: { validator: () => validPrincipal },
            }),
          ).rejects.toThrow(/resource\.url is required/);
        } finally {
          if (previous === undefined) delete process.env["NODE_ENV"];
          else process.env["NODE_ENV"] = previous;
        }
      });

      /**
       * @case Metadata response carries Cache-Control with a non-zero max-age
       * @preconditions Validator auth; default plugin config
       * @expectedResult Cache-Control header advertises a positive max-age per RFC 9728 §3.3
       */
      test("metadata response sets Cache-Control with a positive max-age", async () => {
        const { get } = await startHttpServer([], {
          auth: { validator: () => validPrincipal },
        });
        const res = await get("/.well-known/oauth-protected-resource/mcp");
        const cacheControl = res.headers["cache-control"];
        expect(typeof cacheControl).toBe("string");
        expect(cacheControl as string).toMatch(/max-age=\d+/);
        const match = (cacheControl as string).match(/max-age=(\d+)/);
        expect(Number.parseInt(match![1]!, 10)).toBeGreaterThan(0);
      });
    });

    describe("RFC 9728 protected-resource metadata (OAuth-proxy mode)", () => {
      /**
       * @case oauth() auth works on an ephemeral port with no explicit resource.url
       * @preconditions oauth({...}) auth, port: 0, no resource.url; GET the protected-resource metadata
       * @expectedResult The document advertises the bound port rather than `:0`. Resolution is per request now that no middleware closes over the URL at mount time, so the old startup guard against `port: 0` is gone.
       */
      test("resolves the bound port on an ephemeral port", async () => {
        const { oauth } = await import("../src/mcp/oauth.ts");
        const authConfig = oauth({
          issuer: "http://localhost:9999",
          verify: async () => ({
            kind: "oauth" as const,
            scheme: "bearer" as const,
            subject: "u",
            clientId: "u",
            expiresAt: Math.floor(Date.now() / 1000) + 60,
          }),
        });
        const { get, port } = await startHttpServer([], { auth: authConfig });
        const res = await get("/.well-known/oauth-protected-resource/mcp");
        expect(res.statusCode).toBe(200);
        const doc = JSON.parse(res.body) as { resource: string };
        expect(doc.resource).toContain(`:${port}`);
        expect(doc.resource).not.toContain(":0/");
      });

      /**
       * @case OAuth-proxy mode metadata document is served by our handler, not the SDK's
       * @preconditions oauth() auth with an explicit resource.url; GET /.well-known/oauth-protected-resource
       * @expectedResult Document carries `bearer_methods_supported: ["header"]` -- proves our handler shadowed the SDK's (which omits this field)
       */
      test("OAuth-proxy mode serves the unified metadata shape (has bearer_methods_supported)", async () => {
        const { oauth } = await import("../src/mcp/oauth.ts");
        const authConfig = oauth({
          issuer: "http://localhost:9999",
          verify: async () => ({
            kind: "oauth" as const,
            scheme: "bearer" as const,
            subject: "u",
            clientId: "u",
            expiresAt: Math.floor(Date.now() / 1000) + 60,
          }),
        });
        const { get } = await startHttpServer([], {
          auth: authConfig,
          resource: { url: "http://localhost:9999" },
        });
        const res = await get("/.well-known/oauth-protected-resource/mcp");
        expect(res.statusCode).toBe(200);
        const doc = JSON.parse(res.body) as {
          resource: string;
          bearer_methods_supported?: string[];
        };
        expect(doc.bearer_methods_supported).toEqual(["header"]);
        expect(doc.resource).toBe("http://localhost:9999");
      });
    });

    describe("CORS (validator mode)", () => {
      const validPrincipal = {
        kind: "custom" as const,
        subject: "user-1",
        scheme: "bearer" as const,
      };
      const LOOPBACK_ORIGIN = "http://localhost:6274";

      /**
       * @case OPTIONS preflight on /mcp from a loopback Origin returns 204 with allow headers
       * @preconditions Default cors policy (loopback-only); request Origin is http://localhost:6274
       * @expectedResult 204 status, Access-Control-Allow-Origin echoes the request Origin, Allow-Methods includes POST
       */
      test("OPTIONS /mcp preflight from loopback returns 204 with allow headers", async () => {
        const { options } = await startHttpServer([]);
        const res = await options("/mcp", { Origin: LOOPBACK_ORIGIN });
        expect(res.statusCode).toBe(204);
        expect(res.headers["access-control-allow-origin"]).toBe(
          LOOPBACK_ORIGIN,
        );
        expect(res.headers["access-control-allow-methods"]).toContain("POST");
        expect(res.headers["access-control-allow-methods"]).toContain(
          "OPTIONS",
        );
        expect(res.headers["vary"]).toBe("Origin");
        // Chrome Private Network Access opt-in so public->loopback browser
        // clients (e.g. hosted Inspector tunnelled to a local MCP server) are
        // not blocked at the PNA preflight gate.
        expect(res.headers["access-control-allow-private-network"]).toBe(
          "true",
        );
      });

      /**
       * @case OPTIONS preflight on the metadata endpoint also returns 204 with allow headers
       * @preconditions Default cors policy; request Origin is loopback
       * @expectedResult 204 status with full preflight headers (mirrors /mcp)
       */
      test("OPTIONS /.well-known/oauth-protected-resource preflight returns 204", async () => {
        const { options } = await startHttpServer([]);
        const res = await options("/.well-known/oauth-protected-resource/mcp", {
          Origin: LOOPBACK_ORIGIN,
        });
        expect(res.statusCode).toBe(204);
        expect(res.headers["access-control-allow-origin"]).toBe(
          LOOPBACK_ORIGIN,
        );
      });

      /**
       * @case GET metadata from a loopback Origin carries Access-Control-Allow-Origin
       * @preconditions Default cors policy; GET /.well-known/oauth-protected-resource with loopback Origin
       * @expectedResult 200 response; Allow-Origin reflects the request Origin; Vary: Origin present
       */
      test("GET metadata reflects loopback origin", async () => {
        const { get } = await startHttpServer([]);
        const res = await get("/.well-known/oauth-protected-resource/mcp", {
          Origin: LOOPBACK_ORIGIN,
        });
        expect(res.statusCode).toBe(200);
        expect(res.headers["access-control-allow-origin"]).toBe(
          LOOPBACK_ORIGIN,
        );
        expect(res.headers["vary"]).toBe("Origin");
      });

      /**
       * @case 401 response on /mcp carries CORS headers and exposes WWW-Authenticate
       * @preconditions Auth validator configured; POST without Authorization from loopback Origin
       * @expectedResult 401 status; Allow-Origin echoes Origin; Expose-Headers includes WWW-Authenticate (so browsers can read the RFC 9728 hint)
       */
      test("401 from /mcp carries CORS headers and exposes WWW-Authenticate", async () => {
        const { post } = await startHttpServer([], {
          auth: { validator: () => validPrincipal },
        });
        const res = await post(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: INIT_PARAMS,
          }),
          { Origin: LOOPBACK_ORIGIN },
        );
        expect(res.statusCode).toBe(401);
        expect(res.headers["access-control-allow-origin"]).toBe(
          LOOPBACK_ORIGIN,
        );
        const expose = res.headers["access-control-expose-headers"];
        const exposeStr = Array.isArray(expose) ? expose.join(", ") : expose;
        expect(exposeStr).toBeDefined();
        expect(exposeStr!.toLowerCase()).toContain("www-authenticate");
      });

      /**
       * @case Only the path-suffixed RFC 9728 metadata URL is claimed by the MCP mount
       * @preconditions Default cors policy; GET /.well-known/oauth-protected-resource and /.well-known/oauth-protected-resource/mcp
       * @expectedResult The suffixed variant (the RFC 9728 section 3 probe for a resource at /mcp) returns 200; the bare root belongs to the / mount and 404s here
       */
      test("path-suffixed metadata URL is served; bare root is not claimed", async () => {
        const { get } = await startHttpServer([]);
        const rootRes = await get("/.well-known/oauth-protected-resource", {
          Origin: LOOPBACK_ORIGIN,
        });
        const suffRes = await get("/.well-known/oauth-protected-resource/mcp", {
          Origin: LOOPBACK_ORIGIN,
        });
        expect(rootRes.statusCode).toBe(404);
        expect(suffRes.statusCode).toBe(200);
        expect(suffRes.headers["access-control-allow-origin"]).toBe(
          LOOPBACK_ORIGIN,
        );
      });

      /**
       * @case Validator mode: non-default resource.url.pathname is served at the SDK-derived URL, not a hardcoded one
       * @preconditions resource.url = `http://localhost:9999/api/mcp`; GET /.well-known/oauth-protected-resource/api/mcp from loopback Origin
       * @expectedResult 200 with the framework's enriched metadata at the derived URL. Hardcoded `/mcp` suffix would have failed this case (the request would 404 because we'd only serve at /mcp).
       */
      test("validator mode serves metadata at non-default rsPath", async () => {
        const { get } = await startHttpServer([], {
          resource: { url: "http://localhost:9999/api/mcp" },
        });
        const res = await get("/.well-known/oauth-protected-resource/mcp", {
          Origin: LOOPBACK_ORIGIN,
        });
        expect(res.statusCode).toBe(200);
        const doc = JSON.parse(res.body) as {
          bearer_methods_supported?: string[];
          resource: string;
        };
        expect(doc.bearer_methods_supported).toEqual(["header"]);
        expect(doc.resource).toBe("http://localhost:9999/api/mcp");
        expect(res.headers["access-control-allow-origin"]).toBe(
          LOOPBACK_ORIGIN,
        );
      });

      /**
       * @case OPTIONS preflight on the path-suffixed metadata URL returns 204 with CORS
       * @preconditions Default cors policy; OPTIONS /.well-known/oauth-protected-resource/mcp with loopback Origin
       * @expectedResult 204 with full preflight CORS headers, mirroring the root variant
       */
      test("OPTIONS on path-suffixed metadata URL returns 204 with CORS", async () => {
        const { options } = await startHttpServer([]);
        const res = await options("/.well-known/oauth-protected-resource/mcp", {
          Origin: LOOPBACK_ORIGIN,
        });
        expect(res.statusCode).toBe(204);
        expect(res.headers["access-control-allow-origin"]).toBe(
          LOOPBACK_ORIGIN,
        );
        expect(res.headers["access-control-allow-methods"]).toContain("GET");
      });

      /**
       * @case 404 on a path outside the MCP claims is served by the ingress without CORS headers
       * @preconditions Default cors policy; GET /not/a/real/path with loopback Origin
       * @expectedResult 404 with no Access-Control-Allow-Origin: the path matches no mount claim, so the ingress answers before the MCP handler (and its CORS policy) is ever consulted
       */
      test("404 on unmatched path is served by the ingress without CORS headers", async () => {
        const { get } = await startHttpServer([]);
        const res = await get("/not/a/real/path", { Origin: LOOPBACK_ORIGIN });
        expect(res.statusCode).toBe(404);
        expect(res.headers["access-control-allow-origin"]).toBeUndefined();
      });

      /**
       * @case 404 on unknown path emits no CORS headers when CORS is disabled
       * @preconditions cors: false; GET /not/a/real/path with loopback Origin
       * @expectedResult 404 status with no Access-Control-* headers (proxy is expected to own CORS)
       */
      test("404 on unknown path omits CORS headers when cors: false", async () => {
        const { get } = await startHttpServer([], { cors: false });
        const res = await get("/not/a/real/path", { Origin: LOOPBACK_ORIGIN });
        expect(res.statusCode).toBe(404);
        expect(res.headers["access-control-allow-origin"]).toBeUndefined();
      });

      /**
       * @case Non-loopback Origin is rejected under the default policy
       * @preconditions Default cors policy; request Origin is https://evil.example
       * @expectedResult 403 with no Allow-Origin header
       */
      test("non-loopback origin is rejected by the default policy", async () => {
        const { get } = await startHttpServer([]);
        const res = await get("/.well-known/oauth-protected-resource/mcp", {
          Origin: "https://evil.example",
        });
        expect(res.statusCode).toBe(403);
        expect(res.headers["access-control-allow-origin"]).toBeUndefined();
      });

      /**
       * @case Server-to-server callers (no Origin header) are unaffected by CORS
       * @preconditions Default cors policy; no Origin header on the request
       * @expectedResult Response carries no Access-Control-* headers; caller is not gated by CORS
       */
      test("no Origin header means no CORS headers are emitted", async () => {
        const { get } = await startHttpServer([]);
        const res = await get("/.well-known/oauth-protected-resource/mcp");
        expect(res.statusCode).toBe(200);
        expect(res.headers["access-control-allow-origin"]).toBeUndefined();
      });

      /**
       * @case cors: false disables CORS entirely and does NOT hijack OPTIONS preflight
       * @preconditions cors: false; OPTIONS and GET requests with loopback Origin
       * @expectedResult GET response carries no Access-Control-* headers. OPTIONS preflight is NOT answered with 204 -- the request falls through to the route handler (the framework's contract is that a fronting proxy/CDN owns CORS, so we must let the preflight through rather than swallowing it).
       */
      test("cors: false suppresses CORS headers and defers OPTIONS to the proxy", async () => {
        const { get, options } = await startHttpServer([], { cors: false });
        const getRes = await get("/.well-known/oauth-protected-resource/mcp", {
          Origin: LOOPBACK_ORIGIN,
        });
        expect(getRes.statusCode).toBe(200);
        expect(getRes.headers["access-control-allow-origin"]).toBeUndefined();
        expect(getRes.headers["vary"]).toBeUndefined();

        const optRes = await options("/mcp", { Origin: LOOPBACK_ORIGIN });
        // SDK transport rejects OPTIONS on /mcp with 405; the important
        // contract is that we did NOT synthesize a 204 ourselves.
        expect(optRes.statusCode).not.toBe(204);
        expect(optRes.headers["access-control-allow-origin"]).toBeUndefined();
      });

      /**
       * @case cors: { origin } restricts to the configured allowlist in production
       * @preconditions cors: { origin: "https://app.example.com" }; requests with matching and non-matching Origin
       * @expectedResult Matching Origin is reflected; non-matching Origin gets no Allow-Origin (browser blocks)
       */
      test("cors: { origin: '...' } restricts to the configured origin", async () => {
        const { get } = await startHttpServer([], {
          cors: { origin: "https://app.example.com" },
        });
        const matching = await get(
          "/.well-known/oauth-protected-resource/mcp",
          {
            Origin: "https://app.example.com",
          },
        );
        expect(matching.headers["access-control-allow-origin"]).toBe(
          "https://app.example.com",
        );
        const nonMatching = await get(
          "/.well-known/oauth-protected-resource/mcp",
          {
            Origin: "https://other.example",
          },
        );
        expect(
          nonMatching.headers["access-control-allow-origin"],
        ).toBeUndefined();
      });

      /**
       * @case cors: { origin: '*' } is fully permissive and skips Vary: Origin
       * @preconditions cors: { origin: '*' }; any request Origin
       * @expectedResult Allow-Origin: *; Vary header is NOT set (cache-friendly per CORS spec)
       */
      test("cors: { origin: '*' } reflects wildcard without Vary", async () => {
        const { get } = await startHttpServer([], { cors: { origin: "*" } });
        const res = await get("/.well-known/oauth-protected-resource/mcp", {
          Origin: "https://anywhere.example",
        });
        expect(res.headers["access-control-allow-origin"]).toBe("*");
        expect(res.headers["vary"]).toBeUndefined();
      });

      /**
       * @case Successful POST /mcp from loopback Origin carries CORS headers on the streamed response
       * @preconditions Default cors policy; no auth; valid initialize call from loopback Origin
       * @expectedResult Response is 200 (session established); Allow-Origin echoes Origin (set via setHeader before the SDK responds)
       */
      test("successful POST /mcp carries Access-Control-Allow-Origin", async () => {
        const { post } = await startHttpServer([]);
        const res = await post(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: INIT_PARAMS,
          }),
          { Origin: LOOPBACK_ORIGIN },
        );
        expect(res.statusCode).toBe(200);
        expect(res.headers["access-control-allow-origin"]).toBe(
          LOOPBACK_ORIGIN,
        );
        // Vary: Origin must be present so shared caches do not serve a
        // non-loopback response back to this origin.
        const vary = res.headers["vary"];
        const varyStr = Array.isArray(vary) ? vary.join(", ") : vary;
        expect(varyStr).toContain("Origin");
      });

      /**
       * @case `initialize` mints no session and exposes only WWW-Authenticate
       * @preconditions Default cors policy; loopback Origin; serving is stateless, so no Mcp-Session-Id is emitted on any request
       * @expectedResult No Mcp-Session-Id header, and Access-Control-Expose-Headers lists WWW-Authenticate but neither the removed Mcp-Session-Id nor Last-Event-ID
       */
      test("initialize mints no session and exposes only WWW-Authenticate", async () => {
        const { post } = await startHttpServer([]);
        const res = await post(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: INIT_PARAMS,
          }),
          { Origin: LOOPBACK_ORIGIN },
        );
        expect(res.statusCode).toBe(200);
        expect(res.headers["mcp-session-id"]).toBeUndefined();
        const expose = res.headers["access-control-expose-headers"];
        const exposeStr = Array.isArray(expose) ? expose.join(", ") : expose;
        expect(exposeStr).toBeDefined();
        // Header names are case-insensitive, so the negative assertions match
        // lowercased: a regression re-adding either under a different casing
        // must not slip through.
        const exposeLower = exposeStr!.toLowerCase();
        expect(exposeLower).toContain("www-authenticate");
        expect(exposeLower).not.toContain("mcp-session-id");
        expect(exposeLower).not.toContain("last-event-id");
      });

      /**
       * @case A standalone tools/list carries CORS headers with no prior handshake
       * @preconditions Default cors policy; loopback Origin; tools/list posted as the very first request, with no initialize before it
       * @expectedResult 200 with Access-Control-Allow-Origin -- proving the CORS contract holds on any request in isolation, which is what a stateless endpoint behind a load balancer actually serves
       */
      test("standalone tools/list keeps CORS headers without a handshake", async () => {
        const { post } = await startHttpServer([
          craft()
            .id("two-step-tool")
            .description("Tool for the standalone CORS test")
            .from(mcp())
            .to(noop()),
        ]);
        const res = await post(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/list",
            params: {},
          }),
          { Origin: LOOPBACK_ORIGIN },
        );
        expect(res.statusCode).toBe(200);
        expect(res.headers["access-control-allow-origin"]).toBe(
          LOOPBACK_ORIGIN,
        );
      });

      /**
       * @case POST /mcp from a non-loopback Origin is rejected under the default policy
       * @preconditions Default cors policy; valid initialize call from https://evil.example
       * @expectedResult 403 with no Allow-Origin header
       */
      test("non-loopback POST /mcp gets no Allow-Origin (default policy)", async () => {
        const { post } = await startHttpServer([]);
        const res = await post(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: INIT_PARAMS,
          }),
          { Origin: "https://evil.example" },
        );
        expect(res.statusCode).toBe(403);
        expect(res.headers["access-control-allow-origin"]).toBeUndefined();
      });

      /**
       * @case Authentication is not evaluated for a disallowed Origin
       * @preconditions Auth validator configured; POST without Authorization from https://evil.example
       * @expectedResult Origin validation returns 403 before the auth gate
       */
      test("non-loopback 401 from /mcp gets no Allow-Origin", async () => {
        const { post } = await startHttpServer([], {
          auth: { validator: () => validPrincipal },
        });
        const res = await post(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: INIT_PARAMS,
          }),
          { Origin: "https://evil.example" },
        );
        expect(res.statusCode).toBe(403);
        expect(res.headers["access-control-allow-origin"]).toBeUndefined();
      });
    });

    describe("CORS (OAuth-proxy mode)", () => {
      const LOOPBACK_ORIGIN = "http://localhost:6274";

      async function buildOAuthAuth() {
        const { oauth } = await import("../src/mcp/oauth.ts");
        return oauth({
          issuer: "http://localhost:9999",
          verify: async () => ({
            kind: "oauth" as const,
            scheme: "bearer" as const,
            subject: "u",
            clientId: "u",
            expiresAt: Math.floor(Date.now() / 1000) + 60,
          }),
        });
      }

      /**
       * @case OAuth-proxy mode: OPTIONS preflight on /mcp returns 204 with CORS headers
       * @preconditions oauth() auth with explicit resource.url; loopback Origin
       * @expectedResult 204 with Allow-Origin reflecting Origin (covers the SDK-uncovered /mcp gap)
       */
      test("OPTIONS /mcp returns 204 with CORS headers in OAuth-proxy mode", async () => {
        const auth = await buildOAuthAuth();
        const { options } = await startHttpServer([], {
          auth,
          resource: { url: "http://localhost:9999" },
        });
        const res = await options("/mcp", { Origin: LOOPBACK_ORIGIN });
        expect(res.statusCode).toBe(204);
        expect(res.headers["access-control-allow-origin"]).toBe(
          LOOPBACK_ORIGIN,
        );
      });

      /**
       * @case OAuth-proxy mode: 401 from /mcp carries Access-Control-Allow-Origin and exposes WWW-Authenticate
       * @preconditions oauth() auth; POST /mcp with no Authorization from loopback Origin
       * @expectedResult 401 with CORS headers so browsers can read the WWW-Authenticate hint and follow RFC 9728 discovery
       */
      test("401 from /mcp carries CORS headers in OAuth-proxy mode", async () => {
        const auth = await buildOAuthAuth();
        const { post } = await startHttpServer([], {
          auth,
          resource: { url: "http://localhost:9999" },
        });
        const res = await post(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: INIT_PARAMS,
          }),
          { Origin: LOOPBACK_ORIGIN },
        );
        expect(res.statusCode).toBe(401);
        expect(res.headers["access-control-allow-origin"]).toBe(
          LOOPBACK_ORIGIN,
        );
        const expose = res.headers["access-control-expose-headers"];
        const exposeStr = Array.isArray(expose) ? expose.join(", ") : expose;
        expect(exposeStr).toBeDefined();
        expect(exposeStr!.toLowerCase()).toContain("www-authenticate");
      });

      /**
       * @case OAuth-proxy mode: GET metadata carries CORS headers
       * @preconditions oauth() auth; GET /.well-known/oauth-protected-resource from loopback
       * @expectedResult Allow-Origin reflects the loopback Origin
       */
      test("GET metadata reflects loopback Origin in OAuth-proxy mode", async () => {
        const auth = await buildOAuthAuth();
        const { get } = await startHttpServer([], {
          auth,
          resource: { url: "http://localhost:9999" },
        });
        const res = await get("/.well-known/oauth-protected-resource/mcp", {
          Origin: LOOPBACK_ORIGIN,
        });
        expect(res.statusCode).toBe(200);
        expect(res.headers["access-control-allow-origin"]).toBe(
          LOOPBACK_ORIGIN,
        );
      });

      /**
       * @case OAuth-proxy mode: non-loopback Origin is rejected by the default policy
       * @preconditions oauth() auth; OPTIONS on /mcp with a public Origin
       * @expectedResult 403 with no Allow-Origin header
       */
      test("non-loopback Origin gets no Allow-Origin in OAuth-proxy mode", async () => {
        const auth = await buildOAuthAuth();
        const { options } = await startHttpServer([], {
          auth,
          resource: { url: "http://localhost:9999" },
        });
        const res = await options("/mcp", { Origin: "https://evil.example" });
        expect(res.statusCode).toBe(403);
        expect(res.headers["access-control-allow-origin"]).toBeUndefined();
      });

      /**
       * @case OAuth-proxy mode: the suffixed metadata URL serves the framework document, the bare root is unclaimed
       * @preconditions oauth() auth; GET the bare root and the path-suffixed metadata URL from loopback Origin
       * @expectedResult The suffixed URL returns 200 with `bearer_methods_supported` (proving our handler wins over the SDK's doc); the bare root 404s
       */
      test("OAuth-proxy mode serves framework metadata at the suffixed URL only", async () => {
        const auth = await buildOAuthAuth();
        const { get } = await startHttpServer([], {
          auth,
          resource: { url: "http://localhost:9999/mcp" },
        });
        const rootRes = await get("/.well-known/oauth-protected-resource", {
          Origin: LOOPBACK_ORIGIN,
        });
        const suffRes = await get("/.well-known/oauth-protected-resource/mcp", {
          Origin: LOOPBACK_ORIGIN,
        });
        expect(rootRes.statusCode).toBe(404);
        expect(suffRes.statusCode).toBe(200);
        const doc = JSON.parse(suffRes.body) as {
          bearer_methods_supported?: string[];
        };
        expect(doc.bearer_methods_supported).toEqual(["header"]);
        expect(suffRes.headers["access-control-allow-origin"]).toBe(
          LOOPBACK_ORIGIN,
        );
      });

      /**
       * @case OAuth-proxy mode: with a non-default resource.url pathname, the framework's enriched metadata wins at the SDK-derived URL
       * @preconditions oauth() auth; resource.url = `http://localhost:9999/api/mcp` so the SDK rsPath = `/api/mcp`; GET /.well-known/oauth-protected-resource/api/mcp
       * @expectedResult 200 with `bearer_methods_supported: ["header"]` (our handler, not the SDK's). Regression coverage for the previous hardcoded `/mcp` suffix that would have served at the wrong URL.
       */
      test("OAuth-proxy mode shadows the SDK doc at the non-default rsPath", async () => {
        const auth = await buildOAuthAuth();
        const { get } = await startHttpServer([], {
          auth,
          resource: { url: "http://localhost:9999/api/mcp" },
        });
        const res = await get("/.well-known/oauth-protected-resource/mcp", {
          Origin: LOOPBACK_ORIGIN,
        });
        expect(res.statusCode).toBe(200);
        const doc = JSON.parse(res.body) as {
          bearer_methods_supported?: string[];
          resource: string;
        };
        expect(doc.bearer_methods_supported).toEqual(["header"]);
        expect(doc.resource).toBe("http://localhost:9999/api/mcp");
        expect(res.headers["access-control-allow-origin"]).toBe(
          LOOPBACK_ORIGIN,
        );
      });

      /**
       * @case OAuth-proxy mode: OPTIONS preflight on the path-suffixed metadata URL returns 204 with CORS
       * @preconditions oauth() auth; resource.url with `/mcp` pathname; OPTIONS /.well-known/oauth-protected-resource/mcp with loopback Origin
       * @expectedResult 204 with Allow-Origin reflecting Origin and Allow-Methods including GET, verifying the owned-paths set includes the dynamically-derived suffixed metadata URL
       */
      test("OAuth-proxy OPTIONS on path-suffixed metadata URL returns 204 with CORS", async () => {
        const auth = await buildOAuthAuth();
        const { options } = await startHttpServer([], {
          auth,
          resource: { url: "http://localhost:9999/mcp" },
        });
        const res = await options("/.well-known/oauth-protected-resource/mcp", {
          Origin: LOOPBACK_ORIGIN,
        });
        expect(res.statusCode).toBe(204);
        expect(res.headers["access-control-allow-origin"]).toBe(
          LOOPBACK_ORIGIN,
        );
        expect(res.headers["access-control-allow-methods"]).toContain("GET");
      });

      /**
       * @case OAuth-proxy mode: 404 on unknown path carries CORS headers when CORS is enabled
       * @preconditions oauth() auth + default cors; GET /not/a/real/path with loopback Origin
       * @expectedResult 404 with Allow-Origin set so the browser can read the status
       */
      test("OAuth-proxy 404 on unknown path carries CORS headers", async () => {
        const auth = await buildOAuthAuth();
        const { get } = await startHttpServer([], {
          auth,
          resource: { url: "http://localhost:9999" },
        });
        const res = await get("/not/a/real/path", { Origin: LOOPBACK_ORIGIN });
        expect(res.statusCode).toBe(404);
        expect(res.headers["access-control-allow-origin"]).toBeUndefined();
      });

      /**
       * @case OAuth-proxy mode: 404 on unknown path omits CORS headers when cors: false
       * @preconditions oauth() auth; cors: false; GET /not/a/real/path with loopback Origin
       * @expectedResult 404 status with no Access-Control-* headers. `cors: false` means the CORS middleware is not registered at all in OAuth-proxy mode -- a distinct code path from "applyCorsHeaders is a no-op", worth its own assertion.
       */
      test("OAuth-proxy 404 on unknown path omits CORS headers when cors: false", async () => {
        const auth = await buildOAuthAuth();
        const { get } = await startHttpServer([], {
          auth,
          resource: { url: "http://localhost:9999" },
          cors: false,
        });
        const res = await get("/not/a/real/path", { Origin: LOOPBACK_ORIGIN });
        expect(res.statusCode).toBe(404);
        expect(res.headers["access-control-allow-origin"]).toBeUndefined();
      });
    });

    describe("MCP server identity", () => {
      /**
       * @case title flows into MCP serverInfo.title in the initialize response
       * @preconditions mcpPlugin({ name: "eywa", title: "Eywa MCP" }); client issues `initialize` JSON-RPC
       * @expectedResult result.serverInfo carries name "eywa" and title "Eywa MCP"
       */
      test("serverInfo.title is populated from the title option", async () => {
        const { post } = await startHttpServer([], {
          title: "Eywa MCP",
        });
        const initBody = JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: INIT_PARAMS,
        });
        const res = await post(initBody);
        expect(res.statusCode).toBe(200);
        const parsed = JSON.parse(res.body) as {
          result: { serverInfo: { name: string; title?: string } };
        };
        expect(parsed.result.serverInfo.name).toBe("routecraft");
        expect(parsed.result.serverInfo.title).toBe("Eywa MCP");
      });

      /**
       * @case serverInfo.title is absent when title is unset (no defaulting to name in the protocol)
       * @preconditions mcpPlugin({}) with no title; client issues `initialize`
       * @expectedResult result.serverInfo.title is undefined; only name is populated
       */
      test("serverInfo.title is omitted when title is unset", async () => {
        const { post } = await startHttpServer([]);
        const initBody = JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: INIT_PARAMS,
        });
        const res = await post(initBody);
        expect(res.statusCode).toBe(200);
        const parsed = JSON.parse(res.body) as {
          result: { serverInfo: { name: string; title?: string } };
        };
        expect(parsed.result.serverInfo.title).toBeUndefined();
      });
    });

    describe("plugin-level userinfo (validator mode)", () => {
      /**
       * @case mcpPlugin({ userinfo: fn }) enriches the validator-mode principal
       * @preconditions Validator returns a thin principal; plugin-level userinfo function adds email + roles
       * @expectedResult The route's exchange principal carries the enriched fields, validator fields preserved
       */
      test("function userinfo enriches the principal in validator mode", async () => {
        let capturedPrincipal: Principal | undefined;
        const { post, initHandshake } = await startHttpServer(
          [
            craft()
              .id("userinfo-capture")
              .description("Capture enriched principal for validator userinfo")
              .input({ body: z.object({}) })
              .from(mcp())
              .tap((ex) => {
                capturedPrincipal = ex.principal;
              })
              .to(noop()),
          ],
          {
            auth: {
              validator: () => ({
                kind: "custom" as const,
                scheme: "bearer" as const,
                subject: "user-42",
                expiresAt: Math.floor(Date.now() / 1000) + 3600,
              }),
            },
            userinfo: async (principal) => {
              expect(principal.subject).toBe("user-42");
              return { email: "ada@example.com", roles: ["admin"] };
            },
          },
        );

        await initHandshake({ Authorization: "Bearer t" });
        const callRes = await post(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "userinfo-capture", arguments: {} },
          }),
          { Authorization: "Bearer t" },
        );
        expect(callRes.statusCode).toBe(200);

        expect(capturedPrincipal).toMatchObject({
          subject: "user-42",
          email: "ada@example.com",
          roles: ["admin"],
        });
      });

      /**
       * @case userinfo: true without a validator issuer fails fast at startup
       * @preconditions Plain custom validator (no issuer) + plugin-level userinfo: true
       * @expectedResult server.start() rejects with a TypeError mentioning issuer
       */
      test("userinfo: true without an issuer throws at startup", async () => {
        await expect(
          startHttpServer([], {
            auth: {
              validator: () => ({
                kind: "custom" as const,
                scheme: "bearer" as const,
                subject: "user-42",
                expiresAt: Math.floor(Date.now() / 1000) + 3600,
              }),
            },
            userinfo: true,
          }),
        ).rejects.toThrow(/issuer/i);
      });

      /**
       * @case Userinfo cannot silently disappear when MCP inherits server auth
       * @preconditions Named server has validator auth; MCP omits auth and configures userinfo enrichment
       * @expectedResult Context build fails before binding and names the explicit-auth requirement
       */
      test("inherited auth with userinfo fails fast", async () => {
        await expect(
          testContext()
            .with({
              servers: {
                default: {
                  port: 0,
                  auth: {
                    validator: () => ({
                      kind: "custom" as const,
                      scheme: "bearer" as const,
                      subject: "inherited-user",
                    }),
                  },
                },
              },
              plugins: [
                mcpPlugin({
                  transport: "http",
                  userinfo: async () => ({ email: "ada@example.com" }),
                }),
              ],
            })
            .build(),
        ).rejects.toThrow(/userinfo requires an explicit mcp\.auth validator/i);
      });

      /**
       * @case userinfo absent leaves the validator principal unchanged
       * @preconditions Validator returns a thin principal; no plugin-level userinfo
       * @expectedResult The route's principal has no email / roles beyond what the validator returned
       */
      test("no userinfo leaves the principal unenriched", async () => {
        let capturedPrincipal: Principal | undefined;
        const { post, initHandshake } = await startHttpServer(
          [
            craft()
              .id("noenrich-capture")
              .description("Capture principal with no userinfo")
              .input({ body: z.object({}) })
              .from(mcp())
              .tap((ex) => {
                capturedPrincipal = ex.principal;
              })
              .to(noop()),
          ],
          {
            auth: {
              validator: () => ({
                kind: "custom" as const,
                scheme: "bearer" as const,
                subject: "user-42",
                expiresAt: Math.floor(Date.now() / 1000) + 3600,
              }),
            },
          },
        );

        await initHandshake({ Authorization: "Bearer t" });
        await post(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "noenrich-capture", arguments: {} },
          }),
          { Authorization: "Bearer t" },
        );

        expect(capturedPrincipal?.subject).toBe("user-42");
        expect(capturedPrincipal?.email).toBeUndefined();
        expect(capturedPrincipal?.roles).toBeUndefined();
      });
    });

    describe("oauth auth", () => {
      /**
       * @case oauth() verify returning a fully populated Principal rides as one structured header
       * @preconditions McpServer with oauth() auth; verify returns subject, clientId, email, name, issuer, audience, roles, scopes, expiresAt, claims
       * @expectedResult Route receives a single structured principal at headers["routecraft.auth.principal"] (also exposed via the ex.principal getter); legacy flat routecraft.auth.* keys are no longer set
       */
      test("surfaces full principal as a single structured header", async () => {
        const { oauth } = await import("../src/mcp/oauth.ts");
        let capturedPrincipal: unknown | undefined;
        let capturedHeaders: Record<string, unknown> | undefined;

        const authConfig = oauth({
          issuer: "http://localhost:9999",
          verify: async (token) => {
            expect(token).toBe("rich-token");
            return {
              kind: "oauth" as const,
              scheme: "bearer" as const,
              subject: "user-42",
              clientId: "client-abc",
              name: "Ada Lovelace",
              email: "ada@example.com",
              issuer: "https://idp.example.com",
              audience: ["mcp.example.com"],
              scopes: ["email", "profile"],
              roles: ["admin"],
              expiresAt: Math.floor(Date.now() / 1000) + 3600,
              claims: { sub: "user-42", custom: "value" },
            };
          },
        });

        const { post, initHandshake } = await startHttpServer(
          [
            craft()
              .id("oauth-capture")
              .description("Capture exchange headers for OAuth test")
              .input({ body: z.object({}) })
              .from(mcp())
              .tap((ex) => {
                capturedHeaders = ex.headers as Record<string, unknown>;
                capturedPrincipal = ex.principal;
              })
              .to(noop()),
          ],
          {
            auth: authConfig,
            resource: { url: "http://localhost:9999" },
          },
        );

        await initHandshake({
          Authorization: "Bearer rich-token",
        });
        const callRes = await post(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "oauth-capture", arguments: {} },
          }),
          { Authorization: "Bearer rich-token" },
        );
        expect(callRes.statusCode).toBe(200);

        expect(capturedPrincipal).toMatchObject({
          kind: "oauth",
          scheme: "bearer",
          subject: "user-42",
          clientId: "client-abc",
          name: "Ada Lovelace",
          email: "ada@example.com",
          issuer: "https://idp.example.com",
          audience: ["mcp.example.com"],
          roles: ["admin"],
          scopes: ["email", "profile"],
          claims: { sub: "user-42", custom: "value" },
        });

        // The principal rides on the structured header key; the ex.principal
        // getter is sugar over it. Legacy flat routecraft.auth.* keys are
        // no longer set.
        expect(capturedHeaders?.["routecraft.auth.principal"]).toBe(
          capturedPrincipal,
        );
        expect(capturedHeaders?.["routecraft.auth.subject"]).toBeUndefined();
        expect(capturedHeaders?.["routecraft.auth.client_id"]).toBeUndefined();
        expect(capturedHeaders?.["routecraft.auth.email"]).toBeUndefined();
      });

      /**
       * @case oauth() advertises its Authorization Server and mounts none of its own
       * @preconditions McpServer with oauth({ issuer }) and a fixed resource url; GET the protected-resource metadata and the RFC 8414 authorization-server path
       * @expectedResult The RFC 9728 document names the issuer under authorization_servers so clients discover the real IdP, and the authorization-server path 404s because Routecraft is a Resource Server and mounts no OAuth endpoints of its own
       */
      test("advertises the issuer and mounts no authorization server", async () => {
        const { oauth } = await import("../src/mcp/oauth.ts");
        const authConfig = oauth({
          issuer: "http://localhost:9999",
          verify: async () => ({
            kind: "oauth" as const,
            scheme: "bearer" as const,
            subject: "s",
            clientId: "c",
            scopes: [],
            expiresAt: Math.floor(Date.now() / 1000) + 600,
          }),
        });

        const { get } = await startHttpServer([], {
          auth: authConfig,
          resource: { url: "http://localhost:9999" },
        });

        const metadata = await get("/.well-known/oauth-protected-resource/mcp");
        expect(metadata.statusCode).toBe(200);
        const doc = JSON.parse(metadata.body) as {
          authorization_servers?: string[];
        };
        expect(doc.authorization_servers).toEqual(["http://localhost:9999"]);

        // Routecraft proxies no OAuth endpoints: clients run the flow against
        // the issuer the document above names.
        const as = await get("/.well-known/oauth-authorization-server");
        expect(as.statusCode).toBe(404);
        expect((await get("/authorize")).statusCode).toBe(404);
        expect((await get("/token")).statusCode).toBe(404);
      });

      /**
       * @case Minimal Principal carries only the fields verify returned; absent fields stay undefined on the principal
       * @preconditions McpServer with oauth(); verify returns only required fields (kind, scheme, subject, clientId, scopes)
       * @expectedResult ex.principal has subject, clientId, scheme, scopes set; email/name/issuer/audience are undefined on the structured object
       */
      test("minimal principal omits optional identity fields", async () => {
        const { oauth } = await import("../src/mcp/oauth.ts");
        let capturedPrincipal: Principal | undefined;

        const authConfig = oauth({
          issuer: "http://localhost:9999",
          verify: async () => ({
            kind: "oauth" as const,
            scheme: "bearer" as const,
            subject: "client-only",
            clientId: "client-only",
            scopes: ["read"],
            // expiresAt is required by the MCP SDK's requireBearerAuth middleware.
            expiresAt: Math.floor(Date.now() / 1000) + 600,
          }),
        });

        const { post, initHandshake } = await startHttpServer(
          [
            craft()
              .id("oauth-minimal")
              .description("Minimal OAuth capture")
              .input({ body: z.object({}) })
              .from(mcp())
              .tap((ex) => {
                capturedPrincipal = ex.principal;
              })
              .to(noop()),
          ],
          {
            auth: authConfig,
            resource: { url: "http://localhost:9999" },
          },
        );

        await initHandshake({
          Authorization: "Bearer any",
        });
        const callRes = await post(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "oauth-minimal", arguments: {} },
          }),
          { Authorization: "Bearer any" },
        );
        expect(callRes.statusCode).toBe(200);

        expect(capturedPrincipal).toBeDefined();
        expect(capturedPrincipal?.subject).toBe("client-only");
        expect(capturedPrincipal?.clientId).toBe("client-only");
        expect(capturedPrincipal?.scheme).toBe("bearer");
        expect(capturedPrincipal?.scopes).toEqual(["read"]);
        expect(capturedPrincipal?.email).toBeUndefined();
        expect(capturedPrincipal?.name).toBeUndefined();
        expect(capturedPrincipal?.issuer).toBeUndefined();
        expect(capturedPrincipal?.audience).toBeUndefined();
      });

      /**
       * @case Runtime guard rejects a principal without expiresAt smuggled past the type system
       * @preconditions McpServer with oauth() auth; verify is cast to bypass the OAuthPrincipal
       *                type contract and return a principal without expiresAt (simulating a
       *                dynamically wired plugin or `as any` escape hatch in user code)
       * @expectedResult HTTP 401 response and an auth:rejected event; oauth() wraps the verifier so a principal with no expiry is refused rather than treated as never expiring
       */
      test("rejects principal without expiresAt and emits auth:rejected", async () => {
        const { oauth } = await import("../src/mcp/oauth.ts");

        const rejections: Array<Record<string, unknown>> = [];

        // Deliberately bypass the OAuthPrincipal type constraint to exercise
        // the runtime defense-in-depth guard.
        const unsafeVerify = async () => ({
          kind: "oauth" as const,
          scheme: "bearer" as const,
          subject: "user-no-exp",
          clientId: "client-abc",
          // expiresAt intentionally omitted
        });

        const authConfig = oauth({
          issuer: "http://localhost:9999",
          verify: unsafeVerify as unknown as Parameters<
            typeof oauth
          >[0]["verify"],
        });

        t = await testContext()
          .store(MCP_STORE_KEY, true)
          .with({ servers: { default: { host: "127.0.0.1", port: 0 } } })
          .build();
        server = new McpServer(t.ctx, {
          transport: "http",
          auth: authConfig,
          resource: { url: "http://localhost:9999" },
        });

        t.ctx.on("auth:rejected", (payload) => {
          rejections.push(payload.details as Record<string, unknown>);
        });

        await server.prepare();
        await t.startAndWaitReady();
        await server.start();
        const port = server.getHttpPort()!;

        // Resolve as soon as response headers arrive -- the statusCode is
        // available immediately, and we don't need the body. Destroy the
        // socket right after to close the connection on both sides; otherwise
        // the MCP SSE transport holds the connection open and server.stop()
        // blocks waiting for all connections to drain.
        const res = await new Promise<{ statusCode: number }>(
          (resolve, reject) => {
            let resolved = false;
            const req = http.request(
              {
                host: "127.0.0.1",
                port,
                path: "/mcp",
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Accept: "application/json",
                  Authorization: "Bearer some-token",
                  Connection: "close",
                },
              },
              (r) => {
                resolved = true;
                resolve({ statusCode: r.statusCode ?? 0 });
                r.resume();
                r.socket?.destroy();
              },
            );
            req.on("error", (err) => {
              if (!resolved) reject(err);
            });
            req.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: INIT_PARAMS,
              }),
            );
            req.end();
          },
        );

        expect(res.statusCode).toBeGreaterThanOrEqual(400);
        expect(rejections).toHaveLength(1);
        expect(rejections[0]).toMatchObject({
          // `invalid_token`: the refusal now comes from the verifier wrapper
          // `oauth()` installs, so it classifies like any other rejected token.
          reason: "invalid_token",
          scheme: "bearer",
          source: "mcp",
        });
      });
    });

    describe("principal kinds via validator", () => {
      /**
       * @case Validator returning a JwtPrincipal surfaces JWT-specific claims as headers
       * @preconditions McpServer with validator returning kind: "jwt" with claims, issuer, audience, roles
       * @expectedResult Exchange headers include auth.issuer, auth.audience, auth.roles, auth.email, auth.name
       */
      test("jwt principal carries jwt-specific fields", async () => {
        let capturedPrincipal: Principal | undefined;

        const { post, initHandshake } = await startHttpServer(
          [
            craft()
              .id("jwt-capture")
              .description("Capture JWT principal headers")
              .input({ body: z.object({}) })
              .from(mcp())
              .tap((ex) => {
                capturedPrincipal = ex.principal;
              })
              .to(noop()),
          ],
          {
            auth: {
              validator: () => ({
                kind: "jwt" as const,
                scheme: "bearer" as const,
                subject: "jwt-user",
                name: "JWT User",
                email: "jwt@example.com",
                issuer: "https://idp.example.com",
                audience: ["aud-a", "aud-b"],
                scopes: ["read", "write"],
                roles: ["member"],
                expiresAt: Math.floor(Date.now() / 1000) + 600,
                claims: { sub: "jwt-user" },
              }),
            },
          },
        );

        await initHandshake({
          Authorization: "Bearer jwt",
        });
        const callRes = await post(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "jwt-capture", arguments: {} },
          }),
          { Authorization: "Bearer jwt" },
        );
        expect(callRes.statusCode).toBe(200);

        expect(capturedPrincipal).toBeDefined();
        expect(capturedPrincipal?.kind).toBe("jwt");
        expect(capturedPrincipal?.subject).toBe("jwt-user");
        expect(capturedPrincipal?.name).toBe("JWT User");
        expect(capturedPrincipal?.email).toBe("jwt@example.com");
        expect(capturedPrincipal?.issuer).toBe("https://idp.example.com");
        expect(capturedPrincipal?.audience).toEqual(["aud-a", "aud-b"]);
        expect(capturedPrincipal?.roles).toEqual(["member"]);
        expect(capturedPrincipal?.scopes).toEqual(["read", "write"]);
        // JWT principals have no clientId.
        expect(capturedPrincipal?.clientId).toBeUndefined();
      });

      /**
       * @case Validator returning a custom Principal carries subject and name but no JWT-specific fields
       * @preconditions McpServer with validator returning kind: "custom" with a name
       * @expectedResult ex.principal has subject, scheme, name; email/issuer/audience/scopes/clientId are undefined
       */
      test("custom principal omits jwt-only fields", async () => {
        let capturedPrincipal: Principal | undefined;

        const { post, initHandshake } = await startHttpServer(
          [
            craft()
              .id("apikey-capture")
              .description("Capture API key principal headers")
              .input({ body: z.object({}) })
              .from(mcp())
              .tap((ex) => {
                capturedPrincipal = ex.principal;
              })
              .to(noop()),
          ],
          {
            auth: {
              validator: () => ({
                kind: "custom" as const,
                scheme: "bearer" as const,
                subject: "key-123",
                name: "Deploy key",
              }),
            },
          },
        );

        await initHandshake({
          Authorization: "Bearer key",
        });
        const callRes = await post(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "apikey-capture", arguments: {} },
          }),
          { Authorization: "Bearer key" },
        );
        expect(callRes.statusCode).toBe(200);

        expect(capturedPrincipal).toBeDefined();
        expect(capturedPrincipal?.kind).toBe("custom");
        expect(capturedPrincipal?.subject).toBe("key-123");
        expect(capturedPrincipal?.scheme).toBe("bearer");
        expect(capturedPrincipal?.name).toBe("Deploy key");
        expect(capturedPrincipal?.email).toBeUndefined();
        expect(capturedPrincipal?.issuer).toBeUndefined();
        expect(capturedPrincipal?.audience).toBeUndefined();
        expect(capturedPrincipal?.scopes).toBeUndefined();
        expect(capturedPrincipal?.clientId).toBeUndefined();
      });

      describe("rejection log levels (oauth mode)", () => {
        const initBody = JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: INIT_PARAMS,
        });
        const oauthIssuer = "http://localhost:9999";

        /**
         * @case An expired token on the OAuth verifier path returns 401 and logs at debug
         * @preconditions McpServer with oauth() whose verify throws jose's ERR_JWT_EXPIRED; POST /mcp with a bearer token
         * @expectedResult 401 with WWW-Authenticate invalid_token; debug logged as "Auth rejected: token expired"; no "token validation failed" warn
         */
        test("returns 401 and logs an expired oauth token at debug", async () => {
          const { oauth } = await import("../src/mcp/oauth.ts");
          const expiredError = Object.assign(
            new Error('"exp" claim timestamp check failed'),
            { code: "ERR_JWT_EXPIRED" },
          );
          const { post } = await startHttpServer([], {
            auth: oauth({
              issuer: oauthIssuer,
              verify: async () => {
                throw expiredError;
              },
            }),
            resource: { url: "http://localhost:9999" },
          });

          const res = await post(initBody, {
            Authorization: "Bearer expired-token",
          });
          // A token-validation failure is surfaced as InvalidTokenError so the
          // SDK answers 401 invalid_token (the client refreshes), not 500.
          expect(res.statusCode).toBe(401);
          expect(res.headers["www-authenticate"]).toMatch(
            /error="invalid_token"/,
          );

          const expiredMsg = "Auth rejected: token expired";
          const debugCall = t.logger.debug.mock.calls.find(
            (c) => c[1] === expiredMsg,
          );
          expect(debugCall).toBeDefined();
          expect(debugCall?.[0]).toMatchObject({
            reason: "expired",
          });
          expect(
            t.logger.warn.mock.calls.some(
              (c) => c[1] === "Auth rejected: token validation failed",
            ),
          ).toBe(false);
        });

        /**
         * @case A genuinely invalid token on the OAuth verifier path returns 401 and logs at warn
         * @preconditions McpServer with oauth() whose verify throws a generic Error; POST /mcp with a bearer token
         * @expectedResult 401 with WWW-Authenticate invalid_token; warn logged as "token validation failed"; no "token expired" debug
         */
        test("returns 401 and logs a genuinely invalid oauth token at warn", async () => {
          const { oauth } = await import("../src/mcp/oauth.ts");
          const { post } = await startHttpServer([], {
            auth: oauth({
              issuer: oauthIssuer,
              verify: async () => {
                throw new Error("invalid signature");
              },
            }),
            resource: { url: "http://localhost:9999" },
          });

          const res = await post(initBody, {
            Authorization: "Bearer bad-token",
          });
          expect(res.statusCode).toBe(401);
          expect(res.headers["www-authenticate"]).toMatch(
            /error="invalid_token"/,
          );

          const failedMsg = "Auth rejected: token validation failed";
          const warnCall = t.logger.warn.mock.calls.find(
            (c) => c[1] === failedMsg,
          );
          expect(warnCall).toBeDefined();
          expect(warnCall?.[0]).toMatchObject({
            reason: "invalid_token",
          });
          expect(
            t.logger.debug.mock.calls.some(
              (c) => c[1] === "Auth rejected: token expired",
            ),
          ).toBe(false);
        });

        /**
         * @case A framework infrastructure error on the OAuth verifier path stays a 500
         * @preconditions McpServer with oauth() whose verify throws a RoutecraftError (e.g. RC5021 userinfo fetch failure); POST /mcp with a bearer token
         * @expectedResult 500 (server-side failure, not invalid_token); warn logged; auth:rejected emitted
         */
        test("returns 500 for a framework infrastructure error", async () => {
          const { oauth } = await import("../src/mcp/oauth.ts");
          const rejections: Array<Record<string, unknown>> = [];
          const { post } = await startHttpServer([], {
            auth: oauth({
              issuer: oauthIssuer,
              verify: async () => {
                throw rcError(
                  "RC5021",
                  new Error("userinfo endpoint unreachable"),
                );
              },
            }),
            resource: { url: "http://localhost:9999" },
          });
          t.ctx.on("auth:rejected", (payload) => {
            rejections.push(payload.details as Record<string, unknown>);
          });

          const res = await post(initBody, {
            Authorization: "Bearer some-token",
          });
          // A server-side failure must not be reported to the client as an
          // invalid token; it stays a 500 so the client retries rather than
          // discarding a token that may be valid.
          expect(res.statusCode).toBe(500);
          expect(res.headers["www-authenticate"]).toBeUndefined();
          expect(
            t.logger.warn.mock.calls.some(
              (c) => c[1] === "Auth rejected: token validation failed",
            ),
          ).toBe(true);
          expect(rejections.length).toBeGreaterThanOrEqual(1);
          expect(rejections[0]?.["reason"]).toBe("infrastructure");
        });

        /**
         * @case A JWKS infrastructure failure on the OAuth verifier path returns 500, not 401
         * @preconditions McpServer with oauth() whose verify throws a jose error with code ERR_JWKS_TIMEOUT; POST /mcp with a bearer token
         * @expectedResult 500 with no WWW-Authenticate; the client must retry, not treat its token as invalid
         */
        test("returns 500 for a jose JWKS infrastructure failure", async () => {
          const { oauth } = await import("../src/mcp/oauth.ts");
          const jwksTimeout = Object.assign(new Error("request timed out"), {
            code: "ERR_JWKS_TIMEOUT",
          });
          const { post } = await startHttpServer([], {
            auth: oauth({
              issuer: oauthIssuer,
              verify: async () => {
                throw jwksTimeout;
              },
            }),
            resource: { url: "http://localhost:9999" },
          });

          const res = await post(initBody, {
            Authorization: "Bearer some-token",
          });
          expect(res.statusCode).toBe(500);
          expect(res.headers["www-authenticate"]).toBeUndefined();
        });
      });
    });
  });

  describe("plugin events", () => {
    /**
     * @case tools:exposed event is emitted with tool names and count
     * @preconditions McpServer with one mcp() route; request tools/list
     * @expectedResult Event emitted with tools array and count
     */
    test("emits plugin:mcp:server:tools:exposed on first tools list", async () => {
      t = await testContext()
        .routes([
          craft().id("exposed-evt").description("test").from(mcp()).to(noop()),
        ])
        .store(MCP_STORE_KEY, true)
        .with({ servers: { default: { host: "127.0.0.1", port: 0 } } })
        .build();
      server = new McpServer(t.ctx, {
        transport: "http",
      });

      const exposed: Array<Record<string, unknown>> = [];
      t.ctx.on("plugin:mcp:server:tools:exposed", (payload) => {
        exposed.push(payload.details as Record<string, unknown>);
      });

      const total = t.ctx.getRoutes().length;
      const routesReady = new Promise<void>((resolve, reject) => {
        let ready = 0;
        const timeout = setTimeout(() => reject(new Error("Timeout")), 3000);
        t.ctx.on("route:started", () => {
          ready++;
          if (ready >= total) {
            clearTimeout(timeout);
            resolve();
          }
        });
      });
      await server.prepare();
      await t.startAndWaitReady();
      await routesReady;
      await server.start();

      // tools:exposed fires on start or first tools/list
      expect(exposed).toHaveLength(1);
      expect(exposed[0]).toMatchObject({
        tools: ["exposed-evt"],
        count: 1,
      });
    });

    /**
     * @case tool:called, tool:completed events emitted on successful tool call
     * @preconditions McpServer with HTTP transport; call a tool via JSON-RPC
     * @expectedResult called event with tool name and args, completed event with tool name
     */
    test("emits tool:called and tool:completed on success", async () => {
      t = await testContext()
        .routes([
          craft()
            .id("call-evt")
            .description("test")
            .input({ body: z.object({ x: z.number().optional() }) })
            .from(mcp())
            .to(noop()),
        ])
        .store(MCP_STORE_KEY, true)
        .with({ servers: { default: { host: "127.0.0.1", port: 0 } } })
        .build();
      server = new McpServer(t.ctx, {
        transport: "http",
      });

      const called: Array<Record<string, unknown>> = [];
      const completed: Array<Record<string, unknown>> = [];
      t.ctx.on("plugin:mcp:tool:called", (payload) => {
        called.push(payload.details as Record<string, unknown>);
      });
      t.ctx.on("plugin:mcp:tool:completed", (payload) => {
        completed.push(payload.details as Record<string, unknown>);
      });

      const total = t.ctx.getRoutes().length;
      const routesReady = new Promise<void>((resolve, reject) => {
        let ready = 0;
        const timeout = setTimeout(() => reject(new Error("Timeout")), 3000);
        t.ctx.on("route:started", () => {
          ready++;
          if (ready >= total) {
            clearTimeout(timeout);
            resolve();
          }
        });
      });
      await server.prepare();
      await t.startAndWaitReady();
      await routesReady;
      await server.start();
      const port = server.getHttpPort()!;

      // Legacy-era initialize handshake; the server answers it statelessly
      await new Promise<{
        statusCode: number;
        headers: Record<string, string | string[] | undefined>;
      }>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: "/mcp",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
            },
          },
          (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () =>
              resolve({
                statusCode: res.statusCode ?? 0,
                headers: res.headers,
              }),
            );
          },
        );
        req.on("error", reject);
        req.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: INIT_PARAMS,
          }),
        );
        req.end();
      });

      // Call the tool
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: "/mcp",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
            },
          },
          (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => resolve());
          },
        );
        req.on("error", reject);
        req.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "call-evt", arguments: { x: 42 } },
          }),
        );
        req.end();
      });

      expect(called).toHaveLength(1);
      expect(called[0]).toMatchObject({ tool: "call-evt", args: { x: 42 } });

      expect(completed).toHaveLength(1);
      expect(completed[0]).toMatchObject({ tool: "call-evt" });
    });

    /**
     * @case tool:failed event emitted when tool call errors
     * @preconditions McpServer with HTTP transport; call a non-existent tool
     * @expectedResult failed event with tool name and error message
     */
    test("emits tool:failed when tool not found", async () => {
      t = await testContext()
        .routes([
          craft().id("exists-evt").description("test").from(mcp()).to(noop()),
        ])
        .store(MCP_STORE_KEY, true)
        .with({ servers: { default: { host: "127.0.0.1", port: 0 } } })
        .build();
      server = new McpServer(t.ctx, {
        transport: "http",
      });

      const failed: Array<Record<string, unknown>> = [];
      t.ctx.on("plugin:mcp:tool:failed", (payload) => {
        failed.push(payload.details as Record<string, unknown>);
      });

      const total = t.ctx.getRoutes().length;
      const routesReady = new Promise<void>((resolve, reject) => {
        let ready = 0;
        const timeout = setTimeout(() => reject(new Error("Timeout")), 3000);
        t.ctx.on("route:started", () => {
          ready++;
          if (ready >= total) {
            clearTimeout(timeout);
            resolve();
          }
        });
      });
      await server.prepare();
      await t.startAndWaitReady();
      await routesReady;
      await server.start();
      const port = server.getHttpPort()!;

      // Legacy-era initialize handshake; the server answers it statelessly
      await new Promise<{
        headers: Record<string, string | string[] | undefined>;
      }>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: "/mcp",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
            },
          },
          (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => resolve({ headers: res.headers }));
          },
        );
        req.on("error", reject);
        req.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: INIT_PARAMS,
          }),
        );
        req.end();
      });

      // Call a tool that does not exist
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: "/mcp",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
            },
          },
          (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => resolve());
          },
        );
        req.on("error", reject);
        req.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "no-such-tool", arguments: {} },
          }),
        );
        req.end();
      });

      expect(failed).toHaveLength(1);
      expect(failed[0]!["tool"]).toBe("no-such-tool");
      expect(failed[0]!["error"]).toBeTypeOf("string");
    });

    /**
     * @case Wildcard plugin:mcp:tool:** catches all tool events
     * @preconditions McpServer with HTTP transport; subscribe with globstar pattern
     * @expectedResult Both called and completed events captured by single wildcard handler
     */
    test("exact plugin:mcp:tool:* names capture all tool events", async () => {
      t = await testContext()
        .routes([
          craft()
            .id("wc-tool")
            .description("test")
            .input({ body: z.object({}) })
            .from(mcp())
            .to(noop()),
        ])
        .store(MCP_STORE_KEY, true)
        .with({ servers: { default: { host: "127.0.0.1", port: 0 } } })
        .build();
      server = new McpServer(t.ctx, {
        transport: "http",
      });

      const allToolEvents: string[] = [];
      for (const name of [
        "plugin:mcp:tool:called",
        "plugin:mcp:tool:completed",
        "plugin:mcp:tool:failed",
      ] as const) {
        t.ctx.on(name, (payload) => {
          const d = payload.details as { tool?: string };
          allToolEvents.push(d.tool ?? "unknown");
        });
      }

      const total = t.ctx.getRoutes().length;
      const routesReady = new Promise<void>((resolve, reject) => {
        let ready = 0;
        const timeout = setTimeout(() => reject(new Error("Timeout")), 3000);
        t.ctx.on("route:started", () => {
          ready++;
          if (ready >= total) {
            clearTimeout(timeout);
            resolve();
          }
        });
      });
      await server.prepare();
      await t.startAndWaitReady();
      await routesReady;
      await server.start();
      const port = server.getHttpPort()!;

      // Legacy-era initialize handshake; the server answers it statelessly
      await new Promise<{
        headers: Record<string, string | string[] | undefined>;
      }>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: "/mcp",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
            },
          },
          (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => resolve({ headers: res.headers }));
          },
        );
        req.on("error", reject);
        req.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: INIT_PARAMS,
          }),
        );
        req.end();
      });

      // Call the tool
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: "/mcp",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
            },
          },
          (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => resolve());
          },
        );
        req.on("error", reject);
        req.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "wc-tool", arguments: {} },
          }),
        );
        req.end();
      });

      // Should capture both called and completed
      expect(allToolEvents.length).toBeGreaterThanOrEqual(2);
      expect(allToolEvents.filter((t) => t === "wc-tool")).toHaveLength(2);
    });

    /**
     * @case auth:success event emitted with principal details on valid auth
     * @preconditions McpServer with auth validator; send request with valid token
     * @expectedResult Event emitted with subject, scheme, and source
     */
    test("emits auth:success on valid token", async () => {
      t = await testContext()
        .store(MCP_STORE_KEY, true)
        .with({ servers: { default: { host: "127.0.0.1", port: 0 } } })
        .build();
      server = new McpServer(t.ctx, {
        transport: "http",
        auth: {
          validator: (token) => {
            if (token !== "good") throw new Error("invalid token");
            return {
              kind: "custom" as const,
              subject: "user-1",
              scheme: "bearer" as const,
            };
          },
        },
      });

      const successes: Array<Record<string, unknown>> = [];
      t.ctx.on("auth:success", (payload) => {
        successes.push(payload.details as Record<string, unknown>);
      });

      await server.prepare();
      await t.startAndWaitReady();
      await server.start();
      const port = server.getHttpPort()!;

      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: "/mcp",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              Authorization: "Bearer good",
            },
          },
          (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => resolve());
          },
        );
        req.on("error", reject);
        req.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: INIT_PARAMS,
          }),
        );
        req.end();
      });

      expect(successes).toHaveLength(1);
      expect(successes[0]).toMatchObject({
        subject: "user-1",
        scheme: "bearer",
        source: "mcp",
      });
    });

    /**
     * @case auth:rejected event emitted with reason on invalid token
     * @preconditions McpServer with auth validator; send request with bad token
     * @expectedResult Event emitted with reason and source
     */
    test("emits auth:rejected on invalid token", async () => {
      t = await testContext()
        .store(MCP_STORE_KEY, true)
        .with({ servers: { default: { host: "127.0.0.1", port: 0 } } })
        .build();
      server = new McpServer(t.ctx, {
        transport: "http",
        auth: {
          validator: () => {
            throw new Error("invalid token");
          },
        },
      });

      const rejections: Array<Record<string, unknown>> = [];
      t.ctx.on("auth:rejected", (payload) => {
        rejections.push(payload.details as Record<string, unknown>);
      });

      await server.prepare();
      await t.startAndWaitReady();
      await server.start();
      const port = server.getHttpPort()!;

      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: "/mcp",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              Authorization: "Bearer bad",
            },
          },
          (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => resolve());
          },
        );
        req.on("error", reject);
        req.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: INIT_PARAMS,
          }),
        );
        req.end();
      });

      expect(rejections).toHaveLength(1);
      expect(rejections[0]).toMatchObject({
        reason: "invalid_token",
        scheme: "bearer",
        source: "mcp",
      });
    });

    /**
     * @case A validator error message containing the bearer never leaks into auth:rejected
     * @preconditions McpServer with a custom auth validator that throws an Error embedding the raw token in its message; request sent with a bearer token
     * @expectedResult auth:rejected payload reason is the bounded literal "invalid_token"; the token does not appear anywhere in the payload
     */
    test("does not leak the bearer from a validator error message into auth:rejected", async () => {
      const token = "super-secret-bearer-token";
      t = await testContext()
        .store(MCP_STORE_KEY, true)
        .with({ servers: { default: { host: "127.0.0.1", port: 0 } } })
        .build();
      server = new McpServer(t.ctx, {
        transport: "http",
        auth: {
          validator: (tok: string) => {
            throw new Error(`token ${tok} rejected`);
          },
        },
      });

      const rejections: Array<Record<string, unknown>> = [];
      t.ctx.on("auth:rejected", (payload) => {
        rejections.push(payload.details as Record<string, unknown>);
      });

      await server.prepare();
      await t.startAndWaitReady();
      await server.start();
      const port = server.getHttpPort()!;

      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: "/mcp",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              Authorization: `Bearer ${token}`,
            },
          },
          (res) => {
            res.on("data", () => {});
            res.on("end", () => resolve());
          },
        );
        req.on("error", reject);
        req.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: INIT_PARAMS,
          }),
        );
        req.end();
      });

      expect(rejections).toHaveLength(1);
      expect(rejections[0]).toMatchObject({
        reason: "invalid_token",
        scheme: "bearer",
        source: "mcp",
      });
      expect(JSON.stringify(rejections[0])).not.toContain(token);
    });
  });

  describe("advertised output enforcement", () => {
    /** Shape of the tool result the server hands back to a client. */
    type ToolResult = {
      content: Array<{ type: string; text: string }>;
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
    };

    /** Call a tool the way the SDK does, bypassing the JSON-RPC transport. */
    async function callTool(
      srv: McpServer,
      tool: string,
      args: Record<string, unknown>,
    ): Promise<ToolResult> {
      return (await (
        srv as unknown as {
          handleToolCall(
            tool: string,
            args: Record<string, unknown>,
            principal: undefined,
          ): Promise<ToolResult>;
        }
      ).handleToolCall(tool, args, undefined)) as ToolResult;
    }

    /**
     * Serve one tool straight from the local registry, with a handler that
     * returns `body` without a route behind it. Isolates the MCP boundary
     * from the route pipeline's own `.output()` validation.
     */
    async function serveUnvalidated(body: unknown): Promise<McpServer> {
      const srv = await serve();
      t.ctx.setStore(
        MCP_LOCAL_TOOL_REGISTRY,
        new Map([
          [
            "unchecked",
            {
              endpoint: "unchecked",
              description: "Returns a body nobody validated",
              output: { body: z.object({ total: z.number() }) },
              handler: async (exchange) =>
                DefaultExchange.rewrap(exchange, { body }),
            } satisfies McpLocalToolEntry,
          ],
        ]),
      );
      return srv;
    }

    /**
     * @case An unvalidated result is published as the schema's output, not as the value handed in
     * @preconditions Local registry entry whose declared output transforms a string into a Date, with a handler returning the untransformed string and no route to validate it
     * @expectedResult The published body carries the transformed value, so a client parsing structuredContent against the advertised schema sees what it was promised rather than the input shape
     */
    test("publishes the validated value when the boundary does the validating", async () => {
      t = await testContext().store(MCP_STORE_KEY, true).build();
      await t.startAndWaitReady();
      t.ctx.setStore(
        MCP_LOCAL_TOOL_REGISTRY,
        new Map([
          [
            "unchecked",
            {
              endpoint: "unchecked",
              description: "Returns a body nobody validated",
              output: {
                body: z.object({
                  at: z.string().transform((s) => new Date(s)),
                }),
              },
              handler: async (exchange) =>
                DefaultExchange.rewrap(exchange, {
                  body: { at: "2026-01-01T00:00:00.000Z" },
                }),
            } satisfies McpLocalToolEntry,
          ],
        ]),
      );
      server = new McpServer(t.ctx);

      const result = await callTool(server, "unchecked", {});

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual({
        at: new Date("2026-01-01T00:00:00.000Z"),
      });
    });

    /**
     * @case A tool result that does not satisfy the advertised outputSchema is refused at the MCP boundary
     * @preconditions Local registry entry declaring an output body schema, whose handler resolves with a body that violates it without a route (so no route-level output validation runs)
     * @expectedResult isError true and the validation message names the failing field, so the server never publishes a body contradicting what tools/list advertised
     */
    test("refuses a body the advertised schema rejects", async () => {
      const srv = await serveUnvalidated({ total: "lots" });

      const result = await callTool(srv, "unchecked", {});

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain(
        'MCP tool "unchecked" returned a body that does not match its declared output schema',
      );
      expect(result.content[0]!.text).toContain("total");
      expect(result.structuredContent).toBeUndefined();
    });

    /**
     * @case A dropped exchange is declined rather than answered, on a tool that declares an output
     * @preconditions Route declares .output() and drops the exchange in a filter, so the request body resolves untouched
     * @expectedResult isError true saying the tool declined the request, not a schema violation, and no structuredContent or echoed request body
     */
    test("declines a dropped call on a tool with a declared output", async () => {
      const srv = await serve([
        craft()
          .id("dropper")
          .description("Drops the exchange instead of completing it")
          .output({ body: z.object({ total: z.number() }) })
          .from<{ value: string }>(mcp())
          .filter(() => false)
          .transform(() => ({ total: 1 })),
      ]);

      const result = await callTool(srv, "dropper", { value: "hi" });

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain(
        'MCP tool "dropper" declined the request and produced no result',
      );
      expect(result.content[0]!.text).not.toContain("output schema");
      expect(result.content[0]!.text).not.toContain("hi");
      expect(result.structuredContent).toBeUndefined();
    });

    /**
     * @case A dropped exchange is declined rather than answered, on a tool with no declared output
     * @preconditions Route declares no .output() and drops the exchange in a filter
     * @expectedResult isError true saying the tool declined the request, so an undeclared tool is guarded the same way rather than echoing the request back as its result
     */
    test("declines a dropped call on a tool without a declared output", async () => {
      const srv = await serve([
        craft()
          .id("silent-dropper")
          .description("Drops the exchange and declares no output schema")
          .from<{ value: string }>(mcp())
          .filter(() => false)
          .transform(() => ({ anything: true })),
      ]);

      const result = await callTool(srv, "silent-dropper", { value: "hi" });

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain(
        'MCP tool "silent-dropper" declined the request and produced no result',
      );
      expect(result.content[0]!.text).not.toContain("hi");
      expect(result.structuredContent).toBeUndefined();
    });

    /**
     * @case A decline is reported as declined, not as a failure
     * @preconditions Listeners on plugin:mcp:tool:declined, :failed and :completed; route drops the exchange in a filter; spy logger captures levels
     * @expectedResult The declined event fires with the tool name and reason, neither failed nor completed fires, and nothing is logged at error level, so an error-rate alert does not fire on a tool that filters as a matter of course
     */
    test("emits tool:declined rather than tool:failed on a drop", async () => {
      const srv = await serve([
        craft()
          .id("filtering-tool")
          .description("Declines every call by design")
          .from<{ value: string }>(mcp())
          .filter(() => false),
      ]);

      const declined: Array<Record<string, unknown>> = [];
      const failed: Array<Record<string, unknown>> = [];
      const completed: Array<Record<string, unknown>> = [];
      t.ctx.on("plugin:mcp:tool:declined", (payload) => {
        declined.push(payload.details as Record<string, unknown>);
      });
      t.ctx.on("plugin:mcp:tool:failed", (payload) => {
        failed.push(payload.details as Record<string, unknown>);
      });
      t.ctx.on("plugin:mcp:tool:completed", (payload) => {
        completed.push(payload.details as Record<string, unknown>);
      });

      const result = await callTool(srv, "filtering-tool", { value: "hi" });

      expect(result.isError).toBe(true);
      expect(declined).toHaveLength(1);
      expect(declined[0]).toMatchObject({ tool: "filtering-tool" });
      expect(String(declined[0]!["reason"])).toContain("declined the request");
      expect(failed).toHaveLength(0);
      expect(completed).toHaveLength(0);
      expect(t.logger.error.mock.calls).toHaveLength(0);
    });

    /**
     * @case A route whose output schema transforms is published, not rejected
     * @preconditions Route declares .output() with a schema whose output type differs from its input type (string transformed to Date), and returns a body the schema accepts
     * @expectedResult No error; the transformed value is published. The route's own validation replaced the body with the schema's output, and re-running the schema over that output at the boundary would reject the value the route just produced
     */
    test("publishes a result whose output schema transforms the value", async () => {
      const srv = await serve([
        craft()
          .id("transforming")
          .description("Output schema transforms a string into a Date")
          .output({
            body: z.object({ at: z.string().transform((s) => new Date(s)) }),
          })
          .from<{ at: string }>(mcp())
          .transform((body) => ({ at: body.at })),
      ]);

      const result = await callTool(srv, "transforming", {
        at: "2026-01-01T00:00:00.000Z",
      });

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual({
        at: new Date("2026-01-01T00:00:00.000Z"),
      });
    });

    /**
     * @case A run that parks at a .suspend() answers with its acknowledgment, not a schema violation
     * @preconditions Route declares .output() and reaches .suspend() before producing that output, with an in-memory suspension store
     * @expectedResult No error; the Suspended acknowledgment is published. The pipeline deliberately skips output validation for a parked run, so the boundary must not enforce the declared output against an acknowledgment that was never meant to satisfy it
     */
    test("publishes the acknowledgment when the route suspends", async () => {
      t = await testContext()
        .with(suspending())
        .store(MCP_STORE_KEY, true)
        .routes([
          craft()
            .id("approve-payout")
            .description("Parks for approval before paying out")
            .output({ body: z.object({ paid: z.boolean() }) })
            .from<{ amount: number }>(mcp())
            .suspend({ expect: z.object({ approved: z.boolean() }) })
            .transform(() => ({ paid: true })),
        ])
        .build();
      await t.startAndWaitReady();
      server = new McpServer(t.ctx);

      const result = await callTool(server, "approve-payout", { amount: 100 });

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({ status: "suspended" });
    });

    /**
     * @case A conforming result is published unchanged
     * @preconditions Route declares .output() with a defaulted field and returns a body the schema accepts
     * @expectedResult No error; structuredContent carries the route's body with the default applied exactly once
     */
    test("publishes a conforming result unchanged", async () => {
      const srv = await serve([
        craft()
          .id("conforming")
          .description("Returns a body its output schema accepts")
          .output({
            body: z.object({
              value: z.string(),
              seen: z.number().default(1),
            }),
          })
          .from<{ value: string }>(mcp())
          .transform((body) => ({ value: body.value })),
      ]);

      const result = await callTool(srv, "conforming", { value: "hi" });

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual({ value: "hi", seen: 1 });
    });

    /**
     * @case A tool whose route declares no output is not checked
     * @preconditions Route without .output() completes with a body no schema describes
     * @expectedResult The body passes through with no error, because no outputSchema was advertised for a client to trust
     */
    test("leaves a tool without a declared output unchecked", async () => {
      const srv = await serve([
        craft()
          .id("undeclared")
          .description("Declares no output schema")
          .from<{ value: string }>(mcp())
          .transform(() => ({ anything: true })),
      ]);

      const result = await callTool(srv, "undeclared", { value: "hi" });

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0]!.text)).toEqual({ anything: true });
    });

    /**
     * @case An output-schema violation is reported as a failed tool call
     * @preconditions Listeners on plugin:mcp:tool:completed and plugin:mcp:tool:failed; tool served straight from the registry returns a body its declared schema rejects
     * @expectedResult The failed event fires carrying the tool name and the violation, and no completed event is emitted
     */
    test("emits tool:failed and no tool:completed on a violation", async () => {
      const srv = await serveUnvalidated({ total: "lots" });

      const failed: Array<Record<string, unknown>> = [];
      const completed: Array<Record<string, unknown>> = [];
      t.ctx.on("plugin:mcp:tool:failed", (payload) => {
        failed.push(payload.details as Record<string, unknown>);
      });
      t.ctx.on("plugin:mcp:tool:completed", (payload) => {
        completed.push(payload.details as Record<string, unknown>);
      });

      const result = await callTool(srv, "unchecked", {});

      expect(result.isError).toBe(true);
      expect(completed).toHaveLength(0);
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ tool: "unchecked" });
      expect(String(failed[0]!["error"])).toContain("output schema");
      expect(t.logger.error.mock.calls.length).toBeGreaterThan(0);
    });

    /**
     * @case A route that completes with a body its own .output() rejects still surfaces as a failed tool call
     * @preconditions Route declares .output() and transforms to a body the schema rejects, so the route pipeline's output validation fails the exchange before the MCP boundary sees it
     * @expectedResult isError true carrying the field-level validation message, so enforcement holds on the completed path as well
     */
    test("surfaces a route-level output violation as isError", async () => {
      const srv = await serve([
        craft()
          .id("violator")
          .description("Returns a body its output schema rejects")
          .output({ body: z.object({ total: z.number() }) })
          .from<{ value: string }>(mcp())
          .transform(() => ({ total: "lots" })),
      ]);

      const result = await callTool(srv, "violator", { value: "hi" });

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("total");
      expect(result.structuredContent).toBeUndefined();
    });
  });

  describe("buildAuthHeaders", () => {
    /**
     * @case Returns undefined when auth is undefined
     * @preconditions No auth options provided
     * @expectedResult undefined (no headers needed)
     */
    test("returns undefined when auth is undefined", async () => {
      expect(await buildAuthHeaders(undefined)).toBeUndefined();
    });

    /**
     * @case Returns undefined when auth has no token or headers
     * @preconditions Empty auth options object
     * @expectedResult undefined (no headers needed)
     */
    test("returns undefined when auth has no token or headers", async () => {
      expect(await buildAuthHeaders({})).toBeUndefined();
    });

    /**
     * @case Builds Authorization header from token
     * @preconditions auth.token is "my-token"
     * @expectedResult Headers with Authorization: Bearer my-token
     */
    test("builds Authorization header from token", async () => {
      const result = await buildAuthHeaders({ token: "my-token" });
      expect(result).toEqual({ Authorization: "Bearer my-token" });
    });

    /**
     * @case Passes through custom headers
     * @preconditions auth.headers has X-Custom: "value"
     * @expectedResult Headers with X-Custom: "value"
     */
    test("passes through custom headers", async () => {
      const result = await buildAuthHeaders({
        headers: { "X-Custom": "value" },
      });
      expect(result).toEqual({ "X-Custom": "value" });
    });

    /**
     * @case Custom headers override token when Authorization is set
     * @preconditions auth.token = "from-token" and auth.headers.Authorization = "Basic abc"
     * @expectedResult Authorization is "Basic abc" (headers override token)
     */
    test("custom Authorization header overrides token", async () => {
      const result = await buildAuthHeaders({
        token: "from-token",
        headers: { Authorization: "Basic abc" },
      });
      expect(result).toEqual({ Authorization: "Basic abc" });
    });

    /**
     * @case Lowercase authorization header overrides token case-insensitively
     * @preconditions auth.token = "from-token" and auth.headers.authorization = "Basic abc"
     * @expectedResult Single canonical Authorization header with "Basic abc"
     */
    test("lowercase authorization header overrides token case-insensitively", async () => {
      const result = await buildAuthHeaders({
        token: "from-token",
        headers: { authorization: "Basic abc" },
      });
      expect(result).toEqual({ Authorization: "Basic abc" });
    });

    /**
     * @case Throws on empty token string
     * @preconditions auth.token = ""
     * @expectedResult Error thrown about non-empty string
     */
    test("throws when token is an empty string", async () => {
      await expect(buildAuthHeaders({ token: "" })).rejects.toThrow(
        /non-empty string/,
      );
    });

    /**
     * @case Resolves token from a string array using round-robin
     * @preconditions auth.token is ["token-a", "token-b"]
     * @expectedResult First call uses token-a, second uses token-b, third wraps to token-a
     */
    test("resolves token from array with round-robin", async () => {
      const tokens = ["token-a", "token-b"];
      const r1 = await buildAuthHeaders({ token: tokens });
      expect(r1).toEqual({ Authorization: "Bearer token-a" });
      const r2 = await buildAuthHeaders({ token: tokens });
      expect(r2).toEqual({ Authorization: "Bearer token-b" });
      const r3 = await buildAuthHeaders({ token: tokens });
      expect(r3).toEqual({ Authorization: "Bearer token-a" });
    });

    /**
     * @case Throws on empty token array
     * @preconditions auth.token is []
     * @expectedResult Error thrown about empty array
     */
    test("throws when token is an empty array", async () => {
      await expect(buildAuthHeaders({ token: [] })).rejects.toThrow(
        /must not be empty/,
      );
    });

    /**
     * @case Resolves token from a synchronous provider function
     * @preconditions auth.token is () => "dynamic-token"
     * @expectedResult Headers with Authorization: Bearer dynamic-token
     */
    test("resolves token from sync provider function", async () => {
      const result = await buildAuthHeaders({ token: () => "dynamic-token" });
      expect(result).toEqual({ Authorization: "Bearer dynamic-token" });
    });

    /**
     * @case Resolves token from an async provider function
     * @preconditions auth.token is async () => "async-token"
     * @expectedResult Headers with Authorization: Bearer async-token
     */
    test("resolves token from async provider function", async () => {
      const result = await buildAuthHeaders({
        token: async () => "async-token",
      });
      expect(result).toEqual({ Authorization: "Bearer async-token" });
    });

    /**
     * @case Throws when provider function returns empty string
     * @preconditions auth.token is () => ""
     * @expectedResult Error thrown about non-empty string
     */
    test("throws when provider function returns empty string", async () => {
      await expect(buildAuthHeaders({ token: () => "" })).rejects.toThrow(
        /non-empty string/,
      );
    });
  });
});
