import type {
  OAuthPrincipal,
  OAuthValidatorAuthOptions,
} from "@routecraft/routecraft";
import type { OAuthVerifier } from "./oauth.ts";

/**
 * Custom enrichment function. Receives the verified principal and the raw
 * bearer token and returns a partial principal whose non-protected fields are
 * merged onto the result.
 *
 * Trusted by contract: the framework does not enforce the `sub` invariant for
 * the function variant (unlike URL / discovery modes), since the caller is
 * already free to consult any backend they choose. Protected fields
 * (`subject`, `issuer`, `audience`, `expiresAt`) from the verified token
 * always win regardless of what the function returns.
 *
 * @experimental
 */
export type UserinfoFn = (
  principal: OAuthPrincipal,
  token: string,
) => Promise<Partial<OAuthPrincipal>>;

/**
 * Input shape for the `userinfo` slot on `oauth({})`.
 *
 * - `true`: auto-discover the userinfo endpoint via OIDC Discovery
 *   (`${issuer}/.well-known/openid-configuration`). Requires the underlying
 *   `verify` helper to expose a single-string `issuer`.
 * - `string | URL`: explicit userinfo endpoint URL.
 * - `UserinfoFn`: custom enrichment function for non-OIDC sources (Clerk
 *   Backend API, internal DB, etc.).
 *
 * @experimental
 */
export type UserinfoOption = true | string | URL | UserinfoFn;

/** Protected fields that come from the verified token and cannot be overridden by enrichment. */
const PROTECTED_FIELDS = [
  "subject",
  "issuer",
  "audience",
  "expiresAt",
] as const;

interface CacheEntry {
  principal: OAuthPrincipal;
  expiresAt: number;
}

/**
 * Token-bound enrichment cache. Entries are keyed by the raw token and
 * evicted lazily at the principal's `expiresAt`. Memory is bounded by the set
 * of currently-active tokens because each entry self-evicts at expiry.
 *
 * @internal
 */
export class UserinfoCache {
  private readonly entries = new Map<string, CacheEntry>();

  get(token: string): OAuthPrincipal | undefined {
    const entry = this.entries.get(token);
    if (!entry) return undefined;
    if (Date.now() / 1000 > entry.expiresAt) {
      this.entries.delete(token);
      return undefined;
    }
    return entry.principal;
  }

  set(token: string, principal: OAuthPrincipal): void {
    this.entries.set(token, { principal, expiresAt: principal.expiresAt });
  }

  clear(): void {
    this.entries.clear();
  }
}

interface OidcDiscoveryDoc {
  userinfo_endpoint?: string;
}

/**
 * Resolve the userinfo endpoint URL from the `userinfo` option.
 *
 * For literal `string | URL`, returns it directly. For `true`, fetches the
 * OIDC Discovery document at `${issuer}/.well-known/openid-configuration`
 * once and reads `userinfo_endpoint`. The discovery doc is cached for the
 * lifetime of the resolver closure (i.e. per `oauth()` call).
 *
 * Throws a `TypeError` when:
 * - `userinfo: true` is set but no issuer can be resolved from `verify`.
 * - the resolved issuer is `string[]` (OIDC Discovery requires a single issuer).
 * - the discovery document does not advertise a `userinfo_endpoint`.
 * - the discovery document fetch fails or returns a non-2xx response.
 *
 * @internal
 */
function createUserinfoUrlResolver(
  option: true | string | URL,
  issuer: string | string[] | undefined,
): () => Promise<URL> {
  if (option !== true) {
    const url = new URL(option.toString());
    return async () => url;
  }

  if (issuer === undefined) {
    throw new TypeError(
      "oauth: `userinfo: true` requires the verify helper to expose an `issuer`. " +
        "Use `jwks({ issuer, ... })` / `jwt({ issuer, ... })`, pass an explicit " +
        '`userinfo: "https://idp.example.com/oauth/userinfo"`, or use a function.',
    );
  }
  if (Array.isArray(issuer)) {
    throw new TypeError(
      "oauth: `userinfo: true` requires a single-string `issuer`; got an array. " +
        "OIDC Discovery resolves one issuer to one userinfo endpoint. Pass an " +
        "explicit userinfo URL or function instead.",
    );
  }

  let cached: URL | null = null;
  return async () => {
    if (cached) return cached;
    const discoveryUrl = new URL(
      "/.well-known/openid-configuration",
      issuer.endsWith("/") ? issuer : `${issuer}/`,
    );
    const response = await fetch(discoveryUrl);
    if (!response.ok) {
      throw new TypeError(
        `oauth: OIDC Discovery fetch failed at ${discoveryUrl.toString()} (status ${response.status}). ` +
          "Pass an explicit `userinfo` URL or function if the IdP does not advertise discovery.",
      );
    }
    const doc = (await response.json()) as OidcDiscoveryDoc;
    if (typeof doc.userinfo_endpoint !== "string" || !doc.userinfo_endpoint) {
      throw new TypeError(
        `oauth: OIDC Discovery document at ${discoveryUrl.toString()} does not advertise a userinfo_endpoint. ` +
          "Pass an explicit `userinfo` URL or function for this IdP.",
      );
    }
    cached = new URL(doc.userinfo_endpoint);
    return cached;
  };
}

