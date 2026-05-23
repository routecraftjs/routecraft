import { createHash } from "node:crypto";
import { rcError, type Principal } from "@routecraft/routecraft";

/**
 * Custom enrichment function. Receives the verified principal and the raw
 * bearer token and returns a partial principal whose non-protected fields are
 * merged onto the result.
 *
 * Trusted by contract: the framework does not enforce the `sub` invariant for
 * the function variant (unlike URL / discovery modes), since the caller is
 * already free to consult any backend they choose. Protected fields
 * (`subject`, `issuer`, `audience`, `expiresAt`, `claims`) from the verified
 * token always win regardless of what the function returns. If you want the
 * raw upstream response surfaced, return `{ userinfoClaims: ... }`.
 *
 * The `principal` parameter is typed as {@link Principal} because enrichment
 * works in both validator and OAuth-proxy modes. When the verifier is
 * `jwks()` / `jwt()` / `oauth()`, the principal carries `expiresAt` at
 * runtime (it is an `OAuthPrincipal`); a custom `{ validator }` may not.
 */
export type UserinfoFn = (
  principal: Principal,
  token: string,
) => Promise<Partial<Principal>>;

/**
 * Input shape for the `userinfo` slot on `mcpPlugin({})`.
 *
 * - `true`: auto-discover the userinfo endpoint via OIDC Discovery. The
 *   discovery document is fetched relative to the verify helper's `issuer`,
 *   so a single-string issuer (with or without a path) is required.
 * - `string | URL`: explicit userinfo endpoint URL.
 * - `UserinfoFn`: custom enrichment function for non-OIDC sources (Clerk
 *   Backend API, internal DB, etc.).
 */
export type UserinfoOption = true | string | URL | UserinfoFn;

/**
 * Fields that come from the verified token and cannot be overridden by
 * enrichment. `claims` is protected so URL / discovery enrichment does not
 * clobber the JWT payload that consumers expect on `principal.claims`; the
 * raw userinfo response lives on `userinfoClaims` instead.
 */
const PROTECTED_FIELDS = [
  "subject",
  "issuer",
  "audience",
  "expiresAt",
  "claims",
] as const;

/** Default cap on cached enriched principals. Tuned for typical MCP fleets; tokens self-evict at `expiresAt`. */
const DEFAULT_CACHE_MAX_ENTRIES = 10_000;

/** Default discovery-document TTL when the IdP does not advertise `Cache-Control: max-age`. */
const DEFAULT_DISCOVERY_TTL_SEC = 3600;

interface CacheEntry {
  enrichment: Partial<Principal>;
  expiresAt: number;
}

/**
 * Token-bound enrichment cache with in-flight request coalescing.
 *
 * Caches the enrichment payload (a `Partial<OAuthPrincipal>`), NOT the
 * fully merged principal. The base verifier runs on every request so any
 * dynamic checks the verifier performs (introspection, revocation, clock
 * comparisons) still fire per request; only the userinfo / function-mode
 * enrichment is memoised.
 *
 * Entries are keyed by a SHA-256 hash of the bearer token so a heap dump
 * or accidental log snapshot does not expose plaintext bearers. Entries
 * self-evict at the principal's `expiresAt`; a configurable
 * insertion-order cap (`maxEntries`) provides a hard memory ceiling so a
 * misbehaving client that never reuses a token cannot grow the map
 * without bound.
 *
 * Concurrent calls for the same uncached token share a single in-flight
 * enrichment promise; the IdP receives one userinfo fetch per
 * (token, expiresAt) window, not one per inbound request.
 *
 * @internal
 */
