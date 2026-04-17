import type { CraftContext, DirectRouteMetadata } from "@routecraft/routecraft";
import {
  ADAPTER_DIRECT_REGISTRY,
  ADAPTER_DIRECT_STORE,
  DefaultExchange,
  isRoutecraftError,
} from "@routecraft/routecraft";
import { AsyncLocalStorage } from "node:async_hooks";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { McpHeadersKeys, isOAuthAuth } from "./types.ts";
import type {
  AuthPrincipal,
  McpOAuthAuthOptions,
  McpPluginOptions,
  McpTool,
  McpToolAnnotations,
  McpValidatorAuthOptions,
} from "./types.ts";

/**
 * Request-scoped storage for the authenticated principal.
 * Set in the HTTP request handler after auth validation;
 * read in handleToolCall to populate exchange headers.
 */
const principalStore = new AsyncLocalStorage<AuthPrincipal | undefined>();

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
  /**
   * Node HTTP server when transport is http; used to listen on port and close on stop.
   * When OAuth is enabled this holds the Express app's underlying server.
   */
  private httpServer: ReturnType<typeof createServer> | null = null;
  /** Active HTTP sessions keyed by session ID (each session has its own server+transport pair). */
  private httpSessions = new Map<
    string,
    { server: unknown; transport: unknown }
  >();
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
   * Dispatches to the OAuth or raw-HTTP path depending on the auth config.
   */
  private async startHttp(): Promise<void> {
    if (this.options.auth && isOAuthAuth(this.options.auth)) {
      await this.startHttpWithOAuth(this.options.auth);
    } else {
      await this.startHttpWithValidator();
    }
  }

  /**
   * Import the MCP SDK Server constructor and StreamableHTTPServerTransport.
   * Shared by both HTTP startup paths.
   */
  private async importSdkHttp(): Promise<{
    ServerCtor: new (
      info: { name: string; version: string },
      options: { capabilities: { tools: Record<string, unknown> } },
    ) => unknown;
    TransportClass: new (options?: {
      sessionIdGenerator?: () => string;
      onsessioninitialized?: (sessionId: string) => void;
      enableJsonResponse?: boolean;
    }) => unknown;
  }> {
    let ServerCtor: new (
      info: { name: string; version: string },
      options: { capabilities: { tools: Record<string, unknown> } },
    ) => unknown;
    try {
      const serverModule =
        await import("@modelcontextprotocol/sdk/server/index.js");
      ServerCtor = serverModule.Server;
    } catch {
      throw new Error(MCP_SDK_INSTALL);
    }

    const streamableModule =
      await import("@modelcontextprotocol/sdk/server/streamableHttp.js").catch(
        () => null,
      );
    const TransportClass = (
      streamableModule as Record<string, unknown> | null
    )?.["StreamableHTTPServerTransport"] as
      | (new (options?: {
          sessionIdGenerator?: () => string;
          onsessioninitialized?: (sessionId: string) => void;
          enableJsonResponse?: boolean;
        }) => unknown)
      | undefined;

    if (!TransportClass) {
      throw new Error(
        "StreamableHTTPServerTransport not found in MCP SDK - ensure @modelcontextprotocol/sdk v1.26.0+ is installed",
      );
    }

    return { ServerCtor, TransportClass };
  }

  /**
   * Creates a new MCP Server + Transport pair for a single HTTP session.
   * Called on every initialization request (no session ID header).
   */
  private async createSession(
    ServerCtor: new (
      info: { name: string; version: string },
      options: { capabilities: { tools: Record<string, unknown> } },
    ) => unknown,
    TransportClass: new (options?: {
      sessionIdGenerator?: () => string;
      onsessioninitialized?: (sessionId: string) => void;
      enableJsonResponse?: boolean;
    }) => unknown,
  ): Promise<{
    transport: unknown;
    handleRequest: (
      req: unknown,
      res: unknown,
      parsedBody?: unknown,
    ) => Promise<void>;
  }> {
    const server = new ServerCtor(
      { name: this.options.name, version: this.options.version },
      { capabilities: { tools: {} } },
    );

    await this.setupRequestHandlersOn(server);

    const transport = new TransportClass({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sessionId: string) => {
        this.httpSessions.set(sessionId, { server, transport });
        this.context.logger.debug({ sessionId }, "MCP session created");
        this.context.emit("plugin:mcp:session:created", { sessionId });
      },
      enableJsonResponse: true,
    });

    const srvWithConnect = server as Record<
      string,
      (t: unknown) => Promise<void>
    >;
    await srvWithConnect["connect"](transport);

    // Clean up on transport close so the session map does not leak.
    const tr = transport as Record<string, unknown>;
    const prevOnClose = tr["onclose"] as (() => void) | undefined;
    tr["onclose"] = () => {
      const sid = (transport as { sessionId?: string }).sessionId;
      if (sid) {
        this.httpSessions.delete(sid);
        this.context.logger.debug({ sessionId: sid }, "MCP session closed");
        this.context.emit("plugin:mcp:session:closed", {
          sessionId: sid,
        });
      }
      prevOnClose?.();
    };

    const handleRequest = (
      transport as Record<
        string,
        (req: unknown, res: unknown, parsedBody?: unknown) => Promise<void>
      >
    )["handleRequest"];
    if (typeof handleRequest !== "function") {
      throw new Error(
        "StreamableHTTPServerTransport.handleRequest not found - SDK may have changed",
      );
    }

    return {
      transport,
      handleRequest: handleRequest.bind(transport) as (
        req: unknown,
        res: unknown,
        parsedBody?: unknown,
      ) => Promise<void>,
    };
  }

  /**
   * Route an MCP request through session management with principal context.
   * Shared by both HTTP startup paths.
   */
  private async handleMcpRequest(
    req: IncomingMessage,
    res: import("node:http").ServerResponse,
    principal: AuthPrincipal | undefined,
    createSessionFn: () => Promise<{
      handleRequest: (
        req: unknown,
        res: unknown,
        parsedBody?: unknown,
      ) => Promise<void>;
    }>,
  ): Promise<void> {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const runWithPrincipal = <T>(fn: () => Promise<T>): Promise<T> =>
      principalStore.run(principal, fn);

    try {
      if (sessionId && this.httpSessions.has(sessionId)) {
        const session = this.httpSessions.get(sessionId)!;
        const hr = (
          session.transport as Record<
            string,
            (req: unknown, res: unknown, parsedBody?: unknown) => Promise<void>
          >
        )["handleRequest"];
        await runWithPrincipal(() => hr.call(session.transport, req, res));
      } else if (!sessionId || req.method === "POST") {
        const { handleRequest } = await createSessionFn();
        await runWithPrincipal(() => handleRequest(req, res));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
      }
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
  }

  /**
   * Start HTTP transport with validator-based auth (existing behavior).
   * Uses raw Node.js `http.createServer`.
   */
  private async startHttpWithValidator(): Promise<void> {
    const { ServerCtor, TransportClass } = await this.importSdkHttp();
    const port = this.options.port;
    const host = this.options.host;

    const createSessionFn = () =>
      this.createSession(ServerCtor, TransportClass);

    this.httpServer = createServer(async (req, res) => {
      const url = req.url?.split("?")[0] ?? "";
      if (url !== "/mcp" && url !== "/mcp/") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not Found", path: url }));
        return;
      }

      let principal: AuthPrincipal | undefined;
      if (this.options.auth) {
        const result = await this.validateAuth(req);
        if (!result) {
          res.writeHead(401, {
            "Content-Type": "application/json",
            "WWW-Authenticate": 'Bearer realm="mcp"',
          });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }
        principal = result;
      }

      await this.handleMcpRequest(req, res, principal, createSessionFn);
    });

    await this.listenHttp(port, host);
  }

  /**
   * Start HTTP transport with OAuth provider auth.
   * Uses Express to mount `mcpAuthRouter` (OAuth endpoints) alongside `/mcp`.
   * Express is available as a transitive dependency of `@modelcontextprotocol/sdk`.
   *
   * Note: if the server runs behind a reverse proxy, `req.ip` and `req.protocol`
   * may be incorrect. Users should set `trust proxy` on the Express app via a
   * future configuration option or by using a custom HTTP server.
   */
  private async startHttpWithOAuth(
    oauthOptions: McpOAuthAuthOptions,
  ): Promise<void> {
    const { ServerCtor, TransportClass } = await this.importSdkHttp();

    // Dynamic imports for Express and SDK OAuth infrastructure.
    // Express types are not available at compile time (transitive dep of SDK),
    // so all Express values are typed as unknown and accessed dynamically.
    let expressFn: (...args: unknown[]) => {
      use: (...args: unknown[]) => void;
      all: (...args: unknown[]) => void;
      listen: (
        port: number,
        host: string,
        cb: () => void,
      ) => ReturnType<typeof createServer>;
    };
    let mcpAuthRouter: (options: Record<string, unknown>) => unknown;
    let requireBearerAuth: (options: Record<string, unknown>) => unknown;
    let ProxyOAuthServerProvider: new (
      options: Record<string, unknown>,
    ) => unknown;

    try {
      // @ts-expect-error -- Express is a transitive dep of @modelcontextprotocol/sdk; no type declarations in this project
      const expressMod = (await import("express")) as Record<string, unknown>;
      expressFn = (expressMod["default"] ?? expressMod) as typeof expressFn;
    } catch {
      throw new Error(
        'OAuth auth requires "express". It should be installed as a dependency of @modelcontextprotocol/sdk.',
      );
    }

    try {
      const routerMod =
        await import("@modelcontextprotocol/sdk/server/auth/router.js");
      mcpAuthRouter = (routerMod as Record<string, unknown>)[
        "mcpAuthRouter"
      ] as typeof mcpAuthRouter;

      const bearerMod =
        await import("@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js");
      requireBearerAuth = (bearerMod as Record<string, unknown>)[
        "requireBearerAuth"
      ] as typeof requireBearerAuth;

      const proxyMod =
        await import("@modelcontextprotocol/sdk/server/auth/providers/proxyProvider.js");
      ProxyOAuthServerProvider = (proxyMod as Record<string, unknown>)[
        "ProxyOAuthServerProvider"
      ] as typeof ProxyOAuthServerProvider;
    } catch {
      throw new Error(
        "OAuth auth requires @modelcontextprotocol/sdk v1.27.0+ with OAuth support. " +
          "Install it with: pnpm add @modelcontextprotocol/sdk",
      );
    }

    // Build the ProxyOAuthServerProvider from the user's config.
    const provider = new ProxyOAuthServerProvider({
      endpoints: {
        authorizationUrl: oauthOptions.endpoints.authorizationUrl,
        tokenUrl: oauthOptions.endpoints.tokenUrl,
        revocationUrl: oauthOptions.endpoints.revocationUrl,
        registrationUrl: oauthOptions.endpoints.registrationUrl,
      },
      verifyAccessToken: oauthOptions.verifyAccessToken,
      getClient: oauthOptions.getClient,
    });

    const port = this.options.port;
    const host = this.options.host;

    const app = expressFn();

    // Mount OAuth endpoints at root (discovery, authorize, token, revoke).
    const authRouterOptions: Record<string, unknown> = {
      provider,
      issuerUrl: new URL(oauthOptions.issuerUrl.toString()),
    };
    if (oauthOptions.baseUrl) {
      authRouterOptions["baseUrl"] = new URL(oauthOptions.baseUrl.toString());
    }
    if (oauthOptions.scopesSupported) {
      authRouterOptions["scopesSupported"] = oauthOptions.scopesSupported;
    }
    if (oauthOptions.serviceDocumentationUrl) {
      authRouterOptions["serviceDocumentationUrl"] = new URL(
        oauthOptions.serviceDocumentationUrl.toString(),
      );
    }
    if (oauthOptions.resourceName) {
      authRouterOptions["resourceName"] = oauthOptions.resourceName;
    }
    app.use(mcpAuthRouter(authRouterOptions));

    // Bearer auth middleware for /mcp.
    const bearerOptions: Record<string, unknown> = { verifier: provider };
    if (oauthOptions.requiredScopes) {
      bearerOptions["requiredScopes"] = oauthOptions.requiredScopes;
    }
    app.use("/mcp", requireBearerAuth(bearerOptions));

    const createSessionFn = () =>
      this.createSession(ServerCtor, TransportClass);

    // MCP transport handler at /mcp.
    app.all("/mcp", async (req: unknown, res: unknown) => {
      const nodeReq = req as IncomingMessage;
      const nodeRes = res as import("node:http").ServerResponse;

      // The SDK's requireBearerAuth sets req.auth with the verified AuthInfo.
      const authInfo = (req as Record<string, unknown>)["auth"] as
        | {
            clientId: string;
            scopes: string[];
            token: string;
            expiresAt?: number;
          }
        | undefined;
      const principal = this.authInfoToPrincipal(authInfo);

      if (principal) {
        const successDetail = {
          subject: principal.subject,
          scheme: principal.scheme,
          source: "mcp",
        };
        this.context.logger.info(successDetail, "Auth succeeded");
        this.context.emit("auth:success", successDetail);
      }

      await this.handleMcpRequest(nodeReq, nodeRes, principal, createSessionFn);
    });

    // Wrap the Express app in a raw HTTP server so listenHttp can bind it.
    // Express apps are callable as (req, res) request handlers.
    this.httpServer = createServer(
      app as unknown as (
        req: import("node:http").IncomingMessage,
        res: import("node:http").ServerResponse,
      ) => void,
    );
    await this.listenHttp(port, host);
  }

  /**
   * Bind the HTTP server to the configured port and host.
   * Used by the validator path.
   */
  private async listenHttp(port: number, host: string): Promise<void> {
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
    const listenDetail = { host, port: boundPort, path: "/mcp" };
    this.context.logger.info(listenDetail, "MCP HTTP server listening");
    this.context.emit("plugin:mcp:server:listening", listenDetail);
  }

  /**
   * Convert the MCP SDK's AuthInfo (set by requireBearerAuth) to an AuthPrincipal
   * for routecraft's exchange headers.
   */
  private authInfoToPrincipal(
    authInfo:
      | {
          clientId: string;
          scopes: string[];
          token: string;
          expiresAt?: number;
        }
      | undefined,
  ): AuthPrincipal | undefined {
    if (!authInfo) return undefined;
    const principal: AuthPrincipal = {
      subject: authInfo.clientId,
      scheme: "bearer",
      scopes: authInfo.scopes,
      claims: {
        clientId: authInfo.clientId,
      },
    };
    if (authInfo.expiresAt !== undefined) {
      principal.expiresAt = authInfo.expiresAt;
    }
    return principal;
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
   * Validate the Authorization header using the configured validator.
   * Only used on the validator auth path (not OAuth -- that uses Express middleware).
   * Returns the authenticated principal on success, or `null` to reject with 401.
   */
  private async validateAuth(
    req: IncomingMessage,
  ): Promise<AuthPrincipal | null> {
    const authOptions = this.options.auth as
      | McpValidatorAuthOptions
      | undefined;
    if (!authOptions || !("validator" in authOptions)) return null;

    const rawHeader = req.headers["authorization"];
    if (!rawHeader || Array.isArray(rawHeader)) {
      const detail = {
        reason: "missing_header",
        scheme: "bearer",
        source: "mcp",
      };
      this.context.logger.warn(
        detail,
        "Auth rejected: missing or malformed Authorization header",
      );
      this.context.emit("auth:rejected", detail);
      return null;
    }

    const schemeMatch = /^bearer\s+(.+)$/i.exec(rawHeader);
    if (!schemeMatch) {
      const detail = {
        reason: "unsupported_scheme",
        scheme: "bearer",
        source: "mcp",
      };
      this.context.logger.warn(
        detail,
        "Auth rejected: unsupported authorization scheme",
      );
      this.context.emit("auth:rejected", detail);
      return null;
    }
    const token = schemeMatch[1];

    // Delegate to the validator. It must return an AuthPrincipal on success
    // or null/false to reject. Throws propagate as 500.
    const result = await authOptions.validator(token);
    if (!result) {
      const detail = {
        reason: "invalid_token",
        scheme: "bearer",
        source: "mcp",
      };
      this.context.logger.warn(
        detail,
        "Auth rejected: token validation failed",
      );
      this.context.emit("auth:rejected", detail);
      return null;
    }

    const successDetail = {
      subject: result.subject,
      scheme: result.scheme,
      source: "mcp",
    };
    this.context.logger.info(successDetail, "Auth succeeded");
    this.context.emit("auth:success", successDetail);
    return result;
  }

  /**
   * Set up request handlers on this.server (used by stdio transport).
   */
  private async setupRequestHandlers(): Promise<void> {
    await this.setupRequestHandlersOn(this.server);
  }

  /**
   * Set up request handlers on the given server instance.
   * Uses SDK request schemas so setRequestHandler receives a proper schema (method literal).
   */
  private async setupRequestHandlersOn(server: unknown): Promise<void> {
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

    const srv = server as Record<
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
        // Close all active HTTP sessions.
        for (const [, session] of this.httpSessions) {
          const tr = session.transport as Record<string, () => Promise<void>>;
          if (typeof tr["close"] === "function") {
            await tr["close"]();
          }
        }
        this.httpSessions.clear();

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
    const names = tools.map((t) => t.name);
    const exposedDetail = { tools: names, count: names.length };
    this.context.logger.info(exposedDetail, "Exposing MCP tools");
    this.context.emit("plugin:mcp:server:tools:exposed", exposedDetail);
    this.toolsListLogged = true;
  }

  /**
   * Get list of tools that should be exposed via MCP.
   * Reads the registry lazily - called on every tools/list request and for tests.
   */
  getAvailableTools(): McpTool[] {
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
  private metadataToMcpTool(metadata: DirectRouteMetadata): McpTool {
    const tool: McpTool = {
      name: metadata.endpoint,
      description: metadata.description || "",
      inputSchema: this.schemaToJsonSchema(
        metadata.schema,
      ) as McpTool["inputSchema"],
    };
    // metadata.annotations is the core direct-adapter pass-through bag; the
    // write site (McpServerOptions.annotations) constrains it to McpToolAnnotations,
    // so this cast restores that type at the read boundary.
    if (metadata.annotations !== undefined) {
      tool.annotations = metadata.annotations as McpToolAnnotations;
    }
    return tool;
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
  ): Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }> {
    try {
      // Get the direct channel store
      const channelStore = this.context.getStore(ADAPTER_DIRECT_STORE) as
        | Map<string, Record<string, unknown>>
        | undefined;

      if (!channelStore) {
        const err = new Error("No direct channels available");
        this.context.emit(`plugin:mcp:tool:failed`, {
          tool: toolName,
          error: err.message,
        });
        return {
          isError: true,
          content: [
            { type: "text", text: `Error: No direct channels available` },
          ],
        };
      }

      // Get the channel for this tool endpoint
      const channel = channelStore.get(toolName);
      if (!channel) {
        const err = new Error(`Tool not found: ${toolName}`);
        this.context.emit(`plugin:mcp:tool:failed`, {
          tool: toolName,
          error: err.message,
        });
        return {
          isError: true,
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

      // Build exchange headers, including auth principal if present.
      const principal = principalStore.getStore();
      const headers: Record<string, string | string[] | undefined> = {
        [McpHeadersKeys.TOOL]: toolName,
        [McpHeadersKeys.SESSION]: `mcp-${Date.now()}`,
      };
      if (principal) {
        headers[McpHeadersKeys.AUTH_SUBJECT] = principal.subject;
        headers[McpHeadersKeys.AUTH_SCHEME] = principal.scheme;
        if (principal.roles)
          headers[McpHeadersKeys.AUTH_ROLES] = principal.roles;
        if (principal.scopes)
          headers[McpHeadersKeys.AUTH_SCOPES] = principal.scopes;
        if (principal.email)
          headers[McpHeadersKeys.AUTH_EMAIL] = principal.email;
        if (principal.name) headers[McpHeadersKeys.AUTH_NAME] = principal.name;
        if (principal.issuer)
          headers[McpHeadersKeys.AUTH_ISSUER] = principal.issuer;
        if (principal.audience)
          headers[McpHeadersKeys.AUTH_AUDIENCE] = principal.audience;
      }

      const exchange = new DefaultExchange(this.context, {
        body,
        headers,
      });

      this.context.emit(`plugin:mcp:tool:called`, {
        tool: toolName,
        args,
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

      this.context.emit(`plugin:mcp:tool:completed`, {
        tool: toolName,
      });

      return {
        content: [{ type: "text", text: resultText }],
      };
    } catch (error) {
      const logMsg = isRoutecraftError(error)
        ? (error as unknown as { meta: { message: string } }).meta.message
        : error instanceof Error
          ? error.message
          : String(error);
      this.context.logger.error({ tool: toolName, err: error }, logMsg);
      this.context.emit(`plugin:mcp:tool:failed`, {
        tool: toolName,
        error: logMsg,
      });

      // Build a clean user-facing message: include the cause (e.g. schema
      // field errors) but never expose stack traces or internal details.
      let userMsg = logMsg;
      if (isRoutecraftError(error)) {
        const cause = (error as { cause?: Error }).cause;
        if (cause?.message) {
          userMsg = `${logMsg}: ${cause.message}`;
        }
      }

      return {
        content: [{ type: "text", text: `Error: ${userMsg}` }],
        isError: true,
      };
    }
  }
}
