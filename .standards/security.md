# Security Standard

Authoritative rules for authentication, authorization, principal propagation, and the handling of secrets in Routecraft. Anchors the `packages/routecraft/src/auth/` directory and the `@routecraft/ai` OAuth surface.

---

## 1. JWT verification (`jwt()` / `jwks()`)

- **`issuer` is required.** Both `jwt()` and `jwks()` throw at construction if `issuer` is unset or empty. There is no default. This prevents cross-issuer token replay.
- **`audience` is required**, with an explicit `"*"` opt-out for IdPs that do not emit `aud` (e.g. Clerk without a configured API audience). The opt-out must be deliberate; an unset `audience` throws.
- **`exp` is mandatory** on every verified token. `principalFromJwtPayload` rejects payloads without a numeric `exp`. The MCP SDK's bearer middleware depends on the resulting `OAuthPrincipal.expiresAt`; never relax this.
- **Algorithm allowlist:**
  - `jwt()` (HMAC / RSA via `node:crypto`): default `HS256` / `RS256`; rejects any token whose `alg` header is outside the supported map. Do not extend the map without security review.
  - `jwks()` (asymmetric via `jose`): defaults to `RS*` / `PS*` / `ES*` / `EdDSA`. Symmetric `HS*` algorithms are **excluded by design** to prevent algorithm-confusion attacks where a malicious token signed with an `oct` key from the JWKS bypasses asymmetric verification. Do not add `HS*` to a JWKS allowlist.
- **Clock tolerance** flows from the source-side helper into the route-side validator. When `jwt({ clockToleranceSec })` / `jwks({ clockToleranceSec })` is set, pass the same value to `authorize({ clockToleranceSec })` so a token accepted at the route boundary is not rejected mid-pipeline by a fraction of a second.

## 2. JWKS rotation

- `jwks()` builds its remote key set via `jose.createRemoteJWKSet`, which caches keys and rotates on signature mismatch. The set is constructed lazily on first verify and stored in the validator closure for the lifetime of the context.
- Do not cache the verified principal across requests at the JWKS layer. The framework's token-bound enrichment cache (`UserinfoCache` in `packages/ai/src/mcp/userinfo.ts`) is the only sanctioned caching surface, and it caches only enrichment data, never the verify result. The base verifier runs on every request so dynamic checks (introspection, revocation, clock) keep firing.

## 3. Principal propagation across the exchange

- The verified `Principal` rides on the exchange as a single structured header: `headers["routecraft.auth.principal"]`. The `ex.principal` getter is sugar over this header. Read principal fields off the structured object; never look them up under flat header keys.
- **Adapters MUST NOT mutate `ex.principal`.** Build a derived exchange via spread or `DefaultExchange.rewrap` if a `.process()` step needs to swap the principal (e.g. service-account exchange). Mutating the principal in place breaks event payload immutability and downstream `.authorize()` checks. See `.standards/exchange-state-model.md`.
- **Principal fields are loggable; bearer tokens are not.** `principal.subject`, `principal.clientId`, `principal.email`, `principal.name`, `principal.scopes`, `principal.roles`, `principal.issuer`, `principal.audience` are safe to include in structured logs. Never log the raw bearer or anything derived from it that could be reversed.
- **`principal.claims` is the verified JWT payload.** When `oauth({ userinfo })` enrichment runs, the framework writes the raw userinfo response to `principal.userinfoClaims` and leaves `principal.claims` untouched. This invariant is enforced by the protected-fields list in `userinfo.ts`; do not move userinfo data into `claims`.

## 4. Bearer tokens are secrets

