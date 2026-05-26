---
title: The Routecraft DSL cheat sheet
description: One graphic that fits the entire Routecraft fluent API onto a single page. Filter, validate, transform, enrich, split, aggregate, error handling, MCP integration, the events system, the CLI, and a quick-reference table. Plus a per-section narrative and notes on what changed in v0.5.0.
date: 2026-05-22
author: Jaco Botha
authorRole: Founder, DevOptix
tags:
  - routecraft
  - cheat-sheet
  - dsl
  - typescript
  - reference
image: /images/blog/routecraft-dsl-cheat-sheet/cheat-sheet.png
imageAlt: "One-page Routecraft cheat sheet covering installation, builder DSL, sources, destinations, exchanges, split and aggregate, enrich, validation, events, error handling, context and plugins, AI and MCP integration, CLI, and TUI"
layout: blog-post
---

If you write Routecraft routes more than once a week, you stop needing the docs for the common cases and start needing a single page you can keep open in a second tab. This is that page. The cheat sheet above fits the entire fluent API onto one graphic. The walkthrough below is the narrative version, useful for new readers and as a refresher when you forget which side of `.enrich()` the destination goes.

Save the image. Print it. Pin it to your monitor. Whatever works for you.

> Note on versions: the cheat sheet was drawn for Routecraft v0.4.0. The shape is unchanged in v0.5.0, but a few names moved. Notes inline below where it matters, plus a [v0.5.0 changes](#whats-changed-in-v050) section at the bottom.

## The mental model

A Routecraft route is a typed pipeline:

```
source -> operations -> destination
```

You start with a builder, attach a source adapter, chain operations that transform or filter or branch the data, and finish with a destination. Types flow through automatically. The runtime handles scheduling, retries, logging, and lifecycle.

Three things you reach for over and over:

- **`craft()`** opens a route builder.
- **`ContextBuilder`** assembles the runtime (routes, plugins, adapter config) into a context you `start()` and `stop()`.
- **Adapters** are the integrations. Cron, HTTP, IMAP, SMTP, channels, MCP, LLM, files. Each one is symmetric: the same adapter can usually be a source or a destination.

If you internalise that, the rest of this post is just lookups.

## Installation

```bash
npm add @routecraft/routecraft       # core library
npm add @routecraft/ai                # AI / MCP integration
npm add -g @routecraft/cli            # CLI to run routes from terminal
```

The CLI runs TypeScript directly via Bun (Bun >= 1.1.0). If you are on Node, the CLI still works, but the dev loop is faster on Bun.

## Builder DSL: the fluent API in one place

Every operation chains. Types thread through each step automatically. The most common combinations:

```ts
craft()
  .id('pipeline')              // unique route name
  .description('...')           // doc string used in errors
  .input({ size: 100 })         // optional input schema
  .from(source)                 // source adapter
  .transform(body => body)      // pure body function
  .process(ex => ex)            // full exchange access
  .filter(ex => ex.body.age > 18) // drop if false
  .validate(schema(zodSchema))  // any Standard Schema library
  .header('key', 'val')         // set a header
  .enrich(other)                // fetch and merge
  .split()                      // emit one exchange per array item
  .aggregate()                  // collect back into one
  .to(destination)              // destination adapter
  .build()
```

`craft()` builds a route. `craft().build()` produces a `Route` object ready to be added to a `ContextBuilder`.

## Sources: where data comes from

```ts
// Static value or async function
.from(simple({ hello: 'world' }))
.from(simple(() => fetch('/api').then(r => r.json())))

// Emit on an interval
.from(timer({ intervalMs: 5000 }))

// Cron schedule
.from(cron('0 9 * * *'))
.from(cron('0 9 * * *', { timezone: 'UTC' }))

// In-process channel (pub/sub between routes)
.from(channel('channel-name', { schema }))

// IMAP mail (push via IDLE)
.from(imap({ folder: 'INBOX', unseen: true }))

// File source
.from(file({ path: './data.json' }))
.from(file({ path: './data.json', channel: true }))
```

Every source adapter has the same surface: pass options, get back something `from()` accepts.

## Destinations: where data goes

```ts
// Log to console
.to(log())
.to(debug(ex => ex.body))

// HTTP request
.to(http({
  method: 'POST',
  url: 'https://example.com',
  body: ex => ex.body,
}))

// Dynamic URL
.to(http({ url: ex => `/${ex.body.id}` }))

// In-process channel
.to(channel('my-channel'))

// Write file
.to(file({ path: './out.txt', mode: 'append' }))

// Send email via SMTP
.to(smtp({
  to: ex => ex.body.email,
  subject: 'Hello',
}))
```

The same `http` / `file` / `channel` / `smtp` adapters work as sources too, in most cases. That symmetry is what lets a route easily reverse direction (consume vs produce).

## Exchanges: the data envelope

Every value flowing through a route is wrapped in an Exchange:

```ts
type Exchange<T> = {
  id: string
  body: T
  headers: ExchangeHeaders
  logger: Logger
}
```

You almost always touch `body`. `headers` and `id` show up when you need to pass routing metadata or correlate logs.

Access patterns:

```ts
// .transform() gets just the body
.transform(body => body.toUpperCase())

// .process() gets the full exchange
.process(ex => ({
  ...ex,
  body: { ...ex.body, ts: Date.now() },
}))

// .filter() also gets the full exchange
.filter(ex => ex.body.age > 18)
```

Rule of thumb: reach for `.transform()` first. Drop down to `.process()` only when you need headers or the exchange ID.

## Split and aggregate: fan-out, then re-collect

```ts
craft()
  .from(simple([1, 2, 3]))
  .split()                  // 3 exchanges
  .transform(n => n * 2)    // each runs independently
  .aggregate()              // [2, 4, 6]
  .to(log())
```

This is map / reduce in one line. `.split()` on an array emits one exchange per item; `.aggregate()` collects them back. Useful for "process every row of this query result", "send one email per recipient", "fetch one detail page per ID".

## Enrich: fetch additional data and merge

```ts
// Default: deep merge
.enrich(http({ url: '/api/user' }))

// Custom merge strategy
.enrich(dest, (orig, fetched) => ({
  ...orig.body,
  meta: fetched.body,
}))

// Merge helpers
.enrich(dest, only('meta'))
.enrich(dest, replace())
```

This is the lookup pattern. You have a partial record, you go fetch the rest, and the merger decides how to combine.

## Validation: Standard Schema, any library

Routecraft accepts any [Standard Schema](https://standardschema.dev) implementation. Zod, Valibot, ArkType, your own.

```ts
import { z } from 'zod'
import { schema } from '@routecraft/routecraft'

craft()
  .from(channel('input'))
  .validate(schema(z.object({
    email: z.string().email(),
    age: z.number().min(18),
  })))
  .to(log())
```

After `.validate()`, `body`'s type is inferred from the schema. Invalid input becomes a structured error before any downstream code runs.

## Events: lifecycle and tracing

The context emits typed events you can listen to:

```ts
// Lifecycle
ctx.on('context:started', () => {})
ctx.on('context:error', (err) => {})

// Route lifecycle
ctx.on('route:started', () => {})

// Exchange tracking
ctx.on('route:exchange:completed', ({ details }) => {
  // { exchange, duration }
})

// Step-level tracing
ctx.on('step:completed', ({ details }) => {
  // { operation, adapter, duration }
})

// Wildcards (glob-style)
ctx.on('route:**', () => {})
```

This is your hook for metrics, custom logging, alerting, and the TUI's telemetry feed.

## Error handling

```ts
craft()
  .error((error, exchange, forward) => {
    // Return a recovery value
    return { recovered: true }

    // Or forward to another route (dead-letter queue)
    return forward('dlq', {
      source: error.message,
    })
  })
  .from(source)
  .to(destination)
```

Errors get classified by code. Ranges to know:

| Range    | Meaning    |
| -------- | ---------- |
| RC1xxx   | Definition |
| RC2xxx   | DSL        |
| RC3xxx   | Runtime    |
| RC4xxx   | Lifecycle  |
| RC5xxx   | Adapter    |

Knowing the range gets you to the right place fast when something blows up in production.

## Context and plugins

```ts
const ctx = await new ContextBuilder()
  .add({
    crm: { timezone: 'UTC' },
    direct: { channelType: 'memory' },
    mail: { accounts: { /* ... */ } },
    plugins: [myPlugin],
  })
  .on('context:started', () => {})
  .store('custom-key', value)
  .routes(route1, route2)
  .build()

const myPlugin: CraftPlugin = {
  async apply(ctx) {
    ctx.store('key', new Map())
  },
  async teardown(ctx) {
    // cleanup
  },
}
```

The context is your composition root. Plugins are how you add cross-cutting behavior (telemetry, custom logging, shared state). Adapter config (mail accounts, timezone, channel backends) lives on the context too.

## AI and MCP integration

Expose any route as an MCP tool. Same builder, different source:

```ts
import { mcp } from '@routecraft/ai'

craft()
  .id('fetch-page')
  .from(mcp({
    name: 'fetch-page',
    description: 'Fetch webpage content',
    schema: z.object({ url: z.string().url() }),
  }))
  .enrich(http({ url: ex => ex.body.url }))
  .to(log())
```

Call an LLM from inside a route:

```ts
import { llm } from '@routecraft/ai'

craft()
  .id('summarize')
  .from(channel('text-in'))
  .to(llm({
    systemPrompt: 'Summarize concisely',
    userPrompt: ex => ex.body.text,
  }))
  .to(log())
```

Connect from Claude Desktop:

```json
{
  "mcpServers": {
    "routecraft": {
      "command": "npx",
      "args": ["@routecraft/cli", "run", "./capabilities/index.ts"]
    }
  }
}
```

For the full MCP + auth story, see [Building an authenticated MCP server with Routecraft and Clerk](/blog/securing-mcp-with-clerk) and the [WorkOS follow-up](/blog/securing-mcp-with-workos).

## CLI

```bash
# Run a route file
craft run ./my-route.ts

# With debug logging
craft run ./my-route.ts \
  --log-level debug \
  --log-file ./craft.log
```

Common patterns:

```ts
// Scheduled fetch and notify
craft()
  .from(cron('0 9 * * *'))
  .enrich(http({ url: '/api/...' }))
  .to(smtp({ to: 'team@example.com' }))

// Webhook fan-out
craft()
  .from(channel('webhook'))
  .split()
  .enrich(http({ url: ex => `/${ex.body.id}` }))
  .to(smtp({ to: ex => ex.body.email }))
```

## TUI: inspect routes and live events

```bash
# Launch the TUI (reads the telemetry DB)
craft tui

# Or point it at a specific telemetry database
craft tui --db ./app/telemetry.db
```

Requires the telemetry plugin enabled on the context. Once it is, the TUI shows live exchanges, route status, and step-level timings. Useful for debugging "why is this thing slow" without setting up a full observability stack.

## Quick reference

The five things I look up most often:

| Task                | Code                                                  |
| ------------------- | ----------------------------------------------------- |
| Every minute        | `cron('* * * * *')`                                   |
| Daily at 9 AM       | `cron('0 9 * * *', { timezone: 'UTC' })`              |
| Filter              | `.filter(ex => ex.body.age > 18)`                     |
| Split an array      | `.split()`                                            |
| Collect results     | `.aggregate()`                                        |
| Validate body       | `.validate(schema(z.object({ ... })))`                |
| Dynamic URL         | `http({ url: ex => `/users/${ex.body.id}` })`         |
| Set header          | `.header('key', ex => ex.body.id)`                    |
| Side effect (tap)   | `.tap(destination)`                                   |
| Forward errors      | `.error((e, ex, fwd) => fwd('dlq'))`                  |

## What's changed in v0.5.0

The cheat sheet is v0.4.0. Most of it still applies verbatim. A few worthwhile updates:

- **`defineConfig` wrapper.** v0.5.0 adds `defineConfig(...)` from `@routecraft/routecraft` as the recommended way to type your config. Old `ContextBuilder().add({...}).build()` still works.
- **MCP config promoted out of `mcpPlugin`.** The previous `plugins: [mcpPlugin({...})]` shape now lives on a top-level `mcp: { ... }` key in the config. The plugin form is still around for advanced cases.
- **Auth primitives moved into core.** `jwks()` is now exported from `@routecraft/routecraft` directly. The `oauth()` proxy still lives in `@routecraft/ai`.
- **`userinfo` callback.** A new hook on the MCP config that lets you hydrate `principal.email`, `principal.name`, and `principal.roles` from your auth provider's API after the JWT is verified. See the [WorkOS MCP post](/blog/securing-mcp-with-workos) for a worked example.
- **`.authorize({ roles: [...] })`.** Role-based gating at the capability level. Pairs with `userinfo` to do real authorization without bespoke middleware.

I will keep this section updated as v0.5 stabilises. If you spot a stale entry, please open a [GitHub issue](https://github.com/routecraftjs/routecraft/issues).

## Where to go next

- [Build your first MCP server in TypeScript](/blog/your-first-mcp-server-in-typescript) if you have not written a Routecraft capability yet.
- [Securing an MCP server with Clerk](/blog/securing-mcp-with-clerk) once you are ready for HTTP and auth.
- [The full Routecraft docs](/docs/introduction) for the deeper reference.

Scaffold a new project in one line:

```bash
bunx create-routecraft my-app
```

Or play with it in your browser via [GitHub Codespaces](https://codespaces.new/routecraftjs/craft-playground) before installing anything.
