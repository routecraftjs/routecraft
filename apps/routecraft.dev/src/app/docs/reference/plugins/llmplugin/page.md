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
| `anthropic` | `{ apiKey: string, baseURL?: string }` | Anthropic API. An explicit `baseURL` wins over the SDK's `ANTHROPIC_BASE_URL` environment fallback |
| `openrouter` | `{ apiKey: string, modelId?: string }` | OpenRouter API |
| `ollama` | `{ baseURL?: string, modelId?: string }` | Local Ollama instance |
| `gemini` | `{ apiKey: string, baseURL?: string }` | Google Gemini API |
| `lmstudio` | `{ baseURL?: string, apiKey?: string, modelId?: string }` | Local [LM Studio](https://lmstudio.ai) server (OpenAI-compatible; defaults to `http://localhost:1234/v1`) |
| `copilot` | `{ modelId?: string, onPermissionRequest?: handler, cliPath?: string, cliUrl?: string, githubToken?: string, workingDirectory?: string }` | GitHub Copilot via the local `copilot` CLI (defaults to the CLI's logged-in user; `githubToken` enables non-interactive auth) |
| `custom` | `{ model: model \| (modelId) => model, modelId?: string }` | Any AI SDK model object you supply, or a factory (in-process, no key, no network). Typed as `unknown` and validated at runtime so no engine type leaks into your code. |

## LM Studio

LM Studio serves an OpenAI-compatible chat-completions API, so the `lmstudio` provider needs no API key. Start the local server in LM Studio, load a model, then reference it by the loaded model id:

```ts
llmPlugin({ providers: { lmstudio: {} } })
// llm("lmstudio:qwen2.5-7b-instruct")
```

Requires the `@ai-sdk/openai-compatible` peer (`bun add @ai-sdk/openai-compatible`); a missing peer raises a clear install error. Token usage is reported on both buffered and streaming responses.

## GitHub Copilot

The `copilot` provider drives the GitHub Copilot CLI through the official Copilot SDK. The `copilot` CLI must be installed and on PATH (or referenced via `cliPath`) wherever routes run. Authentication defaults to the CLI's logged-in user; on non-interactive hosts pass `githubToken` with a Copilot-entitled token instead. Model names come from the CLI (`copilot -i /models`):

```ts
llmPlugin({ providers: { copilot: {} } })
// llm("copilot:gpt-5")
```

Copilot tool executions require approval. Routecraft defaults to approving everything so non-interactive routes never hang on a pending permission request; supply `onPermissionRequest` to enforce a real allow/deny policy:

```ts
llmPlugin({
  providers: {
    copilot: {
      onPermissionRequest: (request) =>
        isAllowed(request)
          ? { kind: 'approved' }
          : { kind: 'denied-by-rules' },
    },
  },
})
```

Requires the `@nomomon/ai-sdk-provider-github-copilot` peer (`bun add @nomomon/ai-sdk-provider-github-copilot`); a missing peer raises a clear install error.

Provider limitations (inherited from the Copilot CLI, not Routecraft's): no structured output (`output` schemas fall back to prompt-engineered JSON; prefer another provider when you need schema-guaranteed output), no embeddings, and sampling options (`temperature`, `topP`, penalties, `maxTokens`) are ignored.

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
