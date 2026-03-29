---
title: Merged Options
---

Set adapter defaults once and share them across your entire context. {% .lead %}

## What are merged options?

Many adapters accept options at the call site -- timezone for `cron()`, temperature for `llm()`, and so on. When the same options repeat across dozens of capabilities, duplication becomes a maintenance problem. **Merged options** solve this by letting you register context-level defaults that every adapter of that type inherits automatically.

The merge hierarchy (last wins):

1. **Built-in defaults** -- hardcoded in the adapter (e.g. `temperature: 0` for `llm()`)
2. **Context defaults** -- registered in `craft.config.ts`
3. **Per-adapter options** -- passed directly at the call site

Per-adapter options always take precedence over context defaults, which in turn take precedence over built-in defaults.

## Setting defaults for core adapters

Core adapters (`cron`, `direct`) have dedicated fields on `CraftConfig`. Set them once and every adapter of that type in the context inherits the values:

```ts
// craft.config.ts
import type { CraftConfig } from '@routecraft/routecraft'

const config: CraftConfig = {
  cron: { timezone: 'UTC', jitterMs: 2000 },
}

export default config
```

Now every `cron()` source inherits `timezone: 'UTC'` and `jitterMs: 2000` unless overridden:

```ts
// Inherits timezone: 'UTC' and jitterMs: 2000 from config
.from(cron('@daily'))

// Overrides timezone but keeps jitterMs: 2000
.from(cron('0 9 * * 1-5', { timezone: 'America/New_York' }))
```

## Setting defaults for external adapters

Adapters from other packages (like `@routecraft/ai`) use the plugin pattern. Register a companion plugin in `craft.config.ts`:

```ts
import type { CraftConfig } from '@routecraft/routecraft'
import { llmPlugin, embeddingPlugin } from '@routecraft/ai'

const config: CraftConfig = {
  plugins: [
    llmPlugin({
      providers: { anthropic: { apiKey: process.env.ANTHROPIC_API_KEY } },
      defaultOptions: { temperature: 0.7 },
    }),
    embeddingPlugin({
      providers: { openai: { apiKey: process.env.OPENAI_API_KEY } },
    }),
  ],
}
```

Plugins that manage additional concerns (like `llmPlugin` which also registers provider credentials) wrap `defaultOptions` inside a larger configuration object. See the [Plugins reference](/docs/reference/plugins) for the full options of each plugin.

The `direct` adapter also supports a context-level `channelType` to swap all endpoints from in-memory to a distributed implementation. See [Configuration](/docs/reference/configuration#direct).

## Supported adapters

| Adapter | How to set defaults | Location |
|---------|-------------------|----------|
| `cron()` | `CraftConfig.cron` | `craft.config.ts` |
| `direct()` | `CraftConfig.direct` (channelType only) | `craft.config.ts` |
| `llm()` | `llmPlugin({ defaultOptions })` | `CraftConfig.plugins` |
| `embedding()` | `embeddingPlugin({ defaultOptions })` | `CraftConfig.plugins` |

## How it works

Under the hood, merged options use the **context store** -- a typed key-value map on `CraftContext`. Config fields and plugins both write defaults to the store at startup. When an adapter needs its options (e.g. in `subscribe()` or `send()`), it resolves them from the store, combining context-level defaults with per-adapter overrides. Per-adapter values always win.

```
┌──────────────┐               ┌────────────────┐
│ CraftConfig  │──────────────►│  Context Store  │
│ cron: { ... }│   setStore()  │  [CRON_OPTIONS] │
└──────────────┘               └───────┬────────┘
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
      ...store,          // context defaults
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

For adapters in external packages, ship a companion plugin so users have a typed, discoverable API:

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

{% quick-link title="Configuration" icon="presets" href="/docs/reference/configuration" description="Full CraftConfig reference including cron and direct fields." /%}
{% quick-link title="Creating adapters" icon="plugins" href="/docs/advanced/custom-adapters" description="Build your own source, destination, or processor adapter." /%}
{% quick-link title="Plugins reference" icon="presets" href="/docs/reference/plugins" description="Full API for built-in plugin options." /%}

{% /quick-links %}
