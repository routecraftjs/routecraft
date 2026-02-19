---
title: AI Package
---

Secure AI integrations for RouteCraft. {% .lead %}

## Why RouteCraft for AI?

RouteCraft takes a **security-first approach** to AI automation. While many frameworks give agents unrestricted system access, RouteCraft requires explicit, coded routes for every capability.

**Benefits:**
- **Controlled access**: Agents call only the routes you define
- **No surprises**: Every action is TypeScript code you can review
- **Production-ready**: Validate inputs, handle errors, log everything
- **MCP-native**: Expose tools to Claude, Cursor, and other AI clients

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

- **`mcp()`** – Alias for `direct()` with semantics for AI/MCP: when you pass options, `description` is **required**; schema and keywords are optional.
- **Discovery** – MCP routes register in the context store so you can query endpoints, descriptions, and schemas at runtime (e.g. for MCP or agent tool catalogs).

Use `mcp()` when building routes that will be discovered and called by AI agents or exposed via MCP.

## mcp()

```ts
mcp<T>(
  endpoint: string | ((exchange: Exchange<T>) => string),
  options?: McpOptions
): DirectAdapter<T>
```

Create a discoverable direct route for AI/MCP integration. If you pass the **options** object (second argument), you **must** include `description`—it is required whenever options are provided. `schema` and `keywords` are optional.

### Options (McpServerOptions / McpOptions)

When you pass options for the server (`.from(mcp(...))`), use `McpServerOptions`; `description` is **required**. Other fields are optional.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `description` | `string` | **Yes** whenever options are passed | Human-readable description of what this tool does; required for discovery. |
| `schema` | `StandardSchemaV1` | No | Body validation schema (Zod, Valibot, ArkType). |
| `headerSchema` | `StandardSchemaV1` | No | Header validation schema. |
| `keywords` | `string[]` | No | Keywords for discovery and categorization. |
| `channelType` | `DirectChannelType<DirectChannel>` | No | Custom direct channel implementation. |

### MCP plugin required for `.from(mcp(...))`

Routes that use `.from(mcp(...))` require the **MCP plugin** to be in your config. If you omit it, the route will fail when it starts with an error: "MCP plugin required". Add `mcpPlugin()` to `plugins` when building your context:

```ts
import { mcp, mcpPlugin } from '@routecraft/ai';
import { craft } from '@routecraft/routecraft';

const ctx = craft()
  .id('my-app')
  .routes([/* routes that use .from(mcp(...)) */])
  .with({ plugins: [mcpPlugin({ transport: 'http', port: 3001 })] })
  .build();
```

`mcpPlugin(options?)` accepts typed **McpPluginOptions** (e.g. `name`, `version`, `transport`, `port`, `host`, `tools`). For full validation of options (e.g. required props), use `validateWithSchema(options, schema)` with a StandardSchema from Zod, Valibot, or ArkType before passing options to `mcpPlugin()`.

### Without options (destination or simple source)

You can call `mcp(endpoint)` with **no** options when you only **send to** an MCP endpoint (`.to(mcp('my-tool'))`) or when you **receive from** an endpoint that is defined by another route with options. The route that *defines* the MCP endpoint must pass options including `description`:

```ts
import { mcp } from '@routecraft/ai';
import { craft, simple } from '@routecraft/routecraft';

// Route that defines the MCP endpoint (options with description required)
craft()
  .id('my-tool')
  .from(
    mcp('my-tool', {
      description: 'Echo or process the incoming query',
    })
  )
  .process((body) => body);

// Producer: send to MCP endpoint (no options when only sending)
craft()
  .id('producer')
  .from(simple({ query: 'hello' }))
  .to(mcp('my-tool'));
```

### With options (define a discoverable MCP endpoint)

When you **define** an MCP endpoint (typically in `.from(mcp(...))`), you must pass an options object that includes `description`. Schema and keywords are optional:

