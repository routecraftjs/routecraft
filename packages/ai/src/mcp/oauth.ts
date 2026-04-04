import type {
  McpOAuthAuthOptions,
  OAuthClientInfo,
  OAuthProxyEndpoints,
  OAuthTokenInfo,
} from "./types.ts";

/**
 * Options for the `oauth()` factory.
 *
 * @experimental
 */
export interface OAuthFactoryOptions {
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
 * Built-in OAuth authentication helper for MCP HTTP servers.
 * Configures a full OAuth 2.1 server flow that proxies to an upstream identity
 * provider using the MCP SDK's `ProxyOAuthServerProvider` and `mcpAuthRouter`.
 *
 * Returns an {@link McpHttpAuthOptions} that can be passed directly to
 * `mcpPlugin({ auth: oauth({ ... }) })`.
 *
 * The server will mount OAuth endpoints (`/.well-known/oauth-authorization-server`,
 * `/authorize`, `/token`, `/revoke`) alongside the `/mcp` transport endpoint.
 *
 * @example
 * ```ts
 * import { mcpPlugin, oauth } from "@routecraft/ai";
 *
 * mcpPlugin({
 *   transport: "http",
 *   auth: oauth({
 *     issuerUrl: "https://mcp.example.com",
 *     endpoints: {
 *       authorizationUrl: "https://idp.example.com/authorize",
 *       tokenUrl: "https://idp.example.com/token",
 *     },
 *     verifyAccessToken: async (token) => ({
 *       token,
 *       clientId: "my-client",
 *       scopes: ["read"],
 *     }),
 *     getClient: async (clientId) => ({
 *       client_id: clientId,
 *       redirect_uris: ["http://localhost:3000/callback"],
 *     }),
 *   }),
 * });
 * ```
 *
 * @experimental
 */
export function oauth(options: OAuthFactoryOptions): McpOAuthAuthOptions {
  // Warn when issuerUrl is not HTTPS (OAuth 2.1 requires TLS).
  const issuer = new URL(options.issuerUrl.toString());
  if (issuer.protocol !== "https:") {
    if (process.env["NODE_ENV"] === "production") {
      throw new TypeError("oauth: issuerUrl must use HTTPS in production");
    }
  }

  const result: McpOAuthAuthOptions = {
    provider: "oauth",
    issuerUrl: options.issuerUrl,
    endpoints: options.endpoints,
    verifyAccessToken: options.verifyAccessToken,
    getClient: options.getClient,
    ...(options.baseUrl !== undefined && { baseUrl: options.baseUrl }),
    ...(options.scopesSupported !== undefined && {
      scopesSupported: options.scopesSupported,
    }),
    ...(options.requiredScopes !== undefined && {
      requiredScopes: options.requiredScopes,
    }),
    ...(options.serviceDocumentationUrl !== undefined && {
      serviceDocumentationUrl: options.serviceDocumentationUrl,
    }),
    ...(options.resourceName !== undefined && {
      resourceName: options.resourceName,
    }),
  };

  return result;
}
