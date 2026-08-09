---
title: Securing capabilities
---

Authenticate the HTTP endpoints that expose your capabilities, and enrich the caller's identity. {% .lead %}

## When you need this

Stdio transport runs as a local subprocess with no network surface, so it needs no authentication. The moment you switch a capability to the HTTP transport (a long-running server multiple clients reach over the network), you must secure it. This page covers every authentication mode Routecraft ships, from a static signing key to OAuth 2.0 resource-server verification, plus identity enrichment, discovery metadata, and CORS.

For wiring the server itself and pointing clients at it, see [Running an MCP server](/docs/advanced/expose-as-mcp). For a concrete, copyable capability, see the [MCP example](/docs/examples/mcp).

You attach authentication with the `auth` option on `mcpPlugin({ transport: 'http' })`:

```ts
// craft.config.ts
import { mcpPlugin, jwt } from '@routecraft/ai'

export default {
  plugins: [
    mcpPlugin({
      transport: 'http',
      port: 3001,
      auth: jwt({
        secret: process.env.JWT_SECRET!,
        issuer: 'https://idp.example.com',
        audience: 'https://mcp.example.com',
      }),
    }),
  ],
}
```

## Static-key JWT (`jwt()`)

Routecraft ships with a built-in `jwt()` helper that verifies JWT signatures using `node:crypto` (zero dependencies). `issuer` and `audience` are required to prevent cross-issuer and cross-audience replay. Both accept a single string or an array of accepted values. Use `audience: "*"` only when you explicitly want to skip audience validation.

```ts
import { jwt } from '@routecraft/ai'

// HMAC (HS256, default)
auth: jwt({
  secret: process.env.JWT_SECRET!,
  issuer: 'https://idp.example.com',
  audience: 'https://mcp.example.com',
})

// RSA (RS256)
auth: jwt({
  algorithm: 'RS256',
  publicKey: fs.readFileSync('./public.pem', 'utf-8'),
  issuer: 'https://idp.example.com',
  audience: 'https://mcp.example.com',
})
```

`jwt` and `jwks` are also exported from `@routecraft/routecraft` -- the `@routecraft/ai` re-export is a convenience.

## JWKS-backed JWT (`jwks()`)

For JWTs signed by an external IdP, use `jwks()`. It lazy-loads `jose` and fetches the public key set from the IdP's JWKS endpoint:

```ts
import { jwks } from '@routecraft/ai'

auth: jwks({
  jwksUrl: 'https://idp.example.com/.well-known/jwks.json',
  issuer: 'https://idp.example.com',
  audience: 'https://mcp.example.com',
})
```

For non-standard IdPs that use different claim names, override individual mappings with `claims`:

```ts
auth: jwks({
  jwksUrl: 'https://login.microsoftonline.com/<tenant>/discovery/v2.0/keys',
  issuer: 'https://login.microsoftonline.com/<tenant>/v2.0',
  audience: '<app-id>',
  claims: {
    subject: (p) => p.oid as string,
    roles: (p) => p['roles'] as string[] | undefined,
  },
})
```

## Custom validator

For API keys, opaque tokens, or any other scheme, pass a `validator` function. Throw to reject; return a `Principal` to accept. A rejected credential answers `401`, but a throw that names an infrastructure failure (an unreachable JWKS endpoint, a failed `userinfo` fetch) answers `500` on every auth mode, so a client retries rather than discarding a credential that is probably valid:

```ts
auth: {
  validator: async (token) => {
    const user = await db.verifyApiKey(token)
    if (!user) throw new Error('unknown key')
    return {
      kind: 'custom',
      scheme: 'bearer',
      subject: user.id,
      name: user.label,
    }
  },
}
```

The returned `Principal` is a flat object tagged with `kind` (`"jwt"`, `"jwks"`, `"oauth"`, or `"custom"`). It rides on the exchange as a structured `routecraft.auth.principal` header and is exposed ergonomically via the `ex.principal` getter.

## OAuth resource server (`oauth()`)

