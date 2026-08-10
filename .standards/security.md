# Security Standard

Authoritative rules for authentication, authorization, principal propagation, and the handling of secrets in Routecraft. Anchors the `packages/routecraft/src/auth/` directory and the `@routecraft/ai` OAuth surface.

---

## 1. JWT verification (`jwt()` / `jwks()`)

- **`issuer` is required.** Both `jwt()` and `jwks()` throw at construction if `issuer` is unset or empty. There is no default. This prevents cross-issuer token replay.
- **`audience` is required**, with an explicit `"*"` opt-out for IdPs that do not emit `aud` (e.g. Clerk without a configured API audience). The opt-out must be deliberate; an unset `audience` throws.
- **`exp` is mandatory** on every verified token. `principalFromJwtPayload` rejects payloads without a numeric `exp`. The MCP server's expiry gate depends on the resulting `OAuthPrincipal.expiresAt` and refuses a principal that lacks one; never relax this.
- **Algorithm allowlist:**
  - `jwt()` (HMAC / RSA via `node:crypto`): default `HS256` / `RS256`; rejects any token whose `alg` header is outside the supported map. Do not extend the map without security review.
  - `jwks()` (asymmetric via `jose`): defaults to `RS*` / `PS*` / `ES*` / `EdDSA`. Symmetric `HS*` algorithms are **excluded by design** to prevent algorithm-confusion attacks where a malicious token signed with an `oct` key from the JWKS bypasses asymmetric verification. Do not add `HS*` to a JWKS allowlist.
- **Clock tolerance** flows from the source-side helper into the route-side validator. `jwt()` and `jwks()` surface their configured `clockToleranceSec` on the options they return, alongside `issuer`, and `oauth()` carries it through, so the MCP expiry gate applies exactly the skew the verifier applied. A consumer that re-checks `expiresAt` without it would refuse the very token the verifier just accepted. The field is absent when unconfigured, so "not configured" stays distinguishable from an explicit zero. For a route-side `authorize({ clockToleranceSec })` the value is still passed explicitly.
- **The expiry boundary is inclusive and floored to whole seconds.** `jwt()`, `authorize()` and the MCP gate reject when `floor(now) >= exp + tolerance`, matching `jose` (`exp <= now - tolerance`, which `jwks()` goes through) and RFC 7519 §4.1.4, which requires the current time to be *before* `exp`. Do not relax this to an exclusive comparison: it would honour a token for a further second and reintroduce a divergence between `jwt()` and `jwks()`.

## 2. JWKS rotation

- `jwks()` builds its remote key set via `jose.createRemoteJWKSet`, which caches keys and rotates on signature mismatch. The set is constructed lazily on first verify and stored in the validator closure for the lifetime of the context.
- Do not cache the verified principal across requests at the JWKS layer. The framework's token-bound enrichment cache (`UserinfoCache` in `packages/ai/src/mcp/userinfo.ts`) is the only sanctioned caching surface, and it caches only enrichment data, never the verify result. The base verifier runs on every request so dynamic checks (introspection, revocation, clock) keep firing.

## 3. Principal propagation across the exchange

