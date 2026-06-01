---
title: llm
---

[← All adapters](/docs/reference/adapters) {% .lead %}

```ts
import { llm } from '@routecraft/ai'
```

Call a language model and get text or structured output. Requires `llmPlugin()` in your context plugins.

```ts
import { llm } from '@routecraft/ai'

// Text output
craft()
  .id('summarise')
  .from(source)
  .enrich(llm('anthropic:claude-haiku-4-5-20251001', {
    system: 'Summarise the following in one sentence.',
    user: (ex) => ex.body.content,
  }))
  .to(log())
// Result merged into body: { ..., text: '...', usage: { inputTokens, outputTokens } }

// Structured output with Zod schema
import { z } from 'zod'

const sentimentSchema = z.object({
  sentiment: z.enum(['positive', 'neutral', 'negative']),
  confidence: z.number(),
})

craft()
  .id('classify')
  .from(source)
  .enrich(llm('openai:gpt-4o', {
    system: 'Classify the sentiment of the text.',
    user: (ex) => ex.body.text,
    output: sentimentSchema,
  }))
  .to(log())
// result.output is typed as { sentiment: 'positive' | 'neutral' | 'negative', confidence: number }
```

Model ID format: `"provider:model-name"` (e.g., `"ollama:llama3.2"`, `"anthropic:claude-sonnet-4-6"`).

**Supported providers:** `openai`, `anthropic`, `ollama`, `openrouter`, `gemini`

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `system` | `string \| (exchange) => string` | -- | System prompt (static or derived from exchange) |
| `user` | `string \| (exchange) => string` | -- | User prompt (static or derived from exchange) |
| `output` | `StandardSchemaV1` | -- | Zod/Valibot/ArkType schema for structured output |
| `temperature` | `number` | -- | Sampling temperature |
| `maxTokens` | `number` | -- | Maximum tokens to generate |
| `topP` | `number` | -- | Top-p sampling |
| `frequencyPenalty` | `number` | -- | Frequency penalty |
| `presencePenalty` | `number` | -- | Presence penalty |

**Result shape (merged into body by `.enrich()`):**

| Field | Type | Description |
|-------|------|-------------|
| `text` | `string` | Raw model output |
| `output` | `T` | Parsed structured output (only when an `output` schema was supplied) |
| `usage.inputTokens` | `number` | Input token count |
| `usage.outputTokens` | `number` | Output token count |
| `usage.totalTokens` | `number` | Total token count |

Provider credentials are configured once in `llmPlugin()` and shared across all `llm()` calls. See [Plugins reference](/docs/reference/plugins).
