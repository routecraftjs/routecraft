import type { CraftContext, DirectRouteMetadata } from "@routecraft/routecraft";
import {
  ADAPTER_DIRECT_REGISTRY,
  ADAPTER_DIRECT_STORE,
  DefaultExchange,
  isRoutecraftError,
} from "@routecraft/routecraft";
import { timingSafeEqual as cryptoTimingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { McpHttpAuthOptions, McpPluginOptions } from "./types.ts";

/**
 * Constant-time string comparison to prevent timing attacks on token comparison.
 * Returns false immediately if lengths differ because crypto.timingSafeEqual
 * requires equal-length buffers. This leaks token length but not content,
 * which is an acceptable tradeoff for bearer tokens.
 */
function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return cryptoTimingSafeEqual(bufA, bufB);
}

const MCP_SDK_INSTALL =
  'MCP server requires "@modelcontextprotocol/sdk". Install it with: pnpm add @modelcontextprotocol/sdk';

/** Resolved options with defaults applied (internal use). */
type McpServerResolvedOptions = Required<
  Pick<McpPluginOptions, "name" | "version" | "transport" | "port" | "host">
> &
  Pick<McpPluginOptions, "tools" | "auth">;

/**
 * McpServer wraps the MCP SDK and bridges it to Routecraft's DirectChannel infrastructure.
 * It reads the MCP route registry lazily (on first tools/list request) to ensure routes have subscribed.
 *
 * Note: Uses dynamic imports to avoid TypeScript compatibility issues with the MCP SDK.
 * Supports both stdio and streamable-http transports.
 *
 * @experimental
 */
export class McpServer {
  private context: CraftContext;
  private options: McpServerResolvedOptions;
  private server: unknown = null;
  private transport: unknown = null;
  /** Node HTTP server when transport is http; used to listen on port and close on stop. */
  private httpServer: ReturnType<typeof createServer> | null = null;
  private running = false;
  private toolsListLogged = false;

  constructor(context: CraftContext, options: McpPluginOptions = {}) {
    this.context = context;
    this.options = {
      name: "routecraft",
      version: "1.0.0",
      transport: "stdio",
      port: 3001,
      host: "localhost",
      ...options,
    };
  }

  /**
   * Start the MCP server and listen for connections
   */
  async start(): Promise<void> {
    if (this.running) {
      this.context.logger.warn({}, "MCP server already running");
      return;
    }

    try {
      const transport = this.options.transport;

      if (transport === "http") {
        await this.startHttp();
      } else {
        await this.startStdio();
      }

      this.running = true;
      this.context.logger.info(
        {
          name: this.options.name,
          version: this.options.version,
          transport,
        },
        "MCP server started",
      );
      this.logExposedToolsOnce();
    } catch (error) {
      const msg = isRoutecraftError(error)
        ? (error as unknown as { meta: { message: string } }).meta.message
        : error instanceof Error
          ? error.message
          : "Failed to start MCP server";
      this.context.logger.error({ err: error }, msg);
      throw error;
    }
  }

  /**
   * Start stdio transport
   */
  private async startStdio(): Promise<void> {
    let Server: new (
      info: { name: string; version: string },
      options: { capabilities: { tools: Record<string, unknown> } },
    ) => unknown;
    let StdioServerTransport: new () => unknown;
    try {
      const serverMod =
        await import("@modelcontextprotocol/sdk/server/index.js");
      Server = serverMod.Server;
      const stdioMod =
        await import("@modelcontextprotocol/sdk/server/stdio.js");
      StdioServerTransport = stdioMod.StdioServerTransport;
    } catch {
      throw new Error(MCP_SDK_INSTALL);
    }

    this.server = new Server(
      {
        name: this.options.name,
        version: this.options.version,
      },
      { capabilities: { tools: {} } },
    );

    await this.setupRequestHandlers();

    this.transport = new StdioServerTransport();
    const srvWithConnect = this.server as Record<
      string,
      (transport: unknown) => Promise<void>
    >;
    await srvWithConnect["connect"](this.transport);
  }