- The verified `Principal` rides on the exchange as a single structured header: `headers["routecraft.auth.principal"]`. The `ex.principal` getter is sugar over this header. Read principal fields off the structured object; never look them up under flat header keys.
- **Only authentic principals are trusted.** A principal counts as authentic when it was established by a trusted origin and registered by `markAuthentic` (see `packages/routecraft/src/auth/authentic.ts`): a source-side verifier (`jwt()` / `jwks()` / `oauth()`, branded at the MCP attach point), or an explicit `authenticate()` mint. Authenticity is membership in a module-private `WeakSet`, not a property on the object. Set membership cannot be enumerated, read back, copied, or transferred, so even code holding a genuine authentic principal (userland receives them via `ex.principal`, `.process()` callbacks, and event payloads) cannot mark a different object as authentic. A property brand, even a non-enumerable private `Symbol`, would be reflectable via `Object.getOwnPropertySymbols()` and could be copied onto a forged object; the `WeakSet` is what closes that hole, so do not regress it to a property brand. `authorize()` rejects any non-authentic principal with `RC5023`. This makes minting an explicit, greppable act and prevents identity from being forged by an incidental header write or by copying an existing principal with elevated roles.
- **To establish identity, mint it; do not write the header by hand.** Use the `.authenticate()` operation (or the `authenticate()` helper) to mint a branded principal from claims you have verified yourself (an e-mail sender, a Slack signature, a service account). A plain object assigned to `headers["routecraft.auth.principal"]` is self-asserted and will not pass `authorize()`. Custom source adapters that verify identity themselves brand their resolved principal with `markAuthentic`. Because minting is an in-process capability (branding stops forgery, not fabrication by code that can call the mint), `@routecraft/eslint-plugin-routecraft` ships `restrict-principal-minting` (error in both the `recommended` and `all` presets): every direct mint site must be explicitly sanctioned with a scoped disable comment or per-file override, so adding one is always a visible act in review. The rule covers direct minting forms only; laundering forms (local re-exports, `export *`, namespace destructuring, helper reassignment) stay outside lint coverage and are a review concern.
- **Adapters MUST NOT mutate `ex.principal`.** Principals are frozen at the trusted origin; build a derived exchange via `.authenticate()` or `DefaultExchange.rewrap` if a `.process()` step needs to swap the principal (e.g. service-account exchange). Mutating in place throws (frozen) and would break event payload immutability and downstream `.authorize()` checks. See `.standards/exchange-state-model.md`.
- **Principal fields are loggable; bearer tokens are not.** `principal.subject`, `principal.clientId`, `principal.email`, `principal.name`, `principal.scopes`, `principal.roles`, `principal.issuer`, `principal.audience` are safe to include in structured logs. Never log the raw bearer or anything derived from it that could be reversed.
- **`principal.claims` is the verified JWT payload.** When `mcpPlugin({ userinfo })` enrichment runs, the framework writes the raw userinfo response to `principal.userinfoClaims` and leaves `principal.claims` untouched. This invariant is enforced by the protected-fields list in `userinfo.ts`; do not move userinfo data into `claims`.

## 3a. Principal in the agent system prompt

- **The agent destination is the only sanctioned path that puts principal data into an LLM prompt.** `agent({ principal })` appends a `## Caller` section to the system prompt (`appendPrincipalToSystem` / `formatCallerSection` in `packages/ai/src/agent/destination.ts`). It is opt-in: the default omits the section so an agent never leaks identity into a prompt by accident. Set `principal: true` for the built-in block, or pass a `(principal, exchange) => string` renderer (`AgentPrincipalRenderer`) for custom wording.
- **The built-in block surfaces only a deliberate subset: `name`, `email`, `subject`, and `roles`.** `claims`, `userinfoClaims`, and the bearer token are NEVER injected (a prompt is logged, cached by providers, and echoed back in completions, so it must be treated as an exfiltration surface). `scopes` are loggable per § 3 but are deliberately excluded from the prompt as well, to avoid nudging the model to treat itself as the authorization gate; do not add them without product sign-off. A custom renderer may surface other fields but MUST observe the same exclusions: never include `claims`, `userinfoClaims`, or anything bearer-derived.
- **Identity fields are integrity-verified, not assumed structurally safe.** The block belongs in the system prompt, not the user prompt: the exchange body (user prompt) is attacker-controlled input, and the principal is verified at the source boundary, so keeping identity in the system channel stops it from being mistaken for, or smuggled in via, the body. But verification guarantees only that the claim reached us unmodified from the IdP, not that the *value* is benign: `name` / `email` are often self-service profile fields the subject controls. `formatCallerSection` therefore collapses newlines in every interpolated field (`oneLine`) so a value cannot break out of its `- Label:` line or forge a `##` heading in the trusted channel. A custom `AgentPrincipalRenderer` owns its own escaping and inherits this responsibility.
- **The block is informational, never an authorization gate.** It states identity facts only and must not instruct the model to enforce roles. Enforcement stays in `.authorize()` and tool guards (§ 7). The model may reason about identity to tailor a response, but a model decision is never a security boundary.
- **The unauthenticated case is explicit.** When no principal is present the section says the request is not authenticated and instructs the model not to invent an identity, so a missing principal cannot be silently impersonated by a hallucination.

## 4. Bearer tokens are secrets

