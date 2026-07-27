---
title: mcpPlugin
---

[← All plugins](/docs/reference/plugins) {% .lead %}

```ts
import { mcpPlugin } from '@routecraft/ai'
```

Starts an MCP server so capabilities exposed with `.from(mcp(...))` are reachable by external MCP clients. Also registers named remote MCP clients (HTTP or stdio subprocess) so capabilities can call external MCP servers by a short server id. Required when any capability uses `mcp()` as a source.

Tools discovered from remote MCP servers (stdio clients and HTTP clients) are collected into an `McpToolRegistry` stored in the context store under `MCP_TOOL_REGISTRY`. Local `mcp()` routes defined in the same context are not auto-populated into this registry; the MCP server reads them directly from the direct-adapter registry when responding to `tools/list`.

```ts
import { mcpPlugin, jwt } from '@routecraft/ai'
import type { CraftConfig } from '@routecraft/routecraft'

const config: CraftConfig = {
  plugins: [
    mcpPlugin({
      transport: 'http',
      port: 3001,
      auth: jwt({ secret: process.env.JWT_SECRET! }),
      clients: {
        browser: {
          url: 'http://127.0.0.1:8089/mcp',
          auth: { token: process.env.BROWSER_MCP_TOKEN! },
        },
        search: { url: 'http://127.0.0.1:8090/mcp' },
        filesystem: {
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
        },
      },
      maxRestarts: 5,
      restartDelayMs: 1000,
      restartBackoffMultiplier: 2,
    }),
  ],
}

export default config
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | `string` | `'routecraft'` | Server name exposed in MCP metadata (`serverInfo.name`) |
| `title` | `string` | -- | Human-readable display title (`serverInfo.title`) |
| `version` | `string` | `'1.0.0'` | Server version |
| `description` | `string` | `'Powered by Routecraft.dev'` | `serverInfo.description`; pass `''` to omit |
| `websiteUrl` | `string` | `'https://routecraft.dev'` | `serverInfo.websiteUrl`; pass `''` to omit |
| `instructions` | `string` | -- | Server-wide usage guidance on the `initialize` result; pass `''` (or omit) to send none |
| `icons` | `McpIcon[]` | Routecraft logo | `serverInfo.icons`, inherited by tools that set none of their own; pass `[]` to omit. See [Server identity and branding](/docs/advanced/expose-as-mcp#server-identity-and-branding). |
| `transport` | `'http' \| 'stdio'` | `'stdio'` | Transport protocol for the MCP server |
| `port` | `number` | `3001` | HTTP port (http transport only) |
| `host` | `string` | `'localhost'` | HTTP host (http transport only) |
| `auth` | `McpHttpAuthOptions` | -- | Auth for the HTTP endpoint (http transport only; see below) |
| `cors` | `false \| McpCorsOptions` | loopback-only | CORS for the HTTP transport. Default reflects loopback `Origin` headers; set to `false` to disable or `{ origin }` to allowlist production browser clients. See [Securing capabilities -> CORS](/docs/advanced/securing-capabilities#cors). |
| `tools` | `string[] \| (meta) => boolean` | -- | Allowlist of local route tool names to expose, or a filter function. Applies to both `tools/list` and `tools/call`. |
| `clients` | `Record<string, McpClientHttpConfig \| McpClientStdioConfig>` | -- | Named remote MCP servers (see below) |
| `proxy` | `Array<string \| McpProxyToolConfig>` | -- | Tools from registered `clients` to re-expose through this server (see below) |
| `maxRestarts` | `number` | `5` | Max automatic restarts for stdio clients before giving up |
| `restartDelayMs` | `number` | `1000` | Initial delay before first restart attempt (ms) |
| `restartBackoffMultiplier` | `number` | `2` | Multiplier applied to delay on each successive restart |
| `toolRefreshIntervalMs` | `number` | `60000` | Polling interval for HTTP client tool lists (0 = no polling) |

**Logging when `transport` is `'stdio'`:**

The stdio transport uses stdout as the protocol channel. Routecraft's logger defaults to stdout, so logs will corrupt the protocol stream unless you redirect them. When running an MCP server over stdio, always pass one of:

- `--log-file <path>` -- write logs to a file
- `--log-level silent` -- disable logging entirely

**HTTP server auth (`McpHttpAuthOptions`):**

When `auth` is set and `transport` is `'http'`, every request to `/mcp` must include a valid `Authorization: Bearer <token>` header. The `auth` object requires a `validator` function that receives the raw bearer token and returns an `AuthPrincipal` on success or `null` to reject. The principal is made available on exchange headers so routes can read the caller's identity.

| Field | Type | Description |
|-------|------|-------------|
| `validator` | `(token: string) => AuthPrincipal \| null \| Promise<AuthPrincipal \| null>` | Validates the bearer token and returns the caller's identity, or `null` to reject with 401. |

**AuthPrincipal:**

`AuthPrincipal` is a discriminated union on the `kind` field. Every subtype carries `kind`, `scheme`, and `subject`; other fields live on the subtype that gives them meaning. Narrow on `kind` to reach scheme-specific data.

Shared fields on every subtype:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `kind` | `'jwt' \| 'oauth' \| 'api-key' \| 'basic' \| 'custom'` | Yes | Discriminator for the principal subtype |
| `scheme` | `string` | Yes | HTTP authentication scheme (`'bearer'`, `'basic'`, `'api-key'`) |
| `subject` | `string` | Yes | Stable identity for the caller (JWT `sub`, user ID, key ID) |

Subtypes:

| `kind` | Additional fields |
|--------|-------------------|
| `'jwt'` | `name?`, `email?`, `issuer?`, `audience?`, `scopes?`, `roles?`, `expiresAt?`, `claims` (required) |
| `'oauth'` | `clientId` (required), `name?`, `email?`, `issuer?`, `audience?`, `scopes?`, `roles?`, `expiresAt?`, `claims?` |
| `'api-key'` | `name?`, `expiresAt?` |
| `'basic'` | `name?` |
| `'custom'` | `name?`, `email?`, `roles?`, `scopes?`, `expiresAt?`, `claims?` |

The populated principal rides on the exchange as a single structured header (`routecraft.auth.principal`) and is exposed ergonomically via the `ex.principal` getter; read fields with `ex.principal?.subject`, `ex.principal?.scopes`, `ex.principal?.claims`, etc.

## Built-in `jwt()` helper

The `jwt()` helper creates a validator that verifies JWT signatures, checks expiry, and maps standard claims to `AuthPrincipal` fields. Zero dependencies (uses `node:crypto`).

```ts
import { mcpPlugin, jwt } from '@routecraft/ai'
```

**HMAC (HS256 / HS384 / HS512):**

```ts
auth: jwt({ secret: process.env.JWT_SECRET! })

