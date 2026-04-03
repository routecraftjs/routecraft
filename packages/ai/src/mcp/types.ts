import type {
  DirectRouteMetadata,
  DirectServerOptions,
  Exchange,
} from "@routecraft/routecraft";
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

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [MCP_PLUGIN_REGISTERED]: boolean;
    [ADAPTER_MCP_CLIENT_SERVERS]: Map<
      string,
      McpClientHttpConfig | McpClientStdioConfig | string
    >;
    [MCP_TOOL_REGISTRY]: McpToolRegistry;
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
    /** Authenticated subject (from AuthPrincipal). */
    "routecraft.auth.subject"?: string;
    /** Authentication scheme used. */
    "routecraft.auth.scheme"?: string;
    /** Roles assigned to the authenticated principal. */
    "routecraft.auth.roles"?: string[];
    /** Scopes granted to the authenticated principal. */
    "routecraft.auth.scopes"?: string[];
    /** Email of the authenticated principal. */
    "routecraft.auth.email"?: string;
    /** Display name of the authenticated principal. */
    "routecraft.auth.name"?: string;
    /** Token issuer (JWT `iss`). */
    "routecraft.auth.issuer"?: string;
    /** Intended audience (JWT `aud`). */
    "routecraft.auth.audience"?: string[];
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
 * Use these with `exchange.headers[McpHeadersKeys.AUTH_SUBJECT]` for type-safe access.
 *
 * @example
 * ```ts
 * import { McpHeadersKeys } from '@routecraft/ai'
 *
 * .process((ex) => {
 *   const user = ex.headers[McpHeadersKeys.AUTH_SUBJECT]
 *   const tool = ex.headers[McpHeadersKeys.TOOL]
 * })
 * ```
 */
export enum McpHeadersKeys {
  /** The MCP tool name that triggered this exchange. */
  TOOL = "routecraft.mcp.tool",
  /** The MCP session identifier. */
  SESSION = "routecraft.mcp.session",
  /** Authenticated subject (from AuthPrincipal). */
  AUTH_SUBJECT = "routecraft.auth.subject",
  /** Authentication scheme used. */
  AUTH_SCHEME = "routecraft.auth.scheme",
  /** Roles assigned to the authenticated principal. */
  AUTH_ROLES = "routecraft.auth.roles",
  /** Scopes granted to the authenticated principal. */
  AUTH_SCOPES = "routecraft.auth.scopes",
  /** Email of the authenticated principal. */
  AUTH_EMAIL = "routecraft.auth.email",
  /** Display name of the authenticated principal. */
  AUTH_NAME = "routecraft.auth.name",
  /** Token issuer (JWT `iss`). */
  AUTH_ISSUER = "routecraft.auth.issuer",
  /** Intended audience (JWT `aud`). */
  AUTH_AUDIENCE = "routecraft.auth.audience",
}

/**
 * Authenticated user principal resolved from an incoming request.
 * Returned by the auth validator to populate exchange headers for logging,
 * filtering, and access control inside routes.
 *
 * `subject` and `scheme` are always required; everything else is
 * scheme-dependent and may be absent.
 *
 * @experimental
 */
export interface AuthPrincipal {
  /** Unique user/client identifier (JWT `sub`, username, API key ID, etc.). */
  subject: string;
  /** Authentication scheme that produced this principal. */
  scheme: "bearer" | "basic" | "api-key" | (string & {});
  /** Role names granted to this principal. */
  roles?: string[];
  /** OAuth 2.0 / JWT scopes. */
  scopes?: string[];
  /** Email address, if known. */
  email?: string;
  /** Display name, if known. */
  name?: string;
  /** Token issuer (JWT `iss`). */
  issuer?: string;
  /** Intended audiences (JWT `aud`). */
  audience?: string[];
  /** Expiry as Unix epoch seconds (JWT `exp`, session expiry). */
  expiresAt?: number;
  /** Arbitrary extra claims. For JWTs this holds the full decoded payload. */
  claims?: Record<string, unknown>;
}

/**
 * Token info returned by the OAuth `verifyAccessToken` callback.
 * Mirrors the MCP SDK's `AuthInfo` with only the fields routecraft needs.
 *
 * @experimental
 */
export interface OAuthTokenInfo {
  /** The raw access token string. */
  token: string;
  /** OAuth client ID that obtained this token. */
  clientId: string;
  /** Scopes granted to the token. */
  scopes: string[];
  /** Expiry as Unix epoch seconds. */
  expiresAt?: number;
}

/**
 * OAuth client info returned by the `getClient` callback.
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
 * Validator-based auth: bearer token checked on every request.
 * Used with `jwt()` helper or custom validator functions.
 *
 * @example
 * ```ts
 * import { jwt } from "@routecraft/ai";
 * auth: jwt({ secret: process.env.JWT_SECRET! })
 *
 * // Custom validator
 * auth: {
 *   validator: async (token) => {
 *     const user = await lookupApiKey(token);
 *     if (!user) return null;
 *     return { subject: user.id, scheme: "api-key", roles: user.roles };
 *   }
 * }
 * ```
 *
 * @experimental
 */
