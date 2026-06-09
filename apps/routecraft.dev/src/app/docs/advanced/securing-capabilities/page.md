---
title: Securing capabilities
---

Authenticate the HTTP endpoints that expose your capabilities, and enrich the caller's identity. {% .lead %}

## When you need this

Stdio transport runs as a local subprocess with no network surface, so it needs no authentication. The moment you switch a capability to the HTTP transport (a long-running server multiple clients reach over the network), you must secure it. This page covers every authentication mode Routecraft ships, from a static signing key to a full OAuth 2.1 proxy, plus identity enrichment, discovery metadata, and CORS.

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

For API keys, opaque tokens, or any other scheme, pass a `validator` function. Throw to reject (any thrown error returns 401); return a `Principal` to accept:

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

## OAuth 2.1 proxy (`oauth()`)

For the full OAuth 2.1 Authorization Code flow with an upstream IdP, use `oauth()`. It proxies the authorization and token endpoints and validates incoming bearer tokens. It requires `express` and (for JWKS verification) `jose` as optional peer dependencies:

```sh
bun add express jose
```

Compose `oauth()` with `jwks()` (or a raw verifier function) via the `verify` option. The protected-resource identity (`resource.url`) lives on the plugin, not on `oauth()`:

```ts
import { mcpPlugin, oauth, jwks } from '@routecraft/ai'

mcpPlugin({
  transport: 'http',
  resource: { url: 'https://mcp.example.com' },
  auth: oauth({
    endpoints: {
      authorizationUrl: 'https://idp.example.com/oauth/authorize',
      tokenUrl: 'https://idp.example.com/oauth/token',
    },
    verify: jwks({
      jwksUrl: 'https://idp.example.com/.well-known/jwks.json',
      issuer: 'https://idp.example.com',
      audience: 'https://mcp.example.com',
    }),
    client: {
      client_id: 'my-mcp-server',
      redirect_uris: ['http://localhost:3000/callback'],
    },
  }),
})
```

For opaque tokens or custom introspection, pass a raw `verify` function instead:

```ts
auth: oauth({
  endpoints: { authorizationUrl: '...', tokenUrl: '...' },
  verify: async (token) => {
    const info = await myIntrospectionCall(token)
    if (!info.active) throw new Error('token inactive')
    return {
      kind: 'oauth',
      scheme: 'bearer',
      subject: info.sub,
      clientId: info.client_id,
      expiresAt: info.exp,
    }
  },
  client: async (clientId) => await db.clients.findByClientId(clientId),
})
```

`client` accepts either a static `OAuthClientInfo` (unknown IDs are rejected) or a `(clientId) => Promise<OAuthClientInfo | undefined>` supplier for dynamic lookup. The supplier is called per request during the OAuth flow, so cache or preload registry reads to keep the hot path fast.

`expiresAt` is required by the MCP SDK's bearer middleware; the server will throw if the verifier returns a principal without it.

The populated `Principal` rides on the exchange as a single structured header (`routecraft.auth.principal`) and is exposed ergonomically via the `ex.principal` getter, e.g. `ex.principal?.subject`, `ex.principal?.scopes`, `ex.principal?.claims`.

> A vendor-specific walkthrough of this flow with Clerk lives in the blog: [Securing a Routecraft MCP with Clerk](/blog/securing-mcp-with-clerk).

## Principal enrichment via `userinfo`

OAuth access tokens are intentionally thin: they authorize but rarely identify. Identity fields needed to gate routes (`email`, `name`, `roles`, org membership) usually live behind the IdP's userinfo endpoint, not in the token itself. The optional `userinfo` option on `mcpPlugin({})` runs after `auth` verifies the token and merges enrichment onto the verified principal.

`userinfo` is **plugin-level and orthogonal to the auth mode**: it works with `jwks()` / `jwt()` (validator mode), a custom `{ validator }`, and `oauth()`. This is the path for IdPs like WorkOS AuthKit where OAuth proxy mode is not viable (no server-side DCR) but you still need identity beyond the thin token.

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

Auto-discovering MCP clients (Claude.ai custom connectors, MCP Inspector, `mcp-remote`, Claude Desktop) probe `/mcp`, receive a 401, then fetch `/.well-known/oauth-protected-resource` to find out which authorization server to use. The framework serves this RFC 9728 metadata document in both validator and OAuth-proxy auth modes, and appends a `resource_metadata="..."` parameter to the 401 `WWW-Authenticate` header so clients know where the document lives.

Protected-resource identity is configured on the plugin, not on the auth helper. It is orthogonal to the auth mode: the same `resource: {...}` block works whether you use `jwt()` / `jwks()` (validator mode) or `oauth()` (proxy mode).

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

The metadata document populates `authorization_servers` from the validator's `issuer` (surfaced by `jwks()` / `jwt()`) when present. Custom validators with no declared issuer omit the field, which RFC 9728 allows. OAuth-proxy mode derives `authorization_servers` from the MCP SDK's `mcpAuthRouter`.

When `resource.url` is omitted, the framework advertises the bound `http://{host}:{port}/mcp`. This is fine for local dev but should be overridden in production with the public-facing URL clients use to reach the server. In production, `resource.url` must be HTTPS or the plugin throws at startup.

The motivating case is IdPs that do not support server-side Dynamic Client Registration (DCR) and therefore cannot use OAuth proxy mode -- WorkOS AuthKit is the canonical example. In that setup, validator mode (`auth: jwks(...)`) is the only correct integration, and the RFC 9728 metadata document is what lets MCP clients still auto-discover the IdP.

## CORS

Browser-based MCP clients (MCP Inspector UI, Claude.ai custom connectors, web-hosted Claude Desktop) need CORS headers on the MCP HTTP transport. The framework handles this on three surfaces: `/mcp`, `/.well-known/oauth-protected-resource`, and the 401 `WWW-Authenticate` response.

The default policy is **loopback-only**: a browser request whose `Origin` is on `localhost`, `127.0.0.1`, or `[::1]` (any port, http or https) gets reflected; everything else gets no `Access-Control-Allow-Origin` and is blocked by the browser. This is production-safe by construction: local browser tooling like MCP Inspector at `http://localhost:6274` works with zero config, while production browser origins must be allowlisted explicitly.

Server-to-server callers (`curl`, `mcp-remote`, the MCP CLI) do not send an `Origin` header and are unaffected by this policy regardless of configuration.

The option surface is intentionally minimal: only `origin` is configurable. The framework controls allowed methods (`GET, POST, OPTIONS`), allowed headers (`*`), and exposed headers (`WWW-Authenticate, Mcp-Session-Id, Last-Event-ID`) so browser clients can read the RFC 9728 `resource_metadata` hint on a 401 and follow discovery, echo the SDK-issued `Mcp-Session-Id` on every request after `initialize` (stateful transport), and resume SSE streams via `Last-Event-ID`. Preflight responses also carry `Access-Control-Allow-Private-Network: true` so Chrome PNA crossings (e.g. a hosted browser client tunnelled to a local MCP server) are not blocked.

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

The OAuth-proxy mode's SDK-owned endpoints (`/register`, `/token`, `/revoke`, the SDK's own metadata) keep their own permissive CORS handling from the MCP SDK. The `cors` slot governs only the routes the framework owns (`/mcp` and the protected-resource metadata).

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
