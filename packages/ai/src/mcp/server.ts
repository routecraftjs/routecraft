import type { CraftContext } from "@routecraft/routecraft";
import {
  DefaultExchange,
  HeadersKeys,
  isRoutecraftError,
  markAuthentic,
  requireWebIngress,
} from "@routecraft/routecraft";
import type { PathClaim, WebIngress } from "@routecraft/routecraft";
import type {
  AuthInfo,
  CallToolResult,
  ListToolsResult,
  McpHttpHandler,
  Server as SdkServer,
} from "@modelcontextprotocol/server";
import type { StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import type {
  HttpAuth,
  OAuthValidatorAuthOptions,
  Principal,
  ValidatorAuthOptions,
} from "@routecraft/routecraft";
import {
  MCP_LOCAL_TOOL_REGISTRY,
  MCP_TOOL_REGISTRY,
  McpHeadersKeys,
} from "./types.ts";
import type {
  McpIcon,
  McpLocalToolEntry,
  McpPluginOptions,
  McpRawToolResult,
  McpTool,
} from "./types.ts";
import { dispatchMcpCallRaw } from "./dispatch.ts";
import { makeFnHandlerContext } from "../fn/handler-context.ts";
import {
  proxiedToolToMcpTool,
  resolveProxiedTools,
  type McpProxiedTool,
} from "./proxy.ts";
import {
  buildCorsHeaders,
  PROTECTED_RESOURCE_METADATA_PATH,
  resolveCorsOptions,
} from "./cors.ts";
import { ROUTECRAFT_DEFAULT_ICONS } from "./default-icon.ts";
import { buildEnrichedVerifier } from "./userinfo.ts";
import { classifyRejectionReason, isExpiredTokenError } from "./auth-errors.ts";
import { loadMcpServerSdk, loadMcpServerStdioSdk } from "./sdk.ts";
import {
  advertisedOutputArms,
  declinedError,
  enforceAdvertisedOutput,
} from "./tool-result-guards.ts";

/**
 * MCP SDK `AuthInfo` shape. Imported as a type so nothing is required at
 * runtime from the SDK just for this alias; `import type` is erased by the
 * compiler.
 */
type SdkAuthInfo = AuthInfo;

/**
 * A Node request after the auth gate has run. The gate stashes the verified
 * {@link SdkAuthInfo} here because `toNodeHandler` forwards `req.auth` to the
 * handler as its pass-through `authInfo` -- which is how the principal reaches
 * a per-request server instance without ambient state.
 */

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
  Pick<McpPluginOptions, "name" | "version" | "transport" | "server" | "path">
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
  private mcpHandler: McpHttpHandler | null = null;
  private unmountHttp: (() => void) | null = null;
  /** Handle for the stdio transport, used to await shutdown. `null` on HTTP. */
  private stdioHandle: StdioServerHandle | null = null;
  /**
   * Per-request factory inputs, resolved once by {@link prepareServerFactory}
   * so {@link createServerInstance} stays off the dynamic-import path.
   */
  private sdkServerCtor: typeof SdkServer | null = null;
  private serverInfo: SdkServerInfo | null = null;
  private serverOptions: SdkServerOptions | null = null;
  private running = false;
  private boundPort: number | undefined;
  private readonly bound: Promise<void>;
  private resolveBound!: () => void;
  private readonly stopListeningForServer: () => void;
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
   * enrichment. Built eagerly during mount preparation so a misconfigured
   * `userinfo: true` (no issuer) fails at startup rather than on first
   * request. `null` until the HTTP transport starts.
   */

  constructor(context: CraftContext, options: McpPluginOptions = {}) {
    this.context = context;
    this.options = {
      name: "routecraft",
      version: "1.0.0",
      transport: "stdio",
      server: "default",
      path: "/mcp",
      ...options,
    };
    this.bound = new Promise<void>((resolve) => {
      this.resolveBound = resolve;
    });
    this.stopListeningForServer = context.on(
      "server:listening",
      ({ details }) => {
        if (details.server !== this.options.server) return;
        this.boundPort = details.port;
        this.resolveBound();
        if (this.options.transport === "http") {
          context.emit("plugin:mcp:server:listening", {
            host: details.host,
            port: details.port,
            path: this.options.path,
          });
        }
      },
    );
    this.validateResourceConfig();
  }

  /** Bound port for the named server after `server:listening` fires. */
  getHttpPort(): number | undefined {
    return this.boundPort;
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
   * HTTPS-in-production guard for the shared HTTP transport. A shared
   * listener is commonly published through a TLS-terminating proxy, whose
   * external origin cannot be inferred safely from the local bind address.
   */
  private validateResourceConfig(): void {
    const explicit = this.options.resource?.url;
    const environment = process.env["NODE_ENV"];
    const relaxed = environment === "development" || environment === "test";
    if (
      explicit === undefined &&
      this.options.transport === "http" &&
      !relaxed
    ) {
      throw new TypeError(
        "mcpPlugin: resource.url is required for HTTP transport outside development or test",
      );
    }
    if (explicit === undefined) return;
    const parsed = new URL(explicit.toString());
    if (parsed.protocol !== "https:" && !relaxed) {
      throw new TypeError(
        "mcpPlugin: resource.url must use HTTPS outside development or test",
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

      if (transport !== "http") {
        await this.startStdio();
      } else if (this.boundPort === undefined) {
        await this.bound;
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

  /** Prepare build-time resources and register the HTTP mount before listeners bind. */
  async prepare(): Promise<void> {
    if (this.options.transport !== "http") return;
    await this.prepareHttpMount();
  }

  private async prepareHttpMount(): Promise<void> {
    const verifier = this.buildValidatorVerifier();
    await this.prepareServerFactory();
    const {
      createMcpHandler,
      hostHeaderValidationResponse,
      originValidationResponse,
    } = await loadMcpServerSdk("mcp (http)");
    const cors = resolveCorsOptions(this.options.cors);
    const path = this.options.path.replace(/\/+$/, "") || "/mcp";
    const metadataPath = `${PROTECTED_RESOURCE_METADATA_PATH}${path}`;
    const ingress = requireWebIngress(this.context, this.options.server);
    this.mcpHandler = createMcpHandler(
      (requestContext) =>
        this.createServerInstance(
          this.authInfoToPrincipal(requestContext.authInfo),
        ),
      {
        onerror: (error: Error) => {
          this.context.logger.error({ err: error }, "MCP handler error");
        },
      },
    );
    const claims: PathClaim[] = [
      { kind: "exact", path, methods: ["GET", "POST", "DELETE", "OPTIONS"] },
      {
        kind: "exact",
        path: `${path}/`,
        methods: ["GET", "POST", "DELETE", "OPTIONS"],
      },
      { kind: "exact", path: metadataPath, methods: ["GET", "OPTIONS"] },
    ];
    this.unmountHttp = ingress.mountHttp({
      id: "mcp",
      authExempt: (request) => {
        const requestPath = new URL(request.url).pathname;
        return request.method === "OPTIONS" || requestPath === metadataPath;
      },
      classifyAuthRejection: (rejection) =>
        rejection.reason === "unsupported_scheme"
          ? "unsupported_scheme"
          : classifyRejectionReason(rejection.cause),
      ...(this.options.auth !== undefined
        ? {
            auth:
              this.options.auth === false || verifier === null
                ? this.options.auth
                : { ...this.options.auth, validator: verifier },
          }
        : {}),
      claims: () => claims,
      handler: async (request, mountContext) => {
        const pathname = new URL(request.url).pathname;
        const origin = request.headers.get("origin") ?? undefined;
        const hostRejection = hostHeaderValidationResponse(
          request,
          this.allowedHostnames(ingress),
        );
        if (hostRejection) return hostRejection;
        const owned =
          pathname === path ||
          pathname === `${path}/` ||
          pathname === metadataPath;
        const corsHeaders = buildCorsHeaders(cors, origin, false);
        if (origin !== undefined && cors !== null) {
          let hostname = "";
          try {
            hostname = new URL(origin).hostname;
          } catch {
            // The SDK validator below returns the canonical 403 response.
          }
          const originRejection = originValidationResponse(
            request,
            hostname.length > 0 ? [hostname] : [],
          );
          if (
            originRejection ||
            corsHeaders["Access-Control-Allow-Origin"] === undefined
          ) {
            return originRejection ?? originValidationResponse(request, [])!;
          }
        }
        if (request.method === "OPTIONS" && cors !== null && owned) {
          return new Response(null, {
            status: 204,
            headers: buildCorsHeaders(cors, origin, true),
          });
        }
        if (pathname === metadataPath) {
          const metadata = this.buildProtectedResourceMetadata(
            mountContext.authOptions,
          );
          metadata.resource = this.resourceUrlFor(ingress, path);
          return new Response(JSON.stringify(metadata), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "cache-control": "public, max-age=3600",
              ...corsHeaders,
            },
          });
        }
        if (mountContext.auth?.kind === "reject") {
          const reason = classifyRejectionReason(mountContext.auth.cause);
          if (mountContext.auth.reason === "unsupported_scheme") {
            this.context.logger.debug(
              {
                reason: mountContext.auth.reason,
                scheme: "bearer",
                source: "mcp",
              },
              "Auth rejected: unsupported authorization scheme",
            );
          } else if (isExpiredTokenError(mountContext.auth.cause)) {
            this.context.logger.debug(
              { reason, scheme: "bearer", source: "mcp" },
              "Auth rejected: token expired",
            );
          } else {
            this.context.logger.warn(
              { reason, scheme: "bearer", source: "mcp" },
              "Auth rejected: token validation failed",
            );
          }
          if (reason === "infrastructure") {
            return Response.json(
              { error: "Authentication unavailable" },
              { status: 500, headers: corsHeaders },
            );
          }
          return Response.json(
            { error: "Unauthorized" },
            {
              status: 401,
              headers: {
                ...corsHeaders,
                "WWW-Authenticate": this.buildWebWwwAuthenticateHeader(
                  ingress,
                  path,
                  { error: "invalid_token" },
                ),
              },
            },
          );
        }
        if (pathname !== path && pathname !== `${path}/`) {
          return Response.json(
            { error: "Not Found", path: pathname },
            { status: 404, headers: corsHeaders },
          );
        }

        let principal: Principal | undefined;
        let token: string | undefined;
        if (mountContext.auth?.kind === "absent") {
          this.context.logger.debug(
            { reason: "missing_header", scheme: "bearer", source: "mcp" },
            "Auth rejected: missing or malformed Authorization header",
          );
          this.context.emit("auth:rejected", {
            reason: "missing_header",
            scheme: "bearer",
            source: "mcp",
          });
          return Response.json(
            { error: "Unauthorized" },
            {
              status: 401,
              headers: {
                ...corsHeaders,
                "WWW-Authenticate": this.buildWebWwwAuthenticateHeader(
                  ingress,
                  path,
                  {},
                ),
              },
            },
          );
        }
        if (mountContext.auth?.kind === "admit") {
          principal = mountContext.auth.principal;
          token = mountContext.auth.credential;
          const clockToleranceSec =
            mountContext.authOptions &&
            "clockToleranceSec" in mountContext.authOptions &&
            typeof mountContext.authOptions.clockToleranceSec === "number"
              ? mountContext.authOptions.clockToleranceSec
              : 0;
          if (
            principal.expiresAt !== undefined &&
            (!Number.isFinite(principal.expiresAt) ||
              !Number.isFinite(clockToleranceSec) ||
              Math.floor(Date.now() / 1000) >=
                principal.expiresAt + clockToleranceSec)
          ) {
            return Response.json(
              { error: "Unauthorized" },
              {
                status: 401,
                headers: {
                  ...corsHeaders,
                  "WWW-Authenticate": this.buildWebWwwAuthenticateHeader(
                    ingress,
                    path,
                    { error: "invalid_token" },
                  ),
                },
              },
            );
          }
          const missing = this.missingScopes(principal);
          if (missing.length > 0) {
            const detail = {
              reason: "insufficient_scope",
              scheme: "bearer",
              source: "mcp",
            };
            this.context.logger.warn(
              detail,
              "Auth rejected: insufficient scope",
            );
            this.context.emit("auth:rejected", detail);
            return Response.json(
              { error: "insufficient_scope" },
              {
                status: 403,
                headers: {
                  ...corsHeaders,
                  "WWW-Authenticate": this.buildWebWwwAuthenticateHeader(
                    ingress,
                    path,
                    {
                      error: "insufficient_scope",
                      scope: missing.join(" "),
                    },
                  ),
                },
              },
            );
          }
        }

        const response = await this.mcpHandler!.fetch(
          request,
          principal !== undefined && token !== undefined
            ? { authInfo: this.principalToAuthInfo(principal, token) }
            : {},
        );
        const headers = new Headers(response.headers);
        for (const [name, value] of Object.entries(corsHeaders))
          headers.set(name, value);
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      },
    });
  }

  private allowedHostnames(ingress: WebIngress): string[] {
    const names = new Set<string>();
    const explicit = this.options.resource?.url;
    if (explicit !== undefined) names.add(new URL(explicit).hostname);
    const bound = ingress.boundAddress;
    if (bound !== undefined) names.add(bound.host);
    if (
      bound?.host === "127.0.0.1" ||
      bound?.host === "::1" ||
      bound?.host === "[::1]" ||
      bound?.host === "localhost" ||
      bound?.host === "0.0.0.0" ||
      bound?.host === "::" ||
      bound?.host === "[::]"
    ) {
      names.add("localhost");
      names.add("127.0.0.1");
      names.add("[::1]");
    }
    return [...names];
  }

  private resourceUrlFor(ingress: WebIngress, path: string): string {
    const explicit = this.options.resource?.url;
    if (explicit !== undefined) return explicit.toString();
    const bound = ingress.boundAddress;
    if (bound === undefined) {
      throw new TypeError("mcpPlugin: named server has not bound yet");
    }
    const hostname = bound.host.startsWith("[")
      ? bound.host
      : bound.host.includes(":")
        ? `[${bound.host}]`
        : bound.host;
    return new URL(path, `http://${hostname}:${bound.port}`).toString();
  }

  private buildWebWwwAuthenticateHeader(
    ingress: WebIngress,
    path: string,
    params: Record<string, string>,
  ): string {
    const resourceUrl = this.resourceUrlFor(ingress, path);
    const metadataUrl = new URL(
      `${PROTECTED_RESOURCE_METADATA_PATH}${path}`,
      resourceUrl,
    ).toString();
    const attributes = [
      `realm="mcp"`,
      ...Object.entries(params).map(([key, value]) => `${key}="${value}"`),
      `resource_metadata="${metadataUrl}"`,
    ];
    return `Bearer ${attributes.join(", ")}`;
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
    await this.prepareServerFactory();
    this.stdioHandle = serveStdio(() => this.createServerInstance(undefined));
  }

  /**
   * Resolve everything the per-request factory needs, once, at startup.
   *
   * {@link createServerInstance} runs on every request, so the SDK import and
   * the identity/capability objects are hoisted out of that path: they depend
   * only on `this.options` and would otherwise be recomputed per request on
   * the axis this transport is meant to scale along.
   */
  private async prepareServerFactory(): Promise<void> {
    const { Server } = await loadMcpServerSdk("mcp");
    this.sdkServerCtor = Server;
    this.serverInfo = this.buildServerInfo();
    this.serverOptions = this.buildServerOptions();
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
  private createServerInstance(principal: Principal | undefined): SdkServer {
    if (!this.sdkServerCtor || !this.serverInfo || !this.serverOptions) {
      throw new Error(
        "mcp: server factory used before prepareServerFactory() ran",
      );
    }
    const server = new this.sdkServerCtor(this.serverInfo, this.serverOptions);

    // Each handler casts only the member whose type is deliberately looser
    // than the SDK's generated schema: `McpTool.inputSchema.properties` is a
    // `Record<string, unknown>` because it comes from an arbitrary Standard
    // Schema, and `content` blocks are assembled by route code. The
    // surrounding result envelope stays structurally checked, so a future
    // required field on either result is a compile error rather than a
    // protocol error at a client.
    server.setRequestHandler("tools/list", () => {
      const tools = this.getAvailableTools();
      this.logExposedToolsOnce();
      return { tools: tools as unknown as ListToolsResult["tools"] };
    });

    server.setRequestHandler("tools/call", async (request) => {
      const result = await this.handleToolCall(
        request.params.name,
        request.params.arguments ?? {},
        principal,
      );
      return {
        ...result,
        content: result.content as unknown as CallToolResult["content"],
      };
    });

    return server;
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
  private buildProtectedResourceMetadata(
    effectiveAuth: HttpAuth | undefined = this.options.auth === false
      ? undefined
      : this.options.auth,
  ): ProtectedResourceMetadata {
    const metadata: ProtectedResourceMetadata = {
      resource:
        this.options.resource?.url?.toString() ??
        `http://localhost${this.options.path}`,
      bearer_methods_supported: ["header"],
    };
    metadata.resource_name = this.resolveResourceName();

    const auth = effectiveAuth;
    if (auth && "issuer" in auth) {
      const issuer: OAuthValidatorAuthOptions["issuer"] = auth.issuer;
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
   * Required scopes the principal does not carry, in configuration order.
   * Empty when no `requiredScopes` are configured or all are satisfied.
   */
  private missingScopes(principal: Principal): string[] {
    const required =
      this.options.auth === false
        ? undefined
        : this.options.auth?.requiredScopes;
    if (!required || required.length === 0) return [];
    const granted = new Set(principal.scopes ?? []);
    return required.filter((scope) => !granted.has(scope));
  }

  /**
   * Wrap a verified {@link Principal} as the SDK `AuthInfo` the handler passes
   * through to the per-request factory, stashing the full principal in `extra`
   * so {@link authInfoToPrincipal} recovers it losslessly on the way back out.
   *
   * The principal travels as a construction parameter of the per-request
   * server instance rather than through ambient storage: revision 2026-07-28
   * builds a fresh instance per request, so the identity can be closed over at
   * construction and there is no session for an `AsyncLocalStorage` to key on.
   *
   * `token` carries the verified bearer the caller presented. Every auth
   * helper must agree on it: the SDK hands one `AuthInfo` to every
   * per-request instance, and a consumer reading `authInfo.token` must not see
   * a real credential under `oauth()` and a placeholder under `jwt()`.
   */
  private principalToAuthInfo(
    principal: Principal,
    token: string,
  ): SdkAuthInfo {
    const authInfo: SdkAuthInfo = {
      token,
      clientId: principal.clientId ?? principal.subject,
      scopes: principal.scopes ?? [],
      extra: { principal },
    };
    if (principal.expiresAt !== undefined) {
      authInfo.expiresAt = principal.expiresAt;
    }
    return authInfo;
  }

  /** Recover the verified principal passed through the SDK request context. */
  private authInfoToPrincipal(
    authInfo: SdkAuthInfo | undefined,
  ): Principal | undefined {
    if (authInfo === undefined) return undefined;
    const principal = (authInfo.extra as { principal?: Principal } | undefined)
      ?.principal;
    if (principal !== undefined) return principal;
    return {
      kind: "oauth",
      scheme: "bearer",
      subject: authInfo.clientId,
      clientId: authInfo.clientId,
      scopes: authInfo.scopes,
      ...(authInfo.expiresAt !== undefined
        ? { expiresAt: authInfo.expiresAt }
        : {}),
    };
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
    const authOptions = (
      this.options.auth === false ? undefined : this.options.auth
    ) as (ValidatorAuthOptions & { issuer?: string | string[] }) | undefined;
    if (!authOptions || !("validator" in authOptions)) {
      if (this.options.userinfo !== undefined) {
        throw new TypeError(
          "mcpPlugin: userinfo requires an explicit mcp.auth validator; inherited server auth cannot be enriched",
        );
      }
      return null;
    }

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
   * Stop the MCP server
   */
  async stop(): Promise<void> {
    if (!this.running && !this.unmountHttp && this.mcpHandler === null) {
      return;
    }

    try {
      this.unmountHttp?.();
    } catch (error) {
      this.context.logger.error(
        { err: error },
        "Failed to unmount MCP handler",
      );
    } finally {
      this.unmountHttp = null;
    }
    if (this.mcpHandler !== null) {
      try {
        await this.mcpHandler.close();
      } catch (error) {
        this.context.logger.error(
          { err: error },
          "Failed to close mounted MCP handler",
        );
      } finally {
        this.mcpHandler = null;
      }
    }

    try {
      this.stopListeningForServer();
      if (this.stdioHandle) {
        try {
          await this.stdioHandle.close();
        } catch (error) {
          this.context.logger.error(
            { err: error },
            "Failed to close MCP stdio transport",
          );
        } finally {
          this.stdioHandle = null;
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
    const outputArms = advertisedOutputArms(entry);
    if (outputArms.length > 0) {
      tool.outputSchema = this.schemaToJsonSchema(outputArms[0]) as NonNullable<
        McpTool["outputSchema"]
      >;
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
   * Report a declined tool call: the route ran and chose not to answer.
   *
   * Kept off the failure path deliberately. Core models a drop as its own
   * lifecycle outcome beside completed and failed, and a tool whose job is to
   * filter would otherwise write an error-level line and a `tool:failed`
   * event on every ordinary rejection, paging anyone with an error-rate alert
   * on normal traffic. MCP has no channel but `isError` to tell the caller,
   * so the wire result matches a failure while the log and the event do not.
   */
  private declineToolCall(toolName: string, error: Error): McpToolCallResult {
    const message = toolErrorLogMessage(error);
    this.context.logger.warn({ tool: toolName, err: error }, message);
    this.context.emit(`plugin:mcp:tool:declined`, {
      tool: toolName,
      reason: message,
    });

    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
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
      // This is the single attach point for every MCP auth mode (jwt/jwks/
      // custom validator and `oauth()`) and runs after any userinfo
      // enrichment, so branding here marks the verified identity as
      // authentic for downstream `authorize()` without freezing it too
      // early to enrich.
      const headers: Record<string, unknown> = {
        [McpHeadersKeys.TOOL]: toolName,
        [McpHeadersKeys.REQUEST]: crypto.randomUUID(),
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

      // A decline is the route's answer, not a failure, so it returns here
      // rather than throwing into the catch below.
      const declined = declinedError(entry, resultExchange);
      if (declined) return this.declineToolCall(toolName, declined);

      // Publishes what the schema accepted, not what the handler offered:
      // for a transforming schema those differ, and the client was promised
      // the schema's output.
      const publishedBody = await enforceAdvertisedOutput(
        entry,
        resultExchange,
      );

      const resultText =
        typeof publishedBody === "string"
          ? publishedBody
          : JSON.stringify(publishedBody);

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
        advertisedOutputArms(entry).length > 0 &&
        typeof publishedBody === "object" &&
        publishedBody !== null &&
        !Array.isArray(publishedBody)
      ) {
        result.structuredContent = publishedBody as Record<string, unknown>;
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
