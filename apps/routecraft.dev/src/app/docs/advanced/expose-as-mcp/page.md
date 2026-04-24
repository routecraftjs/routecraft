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

A capability becomes an MCP tool when you use `mcp()` as its source. The tool name is the route's `.id()`; the `.description()` the AI uses to decide when to call it and the `.input()` schema for the payload both live on the route builder. Routecraft validates input against the schema before the capability runs, so invalid calls are rejected before any business logic executes.

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

The returned `Principal` is a flat object tagged with `kind` (`"jwt"`, `"jwks"`, `"oauth"`, or `"custom"`). Its fields are forwarded to your routes as `routecraft.auth.*` exchange headers.

### OAuth 2.1 proxy (`oauth()`)

For the full OAuth 2.1 Authorization Code flow with an upstream IdP, use `oauth()`. It proxies the authorization and token endpoints and validates incoming bearer tokens. It requires `express` and (for JWKS verification) `jose` as optional peer dependencies:

```sh
pnpm add express jose
```

Compose `oauth()` with `jwks()` (or a raw verifier function) via the `verify` option:

```ts
import { oauth, jwks } from '@routecraft/ai'

// Clerk example
auth: oauth({
  resourceIssuerUrl: 'https://mcp.example.com',
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
})
```

For opaque tokens or custom introspection, pass a raw `verify` function instead:

```ts
auth: oauth({
  resourceIssuerUrl: 'https://mcp.example.com',
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

The populated `Principal` surfaces every identity field on the exchange: `routecraft.auth.subject`, `routecraft.auth.client_id`, `routecraft.auth.email`, `routecraft.auth.name`, `routecraft.auth.issuer`, `routecraft.auth.audience`, `routecraft.auth.scopes`, `routecraft.auth.roles`, and `routecraft.auth.kind`.

See the [plugins reference](/docs/reference/plugins#mcpplugin) for the full `Principal` field list.

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
