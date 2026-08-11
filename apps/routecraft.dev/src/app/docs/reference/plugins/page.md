---
title: Plugins
---

Built-in plugins that extend the Routecraft runtime. Each entry opens its own reference page with the full options and behaviour. {% .lead %}

{% plugin-index /%}

{% callout %}
Core adapter defaults (`cron`, `direct`) are set via dedicated fields on `CraftConfig`, not via plugins. See [Configuration](/docs/reference/configuration) and [Merged Options](/docs/advanced/merged-options).
{% /callout %}

## First-class config keys

Importing `@routecraft/ai` augments `CraftConfig` with first-class keys for the AI plugins. Setting `llm`, `mcp`, `embedding`, or `agent` on the config is equivalent to pushing the corresponding plugin onto `plugins: []`. Lifecycle (`apply`, `start`, `teardown`, plugin events) is identical.

```ts
// Before (still supported, use this for shared plugin instances or programmatic composition)
import { defineConfig } from '@routecraft/routecraft'
import { llmPlugin, mcpPlugin } from '@routecraft/ai'

export const craftConfig = defineConfig({
  plugins: [
    llmPlugin({ providers: { openai: { apiKey: '...' } } }),
    mcpPlugin({ clients: { /* ... */ } }),
  ],
})

// After (recommended for declarative configs)
import { defineConfig } from '@routecraft/routecraft'
import '@routecraft/ai' // augments CraftConfig

export const craftConfig = defineConfig({
  llm: { providers: { openai: { apiKey: '...' } } },
  mcp: { clients: { /* ... */ } },
})
```

The factories listed above remain available unchanged. Use them via `plugins: []` when you need to instantiate a plugin once and reuse it (across multiple contexts) or compose plugins programmatically.

## Lifecycle

A plugin has three optional hooks. Which one a piece of work belongs in is decided by what has to already exist for that work to be correct.

| Hook | Runs | The routes are | Use it for |
|------|------|----------------|------------|
| `apply(ctx)` | While the context is being built | Registered, not running | Resolving config, opening resources, populating the context store |
| `start(ctx)` | After every route has started | Running | Work that drives routes or needs them able to serve |
| `teardown(ctx)` | During shutdown | Stopping or stopped | Releasing what `apply` opened, stopping what `start` began |

```ts
import type { CraftPlugin, CraftContext } from '@routecraft/routecraft'

export function heartbeatPlugin(everyMs = 60_000): CraftPlugin {
  // Keyed by context, not a closure slot: one plugin instance can be applied
  // to more than one context in a process, and a single slot would let the
  // second start overwrite the first context's timer.
  const timers = new WeakMap<CraftContext, ReturnType<typeof setInterval>>()

  return {
    name: 'heartbeat',
    apply(ctx: CraftContext) {
      ctx.logger.debug({}, 'heartbeat configured')
    },
    start(ctx: CraftContext) {
      const timer = setInterval(() => {
        ctx.logger.info({}, 'still running')
      }, everyMs)
      timer.unref?.()
      timers.set(ctx, timer)
    },
    teardown(ctx: CraftContext) {
      const timer = timers.get(ctx)
      if (timer) clearInterval(timer)
      timers.delete(ctx)
    },
  }
}
```

Most plugins need none of these: a plugin that only supplies typed, validated defaults to the context store is a config helper, and `apply` alone covers it.

A plugin instance may be applied and started against more than one context in a process, so per-run state a hook creates must be keyed by the `ctx` it was handed rather than held in a closure slot.

Hooks run in registration order and each is awaited before the next plugin's, at both `apply` and `start`. A hook that throws during `start` fails `context.start()` with the original error, and the plugins that already started are torn down before it surfaces.

`start` is awaited, so the context is not ready until every hook has resolved. Use it for startup work that finishes: the suspension plugin scans for suspensions that expired while the process was down, so those escalations reach their routes before new traffic does. Work that does not finish (a poll loop, a subscription) is begun in `start` and left to the plugin's own timer, as above, rather than awaited inside the hook.

{% callout type="note" title="Waiting for a context to be ready" %}
`ctx.start()` resolves when the context **stops**, not when it comes up: a context with an indefinite route (an HTTP server, a `direct()` endpoint) keeps running. Await `ctx.whenStarted()` for readiness. It resolves once no route is still coming up and every `start()` hook has finished, and rejects if a hook or the config refuses. A single route failing to come up is not observable there, since the context keeps the others running.
{% /callout %}

## Related

{% quick-links %}

{% quick-link title="Configuration" icon="installation" href="/docs/reference/configuration" description="craft.config.ts and the merged options resolution order." /%}
{% quick-link title="Adapters" icon="presets" href="/docs/reference/adapters" description="The connectors that plugins configure defaults for." /%}
{% quick-link title="AI capabilities" icon="theming" href="/docs/advanced/composing-capabilities" description="Build the agent or expose capabilities to one." /%}

{% /quick-links %}