A Routecraft MCP server is an OAuth 2.0 **Resource Server**. It verifies bearer tokens, enforces required scopes, and advertises its Authorization Server through RFC 9728 metadata; clients run the authorization flow directly against your IdP. Routecraft does not proxy `/authorize`, `/token`, `/register` or `/revoke`, so there is no web framework to install: `jose` (for JWKS verification) is the only optional peer.

```sh
bun add jose
```

Compose `oauth()` with `jwks()` (or a raw verifier function) via the `verify` option. The protected-resource identity (`resource.url`) lives on the plugin, not on `oauth()`:

```ts
import { mcpPlugin, oauth, jwks } from '@routecraft/ai'

mcpPlugin({
  transport: 'http',
  resource: { url: 'https://mcp.example.com' },
  auth: oauth({
    verify: jwks({
      jwksUrl: 'https://idp.example.com/.well-known/jwks.json',
      issuer: 'https://idp.example.com',
      audience: 'https://mcp.example.com',
    }),
    // Refused with 403 insufficient_scope when the token lacks any of these.
    requiredScopes: ['mcp:invoke'],
  }),
})
```

`oauth()` is a thin layer over the same options `jwks()` and `jwt()` produce: reach for it when you want `requiredScopes` enforcement or an explicit issuer, and pass the validator straight to `auth` otherwise. The issuer comes from the `verify` helper automatically; pass `issuer` explicitly when `verify` is a raw function, since nothing else names the IdP for clients to discover.

For opaque tokens or custom introspection, pass a raw `verify` function instead:

```ts
auth: oauth({
  issuer: 'https://idp.example.com',
  verify: async (token) => {
    const info = await myIntrospectionCall(token)
    if (!info.active) throw new Error('token inactive')
    if (typeof info.exp !== 'number') throw new Error('token has no exp')
    return {
      kind: 'oauth',
      scheme: 'bearer',
      subject: info.sub,
      clientId: info.client_id,
      expiresAt: info.exp,
    }
  },
})
```

`verify` runs on **every** request: revision 2026-07-28 is stateless, so there is no session in which a past verification could be cached. Keep introspection calls fast, or cache them yourself.

`expiresAt` is required on a principal returned through `oauth()`, and a principal whose expiry has already passed is refused at the gate whichever auth mode produced it. A credential with no expiry never expires, so `oauth()` will not admit one.

The populated `Principal` rides on the exchange as a single structured header (`routecraft.auth.principal`) and is exposed ergonomically via the `ex.principal` getter, e.g. `ex.principal?.subject`, `ex.principal?.scopes`, `ex.principal?.claims`.

## Principal enrichment via `userinfo`

OAuth access tokens are intentionally thin: they authorize but rarely identify. Identity fields needed to gate routes (`email`, `name`, `roles`, org membership) usually live behind the IdP's userinfo endpoint, not in the token itself. The optional `userinfo` option on `mcpPlugin({})` runs after `auth` verifies the token and merges enrichment onto the verified principal.

`userinfo` is **plugin-level and orthogonal to the auth mode**: it works with `jwks()` / `jwt()`, a custom `{ validator }`, and `oauth()`. This is the path for IdPs like WorkOS AuthKit where the token itself is thin but you still need richer identity.

Three shapes are accepted; choose exactly one.

**Shape 1: auto-discover via OIDC Discovery.** Requires a single-string `issuer` on the verify helper (`jwks({ issuer })` / `jwt({ issuer })`). The framework resolves the userinfo endpoint from the discovery document at `${issuer}/.well-known/openid-configuration` and caches the URL honouring `Cache-Control: max-age` (default 1 hour).

```ts
mcpPlugin({
  transport: 'http',
  auth: jwks({ jwksUrl, issuer: 'https://idp.example.com', audience }),
  userinfo: true,
})
```

**Shape 2: explicit userinfo endpoint URL.** Skips discovery; use when the IdP does not advertise OIDC Discovery or you want to pin the URL explicitly.

