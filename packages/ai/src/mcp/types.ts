import type { Exchange, Tag } from "@routecraft/routecraft";
import type { Principal, ValidatorAuthOptions } from "@routecraft/routecraft";
import type { ToolGuard } from "../fn/types.ts";
import { TOOL_NAME_PATTERN } from "../tool-name.ts";
import type { McpCorsOptions } from "./cors.ts";
import type { McpToolRegistry } from "./tool-registry.ts";
import type { UserinfoOption } from "./userinfo.ts";

/**
 * Characters allowed in an MCP tool name. Enforced on route ids by the
 * `mcp()` source and on exposed proxied-tool names by the proxy
 * resolver.
 *
 * An alias for the package-wide {@link TOOL_NAME_PATTERN}: the MCP
 * surface and the agent surface answer to the same provider constraint,
 * so they share one definition rather than restating it. Kept under the
 * MCP name because it is part of this module's published surface.
 */
export const MCP_TOOL_NAME_PATTERN = TOOL_NAME_PATTERN;

/**
 * The tool-calling surface of a managed stdio client, as stored under
 * {@link MCP_STDIO_MANAGERS}. `callTool` returns extracted content;
 * `callToolRaw` returns the raw MCP result for verbatim passthrough.
 */
export interface McpStdioToolCaller {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  callToolRaw(
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpRawToolResult>;
}

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
 */
export const MCP_LOCAL_TOOL_REGISTRY = Symbol.for(
  "routecraft.mcp.local-tool-registry",
);

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
    [MCP_STDIO_MANAGERS]: Map<string, McpStdioToolCaller>;
  }

  interface RoutecraftHeaders {
    /** The MCP tool name that triggered this exchange. */
    "routecraft.mcp.tool"?: string;
    /** Correlation id for the single MCP request that produced this exchange. */
    "routecraft.mcp.request"?: string;
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

/**
 * Union of client configs accepted by mcpPlugin({ clients }).
 */
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
  /** Correlation id for the single MCP request that produced this exchange. */
  REQUEST = "routecraft.mcp.request",
}

/**
 * Protected-resource (RFC 9728) metadata for the MCP server.
 *
 * Used by every auth helper to populate
 * `/.well-known/oauth-protected-resource` and the `resource_metadata`
 * parameter on 401 responses. Orthogonal to the auth mode: identifies WHAT
 * is being protected, not HOW it authenticates.
 *
 * When omitted entirely, the framework still advertises a baseline metadata
 * document built from the bound URL and the IdP issuer surfaced by
 * `jwks()` / `jwt()` / `oauth()`.
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
 * Authentication options for the MCP HTTP server.
 * Only applies when `transport` is `"http"`. Ignored for stdio.
 *
 * The MCP server is an OAuth 2.0 **Resource Server**: it verifies bearer
 * tokens and advertises its Authorization Server via RFC 9728 metadata, so
 * clients run the OAuth flow directly against the IdP. Build the options with
 * `jwks()`, `jwt()`, a custom validator, or the `oauth()` helper (which layers
 * `requiredScopes` and issuer advertisement over any of those).
 */
export type McpHttpAuthOptions = ValidatorAuthOptions & {
  /**
   * IdP issuer(s) advertised as `authorization_servers` in the RFC 9728
   * protected-resource metadata, and used to resolve the OIDC Discovery
   * document for plugin-level `mcpPlugin({ userinfo: true })`. Surfaced
   * automatically by `jwks()` / `jwt()` / `oauth()`.
   */
  issuer?: string | string[];
  /**
   * Scopes required on every request to `/mcp`. A token missing any of them
   * is refused with `403 insufficient_scope` (RFC 6750 §3.1), distinct from
   * the `401` an unauthenticated or invalid token receives.
   *
   * Enforcement policy, not metadata: advertise the scopes a client may ask
   * for via `mcpPlugin({ resource: { scopesSupported } })`.
   */
  requiredScopes?: string[];
  /**
   * Clock skew allowed when the server re-checks the verified principal's
   * `expiresAt`. Surfaced automatically by `jwks()` / `jwt()` / `oauth()` from
   * the tolerance the verifier itself applied, so the gate does not refuse a
   * token the verifier accepted within skew. Defaults to `0`, matching
   * `authorize({ clockToleranceSec })`.
   */
  clockToleranceSec?: number;
};

/**
 * A function that provides a bearer token for outbound requests.
 * Called on every request; may be synchronous or asynchronous.
 * Useful for dynamic tokens (JWT refresh, rotating API keys, etc.).
 */
export type McpClientTokenProvider = () => string | Promise<string>;