/**
 * Fetch the userinfo response from the given endpoint using the bearer token.
 * Throws when the response is non-2xx or not valid JSON; all errors are
 * surfaced to the verifier which rejects the request (fail-closed).
 */
async function fetchUserinfo(
  url: URL,
  token: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(
      `userinfo fetch failed: ${response.status} ${response.statusText}`,
    );
  }
  return (await response.json()) as Record<string, unknown>;
}

/**
 * Merge an enrichment payload onto the verified principal. Protected fields
 * (`subject`, `issuer`, `audience`, `expiresAt`) from the verified token
 * always win; everything else is overwritten by the enrichment.
 */
function mergeEnrichment(
  principal: OAuthPrincipal,
  enrichment: Partial<OAuthPrincipal> | Record<string, unknown>,
): OAuthPrincipal {
  const merged = { ...principal } as OAuthPrincipal & Record<string, unknown>;
  for (const [key, value] of Object.entries(enrichment)) {
    if ((PROTECTED_FIELDS as readonly string[]).includes(key)) continue;
    if (value === undefined) continue;
    merged[key] = value;
  }
  return merged;
}

/**
 * Lift standard OIDC claims off a userinfo response payload onto an
 * `OAuthPrincipal` shape. Per OIDC Core §5.3.2 the response is a flat JSON
 * object keyed by claim name; the framework lifts the identity claims onto
 * named fields and stashes the remainder under `claims` for callers that want
 * the raw payload.
 */
function liftOidcClaims(
  payload: Record<string, unknown>,
): Partial<OAuthPrincipal> {
  const out: Partial<OAuthPrincipal> = { claims: payload };
  if (typeof payload["email"] === "string") out.email = payload["email"];
  if (typeof payload["name"] === "string") out.name = payload["name"];
  if (Array.isArray(payload["roles"])) {
    out.roles = (payload["roles"] as unknown[]).filter(
      (r): r is string => typeof r === "string",
    );
  }
  return out;
}

/**
 * Normalise the `verify` option into a `(token) => Promise<OAuthPrincipal>`
 * callback. Mirrors the inner helper in `oauth.ts` but exposed for the
 * enrichment wrapper.
 */
function callBaseVerifier(
  verify: OAuthVerifier,
): (token: string) => Promise<OAuthPrincipal> {
  if (typeof verify === "function") {
    return async (token) => verify(token);
  }
  return async (token) => verify.validator(token);
}

/**
 * Wrap a base verifier with userinfo enrichment. After the base verify
 * succeeds:
 *
 * 1. Cache lookup keyed by the raw token. Hit -> return cached principal.
 * 2. Miss -> fetch userinfo (URL or discovery modes) or invoke the user
 *    function, enforce the `sub` invariant (URL / discovery modes only),
 *    merge onto the principal with protected fields preserved, and cache
 *    the result with TTL = `principal.expiresAt`.
 *
 * Fail-closed: every error (network, parse, sub mismatch) rejects the
 * request.
 *
 * @internal
 */
export function buildEnrichedVerifier(
  verify: OAuthVerifier,
  userinfo: UserinfoOption,
): (token: string) => Promise<OAuthPrincipal> {
  const baseVerifier = callBaseVerifier(verify);
  const cache = new UserinfoCache();

  if (typeof userinfo === "function") {
    return async (token: string) => {
      const cached = cache.get(token);
      if (cached) return cached;
      const principal = await baseVerifier(token);
      const enrichment = await userinfo(principal, token);
      const enriched = mergeEnrichment(principal, enrichment);
      cache.set(token, enriched);
      return enriched;
    };
  }

  const verifyIssuer = typeof verify === "function" ? undefined : verify.issuer;
  const resolveUserinfoUrl = createUserinfoUrlResolver(userinfo, verifyIssuer);

  return async (token: string) => {
    const cached = cache.get(token);
    if (cached) return cached;
    const principal = await baseVerifier(token);
    const url = await resolveUserinfoUrl();
    const payload = await fetchUserinfo(url, token);
    const responseSub = payload["sub"];
    if (typeof responseSub !== "string" || responseSub.length === 0) {
      throw new Error(
        "userinfo response is missing `sub` (required per OIDC Core §5.3.2)",
      );
    }
    if (responseSub !== principal.subject) {
      throw new Error(
        `userinfo \`sub\` (${responseSub}) does not match token \`sub\` (${principal.subject}); rejecting per OIDC Core §5.3.2`,
      );
    }
    const enrichment = liftOidcClaims(payload);
    const enriched = mergeEnrichment(principal, enrichment);
    cache.set(token, enriched);
    return enriched;
  };
}

/**
 * Type-only re-export hook so consumers can refer to the issuer field on
 * `OAuthValidatorAuthOptions` without importing the parent type. Internal.
 *
 * @internal
 */
export type IssuerCarrier = Pick<OAuthValidatorAuthOptions, "issuer">;