```ts
mcpPlugin({
  transport: 'http',
  auth: jwks({ jwksUrl, issuer: 'https://idp.example.com', audience }),
  userinfo: 'https://idp.example.com/oauth/userinfo',
})
```

**Shape 3: custom function** for non-OIDC backends (WorkOS / Clerk Backend API, internal DB, etc.). Sub-invariant enforcement is the caller's responsibility in this mode.

```ts
mcpPlugin({
  transport: 'http',
  auth: jwks({ jwksUrl, issuer: 'https://idp.example.com', audience }),
  userinfo: async (principal, token) => {
    const [profile, roles] = await Promise.all([
      fetch('https://idp.example.com/oauth/userinfo', {
        headers: { Authorization: `Bearer ${token}` },
      }).then((r) => r.json()),
      myService.getRoles(principal.subject),
    ])
    return { ...profile, roles }
  },
})
```

The same `userinfo` option works unchanged when `auth` is `oauth({})`.

Semantics:

- **Default is no enrichment.** When `userinfo` is omitted, the principal carries only what the token itself provided (`email` / `name` / `roles` only if those claims are in the JWT). Set `userinfo` to fetch them for thin tokens.
- **Runs after verify.** The verified principal is the starting point; userinfo only adds or overwrites non-protected fields.
- **Verify wins on protected fields.** `subject`, `issuer`, `audience`, `expiresAt`, and `claims` always come from the token. An enrichment that tries to overwrite them is silently dropped. The raw userinfo response is surfaced on a separate `userinfoClaims` field so `principal.claims` keeps its meaning ("verified JWT payload") regardless of whether enrichment ran.
- **`sub` invariant (URL and discovery modes).** The userinfo response MUST include `sub` and it MUST equal the verified token's `sub` (OIDC Core §5.3.2). Mismatches reject the request with `RC5022`. The function variant is trusted by contract.
- **Auto-discovery (`userinfo: true`).** The framework fetches the OIDC Discovery document relative to the verifier's `issuer` (preserving the issuer's path, so Keycloak realms and tenant-prefixed IdPs work), reads `userinfo_endpoint`, and caches the resolved URL honouring the response's `Cache-Control: max-age` (default one hour). A missing single-string issuer fails fast at startup; a missing `userinfo_endpoint` or unreachable discovery doc raises `RC5021` on the first request.
- **Token-bound enrichment caching with coalescing.** The verifier runs on every request, so dynamic checks (introspection, revocation, clock comparisons) still fire per request. Only the enrichment payload is memoised, keyed by SHA-256 of the bearer (not the raw bearer) and evicted at `expiresAt`. The cache has a default cap of 10,000 entries with insertion-order eviction. Concurrent first-callers for the same token share a single in-flight enrichment, so the IdP receives one userinfo fetch per token, not one per inbound request.
- **Fail-closed.** Userinfo fetch, parse, and discovery errors raise `RC5021`; sub-invariant violations raise `RC5022`. There is no opt-in "best effort" mode; if you need that, write a function variant that swallows its own errors.

If `authorize()` runs mid-pipeline after a slow step, set `authorize({ clockToleranceSec })` to the same value used on the source-side verifier so a token accepted at the route boundary is not rejected by a fraction of a second.

Use `userinfo` when the bearer alone does not carry the identity fields you need. Skip it when the token already contains everything (e.g. a JWT with `email` and `roles` claims).

See the [mcpPlugin reference](/docs/reference/plugins/mcpplugin) for the full `Principal` field list.

## Protected-resource metadata (RFC 9728)

Auto-discovering MCP clients (Claude.ai custom connectors, MCP Inspector, `mcp-remote`, Claude Desktop) probe `/mcp`, receive a 401, then fetch `/.well-known/oauth-protected-resource` to find out which authorization server to use. The framework serves this RFC 9728 metadata document whichever auth helper you use, and appends a `resource_metadata="..."` parameter to the 401 `WWW-Authenticate` header so clients know where the document lives.