/**
 * Auth config for an outbound MCP HTTP client connection.
 * Passed as request headers on every connection to the remote server.
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

  /** Named server to mount the HTTP transport on. Defaults to `"default"`. */
  server?: string;

  /** HTTP path for the MCP endpoint. Defaults to `"/mcp"`. */
  path?: string;

  /**
   * Protected-resource (RFC 9728) metadata for the HTTP transport. When set,
   * the server advertises `/.well-known/oauth-protected-resource` and adds
   * `resource_metadata="..."` to 401 `WWW-Authenticate` headers. Used by every
   * auth helper; ignored for stdio.
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
  auth?: McpHttpAuthOptions | false;

  /**
   * Principal enrichment that runs after `auth` verifies a token, for the
   * HTTP transport. Orthogonal to the auth mode: works with `jwks()` /
   * `jwt()` (validator mode), a custom `{ validator }`, and `oauth()`.
   * Three input shapes:
   *
   * - `true`: auto-discover the userinfo endpoint via OIDC Discovery at
   *   `${issuer}/.well-known/openid-configuration`. Requires the verifier to
   *   expose a single-string `issuer` (`jwks()` / `jwt()` do).
   * - `string | URL`: explicit userinfo endpoint URL. The framework fetches
   *   it with the bearer token and lifts standard OIDC claims (`email`,
   *   `name`, `roles`) onto the principal.
   * - `(principal, token) => Promise<Partial<Principal>>`: custom enrichment
   *   from any backend (WorkOS / Clerk Backend API, internal DB, etc.).
   *
   * For URL and discovery modes the userinfo response `sub` MUST equal the
   * verified token's `sub` (OIDC Core §5.3.2); mismatches reject the
   * request. Verify wins on `subject`, `issuer`, `audience`, `expiresAt`,
   * `claims`; other fields are overwritten by the enrichment, and the raw
   * userinfo response is surfaced on `principal.userinfoClaims`. Results are
   * cached per token (SHA-256 keyed) and evicted at `expiresAt`; concurrent
   * requests for the same token share one in-flight fetch. All enrichment
   * errors are fail-closed (the request is rejected). Defaults to no
   * enrichment.
   */
  userinfo?: UserinfoOption;

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
   * Proxy selected tools from registered `clients` through this MCP server,
   * without writing a route per tool. Each entry is either a ref string or a
   * config object with per-tool overrides:
   *
   * - `"server:tool"` -- proxy one tool from a registered client.
   * - `"server:*"` or `"server"` -- proxy every tool the client advertises.
   * - `{ ref: "server:tool", name?, description?, annotations? }` -- proxy one
   *   tool with overrides (exact refs only; wildcards cannot be renamed).
   *
   * Proxied tools appear in `tools/list` under their original name (or the
   * `name` override) with the remote schema, description, and annotations
   * passed through. `tools/call` dispatches over the client's registered
   * transport and auth, and the remote result (content, structuredContent,
   * isError) is returned verbatim.
   *
   * Selection resolves against the live tool registry, so wildcard entries
   * follow tool refresh and stdio restarts. An exact ref and a wildcard
   * covering the same remote tool compose: the exact entry's overrides and
   * guard win regardless of config order. Collisions between different
   * remote tools on one exposed name are deterministic: a local
   * `.from(mcp())` route always wins over a proxied tool, and earlier
   * `proxy` entries win over later ones (a warning is logged either way;
   * use the `name` override to disambiguate). Exposed names must match
   * `[A-Za-z0-9_-]{1,64}`; a remote tool whose own name does not conform
   * is skipped with a warning unless renamed via an exact entry's `name`.
   *
   * Trust boundary: the caller's authenticated principal is NOT forwarded to
   * the remote server; the Routecraft -> MCP hop authenticates with the
   * client's registered `auth`. Route-scope guardrails (`authorize()`, input
   * validation, throttling) do not run for proxied calls, but a per-entry
   * `guard` can reject a call by caller identity before it dispatches (same
   * contract as the agent's `tools([{ name, guard }])`). Proxy simple,
   * read-only tools, guard the ones that need an identity check, and put
   * anything needing stateful guardrails behind a `.from(mcp())` route.
   */
  proxy?: Array<string | McpProxyToolConfig>;

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
 * Config-object form of an `mcpPlugin({ proxy })` entry. Proxies one tool
 * from a registered client with optional overrides for how it is exposed.
 */
export interface McpProxyToolConfig {
  /**
   * Tool reference: `"server:tool"` for one tool, or `"server:*"` / `"server"`
   * for every tool the client advertises. `server` must be a key of
   * `mcpPlugin({ clients })`.
   */
  ref: string;
  /**
   * Exposed tool name override. Defaults to the remote tool's own name.
   * Must match `[A-Za-z0-9_-]{1,64}` and is invalid on wildcard refs.
   */
  name?: string;
  /**
   * Description override shown in `tools/list`. Defaults to the remote
   * tool's description. Invalid on wildcard refs.
   */
  description?: string;
  /**
   * Annotation overrides merged over the remote tool's annotations
   * (per-key; an override key wins over the remote value).
   */
  annotations?: McpToolAnnotations;
  /**
   * Guard run before the call is dispatched to the remote server. Same
   * contract as the agent's `tools([{ name, guard }])`: receives the raw
   * tool arguments and a handler context carrying the MCP caller's
   * read-only `principal` (when the HTTP transport authenticated one);
   * throw to reject the call, which surfaces to the client as an
   * `isError` result. On a wildcard ref the guard is attached to every
   * expanded tool.
   */
  guard?: ToolGuard;
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
  /** Human-readable display title reported by the source server. */
  title?: string;
  /** Human-readable description of the tool. */
  description?: string;
  /** JSON Schema for tool input. */
  inputSchema: Record<string, unknown>;
  /** JSON Schema for tool output, when the source server reports one. */
  outputSchema?: Record<string, unknown>;
  /** Icons reported by the source server. */
  icons?: McpIcon[];
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
   * routes use; surfaced on `ToolsCatalog.mcp[].tags` for the builder
   * form of `tools((catalog) => ...)` so MCP tools can be filtered
   * alongside fn / route entries.
   *
   * Mapping: `readOnlyHint -> "read-only"`,
   * `destructiveHint -> "destructive"`, `idempotentHint -> "idempotent"`,
   * `openWorldHint -> "open-world"`.
   */
  tags?: readonly Tag[];
}

/**
 * Raw MCP `tools/call` result as returned by the SDK, before any content
 * extraction. Used by the raw dispatch path so proxied tool calls can pass
 * the remote result through verbatim (content array of any spec type,
 * structured content, and the error flag).
 */
export interface McpRawToolResult {
  content?: Array<{
    type: string;
    text?: string;
    data?: string;
    [key: string]: unknown;
  }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
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
