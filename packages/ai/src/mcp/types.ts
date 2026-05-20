import type { Exchange, Tag } from "@routecraft/routecraft";
import type {
  OAuthPrincipal,
  Principal,
  ValidatorAuthOptions,
} from "@routecraft/routecraft";
import type { McpCorsOptions } from "./cors.ts";
import type { McpToolRegistry } from "./tool-registry.ts";

/**
 * Store key set by mcpPlugin() when applied; routes using .from(mcp(...)) require it.
 * @internal
 */
export const MCP_PLUGIN_REGISTERED = Symbol.for(
  "routecraft.mcp.plugin.registered",
);

/**
 * Store key for named remote MCP servers (mcpPlugin({ clients })). Used by McpClient to resolve serverId.
 * @internal
 */
export const ADAPTER_MCP_CLIENT_SERVERS = Symbol.for(
  "routecraft.mcp.client.servers",
);

/**
 * Store key for the unified MCP tool registry. Used by agent adapter for tool discovery.
 * @internal
 */
export const MCP_TOOL_REGISTRY = Symbol.for("routecraft.mcp.tool.registry");

/**
 * Store key for stdio client managers. Used by destination adapter to call tools on stdio clients.
 * @internal
 */
export const MCP_STDIO_MANAGERS = Symbol.for("routecraft.mcp.stdio.managers");

/**
 * Store key for the MCP local tool registry. Populated at `mcp()` subscription time
 * with one entry per `.from(mcp(endpoint, options))` route in this context.
 *
 * Kept separate from {@link MCP_TOOL_REGISTRY}, which holds tools discovered from
 * external (stdio/HTTP) client servers and is consumed by the agent adapter.
 *
 * @experimental
 */
export const MCP_LOCAL_TOOL_REGISTRY = Symbol.for(
  "routecraft.mcp.local-tool-registry",
);

/**
 * Per-direction schema bundle for an MCP tool's request side.
 * Both `body` (MCP `Tool.inputSchema`) and `headers` are validated at runtime
 * before the route handler runs.
 *
 * @experimental
 */
/**
 * @deprecated Use `RouteSchemas` from `@routecraft/routecraft`. Kept as an
 * alias so existing imports do not break during migration.
 */
export type McpInput = import("@routecraft/routecraft").RouteSchemas;

/**
 * @deprecated Use `RouteSchemas` from `@routecraft/routecraft`. Kept as an
 * alias so existing imports do not break during migration.
 */
export type McpOutput = import("@routecraft/routecraft").RouteSchemas;

/**
 * Entry in the {@link MCP_LOCAL_TOOL_REGISTRY}. One per `.from(mcp(endpoint, options))`
 * route. Holds the discovery metadata needed for `tools/list` and the invocation
 * handler used by `tools/call`.
 *
 * @experimental
 */
export interface McpLocalToolEntry {
  /** Tool name (matches the route id). Used as `tool.name` in MCP `tools/list`. */
  endpoint: string;
  /** Human-readable display title forwarded to `tools/list` when provided. */
  title?: string;
  /** Human-readable description of the tool (required for MCP discoverability). */
  description: string;
  /** Input schemas (request body, request headers). */
  input?: import("@routecraft/routecraft").RouteSchemas;
  /** Output schemas (response body, response headers); forwarded to `tools/list`. */
  output?: import("@routecraft/routecraft").RouteSchemas;
  /** MCP tool annotations (read-only hints, destructive hints, etc.). */
  annotations?: McpToolAnnotations;
  /** Icons forwarded to `tools/list` per the MCP spec. */
  icons?: McpIcon[];
  /**
   * Invocation handler. Receives an exchange pre-built by the MCP server
   * (with tool/session/auth headers and the request body) and returns the
   * resulting exchange after the route has processed it.
   */
  handler: (exchange: Exchange) => Promise<Exchange>;
}

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [MCP_PLUGIN_REGISTERED]: boolean;
    [ADAPTER_MCP_CLIENT_SERVERS]: Map<
      string,
      McpClientHttpConfig | McpClientStdioConfig | string
    >;
    [MCP_TOOL_REGISTRY]: McpToolRegistry;
    [MCP_LOCAL_TOOL_REGISTRY]: Map<string, McpLocalToolEntry>;
    [MCP_STDIO_MANAGERS]: Map<
      string,
      {
        callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
      }
    >;
  }

  interface RoutecraftHeaders {
    /** The MCP tool name that triggered this exchange. */
    "routecraft.mcp.tool"?: string;
    /** The MCP session identifier. */
    "routecraft.mcp.session"?: string;
  }
}

