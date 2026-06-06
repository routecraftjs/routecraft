---
title: agent
---

[← All adapters](/docs/reference/adapters) {% .lead %}

```ts
import { agent } from '@routecraft/ai'
```

Run an LLM with a fixed system prompt on each incoming exchange. Replaces the body with `AgentResult { text, usage? }`. Two forms:

- **Inline** (`agent({ model, system, user? })`) -- identity and description come from the enclosing route (`.id()`, `.description()`). Suitable when the route _is_ the agent.
- **By name** (`agent("summariser")`) -- resolves a registered agent from the context. Register agents via `agentPlugin({ agents: { name: {...} } })` ([`agentPlugin` reference](/docs/reference/plugins/agentplugin)).

```ts
import { agent, agentPlugin } from '@routecraft/ai'
import { readFileSync } from 'node:fs'

// Inline: the route IS the agent. Other routes call it via direct("zoe").
craft()
  .id('zoe')
  .description('Internal ops assistant')
  .from(direct())
  .to(agent({
    model: 'anthropic:claude-opus-4-7',
    system: readFileSync('./prompts/zoe.md', 'utf-8'),
  }))
  .to(direct('reply'))

// By name: register once, use from any route in the context. Per-agent
// fields can be omitted when defaultOptions supplies them.
agentPlugin({
  defaultOptions: {
    model: 'anthropic:claude-opus-4-7',
  },
  agents: {
    summariser: {
      description: 'Summarises documents into bullet points',
      system: 'Be concise.',
      // model inherited from defaultOptions
    },
  },
})

craft()
  .id('periodic-summary')
  .from(timer({ intervalMs: 60_000 }))
  .to(agent('summariser'))
  .to(log())
```

Model ID format: `"provider:model-name"` (same as `llm()`). The provider must be registered via `llmPlugin({ providers: {...} })`. There is no inline-credentials escape hatch on `agent({...})`; centralised wiring via `llmPlugin` is the only path.

**Supported providers:** `openai`, `anthropic`, `ollama`, `openrouter`, `gemini`, `lmstudio`, `custom`

**`AgentOptions` (inline form):**

| Option | Type | Default | Required | Description |
|--------|------|---------|----------|-------------|
| `model` | `LlmModelId` | -- | No\* | `"provider:model"` string resolved via `llmPlugin`. Required unless `defaultOptions.model` supplies a fallback; otherwise dispatch throws `RC5003` |
| `system` | `string` | -- | Yes | System prompt. Load from disk yourself when sourcing from a file |
| `user` | `(exchange) => string` | body as-is / JSON | No | Override for deriving the user prompt. Defaults to body (string as-is, JSON for objects) |
| `tools` | `ToolSelection` | -- | No | Tool whitelist built via `tools([...])`. Inherits `defaultOptions.tools` when omitted; an explicit value replaces the default entirely |
| `principal` | `boolean \| (principal, exchange) => string` | `false` | No | When `true`, append a built-in `## Caller` section to the system prompt describing `exchange.principal` (identity + roles), or stating the request is unauthenticated. Pass a function to render the section yourself. See [Telling the agent who the caller is](#telling-the-agent-who-the-caller-is) |
| `output` | `StandardSchemaV1` | -- | No | Schema for structured output. Validated and parsed onto `AgentResult.output` after dispatch (runtime ships in a follow-up release) |

**`AgentRegisteredOptions` (entries in `agentPlugin({ agents: {...} })`, for by-name reuse):** same as `AgentOptions` plus:

| Option | Type | Default | Required | Description |
|--------|------|---------|----------|-------------|
| `description` | `string` | -- | Yes | Human-readable description. Surfaces in observability and is used as the tool description when the agent is exposed to other agents |

The id is the record key in `agentPlugin({ agents: { [id]: {...} } })`.

**Result shape (body is replaced by `.to()`):**

| Field | Type | Description |
|-------|------|-------------|
| `text` | `string` | Generated text from the model |
| `output` | `T` | Parsed structured output (only when an `output` schema was supplied; runtime ships in a follow-up) |
| `usage.inputTokens` | `number` | Input token count (when reported) |
| `usage.outputTokens` | `number` | Output token count (when reported) |
| `usage.totalTokens` | `number` | Total token count (when reported) |

**Resolution semantics:**

- `agent("name")` only resolves registered agents. To call a route-backed agent from another route, use `.to(direct("route-id"))`. `direct` runs the full pipeline of the target route; `agent("name")` runs the registered agent's LLM call inline.
- Model resolution at dispatch is `instance value > defaultOptions.model > throw RC5003`.
- Duplicate registered agent ids, missing description, malformed model string when present, or a non-`ToolSelection` `tools` value fail at context init with `RC5003` (Adapter misconfigured).
- Referencing an unknown registered agent name fails at dispatch with `RC5004` (No handler available).

Provider credentials are configured once in `llmPlugin()` and shared across all `agent()` calls. See [`llmPlugin` reference](/docs/reference/plugins/llmplugin).

#### Telling the agent who the caller is

By default the only part of the exchange that reaches the model is the body (as the user prompt). The authenticated caller (`exchange.principal`) is **not** in the prompt, so the model does not know who it is serving unless you put that there yourself.

Set `principal: true` to append a `## Caller` section to the system prompt. It is appended after your own prompt and any `blocks`, and it covers the unauthenticated case explicitly so the model never invents an identity:

```typescript
agent({
  model: 'anthropic:claude-opus-4-7',
  system: 'You are a support assistant.',
  principal: true,
});
```

When the request is authenticated, the model sees:

```text
## Caller

The current request is authenticated.
- Name: Jane Doe
- Email: jane@example.com
- Subject: user_2a9f
- Roles: admin, editor
```

When there is no principal:

```text
## Caller

The current request is not authenticated. No verified user identity is
available. Do not assume, infer, or invent the caller's name, email, or
permissions.
```

Only the loggable identity fields (`name`, `email`, `subject`) and `roles` are surfaced; fields that are absent on the principal are omitted, and interpolated values have newlines collapsed so a subject-controlled field (a self-service display name, say) cannot forge prompt structure. Scopes, `claims`, `userinfoClaims`, and the bearer token are never injected. The block is informational context only: authorization is still enforced by [`.authorize()`](/docs/reference/operations/authorize) and tool guards, never by the model.

To control the wording or which fields are shown, pass a function instead of `true`. It receives the principal (`undefined` when unauthenticated) and the exchange, and returns the markdown to append (return `''` to append nothing). Your renderer owns its own escaping and the same field exclusions apply:

```typescript
agent({
  model: 'anthropic:claude-opus-4-7',
  system: 'You are a support assistant.',
  principal: (p) =>
    p ? `## Caller\n\nYou are assisting ${p.name ?? p.subject}.` : '',
});
```

To opt every agent in a context into caller-awareness at once, set `principal` on `agentPlugin({ defaultOptions })`; a per-agent `principal` (including `false`) overrides it.

Inside a tool handler, the same principal is available as `ctx.principal` (a deep-frozen, read-only snapshot).
