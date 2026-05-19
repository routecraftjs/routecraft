---
title: Expose as MCP
---

Run your capabilities as MCP tools for Claude, Cursor, and other AI clients. {% .lead %}

## How it works

Routecraft uses the Model Context Protocol (MCP) to expose capabilities as typed tools. You define the tool as a capability using the `mcp()` source adapter, run it with `craft run`, and point your AI client at the process. The AI can then call your tool with validated inputs -- nothing else is accessible.

## Install

```bash
npm install @routecraft/ai zod
```

## Define a capability

A capability becomes an MCP tool when you use `mcp()` as its source. The tool name is the route's `.id()`. The `.description()` that the AI uses to decide when to call it, and the `.input()` schema for the payload, both live on the route builder. Routecraft validates input against the schema before the capability runs, so invalid calls are rejected before any business logic executes.

```ts
// capabilities/search-orders.ts
import { mcp } from '@routecraft/ai'
import { craft, http } from '@routecraft/routecraft'
import { z } from 'zod'

export default craft()
  .id('orders.search')
  .description('Search orders by customer ID or date range')
  .input({
    body: z.object({
      customerId: z.string().optional(),
      from: z.string().date().optional(),
      to: z.string().date().optional(),
    }),
  })
  .from(mcp())
  .transform(({ customerId, from, to }) => buildQuery(customerId, from, to))
  .to(http({ method: 'GET', path: '/orders' }))
```

## Stdio transport (default)

Stdio is the simplest transport. The AI client spawns Routecraft as a subprocess and communicates over stdin/stdout. No networking, no auth required.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "my-tools": {
      "command": "bunx",
      "args": [
        "@routecraft/cli",
        "run",
        "./capabilities/search-orders.ts"
      ]
    }
  }
}
```

Restart Claude Desktop completely after saving. Look for the hammer icon in the input area.

### Cursor

Open **Cursor Settings** > **Features** > **Model Context Protocol**, then add:

```json
{
  "my-tools": {
    "command": "bunx",
    "args": [
      "@routecraft/cli",
      "run",
      "./capabilities/search-orders.ts"
    ]
  }
}
```

### Claude Code

Add the following to your `.mcp.json` (project-level) or `~/.claude/mcp.json` (global):

```json
{
  "mcpServers": {
    "my-tools": {
      "command": "bunx",
      "args": [
        "@routecraft/cli",
        "run",
        "./capabilities/search-orders.ts"
      ]
    }
  }
}
```

## HTTP transport

Use the HTTP transport when you want a long-running server that multiple clients can connect to, or when you need authentication. Add `mcpPlugin` to your config with `transport: 'http'`:

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

Start the server with `craft run`, then point your AI client at it.

### Claude Desktop (HTTP)

```json
{
  "mcpServers": {
    "my-tools": {
      "url": "http://localhost:3001/mcp",
      "headers": {
        "Authorization": "Bearer <your-jwt-token>"
      }
    }
  }
}
```

### Cursor (HTTP)

```json
{
  "my-tools": {
    "url": "http://localhost:3001/mcp",
    "headers": {
      "Authorization": "Bearer <your-jwt-token>"
    }
  }
}
```

### Claude Code (HTTP)

```json
{
  "mcpServers": {
    "my-tools": {
      "url": "http://localhost:3001/mcp",
      "headers": {
        "Authorization": "Bearer <your-jwt-token>"
      }
    }
  }
}
```

## Authentication

When using HTTP transport, secure the endpoint with the `auth` option.

### Static-key JWT (`jwt()`)

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

### JWKS-backed JWT (`jwks()`)

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

### Custom validator

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

### OAuth 2.1 proxy (`oauth()`)

For the full OAuth 2.1 Authorization Code flow with an upstream IdP, use `oauth()`. It proxies the authorization and token endpoints and validates incoming bearer tokens. It requires `express` and (for JWKS verification) `jose` as optional peer dependencies:

```sh
bun add express jose
```

Compose `oauth()` with `jwks()` (or a raw verifier function) via the `verify` option. The protected-resource identity (`resource.url`) lives on the plugin, not on `oauth()`:

```ts
import { mcpPlugin, oauth, jwks } from '@routecraft/ai'

