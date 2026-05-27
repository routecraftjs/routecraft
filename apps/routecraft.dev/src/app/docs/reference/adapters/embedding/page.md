---
title: embedding
---

[← All adapters](/docs/reference/adapters) {% .lead %}

```ts
import { embedding } from '@routecraft/ai'
```

Generate vector embeddings from text. Requires `embeddingPlugin()` in your context plugins.

```ts
import { embedding } from '@routecraft/ai'

craft()
  .id('embed-document')
  .from(source)
  .enrich(embedding('openai:text-embedding-3-small', {
    using: (ex) => ex.body.content,
  }))
  .to(vectorStore)
// Result merged into body: { ..., embedding: [0.123, -0.456, ...] }

// Embed a combination of fields
.enrich(embedding('ollama:nomic-embed-text', {
  using: (ex) => `${ex.body.title} ${ex.body.description}`,
}))
```

Model ID format: `"provider:model-name"` (e.g., `"huggingface:all-MiniLM-L6-v2"`, `"ollama:nomic-embed-text"`).

**Supported providers:** `huggingface` (local ONNX, no API key), `ollama`, `openai`, `mock` (deterministic test vectors)

**Options:**

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `using` | `(exchange) => string \| string[]` | Yes | Extract the text to embed from the exchange |

**Result shape (merged into body by `.enrich()`):**

| Field | Type | Description |
|-------|------|-------------|
| `embedding` | `number[]` | Vector representation of the input text |

Provider credentials are configured once in `embeddingPlugin()` and shared across all `embedding()` calls. See [Plugins reference](/docs/reference/plugins).

---
