---
title: Configuration
---

Full reference for `CraftConfig` fields and logging options. {% .lead %}

## CraftConfig

The main configuration object for context settings. Export it as `craftConfig` (named export) alongside your capabilities when using `craft run`:

```ts
import type { CraftConfig } from '@routecraft/routecraft'

export const craftConfig = {
  store: new Map([
    ['my.adapter.config', { apiKey: 'xyz' }]
  ]),
  on: {
    'context:starting': ({ ts }) => console.log('Starting at', ts)
  }
} satisfies CraftConfig
```

## Configuration fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `store` | `Map<keyof StoreRegistry, StoreRegistry[keyof StoreRegistry]>` | No | — | Initial values for the context store |
| `on` | `Partial<Record<EventName, EventHandler \| EventHandler[]>>` | No | — | Event handlers to register on context creation |
| `once` | `Partial<Record<EventName, EventHandler \| EventHandler[]>>` | No | — | One-time event handlers that fire once then auto-unsubscribe |
| `plugins` | `CraftPlugin[]` | No | — | Plugins to initialize before routes are registered |

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