export class UserinfoCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<Partial<Principal>>>();
  private readonly maxEntries: number;

  constructor(maxEntries: number = DEFAULT_CACHE_MAX_ENTRIES) {
    this.maxEntries = maxEntries;
  }

  /**
   * Return the cached enrichment for the token, or run `compute()` to
   * produce one and cache the result. Concurrent callers for the same
   * token share the in-flight promise. The cached entry self-evicts at
   * `expiresAt` (Unix epoch seconds, typically the principal's expiry).
   *
   * When `expiresAt` is `undefined` or non-finite (a custom validator that
   * produced a principal without `exp`), the result is computed fresh on
   * every call: there is no natural TTL to bound a cache entry, so caching
   * is skipped rather than guessed.
   */
  async getOrCompute(
    token: string,
    expiresAt: number | undefined,
    compute: () => Promise<Partial<Principal>>,
  ): Promise<Partial<Principal>> {
    if (expiresAt === undefined || !Number.isFinite(expiresAt)) {
      return compute();
    }
    const key = hashToken(token);
    const cached = this.entries.get(key);
    if (cached) {
      if (Date.now() / 1000 < cached.expiresAt) return cached.enrichment;
      this.entries.delete(key);
    }

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const promise = compute().then(
      (enrichment) => {
        this.store(key, enrichment, expiresAt);
        this.inFlight.delete(key);
        return enrichment;
      },
      (err: unknown) => {
        this.inFlight.delete(key);
        throw err;
      },
    );
    this.inFlight.set(key, promise);
    return promise;
  }

  /** Clear every cached entry. Intended for tests. */
  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
  }

  private store(
    key: string,
    enrichment: Partial<Principal>,
    expiresAt: number,
  ): void {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, { enrichment, expiresAt });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

interface OidcDiscoveryDoc {
  userinfo_endpoint?: string;
}

/**
 * Parse `Cache-Control: max-age=<seconds>` (RFC 9111). Returns the parsed TTL
 * in seconds, or `undefined` if the header is absent or unparseable.
 */
