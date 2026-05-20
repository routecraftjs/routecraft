import type { CraftContext } from "@routecraft/routecraft";
import {
  DefaultExchange,
  HeadersKeys,
  isRoutecraftError,
  loadOptionalPeer,
} from "@routecraft/routecraft";
import { AsyncLocalStorage } from "node:async_hooks";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthPrincipal,
  OAuthValidatorAuthOptions,
  Principal,
  ValidatorAuthOptions,
} from "@routecraft/routecraft";
import {
  MCP_LOCAL_TOOL_REGISTRY,
  McpHeadersKeys,
  isOAuthAuth,
} from "./types.ts";
import type {
  McpIcon,
  McpLocalToolEntry,
  McpPluginOptions,
  McpTool,
  OAuthAuthOptions,
} from "./types.ts";
import {
  applyCorsHeaders,
  buildMcpOwnedPaths,
  PROTECTED_RESOURCE_METADATA_PATH,
  resolveCorsOptions,
} from "./cors.ts";
import { ROUTECRAFT_DEFAULT_ICONS } from "./default-icon.ts";

/**
 * MCP SDK `AuthInfo` shape. Imported as a type so nothing is required at
 * runtime from the SDK just for this alias; `import type` is erased by the
 * compiler.
 */
type SdkAuthInfo = AuthInfo;

/**
 * Request-scoped storage for the authenticated principal.
 * Set in the HTTP request handler after auth validation;
 * read in handleToolCall to populate exchange headers.
 */
const principalStore = new AsyncLocalStorage<Principal | undefined>();

/** Resolved options with defaults applied (internal use). */
type McpServerResolvedOptions = Required<
  Pick<McpPluginOptions, "name" | "version" | "transport" | "port" | "host">
> &
  Pick<
    McpPluginOptions,
    | "tools"
    | "auth"
    | "title"
    | "resource"
    | "cors"
    | "description"
    | "websiteUrl"
    | "instructions"
    | "icons"
  >;

/** The MCP SDK `Server` constructor info arg (the fields we populate). */
type SdkServerInfo = {
  name: string;
  version: string;
  title?: string;
  description?: string;
  websiteUrl?: string;
  icons?: McpIcon[];
};

/** The MCP SDK `Server` constructor options arg (the fields we populate). */
type SdkServerOptions = {
  capabilities: { tools: Record<string, unknown> };
  instructions?: string;
};

/** The MCP SDK `Server` constructor as we consume it via dynamic import. */
type SdkServerCtor = new (
  info: SdkServerInfo,
  options: SdkServerOptions,
) => unknown;

/**
 * RFC 9728 OAuth 2.0 Protected Resource Metadata payload returned by
 * `GET /.well-known/oauth-protected-resource`. Optional fields are omitted
 * from the JSON when unset.
 *
 * @internal
 */
