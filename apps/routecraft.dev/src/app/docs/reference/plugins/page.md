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

Starts an MCP server so capabilities exposed with `.from(mcp(...))` are reachable by external MCP clients. Also registers named remote MCP clients so capabilities can call external MCP servers by a short server id. Required when any capability uses `mcp()` as a source.

```ts
import { mcpPlugin } from '@routecraft/ai'
import type { CraftConfig } from '@routecraft/routecraft'

const config: CraftConfig = {
  plugins: [
    mcpPlugin({
      transport: 'http',
      port: 3001,
      clients: {
        browser: { url: 'http://127.0.0.1:8089/mcp' },
        search: { url: 'http://127.0.0.1:8090/mcp' },
      },
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
| `transport` | `'http' \| 'stdio'` | `'stdio'` | Transport protocol |
| `port` | `number` | `3001` | HTTP port (http transport only) |
| `host` | `string` | `'localhost'` | HTTP host (http transport only) |
| `tools` | `string[]` | — | Allowlist of tool names to expose |
| `clients` | `Record<string, { url: string }>` | — | Named remote MCP servers for client calls |

See [Expose as MCP](/docs/advanced/expose-as-mcp) and [Call an MCP](/docs/advanced/call-an-mcp) for usage guides.

---

## Related

{% quick-links %}

{% quick-link title="Plugins" icon="presets" href="/docs/introduction/plugins" description="How to write and register plugins." /%}
{% quick-link title="Adapters reference" icon="presets" href="/docs/reference/adapters" description="llm, embedding, and mcp adapter signatures and options." /%}

{% /quick-links %}
