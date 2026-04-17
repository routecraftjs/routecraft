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
    /** OAuth client ID (distinct from subject). */
    "routecraft.auth.client_id"?: string;
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
  /** OAuth client ID (distinct from subject). */
  AUTH_CLIENT_ID = "routecraft.auth.client_id",
}

/**
 * Fields shared by every {@link AuthPrincipal} subtype. Only `kind`, `scheme`,
 * and `subject` are universal; scheme-specific fields live on the subtypes
 * (narrow on `kind` to reach them).
 *
 * @experimental
 */
export interface BaseAuthPrincipal {
  /** Discriminator for the principal subtype. Narrow on this to reach scheme-specific fields. */
  kind: "jwt" | "oauth" | "api-key" | "basic" | "custom";
  /** HTTP authentication scheme that produced this principal. */
  scheme: "bearer" | "basic" | "api-key" | (string & {});
  /** Stable identity for the authenticated entity (JWT `sub`, user id, key id, etc.). */
  subject: string;
}

/**
 * Principal produced by a verified JWT (validator path).
 *
 * @experimental
 */
export interface JwtPrincipal extends BaseAuthPrincipal {
  kind: "jwt";
  scheme: "bearer";
  /** Display name from the `name` claim, if present. */
  name?: string;
  /** Email address from the `email` claim, if present. */
  email?: string;
  /** Token issuer (JWT `iss`). */
  issuer?: string;
  /** Intended audiences (JWT `aud`). */
  audience?: string[];
  /** OAuth 2.0 / JWT scopes. */
  scopes?: string[];
  /** Roles from the `roles` claim, if present. */
  roles?: string[];
  /** Expiry as Unix epoch seconds (JWT `exp`). */
  expiresAt?: number;
  /** Full decoded JWT payload. */
  claims: Record<string, unknown>;
}

/**
 * Principal produced by the OAuth 2.1 server path. Carries OAuth-specific data
 * (`clientId`) alongside the verified-token identity fields.
 *
 * @experimental
 */
export interface OAuthPrincipal extends BaseAuthPrincipal {
  kind: "oauth";
  scheme: "bearer";
  /** OAuth client ID that obtained the access token (distinct from `subject`). */
  clientId: string;
  /** Display name, if extracted from the verified access token. */
  name?: string;
  /** Email address, if extracted from the verified access token. */
  email?: string;
  /** Token issuer, when the access token carries one. */
  issuer?: string;
  /** Intended audiences, when the access token carries them. */
  audience?: string[];
  /** Scopes granted on the access token. */
  scopes?: string[];
  /** Roles, if extracted from the verified access token. */
  roles?: string[];
  /** Token expiry as Unix epoch seconds. */
  expiresAt?: number;
  /** Full decoded JWT payload, when the access token was a verified JWT. */
  claims?: Record<string, unknown>;
}

/**
 * Principal produced by API-key authentication.
 *
 * @experimental
 */
export interface ApiKeyPrincipal extends BaseAuthPrincipal {
  kind: "api-key";
  scheme: "api-key";
  /** Human-readable key label, if configured. */
  name?: string;
  /** Key expiry as Unix epoch seconds, if set. */
  expiresAt?: number;
}

/**
 * Principal produced by HTTP Basic authentication.
 *
 * @experimental
 */
export interface BasicPrincipal extends BaseAuthPrincipal {
  kind: "basic";
  scheme: "basic";
  /** Display name, if distinct from `subject`. */
  name?: string;
}

/**
 * Catch-all principal for custom validator returns that do not fit another subtype.
 * Use this when writing a bespoke validator; richer subtypes are preferred when applicable.
 *
 * @experimental
 */
export interface CustomPrincipal extends BaseAuthPrincipal {
  kind: "custom";
  name?: string;
  email?: string;
  roles?: string[];
  scopes?: string[];
  expiresAt?: number;
  claims?: Record<string, unknown>;
}

/**
 * Authenticated principal resolved from an incoming request. Discriminated on
 * `kind`: narrow to reach scheme-specific fields.
 *
 * @example
 * ```ts
 * if (principal.kind === "jwt") {
 *   // principal.claims is typed Record<string, unknown>
 *   console.log(principal.claims["custom_claim"]);
 * }
 * ```
 *
 * @experimental
 */
