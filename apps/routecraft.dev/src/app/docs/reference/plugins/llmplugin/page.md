---
title: llmPlugin
---

[← All plugins](/docs/reference/plugins) {% .lead %}

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
| `lmstudio` | `{ baseURL?: string, apiKey?: string, modelId?: string }` | Local [LM Studio](https://lmstudio.ai) server (OpenAI-compatible; defaults to `http://localhost:1234/v1`) |
| `custom` | `{ model: LanguageModel \| (modelId) => LanguageModel, modelId?: string }` | Any AI SDK model you supply (in-process, no key, no network) |

## LM Studio

LM Studio serves an OpenAI-compatible chat-completions API, so the `lmstudio` provider needs no API key. Start the local server in LM Studio, load a model, then reference it by the loaded model id:

```ts
llmPlugin({ providers: { lmstudio: {} } })
// llm("lmstudio:qwen2.5-7b-instruct")
```

Requires the `@ai-sdk/openai` peer (`bun add @ai-sdk/openai`); a missing peer raises a clear install error.

## Custom (bring your own model)

The `custom` provider is an escape hatch for running `llm()` or `agent()` against a model the built-in providers do not cover, including a deterministic in-process model for tests or offline demos. Supply an AI SDK `LanguageModel` directly, or a factory that receives the model name:

```ts
import { MockLanguageModelV3 } from 'ai/test'

llmPlugin({
  providers: {
    custom: {
      model: new MockLanguageModelV3({
        doGenerate: async () => ({
          finishReason: 'stop',
          usage: { inputTokens: 0, outputTokens: 0 },
          content: [{ type: 'text', text: 'Hello from a local model' }],
          warnings: [],
        }),
      }),
    },
  },
})
// llm("custom:local")
```

See [`llm` adapter](/docs/reference/adapters/llm) for usage.
