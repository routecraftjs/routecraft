---
title: Plugins
---

Built-in plugins that extend the Routecraft runtime. Each entry opens its own reference page with the full options and behaviour. {% .lead %}

{% plugin-index /%}

{% callout %}
Core adapter defaults (`cron`, `direct`) are set via dedicated fields on `CraftConfig`, not via plugins. See [Configuration](/docs/reference/configuration) and [Merged Options](/docs/advanced/merged-options).
{% /callout %}

## First-class config keys

Importing `@routecraft/ai` augments `CraftConfig` with first-class keys for the AI plugins. Setting `llm`, `mcp`, `embedding`, or `agent` on the config is equivalent to pushing the corresponding plugin onto `plugins: []`. Lifecycle (`apply`, `teardown`, plugin events) is identical.

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

## Related

{% quick-links %}

{% quick-link title="Configuration" icon="installation" href="/docs/reference/configuration" description="craft.config.ts and the merged options resolution order." /%}
{% quick-link title="Adapters" icon="presets" href="/docs/reference/adapters" description="The connectors that plugins configure defaults for." /%}
{% quick-link title="AI capabilities" icon="theming" href="/docs/advanced/composing-capabilities" description="Build the agent or expose capabilities to one." /%}

{% /quick-links %}