// Explicit algorithm
auth: jwt({ algorithm: 'HS384', secret: process.env.JWT_SECRET! })
```

**RSA (RS256):**

```ts
import fs from 'node:fs'

auth: jwt({
  algorithm: 'RS256',
  publicKey: fs.readFileSync('./public.pem', 'utf-8'),
})
```

**Custom validator:**

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

## OAuth 2.1 with `oauth()`

`oauth()` mounts a full OAuth 2.1 server flow that proxies to an upstream IdP. Pass a `jwt` config to let the factory handle JWKS fetching, signature verification, issuer and audience checks, and claim mapping (requires the optional peer dependency `jose`). For opaque tokens, introspection, or fully custom verification, pass your own `verifyAccessToken` callback instead.

**Built-in JWT verification (recommended):**

```ts
import { mcpPlugin, oauth } from '@routecraft/ai'

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

`issuer` and `audience` are required, so the server cannot silently accept tokens from a different IdP or minted for a different resource. The factory maps standard JWT claims (`sub`, `client_id`, `email`, `name`, `iss`, `aud`, `scope`, `roles`, `exp`) to `OAuthPrincipal` fields automatically; the resolved principal surfaces on the structured `routecraft.auth.principal` exchange header and is exposed ergonomically via the `ex.principal` getter.