// Clerk example
mcpPlugin({
  transport: 'http',
  resource: { url: 'https://mcp.example.com' },
  auth: oauth({
    endpoints: {
      authorizationUrl: 'https://clerk.example.com/oauth/authorize',
      tokenUrl: 'https://clerk.example.com/oauth/token',
    },
    verify: jwks({
      jwksUrl: 'https://clerk.example.com/.well-known/jwks.json',
      issuer: 'https://clerk.example.com',
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

#### Principal enrichment via `userinfo`

OAuth access tokens are intentionally thin: they authorize but rarely identify. Identity fields needed to gate routes (`email`, `name`, `roles`, org membership) usually live behind the IdP's userinfo endpoint, not in the token itself. The optional `userinfo` slot on `oauth({})` runs after `verify` succeeds and merges enrichment onto the verified principal. Three shapes are accepted; choose exactly one per `oauth({})` call.

**Shape 1: auto-discover via OIDC Discovery.** Requires a single-string `issuer` on the verify helper (`jwks({ issuer })` / `jwt({ issuer })`). The framework resolves the userinfo endpoint from the discovery document at `${issuer}/.well-known/openid-configuration` and caches the URL honouring `Cache-Control: max-age` (default 1 hour).

```ts
auth: oauth({
  endpoints: { ... },
  verify: jwks({ jwksUrl, issuer: 'https://idp.example.com', audience }),
  client: { ... },
  userinfo: true,
})
```

**Shape 2: explicit userinfo endpoint URL.** Skips discovery; use when the IdP does not advertise OIDC Discovery or you want to pin the URL explicitly.

```ts
auth: oauth({
  endpoints: { ... },
  verify: jwks({ jwksUrl, issuer: 'https://idp.example.com', audience }),
  client: { ... },
  userinfo: 'https://idp.example.com/oauth/userinfo',
})
```

**Shape 3: custom function** for non-OIDC backends (Clerk Backend API, internal DB, etc.). Sub-invariant enforcement is the caller's responsibility in this mode.

```ts
auth: oauth({
  endpoints: { ... },
  verify: jwks({ jwksUrl, issuer: 'https://idp.example.com', audience }),
  client: { ... },
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

Semantics:

- **Runs after verify.** The verified principal is the starting point; userinfo only adds or overwrites non-protected fields.
- **Verify wins on protected fields.** `subject`, `issuer`, `audience`, `expiresAt`, and `claims` always come from the token. An enrichment that tries to overwrite them is silently dropped. The raw userinfo response is surfaced on a separate `userinfoClaims` field so `principal.claims` keeps its meaning ("verified JWT payload") regardless of whether enrichment ran.
- **`sub` invariant (URL and discovery modes).** The userinfo response MUST include `sub` and it MUST equal the verified token's `sub` (OIDC Core §5.3.2). Mismatches reject the request with `RC5022`. The function variant is trusted by contract.
- **Auto-discovery (`userinfo: true`).** The framework fetches the OIDC Discovery document relative to the verify helper's `issuer` (preserving the issuer's path, so Keycloak realms and tenant-prefixed IdPs work), reads `userinfo_endpoint`, and caches the resolved URL honouring the response's `Cache-Control: max-age` (default one hour). A missing `userinfo_endpoint` or an unreachable discovery doc raises `RC5021` on the first request.
- **Token-bound enrichment caching with coalescing.** The base verifier (`verify`) runs on every request, so dynamic checks (introspection, revocation, clock comparisons) still fire per request. Only the enrichment payload is memoised, keyed by SHA-256 of the bearer (not the raw bearer) and evicted at `expiresAt`. The cache has a default cap of 10,000 entries with insertion-order eviction. Concurrent first-callers for the same token share a single in-flight enrichment, so the IdP receives one userinfo fetch per token, not one per inbound request.
- **Fail-closed.** Userinfo fetch, parse, and discovery errors raise `RC5021`; sub-invariant violations raise `RC5022`. There is no opt-in "best effort" mode; if you need that, write a function variant that swallows its own errors.

If `authorize()` runs mid-pipeline after a slow step, set `authorize({ clockToleranceSec })` to the same value used on the source-side verifier so a token accepted at the route boundary is not rejected by a fraction of a second.

Use `userinfo` when the bearer alone does not carry the identity fields you need. Skip it when the token already contains everything (e.g. a Clerk JWT with `email` and `roles` claims).

The populated `Principal` rides on the exchange as a single structured header (`routecraft.auth.principal`) and is exposed ergonomically via the `ex.principal` getter, e.g. `ex.principal?.subject`, `ex.principal?.scopes`, `ex.principal?.claims`.

See the [plugins reference](/docs/reference/plugins#mcpplugin) for the full `Principal` field list.

### Protected-resource metadata (RFC 9728)

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

### CORS

Browser-based MCP clients (MCP Inspector UI, Claude.ai custom connectors, web-hosted Claude Desktop) need CORS headers on the MCP HTTP transport. The framework handles this on three surfaces: `/mcp`, `/.well-known/oauth-protected-resource`, and the 401 `WWW-Authenticate` response.

The default policy is **loopback-only**: a browser request whose `Origin` is on `localhost`, `127.0.0.1`, or `[::1]` (any port, http or https) gets reflected; everything else gets no `Access-Control-Allow-Origin` and is blocked by the browser. This is production-safe by construction: local browser tooling like MCP Inspector at `http://localhost:6274` works with zero config, while production browser origins must be allowlisted explicitly.

Server-to-server callers (`curl`, `mcp-remote`, the MCP CLI) do not send an `Origin` header and are unaffected by this policy regardless of configuration.

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

// Last-resort permissive (cannot combine with credentials)
mcpPlugin({
  cors: { origin: '*' },
})

// Disable entirely (e.g. when fronted by a CDN/proxy that owns CORS)
mcpPlugin({
  cors: false,
})
```

`WWW-Authenticate` is exposed by default (`Access-Control-Expose-Headers: WWW-Authenticate`) so browser clients can read the RFC 9728 `resource_metadata` hint on a 401 and follow discovery. Custom `exposeHeaders` are additive with this default.

The OAuth-proxy mode's SDK-owned endpoints (`/register`, `/token`, `/revoke`, the SDK's own metadata) keep their own permissive CORS handling from the MCP SDK. The `cors` slot governs only the routes the framework owns (`/mcp` and the protected-resource metadata).

## Production

Pin the CLI version so your capabilities do not break on package updates:

```json
{
  "mcpServers": {
    "my-tools": {
      "command": "bunx",
      "args": [
        "@routecraft/cli@2.0.0",
        "run",
        "/absolute/path/to/capabilities/search-orders.ts"
      ]
    }
  }
}
```

Use absolute paths in production to avoid working-directory ambiguity.

## Security

- **Validate all inputs** -- every capability should have a Zod schema; Routecraft enforces it before execution
- **Authenticate HTTP endpoints** -- always set `auth` when using HTTP transport in production
- **Guardrails** -- use `.filter()` to reject exchanges that fail a business rule, and `.transform()` to sanitize or normalise values before they reach downstream systems
- **Principle of least privilege** -- only expose capabilities the AI actually needs
- **Audit trail** -- add `.tap(log())` to record every invocation; subscribe to `plugin:mcp:tool:**` events for MCP-specific tracing
- **Never hardcode credentials** -- use `process.env` and `.env` files

---

## Related

{% quick-links %}

{% quick-link title="Call an MCP" icon="plugins" href="/docs/advanced/call-an-mcp" description="Call external MCP servers from within a capability." /%}
{% quick-link title="AI Package reference" icon="presets" href="/docs/reference/ai" description="Full MCP adapter API and options." /%}

{% /quick-links %}