function parseMaxAge(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const match = headerValue.match(/(?:^|,\s*)max-age=(\d+)/i);
  if (!match) return undefined;
  const value = Number.parseInt(match[1]!, 10);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Resolve the userinfo endpoint URL from the `userinfo` option.
 *
 * For literal `string | URL`, returns it directly. For `true`, fetches the
 * OIDC Discovery document relative to the issuer (preserving the issuer's
 * path component, so Keycloak realms and tenant-prefixed IdPs resolve
 * correctly) and reads `userinfo_endpoint`. The discovery URL is cached for
 * the lifetime advertised by `Cache-Control: max-age`, defaulting to one
 * hour. Concurrent first-callers share a single in-flight fetch.
 *
 * Sync errors at construction time:
 * - `TypeError` if `userinfo: true` and no issuer is exposed by `verify`.
 * - `TypeError` if `userinfo: true` and the resolved issuer is an array.
 *
 * Async errors (per call, wrapped in `RC5021`):
 * - Discovery fetch failure (non-2xx, network error, malformed JSON).
 * - Discovery document missing `userinfo_endpoint`.
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

  const base = issuer.endsWith("/") ? issuer : `${issuer}/`;
  const discoveryUrl = new URL(".well-known/openid-configuration", base);

  let cachedUrl: URL | null = null;
  let cachedUntil = 0;
  let inFlight: Promise<URL> | null = null;

  const fetchAndCache = async (): Promise<URL> => {
    let response: Response;
    try {
      response = await fetch(discoveryUrl);
    } catch (cause) {
      throw rcError("RC5021", cause, {
        message: `OIDC Discovery fetch failed at ${discoveryUrl.toString()}`,
        suggestion:
          "Verify network access to the IdP and that the issuer URL is reachable. Pass an explicit `userinfo` URL or function if the IdP does not advertise discovery.",
      });
    }
    if (!response.ok) {
      throw rcError(
        "RC5021",
        new Error(
          `OIDC Discovery fetch returned ${response.status} ${response.statusText}`,
        ),
        {
          message: `OIDC Discovery fetch failed at ${discoveryUrl.toString()} (status ${response.status})`,
          suggestion:
            "Verify the issuer hosts an OIDC Discovery document. Pass an explicit `userinfo` URL or function if it does not.",
        },
      );
    }
    let doc: OidcDiscoveryDoc;
    try {
      doc = (await response.json()) as OidcDiscoveryDoc;
    } catch (cause) {
      throw rcError("RC5021", cause, {
        message: `OIDC Discovery document at ${discoveryUrl.toString()} is not valid JSON`,
        suggestion:
          "Inspect the discovery endpoint manually. Pass an explicit `userinfo` URL or function if the IdP is non-compliant.",
      });
    }
    if (typeof doc.userinfo_endpoint !== "string" || !doc.userinfo_endpoint) {
      throw rcError(
        "RC5021",
        new Error("missing userinfo_endpoint in discovery document"),
        {
          message: `OIDC Discovery document at ${discoveryUrl.toString()} does not advertise a userinfo_endpoint`,
          suggestion:
            "Pass an explicit `userinfo` URL or function for this IdP; it does not advertise auto-discoverable userinfo.",
        },
      );
    }
    const resolved = new URL(doc.userinfo_endpoint);
    const ttl =
      parseMaxAge(response.headers.get("cache-control")) ??
      DEFAULT_DISCOVERY_TTL_SEC;
    cachedUrl = resolved;
    cachedUntil = Date.now() / 1000 + ttl;
    return resolved;
  };

  return async () => {
    if (cachedUrl && Date.now() / 1000 < cachedUntil) return cachedUrl;
    if (inFlight) return inFlight;
    inFlight = fetchAndCache().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

/**
 * Fetch the userinfo response from the given endpoint using the bearer token.
 * Throws `RC5021` when the response is non-2xx or not valid JSON. All errors
 * are surfaced to the verifier which rejects the request (fail-closed).
 */
async function fetchUserinfo(
  url: URL,
  token: string,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (cause) {
    throw rcError("RC5021", cause, {
      message: `userinfo fetch failed at ${url.toString()}`,
      suggestion:
        "Verify network access to the IdP's userinfo endpoint and that the bearer token's scopes permit it.",
    });
  }
  if (!response.ok) {
    throw rcError(
      "RC5021",
      new Error(`userinfo returned ${response.status} ${response.statusText}`),
      {
        message: `userinfo fetch failed at ${url.toString()} (status ${response.status})`,
        suggestion:
          "Check the bearer token has the scopes required by the IdP's userinfo endpoint (typically `openid`, `email`, `profile`).",
      },
    );
  }
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch (cause) {
    throw rcError("RC5021", cause, {
      message: `userinfo response at ${url.toString()} is not valid JSON`,
      suggestion:
        "Inspect the userinfo endpoint manually; it must return a JSON object per OIDC Core §5.3.2.",
    });
  }
}

/**
 * Merge an enrichment payload onto the verified principal. Protected fields
 * (`subject`, `issuer`, `audience`, `expiresAt`, `claims`) from the verified
 * token always win; every other field on the enrichment overwrites the
 * principal's. The raw userinfo response lives on `userinfoClaims` in URL /
 * discovery mode; function-mode enrichment can populate it explicitly.
 */
function mergeEnrichment<P extends Principal>(
  principal: P,
  enrichment: Partial<Principal> | Record<string, unknown>,
): P {
  // Copy into a plain record so the indexed write type-checks under a generic
  // `P`; every original field is preserved, only non-protected fields are
  // overwritten, so the cast back to `P` is sound.
  const merged: Record<string, unknown> = {
    ...(principal as Record<string, unknown>),
  };
  for (const [key, value] of Object.entries(enrichment)) {
    if ((PROTECTED_FIELDS as readonly string[]).includes(key)) continue;
    if (value === undefined) continue;
    merged[key] = value;
  }
  return merged as P;
}

/**
 * Lift standard OIDC claims off a userinfo response payload onto a
 * `Partial<OAuthPrincipal>` shape. Per OIDC Core §5.3.2 the response is a
 * flat JSON object keyed by claim name. The framework lifts the identity
 * claims that have a first-class field on `Principal` (`email`, `name`,
 * `roles`) and stashes the full response under `userinfoClaims` for callers
 * that want the raw payload. The verified JWT payload on `principal.claims`
 * is preserved.
 */
function liftOidcClaims(payload: Record<string, unknown>): Partial<Principal> {
  const out: Partial<Principal> = { userinfoClaims: payload };
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
 * Wrap a base verifier with userinfo enrichment.
 *
 * The base verifier runs on every request so any dynamic checks it
 * performs (introspection, revocation, clock comparisons) still fire per
 * request. Only the enrichment payload is memoised, keyed by
 * SHA-256(token) and TTL'd to `principal.expiresAt`.
 *
 * Generic over the principal type so the same wrapper serves validator
 * mode (`jwks()` / `jwt()` / custom `{ validator }`) and OAuth-proxy mode
 * (`oauth()`); the caller supplies the base verifier and the IdP `issuer`
 * (needed only for `userinfo: true` OIDC Discovery).
 *
 * Concurrent first-callers for the same token share a single in-flight
 * enrichment promise, so the IdP receives one userinfo fetch per
 * (token, expiresAt) window. The merge is recomputed on every request
 * against the freshly-verified principal, so the returned object is never
 * a shared reference into the cache.
 *
 * Sub-invariant enforcement (URL / discovery modes only): the userinfo
 * response `sub` MUST match the first verified principal's `subject` (per
 * OIDC Core §5.3.2). Mismatches raise `RC5022`; the function variant is
 * trusted by contract. Network / fetch / parse failures raise `RC5021`.
 * Fail-closed throughout.
 *
 * For `userinfo: true`, this throws synchronously at call time when no
 * single-string `issuer` is available, so the server can fail fast at
 * startup rather than on the first request.
 *
 * @internal
 */
export function buildEnrichedVerifier<P extends Principal>(
  baseVerifier: (token: string) => Promise<P>,
  userinfo: UserinfoOption,
  issuer: string | string[] | undefined,
): (token: string) => Promise<P> {
  const cache = new UserinfoCache();

  if (typeof userinfo === "function") {
    return async (token: string) => {
      const principal = await baseVerifier(token);
      const enrichment = await cache.getOrCompute(
        token,
        principal.expiresAt,
        () => userinfo(principal, token),
      );
      return mergeEnrichment(principal, enrichment);
    };
  }

  const resolveUserinfoUrl = createUserinfoUrlResolver(userinfo, issuer);

  return async (token: string) => {
    const principal = await baseVerifier(token);
    const enrichment = await cache.getOrCompute(
      token,
      principal.expiresAt,
      async () => {
        const url = await resolveUserinfoUrl();
        const payload = await fetchUserinfo(url, token);
        const responseSub = payload["sub"];
        if (typeof responseSub !== "string" || responseSub.length === 0) {
          throw rcError(
            "RC5022",
            new Error("userinfo response is missing `sub`"),
            {
              message:
                "userinfo response is missing `sub` (required per OIDC Core §5.3.2)",
              suggestion:
                "Inspect the userinfo endpoint manually; the response MUST include a `sub` claim. If the IdP returns a non-standard identifier, use a function-mode `userinfo` and map it yourself.",
            },
          );
        }
        if (responseSub !== principal.subject) {
          throw rcError(
            "RC5022",
            new Error(
              `userinfo \`sub\` (${responseSub}) does not match token \`sub\` (${principal.subject})`,
            ),
            {
              message:
                "userinfo response `sub` does not match the verified token's `sub` (OIDC Core §5.3.2 violation)",
              suggestion:
                "This indicates a compromised userinfo endpoint or a misconfigured userinfo URL. Verify the issuer / userinfo mapping; do not relax this check.",
            },
          );
        }
        return liftOidcClaims(payload);
      },
    );
    return mergeEnrichment(principal, enrichment);
  };
}