`client` accepts either a static `OAuthClientInfo` (matched on `client_id`; unknown IDs are rejected) or a supplier `(clientId) => Promise<OAuthClientInfo | undefined>` for dynamic lookup against a database or registry.

**`OAuthJwtConfig` fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `jwksUrl` | `string \| URL` | Yes | JWKS endpoint the IdP publishes; keys are fetched and rotated by `jose`'s `createRemoteJWKSet` |
| `issuer` | `string` | Yes | Expected `iss` claim; tokens from other issuers are rejected |
| `audience` | `string \| string[]` | Yes | Expected `aud` claim; the token must include at least one of these values |
| `clockTolerance` | `number \| string` | No | Skew tolerance applied to `exp`/`nbf` validation (seconds as a number, or a string like `"5s"`); default: no tolerance |
| `claims` | `OAuthJwtClaimMappers` | No | Per-claim overrides for non-standard IdPs (see below) |

**`OAuthJwtClaimMappers` fields.** Each maps a verified payload to the corresponding `OAuthPrincipal` field when the IdP uses non-standard claim names:

| Field | Default when omitted |
|-------|----------------------|
| `subject` | `payload.sub`, then `payload.client_id`, then `payload.azp` |
| `clientId` | `payload.client_id`, then `payload.azp` |
| `scopes` | space-split `payload.scope` |

