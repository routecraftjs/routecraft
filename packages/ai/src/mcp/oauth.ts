import type {
  OAuthPrincipal,
  OAuthTokenVerifier,
  OAuthValidatorAuthOptions,
} from "@routecraft/routecraft";
import type { McpHttpAuthOptions } from "./types.ts";

/**
 * The `verify` option accepted by `oauth()`.
 *
 * Pass:
 * - An `OAuthValidatorAuthOptions` (output of `jwt()` or `jwks()`) to compose
 *   a validator-based verifier, or
 * - A raw `OAuthTokenVerifier` function for custom logic.
 *
 * Both shapes guarantee an {@link OAuthPrincipal} with `expiresAt`, so a token
 * that outlives its expiry cannot slip through a well-typed verifier.
 */
export type OAuthVerifier = OAuthValidatorAuthOptions | OAuthTokenVerifier;

/**
 * Options for the `oauth()` factory.
 */
export interface OAuthFactoryOptions {
  /**
   * Token verifier for access tokens arriving at `/mcp`.
   *
   * Accept:
   * - `jwks({ jwksUrl, issuer, audience })` -- JWKS-backed verification (the common case)
   * - `jwt({ secret, issuer, audience })` -- static-key verification (rare)
   * - A raw `(token) => Principal | Promise<Principal>` function -- custom logic
   *
   * The verifier is called on every request: protocol revision 2026-07-28 is
   * stateless, so there is no session in which a past verification could be
   * cached.
   */
  verify: OAuthVerifier;
  /**
   * Authorization Server issuer(s) advertised to clients as
   * `authorization_servers` in the RFC 9728 protected-resource metadata.
   *
   * Optional when `verify` is a `jwks()` / `jwt()` result, which already
   * carries the issuer it validates against. Required when `verify` is a raw
   * function, since nothing else names the IdP a client should authenticate
   * with.
   */
  issuer?: string | string[];
  /**
   * Scopes required on every request to `/mcp`. A token missing any of them is
   * refused with `403 insufficient_scope`.
   */
  requiredScopes?: string[];
}

/** True when the issuer is a non-empty string, or an array of them. */
function isNonEmptyIssuer(issuer: string | string[]): boolean {
  return typeof issuer === "string"
    ? issuer.trim().length > 0
    : issuer.length > 0 && issuer.every((value) => value.trim().length > 0);
}

/**
 * Normalise the `verify` option into a `(token) => Promise<OAuthPrincipal>`
 * callback.
 */
function buildVerifier(
  verify: OAuthVerifier,
): (token: string) => Promise<OAuthPrincipal> {
  const base: (token: string) => Promise<OAuthPrincipal> =
    typeof verify === "function"
      ? async (token) => verify(token)
      : async (token) => verify.validator(token);

  // `OAuthPrincipal` makes `expiresAt` required, so this only fires when the
  // type contract was bypassed (`as any`, a dynamically wired plugin). It is
  // checked here rather than in the shared auth gate because the promise is
  // `oauth()`'s: a plain `validator` may legitimately describe a credential
  // with no expiry, such as an API key.
  return async (token) => {
    const principal = await base(token);
    if (principal.expiresAt === undefined) {
      throw new TypeError(
        "oauth: `verify` returned a principal with no `expiresAt`. A credential " +
          "with no expiry never expires; populate it from the token's `exp` claim " +
          "or introspection response.",
      );
    }
    return principal;
  };
}

/**
 * Built-in OAuth authentication helper for MCP HTTP servers.
 *
 * Configures the MCP server as an OAuth 2.0 **Resource Server**: it verifies
 * bearer tokens on every request, enforces `requiredScopes`, and advertises
 * the Authorization Server through RFC 9728 protected-resource metadata so
 * clients run the authorization flow directly against the IdP.
 *
 * Routecraft does not proxy `/authorize`, `/token`, `/register` or `/revoke`.
 * Protocol revision 2026-07-28 deprecated Dynamic Client Registration in
 * favour of Client ID Metadata Documents and steers MCP servers towards
 * delegating to a dedicated provider, so those endpoints belong to the IdP.
 * A client discovers the IdP from the metadata document this server publishes
 * and from the `resource_metadata` hint on a `401`.
 *
 * Returns an {@link McpHttpAuthOptions} for `mcpPlugin({ auth: oauth({...}) })`.
 * It is a thin, explicit layer over the same options `jwks()` / `jwt()`
 * produce: reach for it when you want `requiredScopes` enforcement or an
 * explicit issuer, and pass the validator directly otherwise.
 *
 * @example JWKS-backed verification (e.g. Clerk, Auth0, WorkOS)
 * ```ts
 * import { mcpPlugin, oauth, jwks } from "@routecraft/ai";
 *
 * mcpPlugin({
 *   transport: "http",
 *   resource: { url: "https://mcp.example.com" },
 *   auth: oauth({
 *     verify: jwks({
 *       jwksUrl: "https://idp.example.com/.well-known/jwks.json",
 *       issuer: "https://idp.example.com",
 *       audience: "https://mcp.example.com",
 *     }),
 *     requiredScopes: ["mcp:invoke"],
 *   }),
 * });
 * ```
 *
 * @example Custom verification (opaque tokens, introspection)
 * ```ts
 * oauth({
 *   issuer: "https://idp.example.com",
 *   verify: async (token) => {
 *     const introspected = await myIntrospectionCall(token);
 *     return {
 *       kind: "custom",
 *       scheme: "bearer",
 *       subject: introspected.userId,
 *       clientId: introspected.clientId,
 *       expiresAt: introspected.exp,
 *     };
 *   },
 * });
 * ```
 */
export function oauth(options: OAuthFactoryOptions): McpHttpAuthOptions {
  if (!options.verify) {
    throw new TypeError(
      "oauth: `verify` is required. Pass jwks(...), jwt(...), or a custom (token) => OAuthPrincipal function.",
    );
  }

  // A raw verifier names no issuer, so without an explicit one the metadata
  // document would advertise no Authorization Server and a client could not
  // discover where to authenticate. Fail at construction rather than serving
  // an undiscoverable resource.
  const issuer =
    options.issuer ??
    (typeof options.verify === "function" ? undefined : options.verify.issuer);
  if (issuer === undefined || !isNonEmptyIssuer(issuer)) {
    throw new TypeError(
      "oauth: a non-empty `issuer` is required. Pass the Authorization Server " +
        "issuer explicitly, or use jwks(...) / jwt(...), which carry their own. " +
        "Without it the RFC 9728 metadata document advertises no authorization " +
        "server and clients cannot discover where to authenticate.",
    );
  }

  const resolved: McpHttpAuthOptions = {
    validator: buildVerifier(options.verify),
    issuer,
  };
  if (options.requiredScopes && options.requiredScopes.length > 0) {
    resolved.requiredScopes = options.requiredScopes;
  }
  return resolved;
}
