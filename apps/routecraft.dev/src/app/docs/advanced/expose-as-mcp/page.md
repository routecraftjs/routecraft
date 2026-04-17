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

A capability becomes an MCP tool when you use `mcp()` as its source. Give it a `description` the AI uses to decide when to call it, and a Zod `schema` for the input.

```ts
// capabilities/search-orders.ts
import { mcp } from '@routecraft/ai'
import { craft, http } from '@routecraft/routecraft'
import { z } from 'zod'

export default craft()
  .id('orders.search')
  .from(mcp('orders.search', {
    description: 'Search orders by customer ID or date range',
    schema: z.object({
      customerId: z.string().optional(),
      from: z.string().date().optional(),
      to: z.string().date().optional(),
    }),
    keywords: ['orders', 'search'],
  }))
  .transform(({ customerId, from, to }) => buildQuery(customerId, from, to))
  .to(http({ method: 'GET', path: '/orders' }))
```

The `schema` is validated before the capability runs. Invalid inputs are rejected with a structured error before any business logic executes.

## Stdio transport (default)

Stdio is the simplest transport. The AI client spawns Routecraft as a subprocess and communicates over stdin/stdout. No networking, no auth required.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "my-tools": {
      "command": "npx",
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
    "command": "npx",
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
      "command": "npx",
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

When using HTTP transport, secure the endpoint with the `auth` option. Routecraft ships with a built-in `jwt()` helper that verifies JWT signatures using `node:crypto` (zero dependencies).

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

The `issuer` and `audience` options are optional but strongly recommended in multi-tenant or federated deployments. Without them, any valid token from a trusted signing key is accepted regardless of who it was issued for, which enables cross-audience replay. Both fields accept a single string or an array of accepted values.

For other auth schemes, pass a custom `validator` function:

```ts
auth: {
  validator: async (token) => {
    const user = await db.verifyApiKey(token)
    if (!user) return null
    return {
      kind: 'api-key',
      scheme: 'api-key',
      subject: user.id,
      name: user.label,
    }
  },
}
```

The validator receives the raw bearer token and returns an `AuthPrincipal` on success or `null` to reject with 401. `AuthPrincipal` is a discriminated union on `kind`: pick the subtype that fits the scheme you implement (`jwt`, `oauth`, `api-key`, `basic`, or `custom` for anything else). The principal's fields are set as exchange headers so your routes can read the caller's identity.

For OAuth 2.1 with an upstream IdP, use `oauth()`. The OAuth path relies on Express for the auth router and bearer middleware, and uses `jose` for the built-in JWT verification path; both are declared as optional peer dependencies, so plain validator setups do not pay for them:

```sh
pnpm add express jose
```

Pass a `jwt` config and the factory handles JWKS fetching, signature verification, `issuer` and `audience` validation, and standard claim mapping for you:

```ts
import { oauth } from '@routecraft/ai'

auth: oauth({
  issuerUrl: 'https://mcp.example.com',
  endpoints: {
    authorizationUrl: 'https://idp.example.com/authorize',
    tokenUrl: 'https://idp.example.com/token',
  },
  jwt: {
    jwksUrl: 'https://idp.example.com/.well-known/jwks.json',
    issuer: 'https://idp.example.com',
    audience: 'https://mcp.example.com',
  },
  client: {
    client_id: 'my-mcp-server',
    redirect_uris: ['http://localhost:3000/callback'],
  },
})
```

`issuer` and `audience` are required, so the server cannot silently accept tokens from a different IdP or minted for a different resource. Standard claims (`sub`, `client_id`, `email`, `name`, `iss`, `aud`, `scope`, `roles`, `exp`) are mapped to `OAuthPrincipal` fields automatically.

`client` accepts either a static `OAuthClientInfo` (matched on `client_id`; unknown IDs are rejected) or a supplier `(clientId) => Promise<OAuthClientInfo | undefined>` for dynamic lookup. The supplier is invoked **per request** by the OAuth proxy provider during every authorize/token/revoke call, so cache or preload registry reads to keep the hot path fast.

For non-standard IdPs, pass `jwt.claims` to override individual mappings:

```ts
jwt: {
  jwksUrl: 'https://login.microsoftonline.com/<tenant>/discovery/v2.0/keys',
  issuer: 'https://login.microsoftonline.com/<tenant>/v2.0',
  audience: '<app-id>',
  claims: {
    subject: (p) => p.oid as string,
    roles: (p) => p['roles'] as string[] | undefined,
  },
}
```

For opaque tokens, custom introspection, or anything else that isn't a JWKS-signed JWT, pass a `verifyAccessToken` callback instead of `jwt`:

```ts
import { oauth } from '@routecraft/ai'

auth: oauth({
  issuerUrl: 'https://mcp.example.com',
  endpoints: { authorizationUrl: '...', tokenUrl: '...' },
  verifyAccessToken: async (token) => {
    const principal = await myIntrospectionCall(token)
    return {
      kind: 'oauth',
      scheme: 'bearer',
      subject: principal.userId,
      clientId: principal.clientId,
      expiresAt: principal.exp,
      claims: principal.raw,
    }
  },
  client: async (clientId) => await db.clients.findByClientId(clientId),
})
```

Pass **either** `jwt` **or** `verifyAccessToken`, never both.

The populated `OAuthPrincipal` surfaces every identity field on the exchange: `routecraft.auth.subject` (= JWT `sub`, not the OAuth `client_id`), `routecraft.auth.client_id`, `routecraft.auth.email`, `routecraft.auth.name`, `routecraft.auth.issuer`, `routecraft.auth.audience`, `routecraft.auth.scopes`, and `routecraft.auth.roles`. `expiresAt` is required by the MCP SDK's bearer middleware; omit it and every request is rejected with 401.

See the [plugins reference](/docs/reference/plugins#mcpplugin) for the full `AuthPrincipal` field list.

## Production

Pin the CLI version so your capabilities do not break on package updates:

```json
{
  "mcpServers": {
    "my-tools": {
      "command": "npx",
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