Protected-resource identity is configured on the plugin, not on the auth helper. It is orthogonal to the auth mode: the same `resource: {...}` block works whether you use `jwt()` / `jwks()` directly or via `oauth()`.

```ts
mcpPlugin({
  name: 'eywa',                          // machine identifier (MCP `serverInfo.name`)
  title: 'Eywa MCP',                     // human display; also the metadata `resource_name`
  transport: 'http',
  host: '0.0.0.0',
  port: 3001,
  resource: {
    url: 'https://mcp.example.com',      // metadata `resource` field; defaults to bound URL
    scopesSupported: ['read', 'write'],  // metadata `scopes_supported`
    documentationUrl: 'https://docs.example.com',  // metadata `resource_documentation`
  },
  auth: jwks({
    jwksUrl: 'https://idp.example.com/.well-known/jwks.json',
    issuer: 'https://idp.example.com',
    audience: 'https://mcp.example.com',
  }),
})
```

The metadata document populates `authorization_servers` from the auth options' `issuer`, surfaced by `jwks()` / `jwt()` / `oauth()`. A custom validator with no declared issuer omits the field, which RFC 9728 allows, though clients then have no way to discover where to authenticate.

When `resource.url` is omitted, the framework advertises the bound `http://{host}:{port}/mcp`. This is fine for local dev but should be overridden in production with the public-facing URL clients use to reach the server. In production, `resource.url` must be HTTPS or the plugin throws at startup.

This is how MCP clients auto-discover your IdP. Protocol revision 2026-07-28 deprecated Dynamic Client Registration in favour of Client ID Metadata Documents, so the discovery document plus a direct flow against the IdP is the supported shape for every provider, including ones like WorkOS AuthKit that never offered server-side DCR.

## CORS

Browser-based MCP clients (MCP Inspector UI, Claude.ai custom connectors, web-hosted Claude Desktop) need CORS headers on the MCP HTTP transport. The framework handles this on three surfaces: `/mcp`, `/.well-known/oauth-protected-resource`, and the 401 `WWW-Authenticate` response.

The default policy is **loopback-only**: a browser request whose `Origin` is on `localhost`, `127.0.0.1`, or `[::1]` (any port, http or https) gets reflected; everything else gets no `Access-Control-Allow-Origin` and is blocked by the browser. This is production-safe by construction: local browser tooling like MCP Inspector at `http://localhost:6274` works with zero config, while production browser origins must be allowlisted explicitly.

Server-to-server callers (`curl`, `mcp-remote`, the MCP CLI) do not send an `Origin` header and are unaffected by this policy regardless of configuration.

The option surface is intentionally minimal: only `origin` is configurable. The framework controls allowed methods (`GET, POST, OPTIONS`), allowed headers (`*`), and exposed headers (`WWW-Authenticate`) so browser clients can read the RFC 9728 `resource_metadata` hint on a 401 and follow discovery. Protocol revision 2026-07-28 removed both sessions and SSE resumability, so `Mcp-Session-Id` and `Last-Event-ID` are never emitted and are not exposed. Preflight responses also carry `Access-Control-Allow-Private-Network: true` so Chrome PNA crossings (e.g. a hosted browser client tunnelled to a local MCP server) are not blocked.

```ts
// Default: no config needed for local browser MCP tooling
mcpPlugin({
  transport: 'http',
  auth: jwks({ jwksUrl: '...', issuer: '...' }),
})

// Production: allowlist your browser MCP client's origin
mcpPlugin({
  transport: 'http',
  auth: jwks({ /* ... */ }),
  cors: { origin: 'https://claude.ai' },
})

// Multi-origin allowlist
mcpPlugin({
  cors: { origin: ['https://claude.ai', 'https://inspector.example.com'] },
})

// Custom resolver
mcpPlugin({
  cors: {
    origin: (requestOrigin) =>
      requestOrigin?.endsWith('.tenants.example.com') ? requestOrigin : false,
  },
})

// Last-resort permissive
mcpPlugin({
  cors: { origin: '*' },
})

// Disable entirely (e.g. when fronted by a CDN/proxy that owns CORS)
mcpPlugin({
  cors: false,
})
```