export interface McpValidatorAuthOptions {
  /**
   * Validator function called with the raw bearer token on every request.
   *
   * Return an {@link AuthPrincipal} to allow access; return `null` or `false`
   * to reject with 401. May be async.
   *
   * If the function throws, the server responds with 500.
   * Validators should catch expected failures (e.g. JWT expiry) and return `null`.
   */
  validator: McpAuthValidator;
}

/**
 * OAuth provider auth: full OAuth 2.1 server flow with proxy to upstream IdP.
 * Mounts discovery, authorization, token, and revocation endpoints alongside `/mcp`.
 * Uses the MCP SDK's `ProxyOAuthServerProvider` and `mcpAuthRouter` internally.
 *
 * @example
 * ```ts
 * import { oauth } from "@routecraft/ai";
 * auth: oauth({
 *   issuerUrl: "https://mcp.example.com",
 *   endpoints: {
 *     authorizationUrl: "https://idp.example.com/authorize",
 *     tokenUrl: "https://idp.example.com/token",
 *   },
 *   verifyAccessToken: async (token) => ({
 *     token, clientId: "my-client", scopes: ["read"],
 *   }),
 *   getClient: async (clientId) => ({
 *     client_id: clientId, redirect_uris: ["http://localhost:3000/callback"],
 *   }),
 * })
 * ```
 *
 * @experimental
 */
export interface McpOAuthAuthOptions {
  /** Discriminant for the union. Always `"oauth"`. */
  provider: "oauth";
  /** Issuer URL for OAuth metadata discovery. Must be HTTPS in production. */
  issuerUrl: string | URL;
  /** Base URL for OAuth endpoints (defaults to issuerUrl). */
  baseUrl?: string | URL;
  /** Upstream OAuth provider endpoints to proxy. */
  endpoints: OAuthProxyEndpoints;
  /**
   * Verify an access token and return token info.
   * Called on every authenticated request to `/mcp`.
   */
  verifyAccessToken: (token: string) => Promise<OAuthTokenInfo>;
  /**
   * Look up a registered OAuth client by ID.
   * Return `undefined` to reject the client.
   */
  getClient: (clientId: string) => Promise<OAuthClientInfo | undefined>;
  /** OAuth scopes the server advertises as supported. */
  scopesSupported?: string[];
  /** Scopes required on every request to `/mcp`. */
  requiredScopes?: string[];
  /** URL to service documentation (included in OAuth metadata). */
  serviceDocumentationUrl?: string | URL;
  /** Human-readable resource name (included in OAuth metadata). */
  resourceName?: string;
}

/**
 * Authentication options for the MCP HTTP server.
 * Only applies when `transport` is `"http"`. Ignored for stdio.
 *
 * Two strategies are supported:
 * - `Validator`: simple bearer token check via `jwt()` or custom function.
 * - `OAuth`: full OAuth 2.1 server flow via `oauth()`, proxying to an upstream IdP.
 *
 * @experimental
 */
export type McpHttpAuthOptions = McpValidatorAuthOptions | McpOAuthAuthOptions;

/**
 * Type guard: returns `true` when auth is configured for OAuth provider mode.
 */
export function isOAuthAuth(
  auth: McpHttpAuthOptions,
): auth is McpOAuthAuthOptions {
  return "provider" in auth && auth.provider === "oauth";
}

/**
 * A function that validates a bearer token and resolves the authenticated principal.
 * Called on every incoming HTTP request.
 * May be synchronous or asynchronous.
 *
 * Return an {@link AuthPrincipal} to allow access, or `null` / `false` to reject with 401.
 * If the function throws, the server responds with 500.
 *
 * @experimental
 */
export type McpAuthValidator = (
  token: string,
) => AuthPrincipal | null | false | Promise<AuthPrincipal | null | false>;

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
  /** Server name in MCP protocol handshake. Default: "routecraft" */
  name?: string;

  /** Server version. Default: "1.0.0" */
  version?: string;

  /** Transport mode for MCP server. Default: "stdio" */
  transport?: "stdio" | "http";

  /** Port for the streamable-http MCP server. Default: 3001 (only used with transport: "http") */
  port?: number;

  /** Host to bind to. Default: "localhost" (only used with transport: "http") */
  host?: string;

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
   * Filter which tools to expose. Default: all mcp() routes.
   * Can be an array of endpoint names or a filter function.
   */
  tools?: string[] | ((meta: DirectRouteMetadata) => boolean);

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
 * Options for mcp() when used as a server in .from().
 * Description is required for AI/MCP discoverability.
 */
export interface McpServerOptions extends DirectServerOptions {
  /** Human-readable description (required for MCP tools). */
  description: string;
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
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
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
  /** Source server ID. Local mcp() routes use "local". */
  source: string;
  /** Transport type of the source. */
  transport: "stdio" | "http" | "local";
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
