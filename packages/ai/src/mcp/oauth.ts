import type {
  Principal,
  ValidatorAuthOptions,
  TokenVerifier,
} from "@routecraft/routecraft";
import type {
  OAuthAuthOptions,
  OAuthClientInfo,
  OAuthProxyEndpoints,
} from "./types.ts";

/**
 * Supplier for a registered OAuth client.
 *
 * Called **per request** by the MCP SDK's proxy provider during the OAuth
 * flow (authorize, token exchange, revoke) with the incoming `client_id`.
 * Return the matching {@link OAuthClientInfo} or `undefined` to reject the
 * client with a standard OAuth error.
 *
 * Avoid blocking I/O on the hot path when possible. Cache database reads or
 * load the registry at boot.
 *
 * @experimental
 */
export type OAuthClientSupplier = (
  clientId: string,
) => Promise<OAuthClientInfo | undefined> | OAuthClientInfo | undefined;

/**
 * The `verify` option accepted by `oauth()`.
 *
 * Pass:
 * - A `ValidatorAuthOptions` (output of `jwt()` or `jwks()`) to compose a
 *   validator-based verifier, or
 * - A raw `TokenVerifier` function as the escape hatch for custom logic.
 *
 * @experimental
 */
export type OAuthVerifier = ValidatorAuthOptions | TokenVerifier;

/**
 * Options for the `oauth()` factory.
 *
 * @experimental
 */
export interface OAuthFactoryOptions {
  /**
   * Issuer URL for this MCP server's OAuth metadata discovery endpoint.
   * Must be HTTPS in production.
   *
   * Renamed from `issuerUrl` to avoid confusion with the IdP issuer inside
   * the `verify` config.
   */
  resourceIssuerUrl: string | URL;
  /** Base URL for OAuth endpoints (defaults to resourceIssuerUrl). */
  baseUrl?: string | URL;
  /** Upstream OAuth provider endpoints to proxy. */
  endpoints: OAuthProxyEndpoints;
  /**
   * Token verifier for access tokens arriving at `/mcp`.
   *
   * Accept:
   * - `jwks({ jwksUrl, issuer, audience })` -- JWKS-backed verification (the common case)
   * - `jwt({ secret, issuer, audience })` -- static-key verification (rare)
   * - A raw `(token) => Principal | Promise<Principal>` function -- custom logic
   *
   * The verifier is called on every authenticated request.
   */
  verify: OAuthVerifier;
  /**
   * Registered OAuth client(s). Accepts either:
   * - a static {@link OAuthClientInfo} for the single-client case (matched on
   *   `client_id`; unknown IDs are rejected), or
   * - an {@link OAuthClientSupplier} `(clientId) => OAuthClientInfo | undefined`
   *   for dynamic lookup (database, registry, etc.).
   *
   * The supplier is invoked **per request** by the MCP SDK's proxy provider
   * during every authorize/token/revoke call; treat it as a hot path.
   */
  client: OAuthClientInfo | OAuthClientSupplier;
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
 * Normalise the factory-level `client` option into the `(clientId) =>
 * Promise<OAuthClientInfo | undefined>` shape expected by the MCP SDK's
 * `ProxyOAuthServerProvider`.
 *
 * When a static {@link OAuthClientInfo} is supplied, the returned lookup
 * accepts only requests whose `clientId` matches the object's `client_id`;
 * unknown IDs are rejected so an accidental single-client setup cannot
 * silently authorize other clients.
 */
function normaliseClientSupplier(
  input: OAuthClientInfo | OAuthClientSupplier,
): (clientId: string) => Promise<OAuthClientInfo | undefined> {
  if (typeof input === "function") {
    return async (clientId) => input(clientId);
  }
  const staticClient = input;
  return async (clientId) =>
    clientId === staticClient.client_id ? staticClient : undefined;
}

/**
 * Normalise the `verify` option into a `(token) => Promise<Principal>` callback.
 */
function buildVerifier(
  verify: OAuthVerifier,
): (token: string) => Promise<Principal> {
  if (!verify) {
    throw new TypeError(
      "oauth: `verify` is required. Pass jwks(...), jwt(...), or a custom (token) => Principal function.",
    );
  }
  if (typeof verify === "function") {
    return async (token) => verify(token);
  }
  return async (token) => verify.validator(token);
}

/**
 * Built-in OAuth authentication helper for MCP HTTP servers.
 * Configures a full OAuth 2.1 server flow that proxies to an upstream identity
 * provider using the MCP SDK's `ProxyOAuthServerProvider` and `mcpAuthRouter`.
 *
 * Returns an {@link OAuthAuthOptions} that can be passed directly to
 * `mcpPlugin({ auth: oauth({ ... }) })`.
 *
 * The server will mount OAuth endpoints (`/.well-known/oauth-authorization-server`,
 * `/authorize`, `/token`, `/revoke`) alongside the `/mcp` transport endpoint.
 *
 * @example JWKS-backed OAuth (e.g. Clerk)
 * ```ts
 * import { mcpPlugin, oauth, jwks } from "@routecraft/ai";
 *
 * mcpPlugin({
 *   transport: "http",
 *   auth: oauth({
 *     resourceIssuerUrl: "https://mcp.example.com",
 *     endpoints: {
 *       authorizationUrl: "https://idp.example.com/authorize",
 *       tokenUrl: "https://idp.example.com/token",
 *     },
 *     verify: jwks({
 *       jwksUrl: "https://idp.example.com/.well-known/jwks.json",
 *       issuer: "https://idp.example.com",
 *       audience: "https://mcp.example.com",
 *     }),
 *     client: {
 *       client_id: "my-mcp-server",
 *       redirect_uris: ["http://localhost:3000/callback"],
 *     },
 *   }),
 * });
 * ```
 *
 * @example Dynamic client lookup (e.g. DCR, database-backed registry)
 * ```ts
 * oauth({
 *   // ...
 *   client: async (clientId) => await db.clients.findByClientId(clientId),
 * })
 * ```
 *
 * @example Custom verification (opaque tokens, introspection, etc.)
 * ```ts
 * oauth({
 *   resourceIssuerUrl: "https://mcp.example.com",
 *   endpoints: { authorizationUrl: "...", tokenUrl: "..." },
 *   verify: async (token) => {
 *     const principal = await myIntrospectionCall(token);
 *     return {
 *       kind: "custom",
 *       scheme: "bearer",
 *       subject: principal.userId,
 *       clientId: principal.clientId,
 *       expiresAt: principal.exp,
 *     };
 *   },
 *   client: { ... },
 * });
 * ```
 *
 * @experimental
 */
export function oauth(options: OAuthFactoryOptions): OAuthAuthOptions {
  const issuer = new URL(options.resourceIssuerUrl.toString());
  if (
    issuer.protocol !== "https:" &&
    process.env["NODE_ENV"] === "production"
  ) {
    throw new TypeError(
      "oauth: resourceIssuerUrl must use HTTPS in production",
    );
  }

  const verifyAccessToken = buildVerifier(options.verify);
  const getClient = normaliseClientSupplier(options.client);

  const result: OAuthAuthOptions = {
    provider: "oauth",
    resourceIssuerUrl: options.resourceIssuerUrl,
    endpoints: options.endpoints,
    verifyAccessToken,
    getClient,
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
