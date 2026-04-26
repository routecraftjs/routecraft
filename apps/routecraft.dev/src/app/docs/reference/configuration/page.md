---
title: Configuration
---

Full reference for `CraftConfig` fields and logging options. {% .lead %}

## CraftConfig

The main configuration object for context settings. Export it as `craftConfig` (named export) alongside your capabilities when using `craft run`. The recommended pattern is `defineConfig`, an identity helper that preserves literal-type inference (so autocomplete works for first-class keys):

```ts
import { defineConfig } from '@routecraft/routecraft'

export const craftConfig = defineConfig({
  store: new Map([
    ['my.adapter.config', { apiKey: 'xyz' }]
  ]),
  on: {
    'context:starting': ({ ts }) => console.log('Starting at', ts)
  },
})
```

`defineConfig` is a no-op at runtime; it returns the input unchanged. The legacy `satisfies CraftConfig` pattern continues to work.

## Configuration fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `store` | `Map<keyof StoreRegistry, StoreRegistry[keyof StoreRegistry]>` | No | — | Initial values for the context store |
| `on` | `Partial<Record<EventName, EventHandler \| EventHandler[]>>` | No | — | Event handlers to register on context creation |
| `once` | `Partial<Record<EventName, EventHandler \| EventHandler[]>>` | No | — | One-time event handlers that fire once then auto-unsubscribe |
| `cron` | `Partial<CronOptions>` | No | -- | Default options for all `cron()` sources ([details](#cron)) |
| `direct` | `{ channelType?: DirectChannelType }` | No | -- | Custom channel implementation for all `direct()` endpoints ([details](#direct)) |
| `mail` | `MailContextConfig` | No | -- | Mail adapter accounts (IMAP/SMTP) keyed by name |
| `telemetry` | `TelemetryOptions` | No | -- | Telemetry plugin configuration (SQLite, OpenTelemetry) |
| `plugins` | `CraftPlugin[]` | No | -- | Custom plugins to initialize before routes are registered |

### Ecosystem keys (added by `@routecraft/ai`)

When `@routecraft/ai` is imported (anywhere in the project), `CraftConfig` is augmented with first-class keys for the AI plugins. Each key carries the same options as the corresponding factory and participates in the standard plugin lifecycle.

| Field | Type | Equivalent factory |
|-------|------|--------------------|
| `llm` | `LlmPluginOptions` | `llmPlugin(options)` |
| `mcp` | `McpPluginOptions` | `mcpPlugin(options)` |
| `embedding` | `EmbeddingPluginOptions` | `embeddingPlugin(options)` |
| `agent` | `AgentPluginOptions` | `agentPlugin(options)` |

```ts
import { defineConfig } from '@routecraft/routecraft'
import '@routecraft/ai' // augments CraftConfig with llm/mcp/embedding/agent

export const craftConfig = defineConfig({
  llm: {
    providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } },
    defaultProvider: 'openai',
  },
  mcp: { clients: { /* ... */ } },
})
```

The legacy `plugins: [llmPlugin(...)]` form continues to work and is the right escape hatch for shared plugin instances or programmatic composition.

{% callout type="note" %}
**Troubleshooting:** if TypeScript reports `Object literal may only specify known properties, and 'llm' does not exist in type 'CraftConfig'` (or the same for `mcp`, `embedding`, `agent`), the augmentation has not been loaded. Add `import '@routecraft/ai'` to a file that's part of your project's compilation -- usually next to `defineConfig` in `craft.config.ts`. The side-effect import is what merges the AI keys into `CraftConfig`.
{% /callout %}

## Core adapter defaults

Core adapters have dedicated config fields so you can set context-wide defaults without importing a plugin. See [Merged Options](/docs/advanced/merged-options) for how the merge hierarchy works.

### cron

Default options applied to every `cron()` source in this context. Per-adapter options always take precedence.

```ts
const config: CraftConfig = {
  cron: { timezone: 'UTC', jitterMs: 2000 },
}
```

| Option | Type | Description |
|--------|------|-------------|
| `timezone` | `string` | IANA timezone (e.g. `"America/New_York"`, `"UTC"`) |
| `maxFires` | `number` | Maximum fires before stopping |
| `jitterMs` | `number` | Random delay in ms added to each fire |
| `name` | `string` | Human-readable job name for observability |
| `protect` | `boolean` | Prevent overlapping handler execution |
| `startAt` | `Date \| string` | Date/ISO string at which cron jobs start |
| `stopAt` | `Date \| string` | Date/ISO string at which cron jobs stop |

### direct

Sets the channel implementation used by all `direct()` endpoints in this context. Use this to swap the default in-memory channels for a distributed implementation (e.g. Kafka, Redis).

```ts
import { KafkaChannel } from 'my-kafka-adapter'

const config: CraftConfig = {
  direct: { channelType: KafkaChannel },
}
```

| Option | Type | Description |
|--------|------|-------------|
| `channelType` | `DirectChannelType` | Channel constructor used for all direct endpoints |

When omitted, direct endpoints use the built-in in-memory channel (single-consumer, blocking send).

## Logging configuration

Logging uses a single pino instance configured at module load. Precedence (highest wins):

1. **Environment variables** -- `LOG_LEVEL` / `CRAFT_LOG_LEVEL`, `LOG_FILE` / `CRAFT_LOG_FILE`, `LOG_REDACT` / `CRAFT_LOG_REDACT` (comma-separated paths to redact)
2. **Config file in cwd** -- `craft.log.cjs` or `craft.log.js` in the current working directory
3. **Config file in home** -- `craft.log.cjs` or `craft.log.js` in `~/.routecraft/`
4. **Defaults** -- level `"warn"`, stdout, no redact

The config file exports a **native pino options object** (e.g. `level`, `redact`, `formatters`, `transport`). Env vars are merged on top, so env always wins.

Example `craft.log.js` (or `craft.log.cjs` in a CommonJS project):

```js
// craft.log.js
export default {
  level: "info",
  redact: ["req.headers.authorization"],
};
```

When using the CLI, pass `--log-level` or `--log-file` to set the corresponding env var before the logger initializes, so CLI flags override any config file.

## Environment variables

Routecraft automatically loads environment variables from `.env` files when using the CLI:

```bash
# .env
LOG_LEVEL=debug
NODE_ENV=development
```

---

## Related

{% quick-links %}

{% quick-link title="Events reference" icon="theming" href="/docs/reference/events" description="All lifecycle and runtime events available in the on field." /%}
{% quick-link title="Plugins reference" icon="presets" href="/docs/reference/plugins" description="Full API for plugin interfaces and context methods." /%}
{% quick-link title="Adapters reference" icon="presets" href="/docs/reference/adapters" description="All adapters, options, and signatures." /%}

{% /quick-links %}
