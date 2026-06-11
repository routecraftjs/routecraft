/**
 * Accepted audience values for `jwt()` and `jwks()`.
 * Pass `"*"` to skip audience validation explicitly (opts out of cross-audience
 * replay protection; use only when the IdP does not emit `aud`).
 */
export type JwtAudience = string | string[] | "*";

/**
 * Per-claim overrides for mapping a verified JWT payload to a {@link Principal}.
 * Each callback receives the decoded payload and returns the value to surface.
 *
 * Use when the IdP places identity claims under non-standard names
 * (e.g. Azure AD uses `oid` instead of `sub`, Keycloak nests roles under
 * `realm_access.roles`).
 */
export interface ClaimMappers {
  /** Map to `Principal.subject`. Default: `payload.sub` then `client_id` then `azp`. */
  subject?: (payload: Record<string, unknown>) => string;
  /** Map to `Principal.clientId`. Default: `payload.client_id` then `azp`. */
  clientId?: (payload: Record<string, unknown>) => string;
  /** Map to `Principal.scopes`. Default: space-split `payload.scope`. */
  scopes?: (payload: Record<string, unknown>) => string[] | undefined;
}

/**
 * Authenticated principal resolved from an incoming request.
 *
 * The `kind` field records how the principal was authenticated (useful for
 * logs and analytics). All variants share the same flat shape -- callers
 * never need to type-narrow on `kind` to access identity fields.
 */
export interface Principal {
  /**
   * How the principal was authenticated. Core verifiers use the known
   * values; ecosystem verifiers may use their own kind strings. The
   * `(string & {})` arm keeps autocomplete on the known set while
   * accepting any value.
   */
  kind: "jwt" | "jwks" | "oauth" | "custom" | (string & {});
  /** HTTP authentication scheme. `"bearer"` for token-based flows; may be another value for custom auth schemes. */
  scheme: "bearer" | string;
  /** Stable identity for the authenticated entity (JWT `sub`, user id, etc.). */
  subject: string;
  /** OAuth client ID (distinct from subject). */
  clientId?: string;
  /** Token issuer (JWT `iss`). */
  issuer?: string;
  /** Intended audiences (JWT `aud`). */
  audience?: string[];
  /** Email address from the `email` claim. */
  email?: string;
  /** Display name from the `name` claim. */
  name?: string;
  /** OAuth 2.0 / JWT scopes. */
  scopes?: string[];
  /** Roles from the `roles` claim. */
  roles?: string[];
  /**
   * Expiry as Unix epoch seconds (JWT `exp`).
   * Required by the MCP SDK bearer middleware when using the OAuth flow.
   */
  expiresAt?: number;
  /** Full decoded JWT payload (when available). */
  claims?: Record<string, unknown>;
  /**
   * Raw OIDC userinfo response (when available). Populated only when
   * `mcpPlugin({ userinfo: ... })` runs in URL or auto-discovery mode and the
   * userinfo endpoint returns a non-empty JSON body. Distinct from `claims`,
   * which always carries the verified JWT payload.
   *
   * Function-mode enrichment is free to merge into this field directly if
   * the user wants the raw upstream response surfaced; the framework does
   * not populate it automatically for the function variant.
   */
  userinfoClaims?: Record<string, unknown>;
}

/**
 * Principal variant that guarantees a known token expiry. Used anywhere a
 * bearer-token lifecycle contract must be expressed at the type level
 * (most notably the OAuth flow: the MCP SDK's bearer middleware requires
 * `expiresAt`).
 */
export type OAuthPrincipal = Principal & { expiresAt: number };

/**
 * Verifies a bearer token and resolves the authenticated principal.
 * Throw to reject access; return a {@link Principal} to allow it.
 * May be synchronous or asynchronous.
 */
export type TokenVerifier = (token: string) => Principal | Promise<Principal>;

/**
 * OAuth-flavoured {@link TokenVerifier}. Guarantees the returned principal
 * carries a known `expiresAt`, which the MCP SDK's bearer middleware
 * requires. Any verifier composed into `oauth({ verify })` must satisfy
 * this shape.
 */
export type OAuthTokenVerifier = (
  token: string,
) => OAuthPrincipal | Promise<OAuthPrincipal>;

/**
 * Validator-based auth: a bearer token verified on every request.
 * Returned by `jwt()` and `jwks()` helpers; also accepted as a plain object
 * with a custom `validator` function.
 *
 * @example
 * ```ts
 * import { jwt } from "@routecraft/routecraft";
 * auth: jwt({ secret: process.env.JWT_SECRET! })
 *
 * // Custom validator -- throw to reject
 * auth: {
 *   validator: async (token) => {
 *     const user = await lookupApiKey(token);
 *     if (!user) throw new Error("unknown token");
 *     return { kind: "custom", scheme: "bearer", subject: user.id };
 *   }
 * }
 * ```
 */
export interface ValidatorAuthOptions {
  /** Verifier called with the raw bearer token on every request. Throw to reject. */
  validator: TokenVerifier;
}

/**
 * OAuth-flavoured {@link ValidatorAuthOptions}. The `validator` is guaranteed
 * to resolve an {@link OAuthPrincipal} (with `expiresAt`). Returned by
 * `jwt()` and `jwks()` because both helpers require `exp` on verified tokens.
 *
 * Structurally a subtype of `ValidatorAuthOptions`, so the same value is
 * also usable in non-OAuth contexts.
 */
export interface OAuthValidatorAuthOptions {
  /** Verifier called with the raw bearer token on every request. Throw to reject. */
  validator: OAuthTokenVerifier;
  /**
   * Expected token issuer(s), surfaced from the underlying helper (`jwt()` /
   * `jwks()`). Read by `mcpPlugin({ userinfo: true })` to locate the OIDC
   * Discovery document. Optional because custom validators may not declare an
   * issuer; if absent, OIDC auto-discovery cannot be used and the caller must
   * pass an explicit userinfo URL or function.
   */
  issuer?: string | string[];
}

// See .standards/type-safety-and-schemas.md#module-augmentation for why this
// targets the package specifier and not a relative path.
declare module "@routecraft/routecraft" {
  interface RoutecraftHeaders {
    /**
     * Authenticated principal resolved from the request, when available.
     *
     * One header carries the entire structured `Principal` rather than ten
     * flat string keys (subject, issuer, audience, ...). The `ex.principal`
     * getter is sugar over reading this header. See
     * `.standards/exchange-state-model.md` for the rationale (cross-cutting
     * concerns get one header key, never a special field).
     */
    "routecraft.auth.principal"?: Principal;
  }
}