- **Never log a bearer token.** Not in pino bindings, not in event payloads, not in error causes. If a token-shaped string is in scope at a log boundary, omit it or replace with a SHA-256 truncated fingerprint.
- **Hash before using as a Map key.** `UserinfoCache.entries` is keyed by `createHash("sha256").update(token).digest("hex")`. A heap dump or accidental cache snapshot must not expose plaintext bearers. Any new in-memory token-keyed cache MUST follow the same pattern.
- **Bound memory.** Token-keyed caches MUST have a hard upper bound (insertion-order LRU with `DEFAULT_CACHE_MAX_ENTRIES = 10_000` in `userinfo.ts`). A misbehaving client that never reuses a token must not be able to grow the map without bound.
- **In-flight coalescing.** Concurrent enrichments for the same token share a single in-flight `Promise`; the IdP receives one userinfo fetch per `(token, expiresAt)` window. This both protects the IdP from request floods and ensures consistent behavior under load.

## 5. OAuth `userinfo` enrichment

- **`sub` invariant (OIDC Core §5.3.2):** for URL and discovery modes, the userinfo response's `sub` MUST equal the verified token's `sub`. Mismatches throw **`RC5022`**. Function-mode enrichment is trusted by contract (the user owns the backend) but the protected fields (`subject`, `issuer`, `audience`, `expiresAt`, `claims`) still cannot be overridden.
- **Fail closed.** Every error path in `userinfo.ts` raises **`RC5021`** (fetch / parse / network / discovery failure) or **`RC5022`** (sub invariant). There is no opt-in "best effort" mode; if a user needs that, they write a function-mode `userinfo` that swallows its own errors. The framework's posture is "reject the request rather than authorize on a partial principal."
- **Discovery document caching.** OIDC Discovery (`userinfo: true`) caches the resolved URL honouring `Cache-Control: max-age`, defaulting to one hour. Transient discovery failures clear the in-flight promise so the next call retries cleanly. Do not cache the *result* of a rejected fetch.
- **OIDC path preservation.** Discovery resolves relative to the issuer URL (`new URL(".well-known/openid-configuration", issuer)`); do not use a leading slash, which would strip the issuer's path component and break Keycloak realms, Auth0 tenant prefixes, and Azure AD `/<tenant>/v2.0` issuers.

## 6. RFC 9728 protected-resource metadata