/**
 * HTTP client config for a remote MCP server (Streamable HTTP).
 * Used in mcpPlugin({ clients: { name: config } }).
 */
export interface McpClientHttpConfig {
  transport?: "streamable-http";
  url: string;
  /** Auth credentials sent on every request to this server. */
  auth?: McpClientAuthOptions;
}

/**
 * Stdio client config for a local MCP server subprocess.
 * Used in mcpPlugin({ clients: { name: config } }).
 * The plugin spawns the process, manages its lifecycle, and auto-restarts on crash.
 */
export interface McpClientStdioConfig {
  transport: "stdio";
  /** The executable to run (e.g. "npx", "node", "python"). */
  command: string;
  /** Command line arguments to pass to the executable. */
  args?: string[];
  /** Environment variables for the child process. Defaults to a safe subset of the parent env. */
  env?: Record<string, string>;
  /** Working directory for the child process. Defaults to the current working directory. */
  cwd?: string;
}

/** Union of client configs accepted by mcpPlugin({ clients }). */
export type McpClientServerConfig = McpClientHttpConfig | McpClientStdioConfig;

/**
 * Header keys set on exchanges created by the MCP server.
 *
 * Authenticated identity is exposed via `ex.principal` (a getter over
 * `ex.headers["routecraft.auth.principal"]`); read principal fields off the
 * structured object instead of looking them up under flat header keys.
 *
 * @example
 * ```ts
 * import { McpHeadersKeys } from '@routecraft/ai'
 *
 * .process((ex) => {
 *   const subject = ex.principal?.subject
 *   const tool = ex.headers[McpHeadersKeys.TOOL]
 * })
 * ```
 */
export enum McpHeadersKeys {
  /** The MCP tool name that triggered this exchange. */
  TOOL = "routecraft.mcp.tool",
  /** The MCP session identifier. */
  SESSION = "routecraft.mcp.session",
}

/**
 * OAuth client info supplied to the `oauth()` factory via the `client` option.
 * Mirrors the MCP SDK's `OAuthClientInformationFull` with only the fields routecraft needs.
 *
 * Field names use snake_case to match the OAuth 2.0 Dynamic Client Registration
 * specification (RFC 7591) and the MCP SDK's `OAuthClientInformationFull`.
 *
 * @experimental
 */
export interface OAuthClientInfo {
  /** The client identifier. */
  client_id: string;
  /** Allowed redirect URIs for authorization code flow. */
  redirect_uris: string[];
  /** Human-readable client name. */
  client_name?: string;
  /** Client secret (for confidential clients). */
  client_secret?: string;
}

/**
 * Endpoint URLs for the upstream OAuth provider (used by the proxy).
 *
 * @experimental
 */
export interface OAuthProxyEndpoints {
  /** Authorization endpoint URL. */
  authorizationUrl: string;
  /** Token endpoint URL. */
  tokenUrl: string;
  /** Token revocation endpoint URL. */
  revocationUrl?: string;
  /** Dynamic client registration endpoint URL. */
  registrationUrl?: string;
}

/**
 * Protected-resource (RFC 9728) metadata for the MCP server.
 *
 * Used by both validator-mode and OAuth-proxy auth to populate
 * `/.well-known/oauth-protected-resource` and the `resource_metadata`
 * parameter on 401 responses. Orthogonal to the auth mode: identifies WHAT
 * is being protected, not HOW it authenticates.
 *
 * When omitted entirely, the framework still advertises a baseline metadata
 * document built from the bound URL and (in validator mode) the IdP issuer
 * surfaced by `jwks()` / `jwt()`.
 *
 * @experimental
 */