interface ProtectedResourceMetadata {
  resource: string;
  resource_name?: string;
  authorization_servers?: string[];
  bearer_methods_supported: ["header"];
  scopes_supported?: string[];
  resource_documentation?: string;
}

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
    this.validateResourceConfig();
  }

  /**
   * Resolve the server-level icons: the Routecraft default when unset, the
   * consumer's icons otherwise (an explicit empty array means "no icon").
   */
  private resolveServerIcons(): McpIcon[] {
    return this.options.icons === undefined
      ? ROUTECRAFT_DEFAULT_ICONS
      : this.options.icons;
  }

  /**
   * Build the MCP `serverInfo` (`Implementation`) object shared by both
   * transports. Applies the Routecraft "powered by" defaults for description,
   * websiteUrl, and icons; an empty string/array opts out of a given field.
   */
  private buildServerInfo(): SdkServerInfo {
    const info: SdkServerInfo = {
      name: this.options.name,
      version: this.options.version,
    };
    if (this.options.title !== undefined) {
      info.title = this.options.title;
    }

    const description = this.options.description ?? "Powered by Routecraft.dev";
    if (description !== "") {
      info.description = description;
    }

    const websiteUrl = this.options.websiteUrl ?? "https://routecraft.dev";
    if (websiteUrl !== "") {
      info.websiteUrl = websiteUrl;
    }

    const icons = this.resolveServerIcons();
    if (icons.length > 0) {
      info.icons = icons;
    }
    return info;
  }

  /** Build the MCP `Server` options arg (capabilities plus optional instructions). */
  private buildServerOptions(): SdkServerOptions {
    const options: SdkServerOptions = { capabilities: { tools: {} } };
    if (this.options.instructions !== undefined) {
      options.instructions = this.options.instructions;
    }
    return options;
  }

  /**
   * Validate plugin-level resource config at construction time. Runs the
   * HTTPS-in-production guard on an explicit `resource.url`. The default
   * fallback `http://{host}:{port}/mcp` is permitted as a dev-only
   * convenience; the guard only fires when the user explicitly opted in to
   * an `http://` URL in production.
   */
  private validateResourceConfig(): void {
    const explicit = this.options.resource?.url;
    if (explicit === undefined) return;
    const parsed = new URL(explicit.toString());
    if (
      parsed.protocol !== "https:" &&
      process.env["NODE_ENV"] === "production"
    ) {
      throw new TypeError(
        "mcpPlugin: resource.url must use HTTPS in production",
      );
    }
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
    const serverMod = await loadOptionalPeer(
      () => import("@modelcontextprotocol/sdk/server/index.js"),
      { adapterName: "mcp (stdio)", packageName: "@modelcontextprotocol/sdk" },
    );
    const Server = serverMod.Server as SdkServerCtor;
    const stdioMod = await loadOptionalPeer(
      () => import("@modelcontextprotocol/sdk/server/stdio.js"),
      { adapterName: "mcp (stdio)", packageName: "@modelcontextprotocol/sdk" },
    );
    const StdioServerTransport =
      stdioMod.StdioServerTransport as new () => unknown;

    this.server = new Server(this.buildServerInfo(), this.buildServerOptions());

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
    ServerCtor: SdkServerCtor;
    TransportClass: new (options?: {
      sessionIdGenerator?: () => string;
      onsessioninitialized?: (sessionId: string) => void;
      enableJsonResponse?: boolean;
    }) => unknown;
  }> {
    const serverModule = await loadOptionalPeer(
      () => import("@modelcontextprotocol/sdk/server/index.js"),
      { adapterName: "mcp (http)", packageName: "@modelcontextprotocol/sdk" },
    );
    const ServerCtor = serverModule.Server as SdkServerCtor;

    // streamableHttp is a sub-export that may not exist on older SDK
    // versions; the `.catch(() => null)` lets the OAuth-aware fallback
    // kick in instead of failing the whole startup. Don't route through
    // loadOptionalPeer here because the missing-sub-export case is
    // distinct from the missing-package case.
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
    ServerCtor: SdkServerCtor,
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
      this.buildServerInfo(),
      this.buildServerOptions(),
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
    principal: Principal | undefined,
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
   * Resolve the RFC 9728 `resource` URL. Resolution order:
   *   1. `mcpPlugin({ resource: { url } })`
   *   2. bound fallback `http://{host}:{port}/mcp`
   *
   * The HTTPS-in-production guard on an explicit `resource.url` runs eagerly
   * in the constructor (see `validateResourceConfig`); this resolver is a
   * pure projection. Should be called after `.listen()` so the bound port is
   * known. The OAuth path resolves at startup (pre-listen) because the MCP
   * SDK closes over the URL when middleware is registered; that path
   * forbids `port: 0` with an unset `resource.url` separately to avoid
   * baking `:0` into advertised URLs.
   */
  private resolveResourceUrl(): string {
    const explicit = this.options.resource?.url;
    if (explicit !== undefined) return explicit.toString();
    const host = this.options.host;
    const port = this.getHttpPort() ?? this.options.port;
    return `http://${host}:${port}/mcp`;
  }

  /**
   * Resolve the RFC 9728 `resource_name` value: `title` -> `name`.
   */
  private resolveResourceName(): string {
    return this.options.title ?? this.options.name;
  }

  /**
   * Build the RFC 9728 protected-resource metadata document.
   *
   * `authorization_servers` is populated from the validator's `issuer` (when
   * `auth` is `OAuthValidatorAuthOptions` from `jwks()` / `jwt()`). When the
   * verifier exposes no issuer, the field is omitted (RFC 9728 allows that).
   *
   * @internal
   */
  private buildProtectedResourceMetadata(): ProtectedResourceMetadata {
    const metadata: ProtectedResourceMetadata = {
      resource: this.resolveResourceUrl(),
      bearer_methods_supported: ["header"],
    };
    metadata.resource_name = this.resolveResourceName();

    const auth = this.options.auth;
    if (auth && !("provider" in auth) && "issuer" in auth) {
      const issuer = (auth as OAuthValidatorAuthOptions).issuer;
      if (issuer !== undefined) {
        metadata.authorization_servers = Array.isArray(issuer)
          ? issuer
          : [issuer];
      }
    }

    const resource = this.options.resource;
    if (resource?.scopesSupported && resource.scopesSupported.length > 0) {
      metadata.scopes_supported = resource.scopesSupported;
    }
    if (resource?.documentationUrl !== undefined) {
      metadata.resource_documentation = resource.documentationUrl.toString();
    }

    return metadata;
  }

  /**
   * Build the absolute URL of the protected-resource metadata document.
   * Combines `PROTECTED_RESOURCE_METADATA_PATH` (always rooted at origin)
   * with the resolved `resource.url`'s origin.
   *
   * @internal
   */
  private resolveResourceMetadataUrl(): string {
    return new URL(
      PROTECTED_RESOURCE_METADATA_PATH,
      this.resolveResourceUrl(),
    ).toString();
  }

  /**
   * Build the `WWW-Authenticate` header value for a 401, with an absolute
   * `resource_metadata` URL per RFC 9728 §5.1.
   */
  private buildWwwAuthenticateHeader(): string {
    const metadataUrl = this.resolveResourceMetadataUrl();
    return `Bearer realm="mcp", resource_metadata="${metadataUrl}"`;
  }

  /**
   * Serve the RFC 9728 protected-resource metadata document.
   *
   * Shared between validator and OAuth-proxy modes so both produce the
   * exact same JSON shape. Default `Cache-Control: public, max-age=3600`
   * follows RFC 9728 §3.3's caching guidance; auto-discovering MCP clients
   * fetch this document on every connection, so a short cache prevents the
   * IdP from being polled needlessly.
   *
   * @internal
   */
  private serveProtectedResourceMetadata(
    res: import("node:http").ServerResponse,
  ): void {
    const metadata = this.buildProtectedResourceMetadata();
    // CORS headers, when applicable, are committed by the surrounding
    // request handler via `applyCorsHeaders` before this helper runs. They
    // survive `writeHead` because the headers object below does not name
    // any `Access-Control-*` or `Vary` key.
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
    });
    res.end(JSON.stringify(metadata));
  }

  /**
   * Start HTTP transport with validator-based auth (existing behavior).
   * Uses raw Node.js `http.createServer`.
   */
  private async startHttpWithValidator(): Promise<void> {
    const { ServerCtor, TransportClass } = await this.importSdkHttp();
    const port = this.options.port;
    const host = this.options.host;
    const cors = resolveCorsOptions(this.options.cors);

    const createSessionFn = () =>
      this.createSession(ServerCtor, TransportClass);

    this.httpServer = createServer(async (req, res) => {
      const url = req.url?.split("?")[0] ?? "";
      const rawOrigin = req.headers["origin"];
      const originValue = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
      // Resolved owned/metadata paths derived from the bound resource URL.
      // Computed per-request because `resolveResourceUrl()` depends on the
      // bound port for the default fallback (port: 0 is only known after
      // .listen()). The computation is cheap (URL parse + small set build).
      const resolvedResourceUrl = new URL(this.resolveResourceUrl());
      const { ownedPaths, metadataPaths } =
        buildMcpOwnedPaths(resolvedResourceUrl);

      // OPTIONS preflight on an owned path: answer 204 with CORS headers.
      // When `cors === null` (user opted out via `cors: false`) we DO NOT
      // synthesize a preflight response -- the user said a fronting
      // proxy/CDN owns CORS, so we must let the request fall through
      // rather than swallowing OPTIONS here.
      if (req.method === "OPTIONS" && cors !== null && ownedPaths.has(url)) {
        applyCorsHeaders(res, cors, originValue, true);
        res.writeHead(204);
        res.end();
        return;
      }

      // Commit CORS headers via setHeader/appendHeader for every non-OPTIONS
      // response, including the catch-all 404 below. Browser clients that
      // probe unknown paths (e.g. RFC 9728 discovery fallbacks) need to read
      // the status, not a misleading CORS error. Gated on `!= OPTIONS` so
      // unowned-path OPTIONS (which fell through the short-circuit above)
      // do not pick up non-preflight `Expose-Headers` they cannot use.
      // `applyCorsHeaders` is a no-op when `cors === null`.
      if (req.method !== "OPTIONS") {
        applyCorsHeaders(res, cors, originValue, false);
      }

      if (metadataPaths.has(url)) {
        this.serveProtectedResourceMetadata(res);
        return;
      }

      if (url !== "/mcp" && url !== "/mcp/") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not Found", path: url }));
        return;
      }

      let principal: Principal | undefined;
      if (this.options.auth) {
        const result = await this.validateAuth(req);
        if (!result) {
          res.writeHead(401, {
            "Content-Type": "application/json",
            "WWW-Authenticate": this.buildWwwAuthenticateHeader(),
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
    oauthOptions: OAuthAuthOptions,
  ): Promise<void> {
    const { ServerCtor, TransportClass } = await this.importSdkHttp();

    // Dynamic imports for Express and SDK OAuth infrastructure.
    // Express types are not available at compile time (transitive dep of SDK),
    // so all Express values are typed as unknown and accessed dynamically.
    let expressFn: (...args: unknown[]) => {
      get: (...args: unknown[]) => void;
      use: (...args: unknown[]) => void;
      all: (...args: unknown[]) => void;
      listen: (
        port: number,
        host: string,
        cb: () => void,
      ) => ReturnType<typeof createServer>;
    };

    try {
      // @ts-expect-error -- Express is a transitive dep of @modelcontextprotocol/sdk; no type declarations in this project
      const expressMod = (await import("express")) as Record<string, unknown>;
      expressFn = (expressMod["default"] ?? expressMod) as typeof expressFn;
    } catch {
      throw new Error(
        'OAuth auth requires "express" (optional peer dependency of @routecraft/ai). Install it with: bun add express',
      );
    }

    // OAuth sub-modules require @modelcontextprotocol/sdk v1.27.0+. If the
    // package is missing entirely loadOptionalPeer fires RC5017 with the
    // install hint. If the package is present but the sub-path is not (older
    // SDK), the underlying ERR_MODULE_NOT_FOUND for the sub-path propagates,
    // which is more diagnostic than a generic "install" message.
    const routerMod = await loadOptionalPeer(
      () => import("@modelcontextprotocol/sdk/server/auth/router.js"),
      { adapterName: "mcp (oauth)", packageName: "@modelcontextprotocol/sdk" },
    );
    const mcpAuthRouter = (routerMod as Record<string, unknown>)[
      "mcpAuthRouter"
    ] as (options: Record<string, unknown>) => unknown;

    const bearerMod = await loadOptionalPeer(
      () =>
        import("@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js"),
      { adapterName: "mcp (oauth)", packageName: "@modelcontextprotocol/sdk" },
    );
    const requireBearerAuth = (bearerMod as Record<string, unknown>)[
      "requireBearerAuth"
    ] as (options: Record<string, unknown>) => unknown;

    const proxyMod = await loadOptionalPeer(
      () =>
        import("@modelcontextprotocol/sdk/server/auth/providers/proxyProvider.js"),
      { adapterName: "mcp (oauth)", packageName: "@modelcontextprotocol/sdk" },
    );
    const ProxyOAuthServerProvider = (proxyMod as Record<string, unknown>)[
      "ProxyOAuthServerProvider"
    ] as new (options: Record<string, unknown>) => unknown;

    // Wrap the user's verifier so the MCP SDK sees a clean AuthInfo while the
    // rich OAuthPrincipal rides through in `extra.principal` for
    // this.authInfoToPrincipal. Token verification errors are logged and
    // emitted as `auth:rejected` so operators can observe brute-force
    // attempts, expired tokens, and mismatched audiences alongside the
    // validator path's rejections.
    const wrappedVerifier = async (token: string): Promise<SdkAuthInfo> => {
      let principal: OAuthPrincipal;
      try {
        principal = await oauthOptions.verifyAccessToken(token);
      } catch (err) {
        const reason = err instanceof Error ? err.message : "invalid_token";
        const detail = {
          reason,
          scheme: "bearer",
          source: "mcp",
          path: "oauth",
        };
        this.context.logger.warn(
          { err, ...detail },
          "Auth rejected: token validation failed",
        );
        this.context.emit("auth:rejected", detail);
        throw err;
      }
      // Belt-and-suspenders: the type system already guarantees `expiresAt`,
      // but third-party code using `as any` or dynamic plugin wiring could
      // still hand us an incomplete principal. Emit a structured rejection
      // so an operator can trace the mis-wired verifier instead of debugging
      // a silent 401 from the SDK bearer middleware.
      if ((principal as { expiresAt?: number }).expiresAt === undefined) {
        const detail = {
          reason: "missing_expires_at",
          scheme: "bearer",
          source: "mcp",
          path: "oauth",
        };
        this.context.logger.warn(
          detail,
          "Auth rejected: OAuth principal is missing expiresAt",
        );
        this.context.emit("auth:rejected", detail);
        throw new Error(
          "oauth: verifyAccessToken must return a principal with expiresAt (required by MCP SDK bearer middleware)",
        );
      }
      if (!principal.clientId) {
        this.context.logger.debug(
          { subject: principal.subject },
          "oauth: principal missing clientId; using subject as fallback for AuthInfo.clientId",
        );
      }
      const authInfo: SdkAuthInfo = {
        token,
        clientId: principal.clientId ?? principal.subject,
        scopes: principal.scopes ?? [],
        expiresAt: principal.expiresAt,
        extra: { principal },
      };
      return authInfo;
    };

    // Build the ProxyOAuthServerProvider from the user's config.
    const provider = new ProxyOAuthServerProvider({
      endpoints: {
        authorizationUrl: oauthOptions.endpoints.authorizationUrl,
        tokenUrl: oauthOptions.endpoints.tokenUrl,
        revocationUrl: oauthOptions.endpoints.revocationUrl,
        registrationUrl: oauthOptions.endpoints.registrationUrl,
      },
      verifyAccessToken: wrappedVerifier,
      getClient: oauthOptions.getClient,
    });

    const port = this.options.port;
    const host = this.options.host;

    // OAuth-proxy mode resolves the resource URL at startup because the MCP
    // SDK's `mcpAuthRouter` and `requireBearerAuth` middleware close over
    // the URL when they are mounted. With `port: 0` (an ephemeral port,
    // commonly used in tests) and no explicit `resource.url`, the bound
    // port is unknown at this point and would be baked into the discovery
    // document and `WWW-Authenticate` header as `:0`. Reject that
    // combination loudly so the user picks a fixed port or a public URL.
    if (port === 0 && this.options.resource?.url === undefined) {
      throw new TypeError(
        "mcpPlugin: OAuth-proxy mode requires either a fixed `port` or an explicit `resource.url`. " +
          "With `port: 0` (ephemeral) and no `resource.url`, the protected-resource metadata URL " +
          'would advertise `:0`. Pass `resource: { url: "https://..." }` or a non-zero `port`.',
      );
    }

    // Single source of truth for the resource URL (validates HTTPS in
    // production when explicitly set; falls back to the configured port
    // otherwise).
    const resourceUrl = new URL(this.resolveResourceUrl());
    const { ownedPaths, metadataPaths } = buildMcpOwnedPaths(resourceUrl);

    const app = expressFn();

    const oauthCors = resolveCorsOptions(this.options.cors);

    // CORS middleware for our owned routes (`/mcp` and the protected-resource
    // metadata endpoint). Mounted FIRST so OPTIONS preflight short-circuits
    // before bearer auth runs (a preflight has no Authorization header by
    // design). The SDK-owned OAuth endpoints (`/register`, `/token`,
    // `/revoke`, the SDK's metadata) carry their own permissive CORS via
    // `mcpAuthRouter` -> the `cors` npm package -- we leave those alone.
    //
    // When `oauthCors === null` (user opted out via `cors: false`) the
    // middleware is not registered at all: preflight requests fall through
    // to the bearer middleware / route handler, exactly as they would if
    // CORS support had never been built. The user told us a fronting
    // proxy/CDN owns CORS.
    if (oauthCors !== null) {
      app.use((req: unknown, res: unknown, next: unknown) => {
        const nodeReq = req as IncomingMessage;
        const nodeRes = res as import("node:http").ServerResponse;
        const url = nodeReq.url?.split("?")[0] ?? "";
        const rawOrigin = nodeReq.headers["origin"];
        const originValue = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
        // OPTIONS preflight: we only short-circuit on the paths we own.
        // SDK-owned OAuth endpoints (`/register`, `/token`, ...) have their
        // own `cors()` middleware that handles preflight per their policy,
        // and we must not swallow those.
        if (nodeReq.method === "OPTIONS" && ownedPaths.has(url)) {
          applyCorsHeaders(nodeRes, oauthCors, originValue, true);
          nodeRes.writeHead(204);
          nodeRes.end();
          return;
        }
        // Apply CORS headers via setHeader on every other non-OPTIONS request,
        // including unowned paths. For SDK endpoints the SDK's own `cors()`
        // runs later and overrides via setHeader; for the Express default
        // 404 fallthrough on unknown paths our values persist so browser
        // clients can read the status rather than seeing a misleading CORS
        // error. Unowned-path OPTIONS (e.g. preflight against a route we
        // don't handle) is left untouched so the SDK's per-route preflight
        // policy is the only one in play there.
        if (nodeReq.method !== "OPTIONS") {
          applyCorsHeaders(nodeRes, oauthCors, originValue, false);
        }
        (next as () => void)();
      });
    }

    // Mount our own protected-resource metadata handler BEFORE
    // `mcpAuthRouter`. The SDK's router also mounts a doc, but at a
    // path-aware URL (`/.well-known/oauth-protected-resource{rsPath}`)
    // and without the `bearer_methods_supported` field RFC 9728 §2
    // recommends. Mounting ours first means clients fetching the URL we
    // advertise in the 401 always get the same JSON shape as validator
    // mode -- the design's "auto-mount, same shape, regardless of auth
    // mode" promise. Express runs middleware in registration order, so the
    // handler registered first wins for the matching URL; do NOT move this
    // below `app.use(mcpAuthRouter(...))` or the SDK's path-aware doc will
    // shadow ours when the resource URL collapses to root.
    // CORS headers are committed by the middleware above via `setHeader`,
    // so the handler does not need to re-emit them in `writeHead`.
    //
    // Mount on every metadata path resolved from the resource URL (RFC 9728
    // §3): root plus the path-suffixed variant matching the SDK's `rsPath`
    // math (derived from `resource.url.pathname`). Both URLs return the
    // identical document; this guarantees we shadow the SDK's path-aware
    // doc at whichever URL it chose to mount, regardless of how the user
    // configured `resource.url`.
    const serveMetadata = (_req: unknown, res: unknown) => {
      this.serveProtectedResourceMetadata(
        res as import("node:http").ServerResponse,
      );
    };
    for (const path of metadataPaths) {
      app.get(path, serveMetadata);
    }

    // Mount OAuth endpoints at root (discovery, authorize, token, revoke).
    const authRouterOptions: Record<string, unknown> = {
      provider,
      issuerUrl: resourceUrl,
    };
    if (oauthOptions.baseUrl) {
      authRouterOptions["baseUrl"] = new URL(oauthOptions.baseUrl.toString());
    }
    const resource = this.options.resource;
    if (resource?.scopesSupported && resource.scopesSupported.length > 0) {
      authRouterOptions["scopesSupported"] = resource.scopesSupported;
    }
    if (resource?.documentationUrl !== undefined) {
      authRouterOptions["serviceDocumentationUrl"] = new URL(
        resource.documentationUrl.toString(),
      );
    }
    const resourceName = this.resolveResourceName();
    if (resourceName) {
      authRouterOptions["resourceName"] = resourceName;
    }
    app.use(mcpAuthRouter(authRouterOptions));

    // Bearer auth middleware for /mcp. The SDK appends
    // `resource_metadata="..."` to its 401 WWW-Authenticate header when
    // `resourceMetadataUrl` is provided. Use an absolute URL (RFC 9728
    // §5.1 SHOULD) that points at the doc we just mounted above.
    const bearerOptions: Record<string, unknown> = {
      verifier: provider,
      resourceMetadataUrl: this.resolveResourceMetadataUrl(),
    };
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
        | SdkAuthInfo
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
   * Convert the MCP SDK's AuthInfo (set by requireBearerAuth) to a Principal
   * for routecraft's exchange headers.
   *
   * The OAuth path's wrapped `verifyAccessToken` stashes the fully-populated
   * {@link Principal} in `authInfo.extra.principal`. If the stash is absent
   * (e.g. a third party plugged a bare `ProxyOAuthServerProvider` in some
   * custom setup), fall back to a minimal principal from the SDK-level `AuthInfo`.
   */
  private authInfoToPrincipal(
    authInfo: SdkAuthInfo | undefined,
  ): Principal | undefined {
    if (!authInfo) return undefined;
    const stashed = (authInfo.extra as { principal?: Principal } | undefined)
      ?.principal;
    if (stashed) return stashed;

    const fallback: Principal = {
      kind: "oauth",
      scheme: "bearer",
      subject: authInfo.clientId,
      clientId: authInfo.clientId,
      scopes: authInfo.scopes,
    };
    if (authInfo.expiresAt !== undefined) {
      fallback.expiresAt = authInfo.expiresAt;
    }
    return fallback;
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
  private async validateAuth(req: IncomingMessage): Promise<Principal | null> {
    const authOptions = this.options.auth as ValidatorAuthOptions | undefined;
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

    // Delegate to the validator. Throw to reject; return Principal to accept.
    try {
      const result = await authOptions.validator(token);
      const successDetail = {
        subject: result.subject,
        scheme: result.scheme,
        source: "mcp",
      };
      this.context.logger.info(successDetail, "Auth succeeded");
      this.context.emit("auth:success", successDetail);
      return result;
    } catch (err) {
      const reason = err instanceof Error ? err.message : "invalid_token";
      const detail = {
        reason,
        scheme: "bearer",
        source: "mcp",
      };
      this.context.logger.warn(
        { err, ...detail },
        "Auth rejected: token validation failed",
      );
      this.context.emit("auth:rejected", detail);
      return null;
    }
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
    const typesModule = (await loadOptionalPeer(
      () => import("@modelcontextprotocol/sdk/types.js"),
      { adapterName: "mcp", packageName: "@modelcontextprotocol/sdk" },
    )) as Record<string, unknown>;
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

        // Force-close any lingering connections (e.g. SSE streams that keep
        // the socket open indefinitely). closeAllConnections() is available
        // in Node 18.2+ and Bun; without it, server.close() would hang
        // forever waiting for long-lived SSE connections to drain.
        const srv = this.httpServer as unknown as Record<string, unknown>;
        if (typeof srv["closeAllConnections"] === "function") {
          (srv["closeAllConnections"] as () => void)();
        }

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
   * Reads the MCP local tool registry lazily so routes have time to subscribe
   * before the first `tools/list` request.
   */
  getAvailableTools(): McpTool[] {
    const registry = this.context.getStore(MCP_LOCAL_TOOL_REGISTRY) as
      | Map<string, McpLocalToolEntry>
      | undefined;

    if (!registry) {
      return [];
    }

    let entries = Array.from(registry.values());

    const toolsFilter = this.options.tools;
    if (toolsFilter) {
      if (Array.isArray(toolsFilter)) {
        const allowed = new Set(toolsFilter);
        entries = entries.filter((e) => allowed.has(e.endpoint));
      } else if (typeof toolsFilter === "function") {
        entries = entries.filter(toolsFilter);
      }
    }

    return entries.map((entry) => this.entryToMcpTool(entry));
  }

  /**
   * Convert an MCP local tool registry entry to the MCP `tools/list` wire
   * format. `entry.input.body` flattens to `tool.inputSchema`; `entry.output.body`
   * flattens to `tool.outputSchema`. Header schemas are not part of the MCP
   * spec wire and are not forwarded.
   */
  private entryToMcpTool(entry: McpLocalToolEntry): McpTool {
    const tool: McpTool = {
      name: entry.endpoint,
      description: entry.description,
      inputSchema: this.schemaToJsonSchema(
        entry.input?.body,
      ) as McpTool["inputSchema"],
    };
    if (entry.title !== undefined) {
      tool.title = entry.title;
    }
    if (entry.output?.body !== undefined) {
      tool.outputSchema = this.schemaToJsonSchema(
        entry.output.body,
      ) as NonNullable<McpTool["outputSchema"]>;
    }
    if (entry.annotations !== undefined) {
      tool.annotations = entry.annotations;
    }
    const icons = entry.icons ?? this.resolveServerIcons();
    if (icons.length > 0) {
      tool.icons = icons;
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
      const registry = this.context.getStore(MCP_LOCAL_TOOL_REGISTRY) as
        | Map<string, McpLocalToolEntry>
        | undefined;

      const entry = registry?.get(toolName);
      if (!entry) {
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

      // Build exchange headers. The authenticated principal (when present)
      // rides as a single structured header rather than ten flat keys; the
      // `ex.principal` getter on the exchange surfaces it ergonomically.
      const principal = principalStore.getStore();
      const headers: Record<string, unknown> = {
        [McpHeadersKeys.TOOL]: toolName,
        [McpHeadersKeys.SESSION]: `mcp-${Date.now()}`,
      };
      if (principal) {
        headers[HeadersKeys.AUTH_PRINCIPAL] = principal;
      }

      const exchange = new DefaultExchange(this.context, {
        body,
        headers,
      });

      this.context.emit(`plugin:mcp:tool:called`, {
        tool: toolName,
        args,
      });

      const resultExchange = await entry.handler(exchange);

      const resultText =
        typeof resultExchange.body === "string"
          ? resultExchange.body
          : JSON.stringify(resultExchange.body);

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