- **Resource identity lives on the plugin, not on the auth helper.** `mcpPlugin({ resource: { url, scopesSupported, documentationUrl }, title })` is the single source of truth for the RFC 9728 metadata document; both validator and OAuth-proxy modes read from it. The OAuth `oauth({...})` factory is reduced to proxy mechanics only.
- **HTTPS in production is enforced at construction time.** `validateResourceConfig` throws if an explicit `resource.url` uses `http://` while `NODE_ENV === "production"`. The default `http://{host}:{port}/mcp` fallback is permitted as a dev-only convenience; only explicit user-supplied URLs trigger the guard.
- **`port: 0` + OAuth + unset `resource.url` is rejected eagerly.** The MCP SDK's middleware closes over the resource URL pre-listen; an ephemeral port would bake `:0` into the discovery document and 401 headers.
- **Both auth modes serve identical JSON at every advertised URL.** Validator mode mounts the doc in raw Node HTTP; OAuth mode mounts our own handler on Express **before** `mcpAuthRouter` so the SDK's path-aware doc never wins for the URL we advertise. The metadata mount paths are derived from `resource.url.pathname`: both the root `/.well-known/oauth-protected-resource` and the path-suffixed variant (`/.well-known/oauth-protected-resource${rsPath}` per RFC 9728 §3) are served, matching the SDK's `rsPath` math so a non-default `resource.url` does not produce divergent docs at the two URLs.
- **401 `WWW-Authenticate` carries an absolute `resource_metadata` URL** (RFC 9728 §5.1 SHOULD). Relative URLs break reverse-proxy deployments.
- **CORS on the MCP HTTP transport defaults to loopback-only.** `mcpPlugin({ cors })` controls `/mcp`, the RFC 9728 metadata paths (root + path-suffixed), and the 401 `WWW-Authenticate` response. The default policy reflects loopback `Origin` headers (`localhost`, `127.0.0.1`, `[::1]`) so local browser MCP tooling works with zero config, and rejects everything else so non-loopback browser origins must be allowlisted explicitly via `cors: { origin }`. Server-to-server callers (no `Origin` header) are unaffected. `WWW-Authenticate` is exposed by default so browser clients can follow the RFC 9728 hint. The SDK-owned OAuth endpoints (`/register`, `/token`, `/revoke`, the SDK's own metadata) retain the SDK's permissive `cors()` defaults; we own `/mcp` and our metadata endpoints and apply the strict default there.
- **CORS scope on the catch-all 404 is non-preflight only.** Owned-path responses (200, 401, the framework's 404 fallthrough) carry `Access-Control-Allow-Origin` so browser clients can read the status; OPTIONS preflight is short-circuited with a 204 **only on owned paths**. OPTIONS on an unknown path falls through to the catch-all 404 with no CORS headers attached, because granting preflight semantics on routes we do not own would (in OAuth-proxy mode) shadow the SDK's per-route `cors()` policy on its OAuth endpoints. The realistic browser impact is bounded: RFC 9728 discovery uses plain GET, and browsers do not preflight URLs they will not later fetch.

## 6a. Security defaults policy

Defaults must be safe to ship to production. Where dev ergonomics conflict with production safety, relax the default explicitly in dev (gated on `NODE_ENV !== "production"`, an explicit loopback check, or a clearly named opt-in field), never the other way around.

The principle generalises across the security surface; it is not a network-exposure rule. Concrete instances already in the codebase, drawn from different parts of the stack:

- **`audience` is required, with `"*"` as the named opt-out** (see §1). The default is rejection of any token whose audience is not the configured value; opting out is deliberate and visible at construction. The "easier" inverse (default to accepting any audience, opt-in to enforcement) would be the polarity inversion this policy forbids.
- **`UserinfoCache` is bounded by default** (see §4). `DEFAULT_CACHE_MAX_ENTRIES = 10_000` is hard-coded; callers cannot accidentally create an unbounded cache. The dev relaxation (a higher cap) is a deliberate value change, not a flag flip.
- **HTTPS-in-production guard** for `mcpPlugin({ resource.url })` (see §6). `http://` URLs throw in production; the dev fallback is permitted because the default URL is only used when no explicit one is supplied.
- **CORS on the MCP HTTP transport** (see §6). Default reflects loopback origins only; non-loopback browser origins require an explicit `cors: { origin }` opt-in.

When you add a new default that affects authentication, authorization, network exposure, secret material, or any trust boundary:

1. Make the production-safe behaviour the unconfigured default.
2. Surface the dev/relaxed mode behind an explicit, named opt-in (config field, env gate, or loopback / `NODE_ENV` check). Never invert the polarity (no `secure: true` flag where the default is insecure).
3. Document the new default on its relevant docs reference page and in the section of this standard that governs the affected surface (§1 for token verification, §4 for caching, §6 for transport, etc.). Add a short rationale: what threat the default closes.
4. The General Checklist in `DEFINITION_OF_DONE.md` references this policy; reviewers MUST push back if a new feature ships a permissive default that needs to be tightened.

## 7. `authorize()` is a verification primitive

- **Checks, does not mint.** `authorize()` verifies that the exchange carries a principal that meets the criteria (roles, scopes, predicate, expiry). It does NOT issue, refresh, mint, or attach credentials. Authentication happens at the source boundary (`mcp({ auth: ... })`, future `http({ auth: ... })`) or in a `.process()` step that explicitly attaches a `Principal`.
- **Error codes are stable and meaningful:**

  | Code | Cause | Client expectation |
  |------|-------|--------------------|
  | `RC5012` | No principal on the exchange | Auth flow failed upstream; retry will not help without fresh credentials |
  | `RC5015` | Principal failed role / scope / predicate | Permanent denial under current credentials |
  | `RC5020` | `principal.expiresAt` in the past (beyond `clockToleranceSec`) | Refresh and retry |
  | `RC5021` | `userinfo` enrichment failed | Investigate IdP availability; client cannot recover |
  | `RC5022` | `userinfo` sub invariant violated | Investigate IdP / userinfo URL pairing; potential compromise |

  Do not collapse RC5020 into RC5012 or RC5015; the distinction lets clients decide between "refresh" and "give up."

- **Fail closed on non-finite inputs.** `Number.isFinite(principal.expiresAt) && Number.isFinite(clockToleranceSec)` is checked before comparison. A `NaN` would otherwise silently bypass the guard.

## 8. `loadOptionalPeer` for cryptographic peers

- `jose` is an optional peer of `@routecraft/routecraft` and is loaded via `loadOptionalPeer` from `packages/routecraft/src/auth/jwks.ts`. Missing-peer reports as `RC5017` with a copy-pasteable install hint.
- **Never embed cryptographic libraries as a hard dependency** in the core package. The framework loads via dynamic import so consumers that do not use JWKS verification ship without `jose` in their tree.
- See `.standards/ci-cd.md` § 6 for the canonical `loadOptionalPeer` pattern. New crypto / auth peers MUST follow the same shape.

## 9. Removing or weakening a check

- Any change that removes or relaxes a security check (algorithm allowlist, audience requirement, `exp` requirement, `sub` invariant, HTTPS-in-production guard, fail-closed posture) requires:
  1. An explicit rationale in the commit message naming the threat model the original check addressed.
  2. A test that asserts the new permissive behavior is bounded (e.g. only fires under a documented opt-in).
  3. A docs update describing the user-visible behavior change.
- Reviewers MUST push back on the easier path of "just delete the check." A working test suite without the original threat-model assertion is not evidence the change is safe.

## 10. Event payloads

- `auth:success` and `auth:rejected` events carry sanitised detail objects: `{ subject, scheme, source }` (success) or `{ reason, source }` (rejected). Do not extend these payloads to include the raw token or any high-cardinality identifier (full JWT, opaque session id) that an aggregator would index and retain.
- Principal-shaped payloads on other events (e.g. `route:*:exchange:processed`) MAY include the full `Principal` object via `ex.principal` because the principal itself is sanitised; the bearer is not in it.

---

## Boundaries

- **Source boundary** (`mcp()`, future `http()`): runs `verify` / `validator`; emits `auth:success` or `auth:rejected`; attaches `Principal` to the exchange.
- **Route boundary** (`.authorize()` / `.validate(authorize(...))`): checks principal against role / scope / predicate / expiry; emits `exchange:failed` on rejection.
- **Userinfo boundary** (`buildEnrichedVerifier`): runs after `verify` succeeds; merges enrichment with protected fields preserved; raises `RC5021` / `RC5022` on failure.
- **HTTP transport boundary** (`startHttpWithValidator` / `startHttpWithOAuth`): serves RFC 9728 metadata; emits 401 with `resource_metadata`.

Each boundary is the *only* place that handles its class of error (does not re-throw). Crossing a boundary without logging duplicates entries; not logging at the boundary loses the failure entirely.

## 11. Agent -> MCP auth boundary

When an agent calls an MCP tool via `tools(["mcp_<client>:<tool>"])`, the
agent runtime does NOT forward `FnHandlerContext.principal` (or the bearer it
came from) to the MCP server. The MCP server is reached using the static
credentials registered on `defineConfig.mcp({ clients: { name: { auth } } })`.

This is intentional. Two trust boundaries:

- **Principal authenticates the caller into Routecraft.** It identifies the
  user / service that triggered the route or agent. Used by `.authorize()`,
  guards, and downstream `directTool` dispatches that stay inside the
  in-process trust zone.
- **MCP `auth` authenticates the Routecraft -> MCP hop.** It identifies the
  Routecraft instance to the remote MCP server. The MCP server has its own
  authorisation model; mixing the routecraft principal into the MCP credential
  conflates two policies.

If an agent needs to thread user-specific data into an MCP tool call (e.g.
"only fetch documents for tenant X"), do it as a regular tool argument: the
agent can read `ctx.principal` in a guard or in its own handler and put a
`tenantId` field into the MCP call's input. The MCP server then enforces
that argument against its own policy. Never repurpose a credential field as
a per-user parameter; never reuse a per-user bearer as an MCP credential.