export interface McpResourceOptions {
  /**
   * Identifies this MCP server as an OAuth 2.0 Protected Resource (RFC 9728).
   * Becomes the `resource` field in the metadata document. Must be HTTPS in
   * production. Defaults to `http://{host}:{port}/mcp` when unset.
   */
  url?: string | URL;
  /**
   * OAuth scopes this resource advertises as supported.
   * Becomes the `scopes_supported` field in the metadata document. An empty
   * array is treated as unset and the field is omitted entirely (RFC 9728
   * §2 permits this; most MCP clients treat absence and empty as equivalent).
   */
  scopesSupported?: string[];
  /**
   * URL to human-readable documentation describing this protected resource.
   * Becomes the `resource_documentation` field in the metadata document.
   */
  documentationUrl?: string | URL;
}

/**
 * OAuth provider auth: full OAuth 2.1 server flow with proxy to upstream IdP.
 * Mounts discovery, authorization, token, and revocation endpoints alongside `/mcp`.
 * Uses the MCP SDK's `ProxyOAuthServerProvider` and `mcpAuthRouter` internally.
 *
 * Protected-resource metadata (`resource`, `scopes_supported`, etc.) lives on
 * `mcpPlugin({ resource })`, not here -- it is orthogonal to the auth mode.
 *
 * @experimental
 */
export interface OAuthAuthOptions {
  /** Discriminant for the union. Always `"oauth"`. */
  provider: "oauth";
  /** Base URL for OAuth endpoints (defaults to the resolved resource URL). */
  baseUrl?: string | URL;
  /** Upstream OAuth provider endpoints to proxy. */
  endpoints: OAuthProxyEndpoints;
  /**
   * Verify an access token and return a populated {@link OAuthPrincipal}.
   * Called on every authenticated request to `/mcp`.
   *
   * The returned principal flows through to route exchanges as
   * `headers["routecraft.auth.principal"]` (surfaced via the `ex.principal`
   * getter). `expiresAt` is part of the type contract because the MCP
   * SDK's bearer middleware requires it.
   */
  verifyAccessToken: (token: string) => Promise<OAuthPrincipal>;
  /**
   * Look up a registered OAuth client by ID.
   * Return `undefined` to reject the client.
   */
  getClient: (clientId: string) => Promise<OAuthClientInfo | undefined>;
  /** Scopes required on every request to `/mcp`. Enforcement policy, not metadata. */
  requiredScopes?: string[];
}

/**
 * Authentication options for the MCP HTTP server.
 * Only applies when `transport` is `"http"`. Ignored for stdio.
 *
 * Two strategies are supported:
 * - `Validator`: simple bearer token check via `jwt()` / `jwks()` / or custom function.
 * - `OAuth`: full OAuth 2.1 server flow via `oauth()`, proxying to an upstream IdP.
 *
 * @experimental
 */
export type McpHttpAuthOptions = ValidatorAuthOptions | OAuthAuthOptions;

/**
 * Type guard: returns `true` when auth is configured for OAuth provider mode.
 */
export function isOAuthAuth(
  auth: McpHttpAuthOptions,
): auth is OAuthAuthOptions {
  return "provider" in auth && auth.provider === "oauth";
}

/**
 * A function that provides a bearer token for outbound requests.
 * Called on every request; may be synchronous or asynchronous.
 * Useful for dynamic tokens (JWT refresh, rotating API keys, etc.).
 *
 * @experimental
 */
export type McpClientTokenProvider = () => string | Promise<string>;

/**
 * Auth config for an outbound MCP HTTP client connection.
 * Passed as request headers on every connection to the remote server.
 *
 * @experimental
 */