  /**
   * Start HTTP transport (streamable-http).
   * The SDK transport does not create or listen on a port; we create a Node HTTP server
   * and call transport.handleRequest(req, res) for each request to /mcp.
   */
  private async startHttp(): Promise<void> {
    let Server: new (
      info: { name: string; version: string },
      options: { capabilities: { tools: Record<string, unknown> } },
    ) => unknown;
    try {
      const serverModule =
        await import("@modelcontextprotocol/sdk/server/index.js");
      Server = serverModule.Server;
    } catch {
      throw new Error(MCP_SDK_INSTALL);
    }

    const streamableModule =
      await import("@modelcontextprotocol/sdk/server/streamableHttp.js").catch(
        () => null,
      );
    const TransportClass = (
      streamableModule as Record<string, unknown> | null
    )?.["StreamableHTTPServerTransport"] as new (options?: {
      sessionIdGenerator?: () => string;
    }) => unknown;

    if (!TransportClass) {
      throw new Error(
        "StreamableHTTPServerTransport not found in MCP SDK - ensure @modelcontextprotocol/sdk v1.26.0+ is installed",
      );
    }

    this.server = new Server(
      {
        name: this.options.name,
        version: this.options.version,
      },
      { capabilities: { tools: {} } },
    );

    await this.setupRequestHandlers();

    const port = this.options.port;
    const host = this.options.host;

    // Transport options: sessionIdGenerator and enableJsonResponse (no port/host – we create the server below).
    // enableJsonResponse: true so we return plain JSON per request instead of SSE (simpler for clients).
    this.transport = new TransportClass({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
    } as { sessionIdGenerator?: () => string; enableJsonResponse?: boolean });

    const srvWithConnect = this.server as Record<
      string,
      (transport: unknown) => Promise<void>
    >;
    await srvWithConnect["connect"](this.transport);

    const handleRequest = (
      this.transport as Record<
        string,
        (req: unknown, res: unknown, parsedBody?: unknown) => Promise<void>
      >
    )["handleRequest"];
    if (typeof handleRequest !== "function") {
      throw new Error(
        "StreamableHTTPServerTransport.handleRequest not found - SDK may have changed",
      );
    }

    this.httpServer = createServer(async (req, res) => {
      const url = req.url?.split("?")[0] ?? "";
      if (url !== "/mcp" && url !== "/mcp/") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not Found", path: url }));
        return;
      }
      if (this.options.auth && !(await this.validateAuth(req))) {
        res.writeHead(401, {
          "Content-Type": "application/json",
          "WWW-Authenticate": 'Bearer realm="mcp"',
        });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      try {
        await handleRequest.call(this.transport, req, res);
      } catch (err) {
        const msg = isRoutecraftError(err)
          ? (err as unknown as { meta: { message: string } }).meta.message
          : err instanceof Error
            ? err.message
            : "MCP HTTP request error";
        this.context.logger.error({ err }, msg);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal Server Error" }));
        }
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.listen(port, host, () => resolve());
      this.httpServer!.on("error", (err) => {
        const msg = isRoutecraftError(err)
          ? (err as unknown as { meta: { message: string } }).meta.message
          : err instanceof Error
            ? err.message
            : "MCP HTTP server listen failed";
        this.context.logger.error({ err }, msg);
        reject(err);
      });
    });

    const boundPort = this.getHttpPort() ?? port;
    this.context.logger.info(
      { host, port: boundPort, path: "/mcp" },
      "MCP HTTP server listening",
    );
  }

  /**
   * When transport is http, returns the bound port (useful when port 0 was used). Otherwise undefined.
   */
  getHttpPort(): number | undefined {
    const addr = this.httpServer?.address();
    if (addr && typeof addr === "object" && "port" in addr) {
      return (addr as { port: number }).port;
    }
    return undefined;
  }

