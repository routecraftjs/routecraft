---
title: Plugins
---

Full catalog of built-in plugins with options and behaviour. {% .lead %}

## Plugin overview

| Plugin | Package | Description |
|--------|---------|-------------|
| [`llmPlugin`](#llmplugin) | `@routecraft/ai` | Register LLM providers for use with `llm()` |
| [`embeddingPlugin`](#embeddingplugin) | `@routecraft/ai` | Register embedding providers for use with `embedding()` |
| [`mcpPlugin`](#mcpplugin) | `@routecraft/ai` | Start an MCP server and register remote MCP clients |
| [`agentPlugin`](#agentplugin) | `@routecraft/ai` | Register named agents for use with `agent("id")` |

{% callout %}
Core adapter defaults (`cron`, `direct`) are set via dedicated fields on `CraftConfig`, not via plugins. See [Configuration](/docs/reference/configuration) and [Merged Options](/docs/advanced/merged-options).
{% /callout %}

## llmPlugin

```ts
import { llmPlugin } from '@routecraft/ai'
```

Registers LLM provider credentials in the context store. Required when any capability uses `llm()`. Configure once; all `llm()` calls in the context share it.

```ts
import { llmPlugin } from '@routecraft/ai'
import type { CraftConfig } from '@routecraft/routecraft'

const config: CraftConfig = {
  plugins: [
    llmPlugin({
      providers: {
        anthropic: { apiKey: process.env.ANTHROPIC_API_KEY },
        openai: { apiKey: process.env.OPENAI_API_KEY },
      },
    }),
  ],
}

export default config
```

**Options:**

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `providers` | `LlmPluginProviders` | Yes | Provider credentials (at least one required) |
| `defaultOptions` | `Partial<LlmOptions>` | No | Default options applied to all `llm()` calls |

**Providers:**

| Provider | Options | Description |
|----------|---------|-------------|
| `openai` | `{ apiKey: string, baseURL?: string }` | OpenAI API |
| `anthropic` | `{ apiKey: string }` | Anthropic API |
| `openrouter` | `{ apiKey: string, modelId?: string }` | OpenRouter API |
| `ollama` | `{ baseURL?: string, modelId?: string }` | Local Ollama instance |
| `gemini` | `{ apiKey: string }` | Google Gemini API |

See [`llm` adapter](/docs/reference/adapters#llm) for usage.

## embeddingPlugin

```ts
import { embeddingPlugin } from '@routecraft/ai'
```

Registers embedding provider credentials in the context store. Required when any capability uses `embedding()`. Runs a teardown on context stop to release native ONNX resources (used by the `huggingface` provider).

```ts
import { embeddingPlugin } from '@routecraft/ai'
import type { CraftConfig } from '@routecraft/routecraft'

const config: CraftConfig = {
  plugins: [
    embeddingPlugin({
      providers: {
        openai: { apiKey: process.env.OPENAI_API_KEY },
      },
    }),
  ],
}

export default config
```

**Options:**

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `providers` | `EmbeddingPluginProviders` | Yes | Provider credentials (at least one required) |
| `defaultOptions` | `Partial<EmbeddingOptions>` | No | Default options applied to all `embedding()` calls |

**Providers:**

| Provider | Options | Description |
|----------|---------|-------------|
| `huggingface` | `{}` | Local ONNX inference, no API key required |
| `ollama` | `{ baseURL?: string }` | Local Ollama instance |
| `openai` | `{ apiKey: string, baseURL?: string }` | OpenAI embeddings API |
| `mock` | `{}` | Deterministic test vectors, for use in tests |

See [`embedding` adapter](/docs/reference/adapters#embedding) for usage.

## mcpPlugin

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
| `name` | `string` | `'routecraft'` | Server name exposed in MCP metadata |
| `version` | `string` | `'1.0.0'` | Server version |
| `transport` | `'http' \| 'stdio'` | `'stdio'` | Transport protocol for the MCP server |
| `port` | `number` | `3001` | HTTP port (http transport only) |
| `host` | `string` | `'localhost'` | HTTP host (http transport only) |
| `auth` | `McpHttpAuthOptions` | -- | Auth for the HTTP endpoint (http transport only; see below) |
| `tools` | `string[] \| (meta) => boolean` | -- | Allowlist of tool names to expose, or a filter function |
| `clients` | `Record<string, McpClientHttpConfig \| McpClientStdioConfig>` | -- | Named remote MCP servers (see below) |
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

The populated principal surfaces on the exchange via `routecraft.auth.*` headers (see `McpHeadersKeys`): `auth.subject`, `auth.scheme`, `auth.name`, `auth.email`, `auth.roles`, `auth.scopes`, `auth.issuer`, `auth.audience`, and `auth.client_id` (OAuth only).

### Built-in `jwt()` helper

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

### OAuth 2.1 with `oauth()`

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

`issuer` and `audience` are required, so the server cannot silently accept tokens from a different IdP or minted for a different resource. The factory maps standard JWT claims (`sub`, `client_id`, `email`, `name`, `iss`, `aud`, `scope`, `roles`, `exp`) to `OAuthPrincipal` fields automatically; all of them surface as `routecraft.auth.*` exchange headers.

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
| `subject` | `payload.sub` |
| `clientId` | `payload.client_id` |
| `email` | `payload.email` |
| `name` | `payload.name` |
| `scopes` | space-split `payload.scope` |
| `roles` | `payload.roles` when it is `string[]` |

**Claim overrides for non-standard IdPs:**

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

See [Expose as MCP](/docs/advanced/expose-as-mcp) and [Call an MCP](/docs/advanced/call-an-mcp) for usage guides.

## agentPlugin

```ts
import { agentPlugin } from '@routecraft/ai'
```

Register named agents in the context store so routes can reference them by name via `agent("id")`. Registered agents are distinct from route-backed agents: a registration carries its own description because it is not backed by a route; the id is the record key. Duplicate ids across multiple `agentPlugin` installs throw at context init.

```ts
import { agentPlugin, llmPlugin } from '@routecraft/ai'
import type { CraftConfig } from '@routecraft/routecraft'

export const craftConfig: CraftConfig = {
  plugins: [
    llmPlugin({ providers: { anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! } } }),
    agentPlugin({
      agents: {
        summariser: {
          description: 'Summarises documents into bullet points',
          model: 'anthropic:claude-opus-4-7',
          system: 'You are a summariser. Be concise.',
        },
        'translator-en-fr': {
          description: 'Translates English text to French',
          model: 'anthropic:claude-opus-4-7',
          system: 'Translate the input from English to French.',
        },
      },
    }),
  ],
}
```

Then in any route:

```ts
import { agent } from '@routecraft/ai'

craft()
  .id('daily-digest')
  .from(timer({ intervalMs: 24 * 60 * 60 * 1000 }))
  .to(agent('summariser'))
  .to(direct('reply'))
```

**Options:**

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `agents` | `Record<string, AgentRegisteredOptions>` | No | Agents keyed by id. Duplicate ids across installs throw at context init. Defaults to `{}`. |

**Entry shape (`AgentRegisteredOptions`):**

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `description` | `string` | Yes | Human-readable description. Surfaces in observability and is used as the tool description when the agent is exposed to other agents |
| `model` | `LlmModelId \| LlmModelConfig` | Yes | `"provider:model"` string (resolved via `llmPlugin`) or an inline `LlmModelConfig` |
| `system` | `string` | Yes | System prompt |
| `user` | `(exchange) => string` | No | Override for deriving the user prompt from the incoming exchange |

**Resolution semantics:**

- `agent("name")` resolves only registered agents. Route-backed agents are called via `.to(direct("route-id"))` and run the full pipeline of the target route; `agent("name")` runs the registered agent's LLM call inline.
- The plugin throws at context init (`RC5003`) on: duplicate ids across installs, empty id key, missing description, invalid model string, or empty system.
- `agent("unknown")` fails at dispatch (`RC5004`) with the list of registered agent ids.

See the [`agent`](/docs/reference/adapters#agent) adapter for usage patterns.

### Functions (`functions`)

`agentPlugin` also registers ad-hoc in-process **functions** that agents can whitelist as tools (follow-up story) and that your code can call directly via [`invokeFn`](#invokefn). Functions are keyed by id in the same plugin config and share the same duplicate-id-throws-at-init semantics as agents.

```ts
import { agentPlugin, invokeFn } from '@routecraft/ai'
import { z } from 'zod'

agentPlugin({
  functions: {
    currentTime: {
      description: 'Current UTC timestamp in ISO 8601',
      schema: z.object({}),
      handler: async () => new Date().toISOString(),
    },
    sendSlackMessage: {
      description: 'Post a message to a Slack channel',
      schema: z.object({ channel: z.string(), text: z.string() }),
      handler: async (input, ctx) => {
        ctx.logger.info({ channel: input.channel }, 'Posting to Slack')
        return { ok: true }
      },
    },
  },
})
```

**Options:**

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `functions` | `Record<string, FnOptions>` | No | Functions keyed by id. Duplicate ids across installs throw at context init. Defaults to `{}`. |

**Entry shape (`FnOptions`):**

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `description` | `string` | Yes | Human-readable description. Used in observability and as the tool description when exposed to an agent |
| `schema` | `StandardSchemaV1` | Yes | Standard Schema for the input (Zod, Valibot, ArkType, etc.). Validated at invocation time |
| `handler` | `(input, ctx) => Promise<TOut> \| TOut` | Yes | Called with validated input and a `FnHandlerContext` (`{ logger, abortSignal, context }`) |

### `invokeFn`

Standalone invocation of a registered function. Intended for scripts, tests, and ad-hoc callers; the agent tool loop (follow-up story) uses the same registry.

```ts
import { invokeFn } from '@routecraft/ai'

const iso = await invokeFn(context, 'currentTime', {})
// iso === '2026-04-24T21:05:42.000Z'

const result = await invokeFn<{ channel: string; text: string }, { ok: boolean }>(
  context,
  'sendSlackMessage',
  { channel: '#alerts', text: 'Deploy complete' },
)
// result.ok === true

// With caller-supplied abort signal
const controller = new AbortController()
await invokeFn(context, 'longRunningFn', input, { signal: controller.signal })
```

**Errors:**

- **`RC5004`** -- no fn registry in the context (agentPlugin not installed), or the id is not registered. Message lists all known ids.
- **`RC5002`** -- input fails the fn's schema. Message includes the formatted schema issues.
- **`RC5003`** -- the registered schema is not a valid Standard Schema value.

Errors thrown by the handler itself propagate as-is.

**`FnHandlerContext`:**

| Field | Type | Description |
|-------|------|-------------|
| `logger` | pino child logger | Bound to the fn id; use for structured logs from the handler |
| `abortSignal` | `AbortSignal` | Signal forwarded from `invokeFn(..., { signal })`. Defaults to a never-firing signal |
| `context` | `CraftContext` | Context reference for nested work (e.g. calling direct routes, emitting events) |

### Typed fn ids (`FnRegistry`)

For compile-time autocomplete of fn ids in `invokeFn` and, in follow-up stories, the agent `tools: [...]` field, populate the `FnRegistry` marker interface via declaration merging in your project:

```ts
// src/types/routecraft.d.ts
declare module '@routecraft/ai' {
  interface FnRegistry {
    currentTime: true
    sendSlackMessage: true
  }
}

// Now invokeFn(context, 'unknown', {}) errors at compile time.
```

When `FnRegistry` is empty, the id type falls back to `string` (no breaking change).

---

## Related

{% quick-links %}

{% quick-link title="Plugins" icon="presets" href="/docs/advanced/plugins" description="How to write and register plugins." /%}
{% quick-link title="Adapters reference" icon="presets" href="/docs/reference/adapters" description="llm, embedding, and mcp adapter signatures and options." /%}

{% /quick-links %}