export interface McpClientAuthOptions {
  /**
   * Bearer token(s) or provider for the `Authorization` header.
   * Builds `Authorization: Bearer <token>`.
   *
   * - `string` -- single static token.
   * - `string[]` -- array of tokens; one is selected per request (round-robin).
   * - `() => string | Promise<string>` -- called per request for dynamic tokens.
   */
  token?: string | string[] | McpClientTokenProvider;
  /**
   * Additional headers to include on every request to the remote server.
   * If `Authorization` is set here, it overrides `token`.
   */
  headers?: Record<string, string>;
}

/**
 * Options for the MCP plugin (mcpPlugin).
 * One plugin per adapter: this is the single options type for the MCP plugin.
 */
export interface McpPluginOptions {
  /** Server name in MCP protocol handshake. Default: "routecraft". Machine identifier. */
  name?: string;

  /**
   * Human-readable display title for this MCP server. Defaults to `name` when unset.
   * Used for MCP `serverInfo.title` (where the SDK protocol exposes it) and as
   * the `resource_name` field in RFC 9728 protected-resource metadata.
   */
  title?: string;

  /** Server version. Default: "1.0.0" */
  version?: string;

  /**
   * Human-readable server description, forwarded as MCP `serverInfo.description`.
   * Defaults to `"Powered by Routecraft.dev"` when unset; pass an empty string
   * (`""`) to omit it entirely.
   */
  description?: string;

  /**
   * Server website, forwarded as MCP `serverInfo.websiteUrl`. Defaults to
   * `"https://routecraft.dev"` when unset; pass an empty string (`""`) to omit it.
   */
  websiteUrl?: string;

  /**
   * Server-wide usage guidance, forwarded as the MCP `initialize` result's
   * `instructions`. Clients may inject it into the model's context as a hint
   * (advisory per the spec, not guaranteed). Use it for cross-tool guidance the
   * model cannot infer from individual tool schemas.
   */
  instructions?: string;

  /**
   * Icons identifying this server, forwarded as MCP `serverInfo.icons` and
   * inherited by tools that do not set their own icons. Defaults to the
   * Routecraft logo (light and dark variants) when unset; pass an empty array
   * (`[]`) to serve no icon.
   */
  icons?: McpIcon[];

  /** Transport mode for MCP server. Default: "stdio" */
  transport?: "stdio" | "http";

  /** Port for the streamable-http MCP server. Default: 3001 (only used with transport: "http") */
  port?: number;

  /** Host to bind to. Default: "localhost" (only used with transport: "http") */
  host?: string;

  /**
   * Protected-resource (RFC 9728) metadata for the HTTP transport. When set,
   * the server advertises `/.well-known/oauth-protected-resource` and adds
   * `resource_metadata="..."` to 401 `WWW-Authenticate` headers. Used by both
   * validator and OAuth-proxy auth modes; ignored for stdio.
   *
   * When omitted, baseline metadata is still served (deriving `resource` from
   * the bound URL and `authorization_servers` from the validator's IdP
   * issuer when present).
   */
  resource?: McpResourceOptions;

  /**
   * Authentication for the HTTP transport. When set, every request to `/mcp` must
   * include a valid `Authorization: Bearer <token>` header. Ignored for stdio.
   *
   * @example
   * ```ts
   * import { jwt } from "@routecraft/ai";
   * auth: jwt({ secret: process.env.JWT_SECRET! })
   * ```
   */
  auth?: McpHttpAuthOptions;

  /**
   * CORS configuration for the HTTP transport. Controls which browser origins
   * can read responses from `/mcp`, `/.well-known/oauth-protected-resource`,
   * and the 401 `WWW-Authenticate` hint. Ignored for stdio.
   *
   * Default (when omitted): **loopback-only**. Browser MCP clients on
   * `localhost`, `127.0.0.1`, or `[::1]` (any port, http or https) work out of
   * the box; non-loopback browser origins must be allowlisted explicitly. This
   * is production-safe by construction; see `.standards/security.md` ->
   * "Security defaults policy".
   *
   * - `cors: false` -- disable CORS entirely (e.g. fronted by a CDN/proxy that owns CORS).
   * - `cors: { origin: "https://app.example.com" }` -- exact origin allowlist.
   * - `cors: { origin: ["https://a.example", "https://b.example"] }` -- multi-origin allowlist.
   * - `cors: { origin: "*" }` -- permissive opt-in.
   * - `cors: { origin: (req) => ... }` -- custom resolver.
   *
   * Server-to-server callers (curl, `mcp-remote`, the MCP CLI) are unaffected
   * regardless of this setting because they do not send an `Origin` header.
   *
   * Method, allowed-header, exposed-header, credentials, and preflight-cache
   * values are framework constants and not user-configurable. `WWW-Authenticate`
   * is always exposed so browser clients can read the RFC 9728 hint on a 401.
   *
   * @experimental
   */
  cors?: false | McpCorsOptions;