- **Never log a bearer token.** Not in pino bindings, not in event payloads, not in error causes. If a token-shaped string is in scope at a log boundary, omit it or replace with a SHA-256 truncated fingerprint.
- **Never echo a verifier error message into a sanitised field.** A custom `validator` / `verify` controls its own error message and could embed the bearer in it, so `err.message` must never flow into an event payload or any other aggregator-indexed field. The `auth:rejected` `reason` is drawn from a bounded vocabulary (`expired`, `infrastructure`, `invalid_token`, `missing_header`, `unsupported_scheme`, `missing_expires_at`); the full error remains operator-only via the structured `{ err }` log binding, which a deployment can scrub. Custom validators must still not embed the bearer in error messages, since the thrown error reaches the log binding.
- **Token-keyed caches: hash the key, bound the size, coalesce in-flight.** The user-facing behaviour of `UserinfoCache` (SHA-256 token keys, the 10,000-entry insertion-order cap, one in-flight userinfo fetch per token) is documented at `apps/routecraft.dev/src/app/docs/advanced/securing-capabilities/page.md` ("Principal enrichment via `userinfo`"). The contributor rule stands: any new in-memory token-keyed cache MUST key by SHA-256 fingerprint, never the raw bearer (a heap dump or cache snapshot must not expose plaintext tokens), MUST have a hard upper bound, and MUST coalesce concurrent lookups for the same token onto a single in-flight promise (the IdP must see one fetch per token window, not a request flood).

## 5. Principal `userinfo` enrichment

- **Plugin-level, orthogonal to the auth mode.** `userinfo` lives on `mcpPlugin({ userinfo })`, not on `oauth()`. It runs after `auth` verifies a token and works with `jwks()` / `jwt()` (validator mode), a custom `{ validator }`, and `oauth()`. The wrapper (`buildEnrichedVerifier`) is generic over the principal type and takes an explicit `(baseVerifier, userinfo, issuer)` so the server applies it uniformly to both auth paths. Built eagerly at startup so a misconfigured `userinfo: true` (no single-string issuer) fails fast rather than on the first request.
- **Enrichment semantics are user-facing contract.** The `sub` invariant (**`RC5022`** on mismatch, OIDC Core §5.3.2; function mode trusted by contract with protected fields still preserved), the fail-closed posture (**`RC5021`** on every fetch / parse / network / discovery failure; no "best effort" mode), and discovery-document caching (`Cache-Control: max-age`, default one hour) are documented at `apps/routecraft.dev/src/app/docs/advanced/securing-capabilities/page.md` ("Principal enrichment via `userinfo`"). One review note stays here: transient discovery failures clear the in-flight promise so the next call retries cleanly; do not cache the *result* of a rejected fetch.
- **OIDC path preservation.** Discovery resolves relative to the issuer URL (`new URL(".well-known/openid-configuration", issuer)`); do not use a leading slash, which would strip the issuer's path component and break Keycloak realms, Auth0 tenant prefixes, and Azure AD `/<tenant>/v2.0` issuers.

## 6. RFC 9728 protected-resource metadata

