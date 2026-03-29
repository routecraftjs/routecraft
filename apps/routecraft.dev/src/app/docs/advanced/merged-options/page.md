---
title: Merged Options
---

Set adapter defaults once and share them across your entire context. {% .lead %}

## What are merged options?

Many adapters accept options at the call site -- timezone for `cron()`, temperature for `llm()`, and so on. When the same options repeat across dozens of capabilities, duplication becomes a maintenance problem. **Merged options** solve this by letting you register context-level defaults via a plugin. Each adapter then merges those defaults with its own per-call options at runtime.

The merge hierarchy (last wins):

1. **Built-in defaults** -- hardcoded in the adapter (e.g. `temperature: 0` for `llm()`)
2. **Plugin defaults** -- registered in `craft.config.ts` via a plugin
3. **Per-adapter options** -- passed directly at the call site

Per-adapter options always take precedence over plugin defaults, which in turn take precedence over built-in defaults.

## Using a plugin to set defaults

Every adapter that supports merged options ships a companion plugin function. Register it in `craft.config.ts`:

```ts
// craft.config.ts
import type { CraftConfig } from '@routecraft/routecraft'
import { cronPlugin } from '@routecraft/routecraft'

const config: CraftConfig = {
  plugins: [
    cronPlugin({ timezone: 'UTC', jitterMs: 2000 }),
  ],
}

export default config
```

Now every `cron()` source in the context inherits `timezone: 'UTC'` and `jitterMs: 2000` unless overridden:

```ts
// Inherits timezone: 'UTC' and jitterMs: 2000 from the plugin
.from(cron('@daily'))

// Overrides timezone but keeps jitterMs: 2000
.from(cron('0 9 * * 1-5', { timezone: 'America/New_York' }))
```

## Available plugins

| Adapter | Plugin | Package |
|---------|--------|---------|
| `cron()` | `cronPlugin()` | `@routecraft/routecraft` |
| `direct()` | `directPlugin()` | `@routecraft/routecraft` |
| `llm()` | `llmPlugin()` | `@routecraft/ai` |
| `embedding()` | `embeddingPlugin()` | `@routecraft/ai` |

See the [Plugins reference](/docs/reference/plugins) for the full options of each plugin.

## How it works

Under the hood, merged options use the **context store** -- a typed key-value map on `CraftContext`. A plugin writes defaults to the store at startup. When an adapter needs its options (e.g. in `subscribe()` or `send()`), it calls its own `mergedOptions(context)` method, which reads the store and spreads per-adapter options on top.

```
┌─────────────┐    apply()     ┌────────────────┐
│  cronPlugin  │──────────────►│  Context Store  │
│  { tz, ... } │               │  [CRON_OPTIONS] │
└─────────────┘                └───────┬────────┘
                                       │ getStore()
                                       ▼
                               ┌────────────────┐
                               │  CronAdapter   │
                               │  mergedOptions()│
                               │  { ...store,   │
                               │    ...adapter } │
                               └────────────────┘
```

The store uses `Symbol.for()` keys so the same key resolves correctly even if multiple versions of the package coexist in the dependency tree.

## Adding merged options to a custom adapter

If you are building a custom adapter and want to support merged options, follow these steps.

### 1. Define the options type

```ts
export interface MyAdapterOptions {
  apiKey?: string
  baseUrl?: string
  timeout?: number
}
```

### 2. Create a store key

Use `Symbol.for()` and augment `StoreRegistry` so the key is typed:

```ts
import type { StoreRegistry } from '@routecraft/routecraft'

export const MY_ADAPTER_OPTIONS = Symbol.for('acme.adapter.my-adapter.options')

declare module '@routecraft/routecraft' {
  interface StoreRegistry {
    [MY_ADAPTER_OPTIONS]: Partial<MyAdapterOptions>
  }
}
```

### 3. Implement `MergedOptions<T>` on your adapter class

```ts
import { type MergedOptions, type CraftContext } from '@routecraft/routecraft'

class MyAdapter implements Destination<unknown, void>, MergedOptions<MyAdapterOptions> {
  readonly adapterId = 'acme.adapter.my-adapter'
  public options: Partial<MyAdapterOptions>

  constructor(options?: Partial<MyAdapterOptions>) {
    this.options = options ?? {}
  }

  mergedOptions(context: CraftContext): MyAdapterOptions {
    const store = context.getStore(MY_ADAPTER_OPTIONS) as
      | Partial<MyAdapterOptions>
      | undefined
    return {
      timeout: 5000,     // built-in default
      ...store,          // plugin defaults
      ...this.options,   // per-adapter overrides
    }
  }

  async send(exchange) {
    const opts = this.mergedOptions(exchange.context)
    // use opts.apiKey, opts.baseUrl, opts.timeout ...
  }
}
```

### 4. Create a plugin factory

```ts
import type { CraftPlugin, CraftContext } from '@routecraft/routecraft'

export function myAdapterPlugin(defaultOptions: Partial<MyAdapterOptions>): CraftPlugin {
  return {
    apply(ctx: CraftContext) {
      ctx.setStore(MY_ADAPTER_OPTIONS, defaultOptions)
    },
  }
}
```

### 5. Export both

Export the plugin and the store key from your package so consumers can use either the plugin (recommended) or set the store directly for advanced cases.

```ts
export { myAdapterPlugin, MY_ADAPTER_OPTIONS }
```

---

## Related

{% quick-links %}

{% quick-link title="Plugins" icon="presets" href="/docs/advanced/plugins" description="How to write and register plugins." /%}
{% quick-link title="Creating adapters" icon="plugins" href="/docs/advanced/custom-adapters" description="Build your own source, destination, or processor adapter." /%}
{% quick-link title="Plugins reference" icon="presets" href="/docs/reference/plugins" description="Full API for built-in plugin options." /%}

{% /quick-links %}