export type AuthPrincipal =
  | JwtPrincipal
  | OAuthPrincipal
  | ApiKeyPrincipal
  | BasicPrincipal
  | CustomPrincipal;

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
 * Per-claim overrides for mapping a verified JWT payload to an
 * {@link OAuthPrincipal}. Each callback receives the decoded payload and
 * returns the value to surface on the principal.
 *
 * Use this when the IdP places identity claims under non-standard names
 * (e.g. Azure AD uses `oid` instead of `sub` for stable subject identity,
 * Keycloak nests roles under `realm_access.roles`).
 *
 * @experimental
 */
export interface OAuthJwtClaimMappers {
  /** Map to `OAuthPrincipal.subject`. Default: `payload.sub`. */
  subject?: (payload: Record<string, unknown>) => string;
  /** Map to `OAuthPrincipal.clientId`. Default: `payload.client_id`. */
  clientId?: (payload: Record<string, unknown>) => string;
  /** Map to `OAuthPrincipal.email`. Default: `payload.email`. */
  email?: (payload: Record<string, unknown>) => string | undefined;
  /** Map to `OAuthPrincipal.name`. Default: `payload.name`. */
  name?: (payload: Record<string, unknown>) => string | undefined;
  /** Map to `OAuthPrincipal.scopes`. Default: space-split `payload.scope`. */
  scopes?: (payload: Record<string, unknown>) => string[] | undefined;
  /** Map to `OAuthPrincipal.roles`. Default: `payload.roles` when it is `string[]`. */
  roles?: (payload: Record<string, unknown>) => string[] | undefined;
}

/**
 * Built-in JWT verification config for the `oauth()` factory. When provided,
 * the factory handles JWKS fetching, signature verification, issuer/audience
 * checks, and payload-to-principal mapping internally.
 *
 * Requires the optional peer dependency `jose`.
 *
 * `issuer` and `audience` are required so the server cannot silently accept
 * tokens from a different IdP or minted for a different resource.
 *
 * For opaque tokens, introspection-based verification, or fully custom
 * claim handling, use `verifyAccessToken` on the factory options instead.
 *
 * @experimental
 */
export interface OAuthJwtConfig {
  /**
   * JWKS endpoint URL used to fetch the IdP's signing keys.
   * Keys are cached and rotated by `jose`'s `createRemoteJWKSet`.
   */
  jwksUrl: string | URL;
  /**
   * Expected `iss` claim. Required. Tokens whose issuer does not match are
   * rejected, preventing cross-issuer replay.
   */
  issuer: string;
  /**
   * Expected `aud` claim. Required. Tokens whose audience does not include
   * this value are rejected, preventing cross-audience replay.
   */
  audience: string | string[];
  /**
   * Clock skew tolerance (seconds) applied to `exp` and `nbf` validation.
   * Passed through to `jose`'s `jwtVerify`. Default: no tolerance.
   */
  clockTolerance?: number | string;
  /** Optional per-claim overrides for non-standard IdPs. */
  claims?: OAuthJwtClaimMappers;
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
 *   jwt: {
 *     jwksUrl: "https://idp.example.com/.well-known/jwks.json",
 *     issuer: "https://idp.example.com",
 *     audience: "https://mcp.example.com",
 *   },
 *   client: {
 *     client_id: "my-mcp-server",
 *     redirect_uris: ["http://localhost:3000/callback"],
 *   },
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
   * Verify an access token and return a populated {@link OAuthPrincipal}.
   * Called on every authenticated request to `/mcp`.
   *
   * The returned principal flows through to route exchanges as
   * `routecraft.auth.*` headers. `expiresAt` is required by the MCP SDK's
   * bearer middleware; omitting it causes a 401 regardless of other claims.
   */
  verifyAccessToken: (token: string) => Promise<OAuthPrincipal>;
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
 * Options for mcp() when used as a server in .from().
 * Description is required for AI/MCP discoverability.
 */
export interface McpServerOptions extends DirectServerOptions {
  /** Human-readable description (required for MCP tools). */
  description: string;

  /**
   * MCP tool annotations describing behavior hints (read-only, destructive, etc.).
   * Passed to MCP clients in the tool listing response.
   *
   * @example
   * ```ts
   * .from(mcp("list-users", {
   *   description: "List all users",
   *   annotations: { readOnlyHint: true, destructiveHint: false },
   * }))
   * ```
   */
  annotations?: McpToolAnnotations;
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
  /** MCP tool annotations (behavior hints) reported by the server. */
  annotations?: McpToolAnnotations;
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
