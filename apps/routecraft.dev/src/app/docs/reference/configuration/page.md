---
title: Configuration
---

Configure RouteCraft contexts with store and event handlers. {% .lead %}

## CraftConfig

The main configuration object for context settings. Routes are provided separately via file exports or the ContextBuilder.

```ts
import { type CraftConfig } from '@routecraft/routecraft'

export const craftConfig = {
  store: new Map([
    ['my.adapter.config', { apiKey: 'xyz' }]
  ]),
  on: {
    contextStarting: ({ ts }) => console.log('Starting at', ts)
  }
} satisfies CraftConfig
```

## Configuration fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `store` | `Map<keyof StoreRegistry, StoreRegistry[keyof StoreRegistry]>` | No | — | Initial values for the context store |
| `on` | `Partial<Record<EventName, EventHandler \| EventHandler[]>>` | No | — | Event handlers to register on context creation |
| `plugins` | `CraftPlugin[]` | No | — | Plugins to initialize before routes are registered |

## Usage patterns

### Using CraftConfig in files

When using `craft run`, export your config as a named export and routes as the default:

```ts
// my-route.mjs
import { craft, timer, log } from '@routecraft/routecraft'

// Default export: routes
export default craft()
  .id('my-route')
  .from(timer({ intervalMs: 1000 }))
  .to(log())

// Named export: config (optional)
export const craftConfig = {
  store: new Map([
    ['my.adapter.config', { apiKey: 'xyz' }],
    ['cache.users', new Map()]
  ]),
  on: {
    contextStarting: ({ ts }) => console.log('Starting at', ts),
    error: ({ details }) => console.error('Error:', details.error)
  }
}
```

Then run: `craft run my-route.mjs`

### Using ContextBuilder programmatically

The ContextBuilder provides a fluent API and can consume a CraftConfig:

```ts
import { context } from '@routecraft/routecraft'
import { myRoutes } from './routes'

const ctx = context()
  .with({
    store: new Map([['my.key', { value: 123 }]]),
    on: {
      contextStarting: () => console.log('Starting')
    }
  })
  .routes(myRoutes)
  .build()

await ctx.start()
```

Or build from scratch without a config object:

```ts
const ctx = context()
  .routes(myRoutes)
  .store('my.adapter.config', { apiKey: 'xyz' })
  .on('contextStarting', () => console.log('Starting'))
  .on('error', ({ details }) => console.error(details.error))
  .build()

await ctx.start()
```

You can also combine both approaches:

```ts
const ctx = context()
  .with(craftConfig)                    // Apply config
  .routes(additionalRoutes)             // Add more routes
  .store('another.key', { value: 456 }) // Add more stores
  .on('routeStarted', ({ details }) => console.log('Route started'))
  .build()
```

## Logging configuration

Logging uses a single pino instance configured at module load. Precedence (highest wins):

1. **Environment variables** — `LOG_LEVEL` / `CRAFT_LOG_LEVEL`, `LOG_FILE` / `CRAFT_LOG_FILE`, `LOG_REDACT` / `CRAFT_LOG_REDACT` (comma-separated paths to redact)
2. **Config file in cwd** — `craft.log.cjs` or `craft.log.js` in the current working directory
3. **Config file in home** — `craft.log.cjs` or `craft.log.js` in `~/.routecraft/`
4. **Defaults** — level `"warn"`, stdout, no redact

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

RouteCraft automatically loads environment variables from `.env` files when using the CLI:

```bash
# .env
LOG_LEVEL=debug
NODE_ENV=development
```

## Adapters

Adapters are not auto-loaded. Import and instantiate them explicitly in routes:

```ts
import { craft, timer, http, log } from '@routecraft/routecraft'

export default craft()
  .from(timer({ intervalMs: 5000 }))
  .enrich(http({ url: 'https://api.example.com/data' }))
  .to(log())
```

See the [Adapters reference](/docs/reference/adapters) for all available adapters.

## Context store

The store provides shared state accessible to all routes and adapters. Initialize it via config or builder:

```ts
// Via config
export const craftConfig = {
  store: new Map([
    ['app.config', { version: '1.0.0' }],
    ['cache.users', new Map()],
    ['metrics.counters', { requests: 0 }]
  ])
}

// Via builder
const ctx = context()
  .store('app.config', { version: '1.0.0' })
  .store('cache.users', new Map())
  .routes(myRoutes)
  .build()
```

Access the store in routes and adapters via `context.getStore()` and `context.setStore()`:

```ts
// In an adapter
async send(exchange) {
  const config = exchange.context.getStore('app.config')
  // Use config...
}
```

## Merged options

Some adapters support configuration merging with context-level settings:

```ts
// Adapter can merge its options with context configuration
const adapter = createAdapter({
  options: { timeout: 5000 },
  mergedOptions: (context) => ({
    ...context.getStore('global.http.config'),
    timeout: 5000, // Override specific values
  })
})
```

This pattern allows adapters to inherit global configuration while maintaining local overrides.

## Plugins

Plugins extend RouteCraft with cross-cutting behavior and run before routes are registered. Configure them via `CraftConfig.plugins`:

```ts
// Via config
import { plugin as mcp } from '@routecraft/ai'
import observabilityPlugin from './plugins/observability'

export const craftConfig = {
  plugins: [
    observabilityPlugin(),
    mcp({ name: 'my-tools' })
  ]
}

// Via builder
const ctx = context()
  .with({
    plugins: [observabilityPlugin(), mcp()]
  })
  .routes(myRoutes)
  .build()
```

See the [Plugins reference](/docs/reference/plugins) for details on authoring plugins and advanced patterns like dynamic route registration.

## Events

Subscribe to lifecycle events via config or builder. See the [Events reference](/docs/reference/events) for all available events, signatures, and examples.

```ts
// Via config
export const craftConfig = {
  on: {
    contextStarting: ({ ts }) => console.log('Starting at', ts),
    contextStopped: () => console.log('Stopped'),
    error: ({ details }) => console.error('Error:', details.error)
  }
}

// Via builder
const ctx = context()
  .on('contextStarting', ({ ts }) => console.log('Starting at', ts))
  .on('error', ({ details }) => console.error(details.error))
  .routes(myRoutes)
  .build()
```

## Planned features

The following features are planned for future releases:

### Admin Portal {% badge %}wip{% /badge %}

Web-based monitoring and debugging UI for real-time route inspection, tracing, and metrics visualization.