  /**
   * Validate the Authorization header against configured tokens or a validator function.
   * Uses timing-safe comparison for static tokens to prevent timing attacks.
   * Returns true if auth passes; false if the request should be rejected.
   */
  private async validateAuth(req: IncomingMessage): Promise<boolean> {
    const authOptions = this.options.auth as McpHttpAuthOptions | undefined;
    if (!authOptions) return true;

    const rawHeader = req.headers["authorization"];
    if (!rawHeader || Array.isArray(rawHeader)) return false;

    const schemeMatch = /^bearer\s+(.+)$/i.exec(rawHeader);
    if (!schemeMatch) return false;
    const token = schemeMatch[1];

    // Validator function: delegate entirely to the caller.
    if (typeof authOptions.tokens === "function") {
      return authOptions.tokens(token);
    }

    const allowed = Array.isArray(authOptions.tokens)
      ? authOptions.tokens
      : [authOptions.tokens];

    // Iterate all tokens without short-circuiting to avoid leaking which slot matched.
    let found = false;
    for (const t of allowed) {
      if (timingSafeStringEqual(t, token)) found = true;
    }
    return found;
  }

  /**
   * Set up request handlers (shared by both transports).
   * Uses SDK request schemas so setRequestHandler receives a proper schema (method literal).
   */
  private async setupRequestHandlers(): Promise<void> {
    let typesModule: Record<string, unknown>;
    try {
      typesModule =
        (await import("@modelcontextprotocol/sdk/types.js")) as Record<
          string,
          unknown
        >;
    } catch {
      throw new Error(MCP_SDK_INSTALL);
    }
    const t = typesModule;
    const ListToolsRequestSchema = t["ListToolsRequestSchema"];
    const CallToolRequestSchema = t["CallToolRequestSchema"];

    if (!ListToolsRequestSchema || !CallToolRequestSchema) {
      throw new Error(
        "MCP SDK types missing ListToolsRequestSchema or CallToolRequestSchema - ensure @modelcontextprotocol/sdk is installed",
      );
    }

    const srv = this.server as Record<
      string,
      (schema: unknown, handler: (request: unknown) => Promise<unknown>) => void
    >;

    srv["setRequestHandler"](ListToolsRequestSchema, async () => {
      const tools = this.getAvailableTools();
      this.logExposedToolsOnce();
      return { tools };
    });

    srv["setRequestHandler"](
      CallToolRequestSchema,
      async (request: unknown) => {
        const req = request as Record<string, unknown>;
        const params = req["params"] as Record<string, unknown>;
        return await this.handleToolCall(
          (params["name"] as string) || "",
          (params["arguments"] as Record<string, unknown>) || {},
        );
      },
    );
  }

  /**
   * Stop the MCP server
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    try {
      if (this.httpServer) {
        await new Promise<void>((resolve) => {
          this.httpServer!.close(() => resolve());
        });
        this.httpServer = null;
      }
      if (this.transport) {
        const tr = this.transport as Record<string, () => Promise<void>>;
        if (typeof tr["close"] === "function") {
          await tr["close"]();
        }
      }
      this.running = false;
      this.context.logger.info({}, "MCP server stopped");
    } catch (error) {
      const msg = isRoutecraftError(error)
        ? (error as unknown as { meta: { message: string } }).meta.message
        : error instanceof Error
          ? error.message
          : "Error stopping MCP server";
      this.context.logger.error({ err: error }, msg);
    }
  }

  /**
   * Log exposed MCP tool names once (at start or on first tools/list).
   */
  private logExposedToolsOnce(): void {
    if (this.toolsListLogged) return;
    const tools = this.getAvailableTools();
    if (tools.length === 0) return;
    const names = tools.map((t) => (t["name"] as string) ?? "?");
    this.context.logger.info(
      { tools: names, count: names.length },
      "Exposing MCP tools",
    );
    this.toolsListLogged = true;
  }

  /**
   * Get list of tools that should be exposed via MCP.
   * Reads the registry lazily - called on every tools/list request and for tests.
   */
  getAvailableTools(): Array<Record<string, unknown>> {
    const registry = this.context.getStore(ADAPTER_DIRECT_REGISTRY) as
      | Map<string, DirectRouteMetadata>
      | undefined;

    if (!registry) {
      return [];
    }

    // Get all mcp() routes (those with description)
    let tools = Array.from(registry.values()).filter(
      (t) => t.description !== undefined,
    );

    // Apply user filter if provided
    const toolsFilter = this.options.tools;
    if (toolsFilter) {
      if (Array.isArray(toolsFilter)) {
        const allowed = new Set(toolsFilter);
        tools = tools.filter((t) => allowed.has(t.endpoint));
      } else if (typeof toolsFilter === "function") {
        tools = tools.filter(toolsFilter);
      }
    }

    // Convert to MCP tool format
    return tools.map((meta) => this.metadataToMcpTool(meta));
  }