  /**
   * Filter which tools to expose. Default: all mcp() routes.
   * Can be an array of endpoint names or a filter function.
   */
  tools?: string[] | ((entry: McpLocalToolEntry) => boolean);

  /**
   * Named remote MCP servers for .to(mcp("name:tool")).
   * Keys are server names; values are HTTP or stdio config.
   * Stdio clients are managed as subprocesses with auto-restart.
   * HTTP clients are used for ephemeral tool calls.
   */
  clients?: Record<string, McpClientHttpConfig | McpClientStdioConfig>;

  /**
   * Max auto-restart attempts for stdio clients before giving up.
   * Applies to all stdio clients. Default: 5.
   */
  maxRestarts?: number;

  /**
   * Base delay in ms before the first restart attempt.
   * Subsequent attempts use exponential backoff. Default: 1000.
   */
  restartDelayMs?: number;

  /**
   * Multiplier for exponential backoff between restart attempts.
   * Delay = restartDelayMs * (restartBackoffMultiplier ^ restartCount). Default: 2.
   */
  restartBackoffMultiplier?: number;

  /**
   * Interval in ms to re-list tools from HTTP clients.
   * Set to 0 to disable periodic refresh. Default: 60000 (60s).
   */
  toolRefreshIntervalMs?: number;
}

/**
 * MCP tool annotations describing tool behavior to clients.
 * All properties are hints; clients should not rely on them for correctness or safety.
 *
 * Mirrors the MCP specification (2025-03-26) `ToolAnnotations` shape.
 *
 * @see https://modelcontextprotocol.io/specification/2025-03-26/server/tools#annotations
 */
export interface McpToolAnnotations {
  /** Human-readable title for the tool (used for display in UIs). */
  title?: string;
  /** If true, the tool does not modify any state (default assumed false by clients). */
  readOnlyHint?: boolean;
  /** If true, the tool may perform destructive operations (default assumed true by clients). */
  destructiveHint?: boolean;
  /** If true, calling the tool repeatedly with the same args has no additional effect (default assumed false by clients). */
  idempotentHint?: boolean;
  /** If true, the tool may interact with the "open world" (external systems, network, etc.) (default assumed true by clients). */
  openWorldHint?: boolean;
}

/**
 * Icon reference for an MCP server or tool. Mirrors the MCP specification's
 * `Icon` shape, which is reused by `serverInfo.icons`, `Tool.icons`, and the
 * resource/prompt primitives.
 */
export interface McpIcon {
  /** URL or data URI of the icon. */
  src: string;
  /** MIME type of the icon, e.g. `"image/svg+xml"` or `"image/png"`. */
  mimeType?: string;
  /** One or more icon sizes, e.g. `["48x48"]` or `["48x48", "96x96"]`. */
  sizes?: string[];
  /** The client UI theme this icon is designed for. */
  theme?: "light" | "dark";
}

/**
 * Options for `mcp()` when used as a server in `.from()`.
 *
 * MCP-protocol-specific extras only. Shared discovery fields (title,
 * description, input, output schemas) live on the route via `.title()` /
 * `.description()` / `.input()` / `.output()` and are enforced by the
 * framework; `description` is required for MCP tools and the source will
 * reject a subscribe call whose route has no description set.
 *
 * @experimental
 */