- **Resource identity lives on the plugin, not on the auth helper.** `mcpPlugin({ resource: { url, scopesSupported, documentationUrl }, title })` is the single source of truth for the RFC 9728 metadata document. Every auth helper reads from it; `oauth({ verify, issuer, requiredScopes })` contributes only the Authorization Server issuer it advertises and the scopes it enforces.
- **HTTPS in production is enforced at construction time.** `validateResourceConfig` throws if an explicit `resource.url` uses `http://` while `NODE_ENV === "production"`. The default `http://{host}:{port}/mcp` fallback is permitted as a dev-only convenience; only explicit user-supplied URLs trigger the guard.
- **The resource URL resolves after `.listen()`.** There is no pre-listen middleware registration to close over it, so an ephemeral `port: 0` is safe: the bound port is known by the time the metadata document and 401 headers are built.
- **One handler serves identical JSON at every advertised URL.** The doc is mounted in raw Node HTTP, with no web framework in the way. The metadata mount paths are derived from `resource.url.pathname`: both the root `/.well-known/oauth-protected-resource` and the path-suffixed variant (`/.well-known/oauth-protected-resource${rsPath}` per RFC 9728 §3) are served, so a non-default `resource.url` does not produce divergent docs at the two URLs.
- **401 `WWW-Authenticate` carries an absolute `resource_metadata` URL** (RFC 9728 §5.1 SHOULD). Relative URLs break reverse-proxy deployments.
- **CORS on the MCP HTTP transport defaults to loopback-only.** `mcpPlugin({ cors })` controls `/mcp`, the RFC 9728 metadata paths (root + path-suffixed), and the 401 `WWW-Authenticate` response. The default policy reflects loopback `Origin` headers (`localhost`, `127.0.0.1`, `[::1]`) so local browser MCP tooling works with zero config, and rejects everything else so non-loopback browser origins must be allowlisted explicitly via `cors: { origin }`. Server-to-server callers (no `Origin` header) are unaffected. `WWW-Authenticate` is exposed by default so browser clients can follow the RFC 9728 hint. There are no SDK-owned OAuth endpoints to coexist with: `/mcp` and the metadata paths are the only surface, and the strict default applies across all of it.
- **CORS scope on the catch-all 404 is non-preflight only.** Owned-path responses (200, 401, the framework's 404 fallthrough) carry `Access-Control-Allow-Origin` so browser clients can read the status; OPTIONS preflight is short-circuited with a 204 **only on owned paths**. OPTIONS on an unknown path falls through to the catch-all 404 with no CORS headers attached, because granting preflight semantics on routes we do not own would extend a policy we did not author to paths we do not serve. The realistic browser impact is bounded: RFC 9728 discovery uses plain GET, and browsers do not preflight URLs they will not later fetch.

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

- **Checks, does not mint.** `authorize()` verifies that the exchange carries an authentic principal that meets the criteria (roles, scopes, predicate, expiry). It does NOT issue, refresh, mint, or attach credentials. Authentication happens at the source boundary (`mcp({ auth: ... })`, future `http({ auth: ... })`) or via an explicit `.authenticate()` / `authenticate()` mint.
- **Trusts only authentic principals.** Before checking roles or scopes, `authorize()` rejects a principal that was not established by a trusted origin (see §3): a self-asserted plain object fails with `RC5023`, never with `RC5015`. This keeps "this identity is forged / self-asserted" distinct from "this identity lacks a role."
- **Error codes are stable and meaningful.** The full vocabulary (`RC5012` no principal, `RC5023` not authentic, `RC5015` role / predicate, `RC5020` expired, `RC5021` / `RC5022` userinfo, delegation `RC5034`-`RC5038`) with per-code causes and client expectations is documented at `apps/routecraft.dev/src/app/docs/reference/operations/authorize/page.md` and in the per-code entries of the errors reference. The codes are distinct on purpose -- each distinction lets clients decide between "forge / mint correctly," "refresh," "obtain consent," and "give up"; do not collapse them.

- **Scope failures are RC5038, not RC5015.** Per § 9 this is a deliberate change in check semantics, and the rationale is the recoverable / permanent split: a role or predicate failure states something about who the subject *is*, which no ceremony changes, while a missing scope states something about what the *credential* carries, which a consent flow can widen. Collapsing them would force every consent implementation to parse error text to tell "ask the user" from "give up". The structured detail rides on the cause (`InsufficientAuthority`), not on the RC metadata, so it is in-process only: `RoutecraftError.toJSON()` serialises the cause's message and stack, not its own fields.

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

## 10. Event payloads and rejection log levels

- `auth:success` and `auth:rejected` events carry sanitised detail objects: `{ subject, scheme, source }` (success) or `{ reason, source }` (rejected). Do not extend these payloads to include the raw token or any high-cardinality identifier (full JWT, opaque session id) that an aggregator would index and retain.
- **`reason` is a bounded enum, not free text.** On the MCP paths it is one of `expired`, `infrastructure`, `invalid_token`, `missing_header`, `unsupported_scheme`, `missing_expires_at`; the HTTP plugin uses its own fixed literals, including the webhook-signature rejections (`missing signature header`, `invalid signature`, `signature expired`, emitted with `scheme: "signature"`). Never derive `reason` from `err.message` (see section 4).
- Principal-shaped payloads on other events (e.g. `route:*:exchange:processed`) MAY include the full `Principal` object via `ex.principal` because the principal itself is sanitised; the bearer is not in it.
- **Rejection log levels.** `auth:rejected` fires for every rejection so observers can count them, but the log level must distinguish routine handshake noise from failures that warrant attention. Log at `debug`: a request with no `Authorization` header (the spec-defined MCP OAuth discovery probe, which fires on essentially every client connect), an unparseable or non-bearer scheme, and an expired token (clients routinely present a stale cached token, then refresh). Reserve `warn` for a presented bearer token that fails validation for any other reason (bad signature, wrong audience or issuer, malformed). This keeps `warn` a usable signal rather than one line per connect. Expiry is detected via `isExpiredTokenError` (`packages/ai/src/mcp/auth-errors.ts`), which keys off `jose`'s stable `ERR_JWT_EXPIRED` code.

---

## Boundaries

- **Source boundary** (`mcp()`, future `http()`): runs `verify` / `validator`; emits `auth:success` or `auth:rejected`; attaches `Principal` to the exchange.
- **Route boundary** (`.authorize()` / `.validate(authorize(...))`): checks principal against role / scope / predicate / expiry; emits `exchange:failed` on rejection.
- **Userinfo boundary** (`buildEnrichedVerifier`): runs after `verify` succeeds; merges enrichment with protected fields preserved; raises `RC5021` / `RC5022` on failure.
- **HTTP transport boundary** (`startHttp`): serves RFC 9728 metadata; emits 401 with `resource_metadata`. A failed token validation MUST result in `401 invalid_token` (so the client refreshes), not a generic 500. The framework owns this mapping directly rather than delegating to SDK middleware, which is the point of dropping `requireBearerAuth`: one policy covers every auth helper. Server-side failures map to 500 instead, so a backend blip is never reported to the client as an invalid token (which would make every client discard a valid cached token and stampede the IdP with refreshes): framework errors (`RC5021` / `RC5022`) and JWKS infrastructure failures (endpoint unreachable, timed out, or returning a bad response, detected via `isInfrastructureError` in `packages/ai/src/mcp/auth-errors.ts`) propagate unchanged. The default for an unclassified throw is 401, which keeps custom and built-in `jwt()` validators that reject with a plain `Error` mapping to 401.

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

## 12. Agent identity and delegation

Anchors `packages/routecraft/src/auth/delegate.ts` and the delegation-aware
surface of `authorize()`. Grounded in RFC 8693 (`act` / `may_act`), RFC 9068
(`roles`), and the OAuth actor profile draft (`sub_profile`).

- **`subject` is the party on whose behalf an action is taken; `actor` is the
  party performing it.** `actor` nests (RFC 8693 § 4.1); the outermost entry is
  the current actor and **only the current actor is an access-control input**.
  Prior actors are audit data and MUST NOT be exposed as an authorization
  input. `authorize({ actor })` matches the outermost entry exclusively.
- **Routecraft supports delegation, never impersonation** (RFC 8693 § 1.1).
  A minted principal always retains its subject and always names its actor.
  There is no API that replaces a subject with an agent.
- **Authenticity is a property of the whole chain.** The `WeakSet` brand is
  applied to the root, and `markAuthentic` deep-freezes the `actor` chain and
  the `mayAct` list, because both are policy inputs: a shallow freeze would
  let any holder of `ex.principal` rewrite the current actor or widen the
  consent list of an already-authentic identity. Chains are constructed only
  inside `delegate()`; `authenticate()` rejects `actor` and `grantId` (RC5024)
  so re-minting cannot fabricate a delegated identity while skipping the
  `mayAct` check and the scope intersection. `mayAct` is still accepted at
  mint: it describes the subject, like roles.
- **The delegation semantics are user-facing contract.** The scope
  intersection (`intersect(subject, ceiling)`, roles pass through, the
  actor's own scopes are deliberately not a term), the fail-closed strip on
  missing consent with the `{ otherwise: "keep" }` opt-out, actor identity as
  the `(issuer, subject)` pair, and the fail-closed `act` / `may_act` token
  parsing (with `ClaimMappers.actor` / `ClaimMappers.mayAct` for non-standard
  shapes) are documented at
  `apps/routecraft.dev/src/app/docs/reference/operations/delegate/page.md`
  and `apps/routecraft.dev/src/app/docs/advanced/securing-capabilities/page.md`
  ("Agents acting on behalf of users"). Review notes that stay here:
  - A matcher with no fields set matches any actor; validate config before
    building matchers from it.
  - The `act` parse is depth-capped and rejects beyond the cap rather than
    truncating, since a silently shortened chain misreports the current
    actor.
  - A configurable scope-composition strategy (merging or otherwise varying
    the two-way intersection) was considered and DEFERRED until a real case
    demands it; the intersection is two-way and final.
- **`actor: 'none'` is the `authorize()` default**, per § 6a. A capability is
  not agent-reachable unless it says so. `maxDelegationDepth` defaults to `1`
  and its walk is bounded, so a hand-assembled cyclic chain fails rather than
  hanging the check.
- **Agent-ness is structural, never a role.** `subjectProfile` and `actor` are
  set by the framework at trusted boundaries. Roles come from the IdP and are
  a namespace we do not control, so an "is an agent" role would be forgeable
  where the structural field is not. An absent `subjectProfile` is
  unclassified and MUST attract restrictive policy.
- **A channel identifier is not a credential.** An inbound channel assertion
  (a DKIM-passing sender, a signed Slack event) establishes identification
  only. Converting one into an agent's authority requires a consent record;
  `.authenticate()` MUST NOT be used to mint a user principal from a channel
  identifier and hand it straight to an agent.
- **A model's judgement is never an authorization boundary.** One agent
  reviewing another's work is quality control. Enforcement stays in
  `authorize()` and tool guards.
- **Scopes gate the verb; guards gate the object.** A scope string cannot
  express "to whom" or "which record". Parameter-level authorization belongs
  in `ToolGuard`, not in the scope vocabulary.