The `cors` slot governs the routes the framework owns: `/mcp` and the protected-resource metadata. Routecraft mounts no OAuth endpoints of its own, so there is nothing else on the origin to police.

## Agents acting on behalf of users

When an agent (or any delegate) exercises a user's authority, the principal records both parties: `subject` stays the user the action is for, `actor` names the agent driving it (RFC 8693 `act` semantics). The [`delegate` operation](/docs/reference/operations/delegate) establishes this after identity is verified, intersecting scopes under a consent-derived ceiling so delegation can only narrow authority, never widen it. Roles pass through unchanged: they describe who the subject is, while scopes describe what the credential may do.

Every route then declares who may drive it via [`authorize()`](/docs/reference/operations/authorize):

```ts
// Humans only (this is the default: actor 'none')
.authorize({ roles: ['finance'], actor: 'none' })

// A member directly, or one named agent on a member's behalf
.authorize({
  roles: ['member'],
  scopes: ['mail:send'],
  actor: ['none', { subject: 'agent:zoe', issuer: 'https://agents.example.com' }],
})

// Autonomous agents only (cron-triggered background work)
.authorize({ subject: { profile: 'ai_agent' }, actor: 'none' })
```

Three rules keep the model sound:

- **Identification is not authorization.** A verified channel identifier (a DKIM-passing sender, a Slack user id) says who someone is, never what an agent may do for them. Convert identity into delegated authority only through an explicit consent record, and mint it with `.delegate()`, not by handing the agent the user's full principal.
- **Only the outermost actor is policy input.** Nested actors in a chain are audit data (RFC 8693 section 4.1); `authorize({ actor })` matches the current actor and `maxDelegationDepth` bounds the chain.
- **Delegation claims fail closed at the token boundary.** A verified token whose `act` or `may_act` claim the parser cannot read is rejected, never silently stripped: dropping an `act` would promote a delegated token to a direct call and pass an `actor: 'none'` route, and dropping a `may_act` would turn a restriction into permission. Map non-standard shapes (an actor identified by `client_id`, for instance) with `ClaimMappers.actor` / `ClaimMappers.mayAct`.
- **Autonomous authority is minted from internal triggers only.** An agent acting as its own subject (`subjectProfile: 'ai_agent'`, no actor) should be minted on cron or timer sources, never from an externally reachable channel, so inbound messages can never trigger an agent's standing authority.

## Security checklist

- **Validate all inputs** -- every capability should have a schema; Routecraft enforces it before execution
- **Authenticate HTTP endpoints** -- always set `auth` when using HTTP transport in production
- **Guardrails** -- use `.filter()` to reject exchanges that fail a business rule, and `.transform()` to sanitize or normalise values before they reach downstream systems
- **Authorize per route** -- gate sensitive capabilities with [`authorize()`](/docs/reference/operations/authorize) against the verified principal's roles or scopes
- **Principle of least privilege** -- only expose capabilities the AI actually needs
- **Govern agent tool access** -- hand an agent a wrapped `Direct(...)` route instead of a raw `MCP(...)` tool when it needs authorization, caching, or timeouts; see [Calling an MCP](/docs/advanced/call-an-mcp#guardrails-raw-guarded-or-wrapped)
- **Audit trail** -- add `.tap(log())` to record every invocation; subscribe to `plugin:mcp:tool:**` events for MCP-specific tracing
- **Never hardcode credentials** -- use `process.env` and `.env` files

---

## Related

{% quick-links %}

{% quick-link title="Running an MCP server" icon="plugins" href="/docs/advanced/expose-as-mcp" description="Transports, client wiring, and server identity." /%}
{% quick-link title="MCP tool" icon="installation" href="/docs/examples/mcp" description="A copyable capability exposed as an MCP tool." /%}
{% quick-link title="mcpPlugin reference" icon="presets" href="/docs/reference/plugins/mcpplugin" description="Full plugin options and the Principal field list." /%}

{% /quick-links %}
