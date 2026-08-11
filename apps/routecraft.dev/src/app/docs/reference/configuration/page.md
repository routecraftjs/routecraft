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
| `name` | `string` | No | -- | Service / application name. Emitted on every log line as `service.name` ([details](#service-name)) |
| `store` | `Map<keyof StoreRegistry, StoreRegistry[keyof StoreRegistry]>` | No | -- | Initial values for the context store |
| `on` | `Partial<Record<EventName, EventHandler \| EventHandler[]>>` | No | -- | Event handlers to register on context creation |
| `once` | `Partial<Record<EventName, EventHandler \| EventHandler[]>>` | No | -- | One-time event handlers that fire once then auto-unsubscribe |
| `cron` | `Partial<CronOptions>` | No | -- | Default options for all `cron()` sources ([details](#cron)) |
| `direct` | `{ channelType?: DirectChannelType }` | No | -- | Custom channel implementation for all `direct()` endpoints ([details](#direct)) |
| `http` | `HttpPluginOptions` | No | -- | Serve routes over HTTP for the `http()` source ([details](#http)) |
| `mail` | `MailContextConfig` | No | -- | Mail adapter accounts (IMAP/SMTP) keyed by name |
| `telemetry` | `TelemetryOptions` | No | -- | Telemetry plugin configuration (SQLite, OpenTelemetry) |
| `suspension` | `SuspensionConfig` | Only when a route can reach `.suspend()` or `.resume()` | -- | Where parked exchanges are stored and how resume tokens are signed. A context with a suspendable route and no `suspension` block refuses to start with `RC5052`; the fields inside it are individually optional ([details](#suspension)) |
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

### http

Configures the HTTP server that backs the [`http()` source](/docs/reference/adapters#http). Setting this key starts a listener when the context starts (Bun.serve on Bun, `node:http` on Node 22+). See [httpPlugin](/docs/reference/plugins#httpplugin) for the full behaviour.

```ts
import { defineConfig, jwt } from '@routecraft/routecraft'

export const craftConfig = defineConfig({
  http: {
    port: 8080,
    host: '0.0.0.0',
    auth: jwt({ secret: process.env.JWT_SECRET!, issuer: '...', audience: '...' }),
  },
})
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `port` | `number` | -- (required) | Port to bind. Use `0` to let the OS choose. |
| `host` | `string` | `127.0.0.1` | Host to bind. Use `0.0.0.0` to expose externally. |
| `auth` | `ValidatorAuthOptions \| ApiKeyAuthOptions` | -- | Global auth: `jwt(...)` / `jwks(...)` (bearer) or `apiKey({...})`. Omit for fully public routes. |
| `maxBodySize` | `number` | `10485760` (10 MB) | Maximum request body in bytes; larger requests return `413`. |
| `events` | `{ perRequest?: boolean }` | `{ perRequest: true }` | Toggle the per-request `plugin:http:request:completed` event. |
| `builtins` | `{ health?, ready?, openapi?: { enabled?: boolean; requireAuth?: boolean } }` | see [adapter reference](/docs/reference/adapters/http#configuring-built-ins) | Per-endpoint config for `/health`, `/ready`, `/openapi.json`. Uniform `{ enabled, requireAuth }` shape per built-in (inspired by Spring Boot Actuator). |

### suspension

Configures where parked exchanges are persisted, and the secret used to sign the resume tokens an approver is handed. Required as soon as any route can reach a [`.suspend()`](/docs/reference/operations/suspend): such a context refuses to start without it, with [`RC5052`](/docs/reference/errors#rc-5052). A context that never suspends does not need the key.

It is deliberately not implicit. This setting decides whether a deployment survives a restart and whether resume tokens outlive the process, and defaulting it silently would hand a route that promises durability an in-memory store nobody chose.

```ts
import { defineConfig } from '@routecraft/routecraft'

export const craftConfig = defineConfig({
  suspension: {
    // A mounted volume in a container deployment, so parked exchanges
    // outlive the container that parked them.
    store: { path: '/data/suspensions.db' },
  },
})
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `store` | `string \| { path: string } \| "memory" \| SuspensionStore` | `.routecraft/suspensions.db` | Where parked exchanges live. A path opens the SQLite backend. `"memory"` opts into the in-process backend, accepting that parked exchanges die with the process. A `SuspensionStore` instance plugs in a backend of your own. |
| `secret` | `string` | -- | HMAC secret for signing resume tokens. Prefer the environment variable below; this field is for deployments that fetch secrets at boot and pass them in code. |

Both settings are also readable from the environment, which is how a container deployment supplies them:

| Variable | Purpose |
|----------|---------|
| `ROUTECRAFT_SUSPENSION_STORE` | Store location: a file path, or the literal `memory`. |
| `ROUTECRAFT_SUSPENSION_SECRET` | Resume-token signing secret. |

An explicit config value wins over the environment.

**The store backend is chosen per runtime.** Under Bun it is `bun:sqlite`, a built-in. Under Node it is `better-sqlite3`, an optional peer: install it (`bun add better-sqlite3`) to get a durable store on Node. Without it, an unconfigured context falls back to the in-memory backend and warns that parked exchanges will not survive a restart, while a context that named a `store` path fails to start rather than silently losing durability it asked for.

**If you park exchanges, pin your line endings and build settings across deploys.** A parked exchange records a hash of the steps that have not run yet, so that a change to what an approval authorises invalidates it rather than resuming into different behaviour. That hash reads step identity from function source text **verbatim**, with no normalisation, because any normalisation that made two different sources hash alike would also be a way to miss a real change. The consequence is that the hash is sensitive to more than your source tree: a formatting pass, a checkout with different line endings, and a build that changes emitted text (a different minifier, new bundler settings, a TypeScript target bump) each move it for steps whose behaviour did not change. Every one of those outcomes is safe rather than silent, since affected exchanges re-enter their route's error channel and can be re-asked; none of them can resume an approval into different behaviour, which is the trade being made. For a repository whose routes park approvals for days, commit a `.gitattributes` with `* text eol=lf` (or the equivalent pin for your platform) so checkouts agree on line endings, and keep build settings stable between releases. Running TypeScript directly (the default under Bun, with no bundler in the path) removes the build half of this entirely.

**The signing secret is required, at least 32 bytes, and never generated for you.** A context whose routes can reach a durable suspend fails at startup with [`RC5040`](/docs/reference/errors#rc-5040) when no secret is configured. The secret is deliberately not stored alongside the suspensions: a store compromise must not also yield forgeable resume tokens. `testContext()`, `NODE_ENV=development` and `NODE_ENV=test` mint an ephemeral in-memory key so tests and local iteration need no setup; that key is regenerated on every start, so tokens minted before a restart stop verifying, and the framework warns when it is in use.

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

### Service name

Set `name` on the context to tag every log line with a `service.name` field (the OpenTelemetry semantic convention). This identifies the originating application when shipping logs to an aggregator, and lines up with OTel resource mappings such as BetterStack's `resources.service.name`.

```ts
import { defineConfig } from "@routecraft/routecraft";

export const craftConfig = defineConfig({
  name: "eywa",
});
```

Every log emitted through the context, its routes, and their exchanges then carries the field:

```json
{ "level": "info", "service.name": "eywa", "route": "zoe-mail", "msg": "..." }
```

When `name` is omitted, no `service.name` field is added. The value is a per-context log binding; it does not configure OpenTelemetry trace resources. If you also export traces via `telemetry({ tracerProvider })`, set the matching `service.name` on that provider's `Resource` so logs and spans agree.

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