  /**
   * Convert Routecraft mcp() route metadata to MCP tool format
   */
  private metadataToMcpTool(
    metadata: DirectRouteMetadata,
  ): Record<string, unknown> {
    return {
      name: metadata.endpoint,
      description: metadata.description || "",
      inputSchema: this.schemaToJsonSchema(metadata.schema),
    };
  }

  /**
   * Convert to JSON Schema using Standard JSON Schema (schema['~standard'].jsonSchema.input)
   * when available; otherwise return a generic object schema.
   * Works with any spec-compliant library (Zod 4.2+, ArkType, Valibot via toStandardJsonSchema).
   */
  private schemaToJsonSchema(schema: unknown): Record<string, unknown> {
    if (!schema || typeof schema !== "object") {
      return { type: "object" };
    }

    const standard = (schema as Record<string, unknown>)["~standard"] as
      | {
          jsonSchema?: {
            input?: (opts: { target: string }) => Record<string, unknown>;
          };
        }
      | undefined;
    if (standard?.jsonSchema?.input) {
      try {
        const out = standard.jsonSchema.input({
          target: "draft-2020-12",
        });
        return typeof out === "object" && out !== null
          ? out
          : { type: "object" };
      } catch (error) {
        this.context.logger.debug(
          error,
          "Standard JSON Schema conversion failed",
        );
        return { type: "object" };
      }
    }

    if ("~standard" in schema) {
      return { type: "object", additionalProperties: true };
    }
    return { type: "object" };
  }

  /**
   * Handle a tool call from MCP client
   */
  private async handleToolCall(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    try {
      // Get the direct channel store
      const channelStore = this.context.getStore(ADAPTER_DIRECT_STORE) as
        | Map<string, Record<string, unknown>>
        | undefined;

      if (!channelStore) {
        const err = new Error("No direct channels available");
        this.context.emit("error", { error: err });
        return {
          content: [
            { type: "text", text: `Error: No direct channels available` },
          ],
        };
      }

      // Get the channel for this tool endpoint
      const channel = channelStore.get(toolName);
      if (!channel) {
        const err = new Error(`Tool not found: ${toolName}`);
        this.context.emit("error", { error: err });
        return {
          content: [
            { type: "text", text: `Error: Tool not found: ${toolName}` },
          ],
        };
      }

      // Ensure body is an object when client sends JSON (SDK may pass parsed object or raw string)
      const body =
        typeof args === "string"
          ? (() => {
              try {
                return (JSON.parse(args) as Record<string, unknown>) || {};
              } catch {
                return { input: args };
              }
            })()
          : args && typeof args === "object"
            ? args
            : {};

      this.context.logger.debug(
        { bodyType: typeof body, body },
        "MCP tool call exchange body",
      );

      // Create an exchange with the tool arguments
      const exchange = new DefaultExchange(this.context, {
        body,
        headers: {
          "routecraft.mcp.tool": toolName,
          "routecraft.mcp.session": `mcp-${Date.now()}`,
        },
      });

      // Send the exchange through the direct channel
      const channelTyped = channel as Record<
        string,
        (name: string, ex: unknown) => Promise<unknown>
      >;
      const resultExchange = (await channelTyped["send"](
        toolName,
        exchange,
      )) as Record<string, unknown>;

      // Convert result to MCP format
      const resultText =
        typeof resultExchange["body"] === "string"
          ? (resultExchange["body"] as string)
          : JSON.stringify(resultExchange["body"]);

      return {
        content: [{ type: "text", text: resultText }],
      };
    } catch (error) {
      const msg = isRoutecraftError(error)
        ? (error as unknown as { meta: { message: string } }).meta.message
        : error instanceof Error
          ? error.message
          : String(error);
      this.context.logger.error({ tool: toolName, err: error }, msg);
      this.context.emit("error", { error });
      return {
        content: [{ type: "text", text: `Error: ${msg}` }],
      };
    }
  }
}