`email`, `name`, and `roles` are not mappable here. They are read from the standard claim names (`email`, `name`, `roles`) when present in the token. For identity fields that do not live in the bearer (most IdPs do not put them there), use the [`userinfo` option on `mcpPlugin({})`](/docs/advanced/securing-capabilities#principal-enrichment-via-userinfo): function variant for custom mappings, OIDC Discovery or an explicit URL for the standard `/userinfo` endpoint.

**Claim overrides for non-standard IdPs:**

```ts
jwt: {
  jwksUrl: 'https://login.microsoftonline.com/<tenant>/discovery/v2.0/keys',
  issuer: 'https://login.microsoftonline.com/<tenant>/v2.0',
  audience: '<app-id>',
  claims: {
    subject: (p) => p.oid as string,
  },
}
```

**Custom verification (opaque tokens, introspection, etc.):**

```ts
import { mcpPlugin, oauth } from '@routecraft/ai'
import { jwtVerify, createRemoteJWKSet } from 'jose'

const jwks = createRemoteJWKSet(new URL('https://idp.example.com/.well-known/jwks.json'))

auth: oauth({
  issuerUrl: 'https://mcp.example.com',
  endpoints: {
    authorizationUrl: 'https://idp.example.com/authorize',
    tokenUrl: 'https://idp.example.com/token',
  },
  verifyAccessToken: async (token) => {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: 'https://idp.example.com',
      audience: 'https://mcp.example.com',
    })
    return {
      kind: 'oauth',
      scheme: 'bearer',
      subject: payload.sub as string,
      clientId: payload['client_id'] as string,
      expiresAt: payload.exp,
      claims: payload as Record<string, unknown>,
    }
  },
  client: async (clientId) => await db.clients.findByClientId(clientId),
})
```

`expiresAt` is required by the MCP SDK's bearer middleware; omit it and every request is rejected with 401. Pass **either** `jwt` or `verifyAccessToken`, never both.

The `client` supplier (when you pass a function rather than a static object) is invoked **per request** by the OAuth proxy provider during every authorize/token/revoke call. Cache or preload registry reads so the hot path stays fast.

**HTTP client config (`McpClientHttpConfig`):**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | `string` | Yes | Full URL of the remote MCP server |
| `auth` | `McpClientAuthOptions` | No | Auth credentials sent on every request to this server |

**McpClientAuthOptions:**

| Field | Type | Description |
|-------|------|-------------|
| `token` | `string \| string[] \| (() => string \| Promise<string>)` | Bearer token, array of tokens (round-robin), or provider function called per request |
| `headers` | `Record<string, string>` | Additional request headers; overrides `token` if `Authorization` is set |

**Stdio client config (`McpClientStdioConfig`):**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `transport` | `'stdio'` | Yes | Must be `'stdio'` to select subprocess mode |
| `command` | `string` | Yes | Executable to spawn (e.g. `'node'`, `'npx'`) |
| `args` | `string[]` | No | Arguments passed to the command |
| `env` | `Record<string, string>` | No | Environment variables for the child process |
| `cwd` | `string` | No | Working directory for the child process |

Stdio clients are spawned when the context starts and stopped on teardown. If the subprocess exits unexpectedly, the plugin automatically restarts it with exponential backoff (`restartDelayMs * restartBackoffMultiplier ^ attempt`). The restart counter resets after a successful reconnection.

## Proxying client tools

The `proxy` option re-exposes tools from registered `clients` through this MCP server without a route per tool. Each entry is a ref string or a config object:

| Ref form | Meaning |
|----------|---------|
| `'server:tool'` | Proxy one tool from a registered client |
| `'server:*'` or `'server'` | Proxy every tool the client advertises |
| `{ ref, name?, description?, annotations? }` | Proxy one tool with overrides |

**`McpProxyToolConfig`:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `ref` | `string` | Yes | Tool ref; the server id must be a key of `clients` |
| `name` | `string` | No | Exposed tool name override (`[A-Za-z0-9_-]{1,64}`); invalid on wildcard refs |
| `description` | `string` | No | Description override for `tools/list`; invalid on wildcard refs |
| `annotations` | `McpToolAnnotations` | No | Merged over the remote tool's annotations (per key) |
| `guard` | `ToolGuard` | No | Runs before dispatch with `(args, ctx)`; throw to reject the call as an `isError` result. `ctx.principal` carries the MCP caller's identity (HTTP `auth`). On wildcard refs the guard attaches to every expanded tool. Same contract as the agent's `tools([{ name, guard }])`, except the args are the caller's raw input (no local schema validation runs before a proxy guard). |

Refs are validated when the plugin is created: unknown clients, malformed refs, wildcard renames, and statically duplicate exposed names all throw. Colons beyond the first split stay in the tool segment (matching the agent's `MCP(server:tool)` grammar), so a remote tool named `ns:tool` is addressable as `'server:ns:tool'`. Resolution against the tool registry is live, so wildcard entries follow tool refresh and stdio restarts, and a client whose initial listing failed starts serving as soon as its tools appear.

An exact ref and a wildcard covering the same remote tool compose: the exact entry's overrides and guard apply regardless of config order. On a collision between different remote tools, a local `.from(mcp())` route wins over a proxied tool, and earlier `proxy` entries win over later ones; both log a warning once per registry change. Exposed names must match `[A-Za-z0-9_-]{1,64}`; a remote tool whose own name does not conform is skipped with a warning unless renamed via an exact entry's `name` override.

Proxied calls dispatch over the client's registered transport and auth, and the remote result (`content`, `structuredContent`, `isError`) passes through verbatim. The caller's authenticated principal is not forwarded, and no route pipeline runs (no `authorize()`, validation, or resilience wrappers); a per-entry `guard` covers identity and role checks. Reserve raw `proxy` entries for simple, read-only tools; put anything needing stateful guardrails behind a `.from(mcp())` route. See [Running an MCP server -> Proxying tools from configured clients](/docs/advanced/expose-as-mcp#proxying-tools-from-configured-clients).

See [Running an MCP server](/docs/advanced/expose-as-mcp), [Calling an MCP](/docs/advanced/call-an-mcp), and [Securing capabilities](/docs/advanced/securing-capabilities) for usage guides.
