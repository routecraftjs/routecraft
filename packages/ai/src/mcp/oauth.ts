import type {
  OAuthPrincipal,
  OAuthTokenVerifier,
  OAuthValidatorAuthOptions,
} from "@routecraft/routecraft";
import type {
  OAuthAuthOptions,
  OAuthClientInfo,
  OAuthProxyEndpoints,
} from "./types.ts";
import { buildEnrichedVerifier, type UserinfoOption } from "./userinfo.ts";

export type { UserinfoFn, UserinfoOption } from "./userinfo.ts";

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
 * - An `OAuthValidatorAuthOptions` (output of `jwt()` or `jwks()`) to compose
 *   a validator-based verifier, or
 * - A raw `OAuthTokenVerifier` function for custom logic.
 *
 * Both shapes guarantee an {@link OAuthPrincipal} with `expiresAt`, which the
 * MCP SDK's bearer middleware requires. The type system rejects verifiers
 * that do not uphold that contract -- no more runtime surprises from a
 * well-typed verifier that forgot to populate `expiresAt`.
 *
 * @experimental
 */
export type OAuthVerifier = OAuthValidatorAuthOptions | OAuthTokenVerifier;

/**
 * Options for the `oauth()` factory.
 *
 * @experimental
 */
export interface OAuthFactoryOptions {
  /** Base URL for OAuth endpoints (defaults to the resolved resource URL). */
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
  /** Scopes required on every request to `/mcp`. Enforcement policy, not metadata. */
  requiredScopes?: string[];
  /**
   * Principal enrichment after `verify` succeeds. Three input shapes:
   *
   * - `true`: auto-discover the userinfo endpoint via OIDC Discovery at
   *   `${issuer}/.well-known/openid-configuration`. Requires the `verify`
   *   helper to expose a single-string `issuer` (`jwks()` / `jwt()` do).
   * - `string | URL`: explicit userinfo endpoint URL. The framework fetches
   *   it with the bearer token and lifts standard OIDC claims (`email`,
   *   `name`, `roles`, etc.) onto the principal.
   * - `(principal, token) => Promise<Partial<OAuthPrincipal>>`: custom
   *   enrichment from any backend (Clerk Backend API, internal DB, etc.).
   *
   * For URL and discovery modes the userinfo response `sub` MUST equal the
   * verified token's `sub` (OIDC Core §5.3.2); mismatches reject the
   * request. Verify wins on `subject`, `issuer`, `audience`, `expiresAt`;
   * other fields are overwritten by the enrichment payload. Results are
   * cached per token and evicted at `principal.expiresAt`. All enrichment
   * errors are fail-closed (the request is rejected; no silent
   * degradation).
   *
   * @experimental
   */
  userinfo?: UserinfoOption;
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
 * Normalise the `verify` option into a `(token) => Promise<OAuthPrincipal>`
 * callback.
 */
function buildVerifier(
  verify: OAuthVerifier,
): (token: string) => Promise<OAuthPrincipal> {
  if (!verify) {
    throw new TypeError(
      "oauth: `verify` is required. Pass jwks(...), jwt(...), or a custom (token) => OAuthPrincipal function.",
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
 *   resource: { url: "https://mcp.example.com" },
 *   auth: oauth({
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
  if (!options.verify) {
    throw new TypeError(
      "oauth: `verify` is required. Pass jwks(...), jwt(...), or a custom (token) => OAuthPrincipal function.",
    );
  }
  const verifyAccessToken =
    options.userinfo !== undefined
      ? buildEnrichedVerifier(options.verify, options.userinfo)
      : buildVerifier(options.verify);
  const getClient = normaliseClientSupplier(options.client);

  const result: OAuthAuthOptions = {
    provider: "oauth",
    endpoints: options.endpoints,
    verifyAccessToken,
    getClient,
    ...(options.baseUrl !== undefined && { baseUrl: options.baseUrl }),
    ...(options.requiredScopes !== undefined && {
      requiredScopes: options.requiredScopes,
    }),
  };

  return result;
}