export interface McpServerOptions {
  /**
   * MCP tool annotations describing behavior hints (read-only, destructive, etc.).
   * Forwarded on `tools/list`.
   *
   * @example
   * ```ts
   * .id("list-users")
   * .description("List all users")
   * .from(mcp({ annotations: { readOnlyHint: true, destructiveHint: false } }))
   * ```
   */
  annotations?: McpToolAnnotations;

  /** Icons forwarded on `tools/list` per the MCP spec. */
  icons?: McpIcon[];
}

export type McpOptions = McpServerOptions;

/**
 * Extracts MCP tool arguments from an exchange. Default implementation uses exchange.body.
 */
export type McpArgsExtractor = (
  exchange: Exchange<unknown>,
) => Record<string, unknown>;

/**
 * Options for mcp() when used as a Client in .to() to call a remote MCP server.
 * Provide either url (inline HTTP) or serverId (from plugin/store); tool is required.
 *
 * Supported transports:
 * - **HTTP:** use `url` for an inline endpoint or `serverId` for a named backend.
 * - **Stdio:** use `serverId` referencing a stdio client from mcpPlugin({ clients }).
 *   The destination adapter resolves the manager from the context store and calls
 *   tools directly on the subprocess -- no HTTP involved.
 */
export interface McpClientOptions {
  /** URL of the remote MCP server (HTTP/HTTPS only). Omit when using serverId. */
  url?: string;
  /** Tool name to invoke. If omitted, exchange body may specify it or a default applies. */
  tool?: string;
  /** Server id from context store; resolved to URL at runtime. Use when URL is registered via mcpPlugin({ clients }). */
  serverId?: string;
  /**
   * Extract tool arguments from the exchange. Receives the full exchange.
   * Default: body as object -> use as args; otherwise { input: body }.
   */
  args?: McpArgsExtractor;
  /**
   * Auth credentials for the outbound HTTP connection.
   * When using `serverId`, auth flows automatically from `mcpPlugin({ clients })`
   * so this field is rarely needed. Use it to override registered auth or to
   * supply credentials when using inline `url`.
   */
  auth?: McpClientAuthOptions;
}

/**
 * Represents a tool exposed via MCP
 */
export interface McpTool {
  name: string;
  /** Human-readable display title. */
  title?: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
  /** JSON Schema for the tool output when the route declares one. */
  outputSchema?: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
  /** MCP tool annotations (behavior hints) reported by the server. */
  annotations?: McpToolAnnotations;
  /** Icons forwarded to clients per the MCP spec. */
  icons?: McpIcon[];
}

/**
 * A tool entry in the unified MCP tool registry.
 * Combines local mcp() route tools and remote client tools (stdio and HTTP).
 */
export interface McpToolRegistryEntry {
  /** Tool name (unique within a source, may collide across sources). */
  name: string;
  /** Human-readable description of the tool. */
  description?: string;
  /** JSON Schema for tool input. */
  inputSchema: Record<string, unknown>;
  /** Source server ID (e.g. a stdio/HTTP client name). */
  source: string;
  /**
   * Transport type of the source. stdio/http are populated automatically by mcpPlugin.
   * "local" is reserved for callers who manually register tools with local provenance.
   */
  transport: "stdio" | "http" | "local";
  /** MCP tool annotations (behavior hints). */
  annotations?: McpToolAnnotations;
  /**
   * Capability tags derived from the MCP `annotations` field at
   * registration time. Mirrors the `Tag` namespace fns and direct
   * routes use, so the agent `tools([{ tagged: "read-only" }])`
   * selector matches MCP tools alongside fn/route entries.
   *
   * Mapping: `readOnlyHint -> "read-only"`,
   * `destructiveHint -> "destructive"`, `idempotentHint -> "idempotent"`,
   * `openWorldHint -> "open-world"`.
   *
   * @experimental
   */
  tags?: readonly Tag[];
}

/**
 * MCP tool call result
 */
export interface McpToolResult {
  content: Array<{
    type: "text" | "image" | "resource";
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}

// Re-export Principal for convenience so consumers don't have to import from core.
export type { Principal };
