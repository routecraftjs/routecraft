---
title: embeddingPlugin
---

[← All plugins](/docs/reference/plugins) {% .lead %}

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
