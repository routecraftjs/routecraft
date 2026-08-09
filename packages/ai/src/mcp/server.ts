import type { CraftContext } from "@routecraft/routecraft";
import {
  DefaultExchange,
  HeadersKeys,
  isRoutecraftError,
  loadOptionalPeer,
  markAuthentic,
} from "@routecraft/routecraft";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type {
  AuthInfo,
  CallToolResult,
  ListToolsResult,
  McpHttpHandler,
  McpRequestContext,
  Server as SdkServer,
} from "@modelcontextprotocol/server";
import type { NodeIncomingMessageLike } from "@modelcontextprotocol/node";
import type { StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import type {
  OAuthPrincipal,
  OAuthValidatorAuthOptions,
  Principal,
  ValidatorAuthOptions,
} from "@routecraft/routecraft";
import {
  MCP_LOCAL_TOOL_REGISTRY,
  MCP_TOOL_REGISTRY,
  McpHeadersKeys,
  isOAuthAuth,
} from "./types.ts";
import type {
  McpIcon,
  McpLocalToolEntry,
  McpPluginOptions,
  McpRawToolResult,
  McpTool,
  OAuthAuthOptions,
} from "./types.ts";
import { dispatchMcpCallRaw } from "./dispatch.ts";
import { makeFnHandlerContext } from "../fn/handler-context.ts";
import {
  proxiedToolToMcpTool,
  resolveProxiedTools,
  type McpProxiedTool,
} from "./proxy.ts";
import {
  applyCorsHeaders,
  buildMcpOwnedPaths,
  PROTECTED_RESOURCE_METADATA_PATH,
  resolveCorsOptions,
} from "./cors.ts";
import { ROUTECRAFT_DEFAULT_ICONS } from "./default-icon.ts";
import { buildEnrichedVerifier } from "./userinfo.ts";
import { classifyRejectionReason, isExpiredTokenError } from "./auth-errors.ts";
import {
  loadMcpLegacyAuthSdk,
  loadMcpNodeSdk,
  loadMcpServerSdk,
  loadMcpServerStdioSdk,
} from "./sdk.ts";

/**
 * MCP SDK `AuthInfo` shape. Imported as a type so nothing is required at
 * runtime from the SDK just for this alias; `import type` is erased by the
 * compiler.
 */
type SdkAuthInfo = AuthInfo;

/**
 * A Node request after the auth gate has run. Both HTTP paths stash the
 * verified {@link SdkAuthInfo} here (the validator path directly, the OAuth
 * path via the SDK's bearer middleware) because `toNodeHandler` forwards
 * `req.auth` to the handler as its pass-through `authInfo` -- which is how the
 * principal reaches a per-request server instance without ambient state.
 */
type AuthenticatedRequest = IncomingMessage & { auth?: SdkAuthInfo };

/**
 * Shared never-aborted signal for guard contexts on the proxied-call path,
 * where no per-request abort signal exists. Mirrors the agent runtime's
 * fallback when no route signal is available, without allocating a fresh
 * AbortController per call.
 */
const NEVER_ABORTED = new AbortController().signal;

/** True for a plain, non-array, non-null object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize `tools/call` arguments to a plain object. The MCP SDK may deliver
 * a parsed object or a raw JSON string; MCP tool arguments are always a JSON
 * object, so a primitive, array, or null is coerced to the safe fallback
 * shape (`{ input: <string> }` for a raw non-object string, `{}` otherwise)
 * before any guard or remote dispatch consumes it.
 */
function normalizeToolArgs(args: unknown): Record<string, unknown> {
  if (typeof args === "string") {
    try {
      const parsed: unknown = JSON.parse(args);
      return isPlainObject(parsed) ? parsed : { input: args };
    } catch {
      return { input: args };
    }
  }
  return isPlainObject(args) ? args : {};
}

/** Wire shape returned by `tools/call` handlers (local and proxied). */
type McpToolCallResult = {
  content: Array<{ type: string; [key: string]: unknown }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/**
 * Log-safe message for a failed tool call: the RC meta message for
 * RoutecraftErrors, the error message otherwise.
 */
function toolErrorLogMessage(error: unknown): string {
  return isRoutecraftError(error)
    ? (error as unknown as { meta: { message: string } }).meta.message
    : error instanceof Error
      ? error.message
      : String(error);
}

/**
 * Client-facing message for a failed tool call: includes the RC cause
 * (e.g. schema field errors) but never stack traces or internal details.
 */
function toolErrorUserMessage(error: unknown, logMsg: string): string {
  if (isRoutecraftError(error)) {
    const cause = (error as { cause?: Error }).cause;
    if (cause?.message) {
      return `${logMsg}: ${cause.message}`;
    }
  }
  return logMsg;
}

/** Resolved options with defaults applied (internal use). */
type McpServerResolvedOptions = Required<
  Pick<McpPluginOptions, "name" | "version" | "transport" | "port" | "host">
> &
  Pick<
    McpPluginOptions,
    | "tools"
    | "proxy"
    | "auth"
    | "title"
    | "resource"
    | "cors"
    | "userinfo"
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
 * McpServer wraps the MCP SDK and bridges it to Routecraft's DirectChannel
 * infrastructure. It reads the MCP route registry lazily (on first `tools/list`
 * request) to ensure routes have subscribed.
 *
 * Serving follows protocol revision 2026-07-28: both transports build a fresh
 * server instance per serving unit and hold no state between them, so the HTTP
 * transport scales horizontally with no session affinity. 2025-era clients are
 * still served, through the SDK's stateless fallback.
 *
 * The SDK is loaded through `loadOptionalPeer` (see `./sdk.ts`) because it is
 * an optional peer dependency, not because of any type incompatibility.
 */
export class McpServer {
  private context: CraftContext;
  private options: McpServerResolvedOptions;
  /**
   * Node HTTP server when transport is http; used to listen on port and close on stop.
   * When OAuth is enabled this holds the Express app's underlying server.
   */
  private httpServer: ReturnType<typeof createServer> | null = null;
  /**
   * The web-standard MCP handler backing the HTTP transport. Holds no
   * per-client state: it builds a fresh server instance per request from
   * {@link createServerInstance}. `null` until the HTTP transport starts.
   */
  private mcpHandler: McpHttpHandler | null = null;
  /** Handle for the stdio transport, used to await shutdown. `null` on HTTP. */
  private stdioHandle: StdioServerHandle | null = null;
  private running = false;
  private toolsListLogged = false;
  /**
   * Deduplication keys for proxy-resolution warnings, scoped to a registry
   * version: each distinct condition (unresolved ref, name collision) logs
   * once per resolution epoch instead of per request, and re-logs if it
   * recurs after the client tool registry actually changes (a client that
   * recovers and then degrades again is not silenced by its first outage).
   */
  private proxyWarnings = new Set<string>();

  /** Registry version the memoized proxy resolution was computed against. */
  private proxyResolvedVersion = -1;

  /** Memoized proxy resolution; recomputed only when the registry changes. */
  private proxyResolved: Map<string, McpProxiedTool> = new Map();
  /**
   * Validator-mode token verifier, optionally wrapped with `userinfo`
   * enrichment. Built eagerly in `startHttpWithValidator` so a misconfigured
   * `userinfo: true` (no issuer) fails at startup rather than on first
   * request. `null` until the validator HTTP path starts.
   */
  private validatorVerifier: ((token: string) => Promise<Principal>) | null =
    null;

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
   * Apply a default when the value is unset, then treat an empty string as an
   * explicit opt-out (returns `undefined` so the caller omits the field). This
   * is the uniform "default unless empty" contract used by every optional
   * string field of the server identity.
   */
  private defaultUnlessEmpty(
    value: string | undefined,
    fallback: string,
  ): string | undefined {
    const resolved = value ?? fallback;
    return resolved === "" ? undefined : resolved;
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

    const description = this.defaultUnlessEmpty(
      this.options.description,
      "Powered by Routecraft.dev",
    );
    if (description !== undefined) {
      info.description = description;
    }

    const websiteUrl = this.defaultUnlessEmpty(
      this.options.websiteUrl,
      "https://routecraft.dev",
    );
    if (websiteUrl !== undefined) {
      info.websiteUrl = websiteUrl;
    }

    const icons = this.resolveServerIcons();
    if (icons.length > 0) {
      info.icons = icons;
    }
    return info;
  }

  /**
   * Build the MCP `Server` options arg (capabilities plus optional
   * instructions). `instructions` has no default; an empty string opts out,
   * matching the empty-value contract of the serverInfo string fields.
   */
  private buildServerOptions(): SdkServerOptions {
    const options: SdkServerOptions = { capabilities: { tools: {} } };
    const instructions = this.defaultUnlessEmpty(this.options.instructions, "");
    if (instructions !== undefined) {
      options.instructions = instructions;
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
   * Start stdio transport.
   *
   * `serveStdio` calls the factory once per connection, and once more for a
   * discarded `server/discover` probe when a negotiating client checks which
   * protocol revision this server speaks. stdio carries no HTTP credentials,
   * so the instance is always built without a principal.
   */
  private async startStdio(): Promise<void> {
    const { serveStdio } = await loadMcpServerStdioSdk("mcp (stdio)");
    this.stdioHandle = serveStdio(() => this.createServerInstance(undefined));
  }

  /**
   * Build one MCP `Server` instance bound to a single serving unit: one HTTP
   * request under `createMcpHandler`, or one connection under `serveStdio`.
   *
   * The authenticated principal is closed over rather than read from ambient
   * request-scoped storage. Under the 2026-07-28 stateless model a request is
   * self-describing and its instance is never reused, so the principal is
   * simply a construction parameter -- which is also what makes the handler
   * safe to run on any replica.
   */
  private async createServerInstance(
    principal: Principal | undefined,
  ): Promise<SdkServer> {
    const { Server } = await loadMcpServerSdk("mcp");
    const server = new Server(
      this.buildServerInfo(),
      this.buildServerOptions(),
    );

    // Both handlers cast their result at the wire boundary. `McpTool` and
    // `McpToolCallResult` are Routecraft's own projections, deliberately
    // looser than the SDK's generated schema types (`inputSchema.properties`
    // is `Record<string, unknown>` because it comes from an arbitrary
    // Standard Schema, and `content` blocks are built by route code). The
    // shapes agree on the wire; only the static types differ.
    server.setRequestHandler("tools/list", () => {
      const tools = this.getAvailableTools();
      this.logExposedToolsOnce();
      return { tools } as unknown as ListToolsResult;
    });

    server.setRequestHandler("tools/call", async (request) => {
      const result = await this.handleToolCall(
        request.params.name,
        request.params.arguments ?? {},
        principal,
      );
      return result as unknown as CallToolResult;
    });

    return server;
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
   * Build the stateless web-standard MCP handler shared by both HTTP paths.
   *
   * Under protocol revision 2026-07-28 there is no `initialize` handshake and
   * no `Mcp-Session-Id`: every request is self-describing, so the handler
   * builds a fresh server instance per request and holds nothing between them.
   * That is what lets a Routecraft MCP server run as N replicas behind a plain
   * round-robin load balancer, with no sticky sessions and no shared store.
   *
   * `legacy: "stateless"` (the SDK default) keeps 2025-era clients working:
   * a request that carries no per-request `_meta` envelope is answered by the
   * established stateless 2025 idiom from the same factory. Existing clients
   * therefore keep working unchanged, they simply do not get the new
   * revision's features.
   */
  private async buildHttpHandler(): Promise<
    (req: AuthenticatedRequest, res: import("node:http").ServerResponse) => void
  > {
    const { createMcpHandler } = await loadMcpServerSdk("mcp (http)");
    const { toNodeHandler } = await loadMcpNodeSdk("mcp (http)");

    this.mcpHandler = createMcpHandler(
      (ctx: McpRequestContext) =>
        this.createServerInstance(this.authInfoToPrincipal(ctx.authInfo)),
      {
        onerror: (error: Error) => {
          this.context.logger.error({ err: error }, "MCP handler error");
        },
      },
    );

    const nodeHandler = toNodeHandler(this.mcpHandler, {
      onerror: (error: Error) => {
        this.context.logger.error({ err: error }, "MCP HTTP request error");
      },
    });

    // `IncomingMessage.method` is `string | undefined` while the adapter's
    // duck-typed shape declares `method?: string`; under
    // `exactOptionalPropertyTypes` those differ statically but not at runtime.
    // The handler owns its own error responses, so the promise is not awaited.
    return (req, res) => {
      void nodeHandler(req as NodeIncomingMessageLike, res);
    };
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
    const port = this.options.port;
    const host = this.options.host;
    const cors = resolveCorsOptions(this.options.cors);

    // Build the (optionally enriched) validator verifier eagerly so a
    // misconfigured `userinfo: true` (no issuer) throws at startup, not on
    // the first request.
    this.validatorVerifier = this.buildValidatorVerifier();

    const nodeHandler = await this.buildHttpHandler();

    this.httpServer = createServer(async (req: AuthenticatedRequest, res) => {
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

      if (this.options.auth) {
        const principal = await this.validateAuth(req);
        if (!principal) {
          res.writeHead(401, {
            "Content-Type": "application/json",
            "WWW-Authenticate": this.buildWwwAuthenticateHeader(),
          });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }
        // `toNodeHandler` forwards `req.auth` to the handler's pass-through
        // `authInfo`, which the per-request factory reads back into the
        // principal. This is the stateless replacement for the
        // AsyncLocalStorage the sessionful transport needed.
        req.auth = this.principalToAuthInfo(principal);
      }

      nodeHandler(req, res);
    });

    await this.listenHttp(port, host);
  }

  /**
   * Start HTTP transport with OAuth provider auth.
   *
   * Uses Express to mount `mcpAuthRouter` (the OAuth authorization-server
   * endpoints) alongside `/mcp`, which serves the same stateless handler the
   * validator path uses. Express is a declared optional peer of this package
   * and of `@modelcontextprotocol/server-legacy`.
   *
   * Note: if the server runs behind a reverse proxy, `req.ip` and `req.protocol`
   * may be incorrect. Users should set `trust proxy` on the Express app via a
   * future configuration option or by using a custom HTTP server.
   */
  private async startHttpWithOAuth(
    oauthOptions: OAuthAuthOptions,
  ): Promise<void> {
    const expressMod = await loadOptionalPeer(() => import("express"), {
      adapterName: "mcp (oauth)",
      packageName: "express",
    });
    const expressFn = expressMod.default ?? expressMod;

    // The OAuth *authorization server* surface (`/authorize`, `/token`,
    // `/register`, `/revoke`) lives in `@modelcontextprotocol/server-legacy`
    // as of SDK v2: the spec now steers MCP servers towards delegating to a
    // dedicated IdP rather than proxying one. Resource-server duties stay on
    // the main server package, shared with the validator path.
    const {
      mcpAuthRouter,
      requireBearerAuth,
      ProxyOAuthServerProvider,
      InvalidTokenError,
    } = await loadMcpLegacyAuthSdk("mcp (oauth)");

    // Apply plugin-level `userinfo` enrichment to the OAuth verifier. The
    // issuer for `userinfo: true` discovery is surfaced on the oauth() result
    // from the verify helper. Built eagerly so a misconfigured `userinfo: true`
    // (no issuer) throws at startup.
    const verifyAccessToken =
      this.options.userinfo === undefined
        ? oauthOptions.verifyAccessToken
        : buildEnrichedVerifier(
            oauthOptions.verifyAccessToken,
            this.options.userinfo,
            oauthOptions.issuer,
          );

    // Wrap the user's verifier so the MCP SDK sees a clean AuthInfo while the
    // rich OAuthPrincipal rides through in `extra.principal` for
    // this.authInfoToPrincipal. Token verification failures emit `auth:rejected`
    // so operators can observe brute-force attempts, mismatched audiences, and
    // expired tokens alongside the validator path's rejections. Expiry is
    // routine (the client refreshes and retries) so it logs at `debug`; every
    // other failure logs at `warn`. A token-validation failure is re-thrown as
    // InvalidTokenError so the SDK answers 401 (the client refreshes), not 500.
    const wrappedVerifier = async (token: string): Promise<SdkAuthInfo> => {
      let principal: OAuthPrincipal;
      try {
        principal = await verifyAccessToken(token);
      } catch (err) {
        const expired = isExpiredTokenError(err);
        const reason = classifyRejectionReason(err);
        const detail = {
          reason,
          scheme: "bearer",
          source: "mcp",
          path: "oauth",
        };
        if (expired) {
          this.context.logger.debug(
            { err, ...detail },
            "Auth rejected: token expired",
          );
        } else {
          this.context.logger.warn(
            { err, ...detail },
            "Auth rejected: token validation failed",
          );
        }
        this.context.emit("auth:rejected", detail);
        // A server-side failure (RC5021 userinfo/discovery fetch, RC5022 sub
        // mismatch, or a JWKS endpoint that is unreachable, slow, or returns a
        // bad response) propagates unchanged so the SDK maps it to 500: the
        // client must retry later, not discard a token that may be valid. Every
        // other throw is the verifier rejecting the token, so surface it as
        // InvalidTokenError for 401 invalid_token (which drives the refresh).
        if (reason === "infrastructure") throw err;
        throw new InvalidTokenError(
          expired ? "Token has expired" : "Invalid token",
        );
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
        ...(oauthOptions.endpoints.revocationUrl !== undefined
          ? { revocationUrl: oauthOptions.endpoints.revocationUrl }
          : {}),
        ...(oauthOptions.endpoints.registrationUrl !== undefined
          ? { registrationUrl: oauthOptions.endpoints.registrationUrl }
          : {}),
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
    const resource = this.options.resource;
    const resourceName = this.resolveResourceName();
    app.use(
      mcpAuthRouter({
        provider,
        issuerUrl: resourceUrl,
        ...(oauthOptions.baseUrl
          ? { baseUrl: new URL(oauthOptions.baseUrl.toString()) }
          : {}),
        ...(resource?.scopesSupported && resource.scopesSupported.length > 0
          ? { scopesSupported: resource.scopesSupported }
          : {}),
        ...(resource?.documentationUrl !== undefined
          ? {
              serviceDocumentationUrl: new URL(
                resource.documentationUrl.toString(),
              ),
            }
          : {}),
        ...(resourceName ? { resourceName } : {}),
      }),
    );

    // Bearer auth middleware for /mcp. The SDK appends
    // `resource_metadata="..."` to its 401 WWW-Authenticate header when
    // `resourceMetadataUrl` is provided. Use an absolute URL (RFC 9728
    // §5.1 SHOULD) that points at the doc we just mounted above.
    app.use(
      "/mcp",
      requireBearerAuth({
        verifier: provider,
        resourceMetadataUrl: this.resolveResourceMetadataUrl(),
        ...(oauthOptions.requiredScopes
          ? { requiredScopes: oauthOptions.requiredScopes }
          : {}),
      }),
    );

    const nodeHandler = await this.buildHttpHandler();

    // MCP transport handler at /mcp. `requireBearerAuth` above has already
    // stamped `req.auth` with the verified AuthInfo, which `toNodeHandler`
    // forwards to the per-request factory as its pass-through `authInfo`.
    app.all("/mcp", (req: AuthenticatedRequest, res) => {
      const principal = this.authInfoToPrincipal(req.auth);
      if (principal) {
        const successDetail = {
          subject: principal.subject,
          scheme: principal.scheme,
          source: "mcp",
        };
        this.context.logger.info(successDetail, "Auth succeeded");
        this.context.emit("auth:success", successDetail);
      }

      nodeHandler(req, res);
    });

    // Wrap the Express app in a raw HTTP server so listenHttp can bind it.
    // Express apps are callable as (req, res) request handlers.
    this.httpServer = createServer(app);
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
   * Wrap a verified {@link Principal} as the SDK `AuthInfo` the handler passes
   * through to the per-request factory, stashing the full principal in `extra`
   * so {@link authInfoToPrincipal} recovers it losslessly on the way back out.
   *
   * Used by the validator path, whose verifier produces a Routecraft
   * `Principal` directly. The OAuth path does the same stashing inside its
   * wrapped `verifyAccessToken`, so both auth modes converge on one carrier.
   */
  private principalToAuthInfo(principal: Principal): SdkAuthInfo {
    const authInfo: SdkAuthInfo = {
      token: "",
      clientId: principal.clientId ?? principal.subject,
      scopes: principal.scopes ?? [],
      extra: { principal },
    };
    if (principal.expiresAt !== undefined) {
      authInfo.expiresAt = principal.expiresAt;
    }
    return authInfo;
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
   * Build the validator-mode token verifier, optionally wrapped with
   * `userinfo` enrichment. The base verifier is the configured `validator`;
   * when `mcpPlugin({ userinfo })` is set, it is wrapped with
   * `buildEnrichedVerifier` (token cache, in-flight coalescing, sub
   * invariant, fail-closed). The issuer for `userinfo: true` discovery comes
   * from the verifier's `issuer` (surfaced by `jwks()` / `jwt()`).
   */
  private buildValidatorVerifier():
    ((token: string) => Promise<Principal>) | null {
    const authOptions = this.options.auth as
      (ValidatorAuthOptions & { issuer?: string | string[] }) | undefined;
    if (!authOptions || !("validator" in authOptions)) return null;

    const base = (token: string): Promise<Principal> =>
      Promise.resolve(authOptions.validator(token));
    if (this.options.userinfo === undefined) return base;
    return buildEnrichedVerifier(
      base,
      this.options.userinfo,
      authOptions.issuer,
    );
  }

  /**
   * Validate the Authorization header using the configured validator.
   * Only used on the validator auth path (not OAuth -- that uses Express middleware).
   * Returns the authenticated principal on success, or `null` to reject with 401.
   */
  private async validateAuth(req: IncomingMessage): Promise<Principal | null> {
    const authOptions = this.options.auth as ValidatorAuthOptions | undefined;
    if (!authOptions || !("validator" in authOptions)) return null;
    const verifier = this.validatorVerifier ?? this.buildValidatorVerifier();
    if (!verifier) return null;

    const rawHeader = req.headers["authorization"];
    if (!rawHeader || Array.isArray(rawHeader)) {
      const detail = {
        reason: "missing_header",
        scheme: "bearer",
        source: "mcp",
      };
      // A tokenless request is the spec-defined MCP OAuth discovery probe (the
      // client fetches without credentials to read the 401 + WWW-Authenticate,
      // then runs the flow and retries), so it is logged at `debug`. The
      // `auth:rejected` event still fires so observers can count probes.
      this.context.logger.debug(
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
      // Same class as a tokenless probe: the client has not authenticated yet,
      // so this is routine discovery noise rather than a failed authentication.
      // Logged at `debug`; the `auth:rejected` event still fires.
      this.context.logger.debug(
        detail,
        "Auth rejected: unsupported authorization scheme",
      );
      this.context.emit("auth:rejected", detail);
      return null;
    }
    const token = schemeMatch[1];

    // Delegate to the verifier (validator + optional userinfo enrichment).
    // Throw to reject; return Principal to accept.
    try {
      const result = await verifier(token);
      const successDetail = {
        subject: result.subject,
        scheme: result.scheme,
        source: "mcp",
      };
      this.context.logger.info(successDetail, "Auth succeeded");
      this.context.emit("auth:success", successDetail);
      return result;
    } catch (err) {
      const expired = isExpiredTokenError(err);
      const reason = classifyRejectionReason(err);
      const detail = {
        reason,
        scheme: "bearer",
        source: "mcp",
      };
      // An expired token is routine (the client refreshes and retries), so it
      // logs at `debug`; any other validation failure stays at `warn` as an
      // operator signal. The `auth:rejected` event fires for both.
      if (expired) {
        this.context.logger.debug(
          { err, ...detail },
          "Auth rejected: token expired",
        );
      } else {
        this.context.logger.warn(
          { err, ...detail },
          "Auth rejected: token validation failed",
        );
      }
      this.context.emit("auth:rejected", detail);
      return null;
    }
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
        // Tear down the modern leg: aborts in-flight exchanges and closes
        // their per-request instances. There are no sessions to drain.
        if (this.mcpHandler) {
          await this.mcpHandler.close();
          this.mcpHandler = null;
        }

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
      if (this.stdioHandle) {
        await this.stdioHandle.close();
        this.stdioHandle = null;
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
   * Get list of tools that should be exposed via MCP: local `.from(mcp())`
   * route tools (after the `tools` filter) plus tools proxied from
   * registered clients via `proxy`. Reads the MCP local tool registry lazily
   * so routes have time to subscribe before the first `tools/list` request.
   *
   * On a name collision the local route tool wins and the proxied tool is
   * skipped with a once-per-name warning.
   */
  getAvailableTools(): McpTool[] {
    const entries = this.getExposedLocalEntries();
    const tools = entries.map((entry) => this.entryToMcpTool(entry));

    const localNames = new Set(entries.map((e) => e.endpoint));
    for (const proxied of this.resolveProxied().values()) {
      if (localNames.has(proxied.exposedName)) {
        this.warnProxyOnce(
          `proxy:local-conflict:${proxied.exposedName}`,
          `mcpPlugin proxy: tool name "${proxied.exposedName}" from "${proxied.serverId}:${proxied.toolName}" collides with a local mcp() route; the route wins. Use a name override to expose both.`,
        );
        continue;
      }
      const tool = proxiedToolToMcpTool(proxied);
      // Same icon-inheritance rule as entryToMcpTool: the tool's own icons
      // when set, the server icons when unset, nothing when explicitly [].
      const icons = proxied.entry.icons ?? this.resolveServerIcons();
      if (icons.length > 0) {
        tool.icons = icons;
      }
      tools.push(tool);
    }
    return tools;
  }

  /**
   * Whether a local tool entry passes the `tools` filter. Shared by the
   * list path (filter the whole registry) and the call path (check the one
   * looked-up entry) so a filtered-out tool is consistently invisible.
   */
  private passesToolsFilter(entry: McpLocalToolEntry): boolean {
    const toolsFilter = this.options.tools;
    if (!toolsFilter) return true;
    if (Array.isArray(toolsFilter)) return toolsFilter.includes(entry.endpoint);
    return toolsFilter(entry);
  }

  /**
   * Local route tool entries after the `tools` filter, for `tools/list`.
   */
  private getExposedLocalEntries(): McpLocalToolEntry[] {
    const registry = this.context.getStore(MCP_LOCAL_TOOL_REGISTRY) as
      Map<string, McpLocalToolEntry> | undefined;

    if (!registry) {
      return [];
    }

    return Array.from(registry.values()).filter((e) =>
      this.passesToolsFilter(e),
    );
  }

  /**
   * Look up one local tool entry by name for `tools/call`, honoring the
   * `tools` filter (a filtered-out tool is not callable).
   */
  private lookupLocalEntry(toolName: string): McpLocalToolEntry | undefined {
    const registry = this.context.getStore(MCP_LOCAL_TOOL_REGISTRY) as
      Map<string, McpLocalToolEntry> | undefined;
    const entry = registry?.get(toolName);
    if (!entry || !this.passesToolsFilter(entry)) return undefined;
    return entry;
  }

  /**
   * Resolve the `proxy` selection against the live client tool registry,
   * memoized on the registry's change version: wildcard entries follow
   * tool refresh and stdio restarts (any change re-resolves), while
   * steady-state requests reuse the cached resolution. A version change
   * also opens a new warning epoch so a condition that recurs after the
   * registry recovered is logged again rather than silenced forever.
   */
  private resolveProxied(): Map<string, McpProxiedTool> {
    if (!this.options.proxy || this.options.proxy.length === 0) {
      return new Map();
    }
    const registry = this.context.getStore(MCP_TOOL_REGISTRY);
    const version = registry?.version ?? -1;
    if (registry && version === this.proxyResolvedVersion) {
      return this.proxyResolved;
    }
    // Open a new warning epoch only when a registry is actually present and
    // its version advanced. Clearing unconditionally would re-warn on every
    // request while the registry is still missing (proxyResolvedVersion never
    // advances to -1), flooding the log with the same "no registry" message.
    if (registry) {
      this.proxyWarnings.clear();
    }
    const resolved = resolveProxiedTools(
      this.context,
      this.options.proxy,
      (key, msg) => this.warnProxyOnce(key, msg),
    );
    if (registry) {
      this.proxyResolvedVersion = version;
      this.proxyResolved = resolved;
    }
    return resolved;
  }

  /** Log a proxy-resolution warning once per dedup key. */
  private warnProxyOnce(key: string, message: string): void {
    if (this.proxyWarnings.has(key)) return;
    this.proxyWarnings.add(key);
    this.context.logger.warn({}, message);
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
   * Handle a tool call from MCP client. Resolves local route tools first
   * (after the `tools` filter, so a filtered-out tool is not callable),
   * then tools proxied from registered clients.
   */
  private async handleToolCall(
    toolName: string,
    args: Record<string, unknown>,
    principal: Principal | undefined,
  ): Promise<McpToolCallResult> {
    try {
      // Normalize args once for both the local and proxied paths (the SDK
      // may pass a parsed object or a raw JSON string). MCP tool arguments
      // are always a JSON object; a primitive, array, or null (however it
      // arrives) is coerced to the safe fallback shape before any guard or
      // remote dispatch consumes it, so downstream code can trust a record.
      const body = normalizeToolArgs(args);

      const entry = this.lookupLocalEntry(toolName);
      if (!entry) {
        const proxied = this.resolveProxied().get(toolName);
        if (proxied) {
          return await this.handleProxiedToolCall(proxied, body, principal);
        }
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

      this.context.logger.debug(
        { bodyType: typeof body, body },
        "MCP tool call exchange body",
      );

      // Build exchange headers. The authenticated principal (when present)
      // rides as a single structured header rather than ten flat keys; the
      // `ex.principal` getter on the exchange surfaces it ergonomically.
      // This is the single attach point for every MCP auth mode (validator
      // jwt/jwks/custom and OAuth proxy) and runs after any userinfo
      // enrichment, so branding here marks the verified identity as
      // authentic for downstream `authorize()` without freezing it too
      // early to enrich.
      const requestId = crypto.randomUUID();
      const headers: Record<string, unknown> = {
        [McpHeadersKeys.TOOL]: toolName,
        [McpHeadersKeys.REQUEST]: requestId,
        [McpHeadersKeys.SESSION]: requestId,
      };
      if (principal) {
        headers[HeadersKeys.AUTH_PRINCIPAL] = markAuthentic(principal);
      }

      const exchange = new DefaultExchange(this.context, {
        body,
        headers,
      });

      this.context.emit(`plugin:mcp:tool:called`, {
        tool: toolName,
        // Deep snapshot: the live body is handed to the route handler next
        // and may be mutated (including nested values) after emission.
        args: structuredClone(body),
      });

      const resultExchange = await entry.handler(exchange);

      const resultText =
        typeof resultExchange.body === "string"
          ? resultExchange.body
          : JSON.stringify(resultExchange.body);

      this.context.emit(`plugin:mcp:tool:completed`, {
        tool: toolName,
      });

      // A tool that advertises an outputSchema (the route declares .output())
      // MUST return structuredContent per the MCP spec; spec-compliant clients
      // reject the response otherwise. The text block stays alongside it for
      // non-structured clients, as the spec recommends. Only a plain object
      // body qualifies: the spec requires outputSchema (and therefore the
      // structured result) to be an object, so a primitive or array body from
      // a mismatched .output() declaration falls back to text-only.
      const result: {
        content: Array<{ type: "text"; text: string }>;
        structuredContent?: Record<string, unknown>;
      } = {
        content: [{ type: "text", text: resultText }],
      };
      if (
        entry.output?.body !== undefined &&
        typeof resultExchange.body === "object" &&
        resultExchange.body !== null &&
        !Array.isArray(resultExchange.body)
      ) {
        result.structuredContent = resultExchange.body as Record<
          string,
          unknown
        >;
      }
      return result;
    } catch (error) {
      const logMsg = toolErrorLogMessage(error);
      this.context.logger.error({ tool: toolName, err: error }, logMsg);
      this.context.emit(`plugin:mcp:tool:failed`, {
        tool: toolName,
        error: logMsg,
      });

      return {
        content: [
          {
            type: "text",
            text: `Error: ${toolErrorUserMessage(error, logMsg)}`,
          },
        ],
        isError: true,
      };
    }
  }

  /**
   * Dispatch a proxied tool call to its registered client and pass the raw
   * MCP result (content, structuredContent, isError) through verbatim.
   *
   * Trust boundary: the caller's authenticated principal is NOT forwarded;
   * the Routecraft -> MCP hop authenticates with the client's registered
   * `auth` (same posture as the agent's MCP tool dispatch). Route-scope
   * guardrails do not run here; a per-entry `guard` (run before dispatch,
   * with the caller's read-only principal on its context) covers identity
   * checks, and tools needing stateful guardrails belong behind a
   * `.from(mcp())` route.
   *
   * Guard rejections and dispatch failures are handled here (not in
   * `handleToolCall`'s catch) so the `plugin:mcp:tool:failed` event always
   * carries the proxied/serverId/remoteTool fields the events reference
   * documents, keeping called/failed pairs correlatable per client.
   */
  private async handleProxiedToolCall(
    proxied: McpProxiedTool,
    args: Record<string, unknown>,
    principal: Principal | undefined,
  ): Promise<McpToolCallResult> {
    const detail = {
      tool: proxied.exposedName,
      proxied: true as const,
      serverId: proxied.serverId,
      remoteTool: proxied.toolName,
    };
    // Deep snapshot: the live args object is handed to the guard and remote
    // dispatch next and may be mutated (including nested values) after emission.
    this.context.emit(`plugin:mcp:tool:called`, {
      ...detail,
      args: structuredClone(args),
    });

    try {
      const guard = proxied.config.guard;
      if (guard) {
        const guardCtx = makeFnHandlerContext(
          proxied.exposedName,
          NEVER_ABORTED,
          principal,
        );
        await guard(args, guardCtx);
      }

      const raw: McpRawToolResult = await dispatchMcpCallRaw(
        this.context,
        proxied.serverId,
        proxied.toolName,
        args,
      );

      if (raw.isError) {
        this.context.emit(`plugin:mcp:tool:failed`, {
          ...detail,
          error: "Remote tool returned an error result",
        });
      } else {
        this.context.emit(`plugin:mcp:tool:completed`, detail);
      }

      return {
        ...raw,
        content: Array.isArray(raw.content)
          ? (raw.content as McpToolCallResult["content"])
          : [],
      };
    } catch (error) {
      const logMsg = toolErrorLogMessage(error);
      this.context.logger.error({ ...detail, err: error }, logMsg);
      this.context.emit(`plugin:mcp:tool:failed`, { ...detail, error: logMsg });

      // A framework error here is a dispatch/transport failure (RC5003),
      // whose message and cause can carry the configured upstream URL,
      // host:port, or a subprocess path. Those go to the log and the failed
      // event (operator-facing) but never to the MCP caller; the client gets
      // a generic message. A non-framework throw is the guard's own rejection
      // (the author wrote it for the caller), so its message passes through.
      const clientText = isRoutecraftError(error)
        ? `Proxied tool "${proxied.exposedName}" could not be called.`
        : logMsg;

      return {
        content: [{ type: "text", text: `Error: ${clientText}` }],
        isError: true,
      };
    }
  }
}
