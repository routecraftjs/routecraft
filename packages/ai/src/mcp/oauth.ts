import type {
  McpOAuthAuthOptions,
  OAuthClientInfo,
  OAuthJwtClaimMappers,
  OAuthJwtConfig,
  OAuthPrincipal,
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
 * Base options shared by every shape of `oauth()` factory call.
 */
interface OAuthFactoryBaseOptions {
  /** Issuer URL for OAuth metadata discovery. Must be HTTPS in production. */
  issuerUrl: string | URL;
  /** Base URL for OAuth endpoints (defaults to issuerUrl). */
  baseUrl?: string | URL;
  /** Upstream OAuth provider endpoints to proxy. */
  endpoints: OAuthProxyEndpoints;
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
 * Built-in JWT variant of the `oauth()` factory options.
 */
interface OAuthFactoryJwtOptions extends OAuthFactoryBaseOptions {
  /**
   * Built-in JWT verification. Requires the optional peer dependency `jose`.
   * `issuer` and `audience` are required and enforced.
   */
  jwt: OAuthJwtConfig;
  verifyAccessToken?: never;
}

/**
 * Custom verifier variant of the `oauth()` factory options.
 */
interface OAuthFactoryCustomOptions extends OAuthFactoryBaseOptions {
  /**
   * Verify an access token and return a populated {@link OAuthPrincipal}.
   * Called on every authenticated request to `/mcp`.
   *
   * Populate `subject` from the end-user identity (e.g. JWT `sub`), not the
   * OAuth `client_id`; `clientId` is a separate field on `OAuthPrincipal`.
   * All identity fields (`email`, `name`, `issuer`, `audience`, `claims`, etc.)
   * surface on the route exchange as `routecraft.auth.*` headers.
   *
   * The `expiresAt` field is required by the MCP SDK's bearer middleware;
   * omitting it causes the request to be rejected with 401 regardless of
   * other claim values.
   */
  verifyAccessToken: (token: string) => Promise<OAuthPrincipal>;
  jwt?: never;
}

/**
 * Options for the `oauth()` factory.
 *
 * Pass **either** `jwt` (built-in JWT verification, handles JWKS and claim
 * mapping internally) **or** `verifyAccessToken` (custom validator for opaque
 * tokens, introspection, or non-standard flows). Never both.
 *
 * @experimental
 */
export type OAuthFactoryOptions =
  | OAuthFactoryJwtOptions
  | OAuthFactoryCustomOptions;

/** String coercion helper: returns `value` when it is a non-empty string. */
function stringClaim(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Internal helper: map a verified JWT payload to an {@link OAuthPrincipal}
 * using standard claim names plus optional per-claim overrides.
 *
 * Subject fallback order: `claims.subject(payload)` -> `sub` -> `client_id`
 * -> `azp`. Client-ID fallback order: `claims.clientId(payload)` -> `client_id`
 * -> `azp` -> `sub`. This matches RFC 9068, where `client_id` is OPTIONAL on
 * JWT access tokens, and accommodates client-credentials tokens (often no
 * `sub`) and IdPs that emit only `azp` (Google ID tokens, some Auth0 flows).
 *
 * Exported only so the test suite can exercise the mapping directly. Not
 * part of the package's public API; use the `jwt` factory option or write
 * a custom `verifyAccessToken` callback instead.
 *
 * @internal
 */
export function oauthPrincipalFromJwtPayload(
  payload: Record<string, unknown>,
  claims?: OAuthJwtClaimMappers,
): OAuthPrincipal {
  const sub = stringClaim(payload["sub"]);
  const payloadClientId = stringClaim(payload["client_id"]);
  const azp = stringClaim(payload["azp"]);

  const subject = claims?.subject?.(payload) ?? sub ?? payloadClientId ?? azp;
  if (typeof subject !== "string" || subject.length === 0) {
    throw new TypeError(
      "oauth({ jwt }): verified token has no subject. Expected `sub`, `client_id`, or `azp`; provide claims.subject to map from a non-standard field.",
    );
  }

  const clientId =
    claims?.clientId?.(payload) ?? payloadClientId ?? azp ?? sub ?? subject;

  const audienceRaw = payload["aud"];
  const audience = Array.isArray(audienceRaw)
    ? audienceRaw.filter((a): a is string => typeof a === "string")
    : typeof audienceRaw === "string"
      ? [audienceRaw]
      : undefined;

  const principal: OAuthPrincipal = {
    kind: "oauth",
    scheme: "bearer",
    subject,
    clientId,
    claims: payload,
  };

  const email = claims?.email?.(payload) ?? payload["email"];
  if (typeof email === "string") principal.email = email;

  const name = claims?.name?.(payload) ?? payload["name"];
  if (typeof name === "string") principal.name = name;

  if (typeof payload["iss"] === "string") principal.issuer = payload["iss"];
  if (audience !== undefined) principal.audience = audience;
  if (typeof payload["exp"] === "number") principal.expiresAt = payload["exp"];

  const scopes =
    claims?.scopes?.(payload) ??
    (typeof payload["scope"] === "string"
      ? (payload["scope"] as string).split(" ").filter(Boolean)
      : undefined);
  if (scopes !== undefined) principal.scopes = scopes;

  const roles =
    claims?.roles?.(payload) ??
    (Array.isArray(payload["roles"])
      ? (payload["roles"] as unknown[]).filter(
          (r): r is string => typeof r === "string",
        )
      : undefined);
  if (roles !== undefined) principal.roles = roles;

  return principal;
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
 * Narrow subset of `jose` the built-in JWT verifier uses. Declared so the
 * verifier has real types even when the optional peer dependency is not
 * resolvable at compile time.
 */
interface JoseSubset {
  createRemoteJWKSet: (
    url: URL,
  ) => (header: unknown, input: unknown) => Promise<unknown>;
  jwtVerify: (
    token: string,
    key: unknown,
    options: {
      issuer: string;
      audience: string | string[];
      clockTolerance?: number | string;
    },
  ) => Promise<{ payload: Record<string, unknown> }>;
}

/**
 * Build a `verifyAccessToken` callback from a JWKS-backed JWT config.
 * Lazy-loads `jose` on first call so the factory itself stays synchronous
 * and `jose` remains an optional peer dependency.
 */
function buildJwtVerifyAccessToken(
  config: OAuthJwtConfig,
): (token: string) => Promise<OAuthPrincipal> {
  let joseMod: JoseSubset | null = null;
  let jwks: ReturnType<JoseSubset["createRemoteJWKSet"]> | null = null;

  return async (token: string): Promise<OAuthPrincipal> => {
    if (joseMod === null) {
      try {
        joseMod = (await import("jose")) as unknown as JoseSubset;
      } catch {
        throw new Error(
          'oauth({ jwt }) requires the optional peer dependency "jose". Install it with: pnpm add jose (or supply a custom verifyAccessToken callback).',
        );
      }
    }
    if (jwks === null) {
      jwks = joseMod.createRemoteJWKSet(new URL(config.jwksUrl.toString()));
    }

    const { payload } = await joseMod.jwtVerify(token, jwks, {
      issuer: config.issuer,
      audience: config.audience,
      ...(config.clockTolerance !== undefined && {
        clockTolerance: config.clockTolerance,
      }),
    });

    return oauthPrincipalFromJwtPayload(
      payload as Record<string, unknown>,
      config.claims,
    );
  };
}

/**
 * Built-in OAuth authentication helper for MCP HTTP servers.
 * Configures a full OAuth 2.1 server flow that proxies to an upstream identity
 * provider using the MCP SDK's `ProxyOAuthServerProvider` and `mcpAuthRouter`.
 *
 * Returns an {@link McpOAuthAuthOptions} that can be passed directly to
 * `mcpPlugin({ auth: oauth({ ... }) })`.
 *
 * The server will mount OAuth endpoints (`/.well-known/oauth-authorization-server`,
 * `/authorize`, `/token`, `/revoke`) alongside the `/mcp` transport endpoint.
 *
 * For common JWT-based providers, pass a `jwt` config and let the factory
 * handle JWKS fetching, signature verification, issuer/audience checks, and
 * claim mapping. For opaque tokens or bespoke verification, pass your own
 * `verifyAccessToken` callback.
 *
 * @example Config-only (recommended for standard JWT IdPs)
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
 *     jwt: {
 *       jwksUrl: "https://idp.example.com/.well-known/jwks.json",
 *       issuer: "https://idp.example.com",
 *       audience: "https://mcp.example.com",
 *     },
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
 * @example Claim overrides for a non-standard IdP (Azure AD)
 * ```ts
 * jwt: {
 *   jwksUrl: "https://login.microsoftonline.com/<tenant>/discovery/v2.0/keys",
 *   issuer: "https://login.microsoftonline.com/<tenant>/v2.0",
 *   audience: "<app-id>",
 *   claims: {
 *     subject: (p) => p.oid as string,
 *     roles: (p) => p["roles"] as string[] | undefined,
 *   },
 * }
 * ```
 *
 * @example Custom verification (opaque tokens, introspection, etc.)
 * ```ts
 * import { jwtVerify, createRemoteJWKSet } from "jose";
 *
 * const jwks = createRemoteJWKSet(new URL("https://idp.example.com/.well-known/jwks.json"));
 *
 * oauth({
 *   issuerUrl: "https://mcp.example.com",
 *   endpoints: { authorizationUrl: "...", tokenUrl: "..." },
 *   verifyAccessToken: async (token) => {
 *     const { payload } = await jwtVerify(token, jwks, {
 *       issuer: "https://idp.example.com",
 *       audience: "https://mcp.example.com",
 *     });
 *     return {
 *       kind: "oauth",
 *       scheme: "bearer",
 *       subject: payload.sub as string,
 *       clientId: payload["client_id"] as string,
 *       expiresAt: payload.exp,
 *       claims: payload as Record<string, unknown>,
 *     };
 *   },
 *   client: {
 *     client_id: "my-mcp-server",
 *     redirect_uris: ["http://localhost:3000/callback"],
 *   },
 * });
 * ```
 *
 * @experimental
 */
export function oauth(options: OAuthFactoryOptions): McpOAuthAuthOptions {
  const issuer = new URL(options.issuerUrl.toString());
  if (
    issuer.protocol !== "https:" &&
    process.env["NODE_ENV"] === "production"
  ) {
    throw new TypeError("oauth: issuerUrl must use HTTPS in production");
  }

  const verifyAccessToken = buildVerifier(options);
  const getClient = normaliseClientSupplier(options.client);

  const result: McpOAuthAuthOptions = {
    provider: "oauth",
    issuerUrl: options.issuerUrl,
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

/**
 * Narrow the discriminated factory options to their verifier implementation.
 * Throws when the caller passes both or neither discriminator.
 */
function buildVerifier(
  options: OAuthFactoryOptions,
): (token: string) => Promise<OAuthPrincipal> {
  if (options.jwt !== undefined) {
    if (options.verifyAccessToken !== undefined) {
      throw new TypeError(
        "oauth: pass exactly one of `jwt` (built-in JWT verification) or `verifyAccessToken` (custom validator); both were supplied.",
      );
    }
    return buildJwtVerifyAccessToken(options.jwt);
  }
  if (options.verifyAccessToken !== undefined) {
    return options.verifyAccessToken;
  }
  throw new TypeError(
    "oauth: pass exactly one of `jwt` (built-in JWT verification) or `verifyAccessToken` (custom validator).",
  );
}
