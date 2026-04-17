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

**HTTP server auth (`McpHttpAuthOptions`):**

When `auth` is set and `transport` is `'http'`, every request to `/mcp` must include a valid `Authorization: Bearer <token>` header. The `auth` object requires a `validator` function that receives the raw bearer token and returns an `AuthPrincipal` on success or `null` to reject. The principal is made available on exchange headers so routes can read the caller's identity.

| Field | Type | Description |
|-------|------|-------------|
| `validator` | `(token: string) => AuthPrincipal \| null \| Promise<AuthPrincipal \| null>` | Validates the bearer token and returns the caller's identity, or `null` to reject with 401. |

**AuthPrincipal:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `subject` | `string` | Yes | Unique identifier for the caller (user ID, service name, API key ID) |
| `scheme` | `string` | Yes | Auth scheme used (`'bearer'`, `'basic'`, `'api-key'`) |
| `roles` | `string[]` | No | Assigned roles |
| `scopes` | `string[]` | No | Granted scopes / permissions |
| `email` | `string` | No | Email address |
| `name` | `string` | No | Display name |
| `issuer` | `string` | No | Token issuer (JWT `iss`) |
| `audience` | `string[]` | No | Intended audience (JWT `aud`) |
| `expiresAt` | `number` | No | Expiry as epoch seconds (JWT `exp`) |
| `claims` | `Record<string, unknown>` | No | Raw claims / custom attributes |

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
    return { subject: user.id, scheme: 'api-key', roles: user.roles }
  },
}
```

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

---

## Related

{% quick-links %}

{% quick-link title="Plugins" icon="presets" href="/docs/advanced/plugins" description="How to write and register plugins." /%}
{% quick-link title="Adapters reference" icon="presets" href="/docs/reference/adapters" description="llm, embedding, and mcp adapter signatures and options." /%}

{% /quick-links %}