```ts
import { mcp } from '@routecraft/ai';
import { craft } from '@routecraft/routecraft';
import { z } from 'zod';

craft()
  .id('fetch-webpage')
  .from(
    mcp('fetch-webpage', {
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

As with `direct()`, you can use a function for the endpoint when sending **to** an MCP endpoint (e.g. route by exchange data). The routes that *define* each handler must pass options with `description`:

```ts
craft()
  .id('router')
  .from(simple({ type: 'a', data: 'test' }))
  .to(mcp((ex) => `handler-${ex.body.type}`));

craft()
  .id('handler-a')
  .from(
    mcp('handler-a', {
      description: 'Handle type-a messages',
    })
  )
  .to(consumerA);

craft()
  .id('handler-b')
  .from(
    mcp('handler-b', {
      description: 'Handle type-b messages',
    })
  )
  .to(consumerB);
```

## MCP client: calling remote MCP tools

Your routes can **call** remote MCP servers (e.g. a browser MCP, a custom tool server) by using `mcp()` as a **destination** with client options.

**Ways to call a remote tool:**

1. **By URL and tool name** – `.to(mcp({ url: 'http://host:port/mcp', tool: 'toolName' }, { args: (ex) => ({ ... }) }))`  
   Use when the MCP server is at a known URL (e.g. Streamable HTTP).

2. **By server id (from plugin config)** – Register servers in `mcpPlugin({ clients: { browser: { url: 'http://...' } } })`, then `.to(mcp({ serverId: 'browser', tool: 'browser_navigate' }, { args: () => ({ url: '...' }) }))`.  
   The plugin stores the URL; at runtime the adapter resolves `serverId` from the context store.

3. **Short form** – `.to(mcp('serverId:toolName', { args: () => ({ ... }) }))`  
   Same as (2) with `serverId` and `tool` derived from the string.

**Example (browser MCP):**

```ts
import { mcp, mcpPlugin } from '@routecraft/ai';
import { craft, simple, log } from '@routecraft/routecraft';

const ctx = craft()
  .with({
    plugins: [
      mcpPlugin({
        clients: {
          browser: { url: 'http://127.0.0.1:8089/mcp' },
        },
      },
    ],
  })
  .routes([
    craft()
      .id('scrape')
      .from(simple({ url: 'https://example.com' }))
      .enrich(mcp('browser:browser_navigate', { args: (ex) => ({ url: ex.body.url }) }))
      .enrich(mcp('browser:browser_evaluate', { args: () => ({ script: '() => [1,2,3]' }) }))
      .tap(log()),
  ])
  .build();
```

Tool results (e.g. from `browser_evaluate`) are returned as the destination result; use `.transform()` in your route to parse or normalize the response as needed.

## Discovery registry

MCP routes defined with an options object (which must include `description`) are registered in the context store, along with any optional `schema` and `keywords`. After `context.start()`, you can read the registry to build tool catalogs for MCP or agents:

```ts
import { context, DirectAdapter } from '@routecraft/routecraft';

const ctx = context().routes([/* your routes */]).build();
await ctx.start();

const registry = ctx.getStore(DirectAdapter.ADAPTER_DIRECT_REGISTRY);
const tools = registry ? Array.from(registry.values()) : [];
// e.g. [{ endpoint: 'fetch-webpage', description: '...', schema, keywords }]
```

## Relation to direct()

`mcp()` is an alias for `direct()` with two differences:

1. **Semantics** – Names and docs are oriented toward AI/MCP (MCP endpoints, discovery).
2. **McpServerOptions** – When you pass options, `description` is **required** so every defined MCP endpoint is discoverable; `direct()` leaves all options optional.

Behavior (single consumer, synchronous, validation, registry) is the same as `direct()`. Use `mcp()` when building AI/MCP-facing routes; use `direct()` for general inter-route communication.

## Coming soon

- LLM adapters (OpenAI, Google Gemini)
- Agent routing
