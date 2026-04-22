/**
 * Accepted audience values for `jwt()` and `jwks()`.
 * Pass `"*"` to skip audience validation explicitly (opts out of cross-audience
 * replay protection; use only when the IdP does not emit `aud`).
 *
 * @experimental
 */
export type JwtAudience = string | string[] | "*";

/**
 * Per-claim overrides for mapping a verified JWT payload to a {@link Principal}.
 * Each callback receives the decoded payload and returns the value to surface.
 *
 * Use when the IdP places identity claims under non-standard names
 * (e.g. Azure AD uses `oid` instead of `sub`, Keycloak nests roles under
 * `realm_access.roles`).
 *
 * @experimental
 */
export interface ClaimMappers {
  /** Map to `Principal.subject`. Default: `payload.sub` then `client_id` then `azp`. */
  subject?: (payload: Record<string, unknown>) => string;
  /** Map to `Principal.clientId`. Default: `payload.client_id` then `azp`. */
  clientId?: (payload: Record<string, unknown>) => string;
  /** Map to `Principal.email`. Default: `payload.email`. */
  email?: (payload: Record<string, unknown>) => string | undefined;
  /** Map to `Principal.name`. Default: `payload.name`. */
  name?: (payload: Record<string, unknown>) => string | undefined;
  /** Map to `Principal.scopes`. Default: space-split `payload.scope`. */
  scopes?: (payload: Record<string, unknown>) => string[] | undefined;
  /** Map to `Principal.roles`. Default: `payload.roles` when it is `string[]`. */
  roles?: (payload: Record<string, unknown>) => string[] | undefined;
}

/**
 * Authenticated principal resolved from an incoming request.
 *
 * The `kind` field records how the principal was authenticated (useful for
 * logs and analytics). All variants share the same flat shape -- callers
 * never need to type-narrow on `kind` to access identity fields.
 *
 * @experimental
 */
export interface Principal {
  /** How the principal was authenticated. */
  kind: "jwt" | "jwks" | "oauth" | "custom";
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
}

/**
 * Principal variant that guarantees a known token expiry. Used anywhere a
 * bearer-token lifecycle contract must be expressed at the type level
 * (most notably the OAuth flow: the MCP SDK's bearer middleware requires
 * `expiresAt`).
 *
 * @experimental
 */
export type OAuthPrincipal = Principal & { expiresAt: number };

/**
 * Verifies a bearer token and resolves the authenticated principal.
 * Throw to reject access; return a {@link Principal} to allow it.
 * May be synchronous or asynchronous.
 *
 * @experimental
 */
export type TokenVerifier = (token: string) => Principal | Promise<Principal>;

/**
 * OAuth-flavoured {@link TokenVerifier}. Guarantees the returned principal
 * carries a known `expiresAt`, which the MCP SDK's bearer middleware
 * requires. Any verifier composed into `oauth({ verify })` must satisfy
 * this shape.
 *
 * @experimental
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
 *
 * @experimental
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
 *
 * @experimental
 */
export interface OAuthValidatorAuthOptions {
  /** Verifier called with the raw bearer token on every request. Throw to reject. */
  validator: OAuthTokenVerifier;
}

// See .standards/type-safety-and-schemas.md#module-augmentation for why this
// targets the package specifier and not a relative path.
declare module "@routecraft/routecraft" {
  interface RoutecraftHeaders {
    /** Authenticated subject (from Principal). */
    "routecraft.auth.subject"?: string;
    /** Authentication scheme used (e.g. "bearer"). */
    "routecraft.auth.scheme"?: string;
    /** Authentication kind (jwt | jwks | oauth | custom). */
    "routecraft.auth.kind"?: string;
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
