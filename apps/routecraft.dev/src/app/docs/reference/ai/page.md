---
title: AI Package
---

AI and MCP integrations for RouteCraft via the `@routecraft/ai` package. {% .lead %}

## Installation

{% code-tabs %}
{% code-tab label="npm" language="bash" %}
```bash
npm install @routecraft/ai
```
{% /code-tab %}

{% code-tab label="yarn" language="bash" %}
```bash
yarn add @routecraft/ai
```
{% /code-tab %}

{% code-tab label="pnpm" language="bash" %}
```bash
pnpm add @routecraft/ai
```
{% /code-tab %}

{% code-tab label="bun" language="bash" %}
```bash
bun add @routecraft/ai
```
{% /code-tab %}

{% /code-tabs %}

The package depends on `@routecraft/routecraft` (peer `>=0.2.0`).

## Overview

`@routecraft/ai` provides an AI-friendly DSL on top of RouteCraft's core:

- **`tool()`** – Alias for `direct()` with semantics for AI/MCP: when you pass options, `description` is **required**; schema and keywords are optional.
- **Discovery** – Tools register in the context store so you can query endpoints, descriptions, and schemas at runtime (e.g. for MCP or agent tool catalogs).

Use `tool()` when building routes that will be discovered and called by AI agents or exposed via MCP.

## tool()

```ts
tool<T>(
  endpoint: string | ((exchange: Exchange<T>) => string),
  options?: ToolOptions
): DirectAdapter<T>
```

Create a discoverable direct route for AI/MCP integration. If you pass the **options** object (second argument), you **must** include `description`—it is required whenever options are provided. `schema` and `keywords` are optional.

### Options (ToolOptions)

When you pass options, `description` is **required**. Other fields are optional.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `description` | `string` | **Yes** whenever options are passed | Human-readable description of what this tool does; required for discovery. |
| `schema` | `StandardSchemaV1` | No | Body validation schema (Zod, Valibot, ArkType). |
| `headerSchema` | `StandardSchemaV1` | No | Header validation schema. |
| `keywords` | `string[]` | No | Keywords for discovery and categorization. |
| `channelType` | `DirectChannelType<DirectChannel>` | No | Custom direct channel implementation. |

### Without options (destination or simple source)

You can call `tool(endpoint)` with **no** options when you only **send to** a tool (`.to(tool('my-tool'))`) or when you **receive from** an endpoint that is defined by another route with options. The route that *defines* the tool must pass options including `description`:

```ts
import { tool } from '@routecraft/ai';
import { craft, simple } from '@routecraft/routecraft';

// Route that defines the tool (options with description required)
craft()
  .id('my-tool')
  .from(
    tool('my-tool', {
      description: 'Echo or process the incoming query',
    })
  )
  .process((body) => body);

// Producer: send to tool endpoint (no options when only sending)
craft()
  .id('producer')
  .from(simple({ query: 'hello' }))
  .to(tool('my-tool'));
```

### With options (define a discoverable tool)

When you **define** a tool (typically in `.from(tool(...))`), you must pass an options object that includes `description`. Schema and keywords are optional:

```ts
import { tool } from '@routecraft/ai';
import { craft } from '@routecraft/routecraft';
import { z } from 'zod';

craft()
  .id('fetch-webpage')
  .from(
    tool('fetch-webpage', {
      description: 'Fetch and return the content of a webpage',
      schema: z.object({
        url: z.string().url(),
      }),
      keywords: ['fetch', 'web', 'http'],
    })
  )
  .process(async ({ url }) => {
    const response = await fetch(url);
    return { content: await response.text() };
  });
```

### Dynamic endpoints (destination only)

As with `direct()`, you can use a function for the endpoint when sending **to** a tool (e.g. route by exchange data). The routes that *define* each handler must pass options with `description`:

```ts
craft()
  .id('router')
  .from(simple({ type: 'a', data: 'test' }))
  .to(tool((ex) => `handler-${ex.body.type}`));

craft()
  .id('handler-a')
  .from(
    tool('handler-a', {
      description: 'Handle type-a messages',
    })
  )
  .to(consumerA);

craft()
  .id('handler-b')
  .from(
    tool('handler-b', {
      description: 'Handle type-b messages',
    })
  )
  .to(consumerB);
```

## Discovery registry

Tools defined with an options object (which must include `description`) are registered in the context store, along with any optional `schema` and `keywords`. After `context.start()`, you can read the registry to build tool catalogs for MCP or agents:

```ts
import { context, DirectAdapter } from '@routecraft/routecraft';

const ctx = context().routes([/* your routes */]).build();
await ctx.start();

const registry = ctx.getStore(DirectAdapter.ADAPTER_DIRECT_REGISTRY);
const tools = registry ? Array.from(registry.values()) : [];
// e.g. [{ endpoint: 'fetch-webpage', description: '...', schema, keywords }]
```

## Relation to direct()

`tool()` is an alias for `direct()` with two differences:

1. **Semantics** – Names and docs are oriented toward AI/MCP (tools, discovery).
2. **ToolOptions** – When you pass options, `description` is **required** so every defined tool is discoverable; `direct()` leaves all options optional.

Behavior (single consumer, synchronous, validation, registry) is the same as `direct()`. Use `tool()` when building AI/MCP-facing routes; use `direct()` for general inter-route communication.

## Coming soon

- LLM adapters (OpenAI, Google Gemini)
- MCP source and destination (`.from(mcp())`, `.to(mcp())`)
- Agent routing
