# @routecraft/routecraft

Tools for agents. Or the agent harness itself.

Routecraft is a TypeScript-first framework for building automation capabilities that agents can invoke. Write deterministic pipelines for Software 1.0. Hand them to an AI agent as tools for Software 3.0. Both, from the same code.

## Installation

```bash
# Bun (recommended)
bun add @routecraft/routecraft

# npm / pnpm / yarn
npm install @routecraft/routecraft
pnpm add @routecraft/routecraft
yarn add @routecraft/routecraft
```

## Quick Start

```typescript
// capabilities/timer-ping.ts
import { craft, timer, log } from '@routecraft/routecraft';

export default craft()
  .id('timer-ping')
  .from(timer({ intervalMs: 1000 }))
  .transform((ex) => ({ timestamp: Date.now() }))
  .to(log());
```

Run it directly with the `craft` CLI (requires Bun on the host):

```bash
bunx @routecraft/cli run capabilities/timer-ping.ts
```

For Node-based projects, embed the library programmatically instead of using the CLI -- see [Programmatic Invocation](https://routecraft.dev/docs/advanced/programmatic-invocation).

## Core Concepts

### Capabilities

A capability is a named, typed pipeline that defines exactly what an agent or system can trigger. You compose capabilities using a chainable DSL:

```typescript
import { craft, timer, http } from '@routecraft/routecraft';

craft()
  .id('sync-users')
  .from(timer({ intervalMs: 60_000 }))
  .transform((ex) => ({ ...ex.body, syncedAt: Date.now() }))
  .to(http({ url: 'https://api.example.com/sync' }));
```

### The Exchange

Every message flowing through a capability is an `Exchange` -- a typed envelope with `body`, `headers`, and metadata:

```json
{
  "body": { "userId": "u_123", "action": "sync" },
  "headers": { "source": "timer", "routeId": "sync-users" },
  "exchangeId": "ex_abc"
}
```

### Operations

Operations transform or gate the data flowing through a capability:

| Operation | Purpose |
|-----------|---------|
| `.transform(fn)` | Reshape the exchange body |
| `.process(fn)` | Full exchange access for side effects |
| `.validate(schema)` | Enforce a Zod schema; drop invalid exchanges |
| `.filter(fn)` | Conditionally stop an exchange |
| `.enrich(adapter)` | Augment the body with data from an external source |
| `.to(adapter)` | Send to a destination |

### Context

Group capabilities into a context for lifecycle management:

```typescript
import { ContextBuilder } from '@routecraft/routecraft';

const ctx = new ContextBuilder()
  .routes([sendEmail, syncUsers, processWebhook])
  .build();

await ctx.start();
```

## Features

- Type-safe by default: the entire DSL uses TypeScript generics for end-to-end inference
- AI-authorable: the predictable, chainable DSL is easy for code generators like Claude or Cursor to write
- Run on a schedule or hand to an agent as a tool -- the same capability file works for both
- Secure by design: agents can only invoke the capabilities you expose; no arbitrary filesystem access or shell commands
- Minimal dependencies

## Event System

Routecraft emits structured events throughout a capability's lifecycle, useful for observability, cost tracking, and debugging.

### Event Naming

Event names are a fixed, colon-separated set; identity (route id, plugin
id) lives in the payload, never in the name:

```text
context:started
route:registered
route:exchange:started        (details.routeId)
route:step:completed          (details.routeId, details.operation)
plugin:started                (details.pluginId)
```

### Subscribing

`ctx.on()` / `ctx.once()` subscriptions use exact names plus payload
filtering. The `forRoute()` helper scopes a handler to one route; the
only pattern is the catch-all `"*"`, which observes every event. (The
`event()` source adapter additionally supports `*` / `**` patterns in
its filter.)

```typescript
import { ContextBuilder, forRoute } from '@routecraft/routecraft';

const ctx = new ContextBuilder()
  .routes([...])
  .on('route:exchange:completed', ({ details }) => {
    console.log('Exchange completed on', details.routeId);
  })
  .on('route:step:completed', forRoute('orders', ({ details }) => {
    console.log(`orders step ${details.operation} took ${details.duration}ms`);
  }))
  .build();
```

### Full Event Reference

```text
context:starting / started / stopping / stopped / error
route:registered / starting / started / stopping / stopped
route:error / route:error:caught
route:exchange:started / completed / failed / dropped / restored
route:step:started / completed / failed / error
route:batch:started / flushed / stopped
route:error-handler:invoked / recovered / failed
route:cache:hit / miss / stored / failed
plugin:starting / started / stopping / stopped
```

See the [events reference](https://routecraft.dev/docs/reference/events)
for every name and payload shape.

### Adapter Metadata

Adapters populate `details.metadata` for filtering and metrics. Include small values (IDs, counts, codes) and exclude large bodies or sensitive data.

Examples by adapter type:
- **LLM**: model, provider, inputTokens, outputTokens, temperature
- **HTTP**: method, url, statusCode, contentLength
- **MCP**: toolName, transport, userId, serverId
- **Kafka**: topic, partition, offset, messageSize

### Event Source Adapter

Trigger a capability from internal events:

```typescript
import { craft, event, log } from '@routecraft/routecraft';

craft()
  .from(event('route:*:exchange:completed'))
  .process((ex) => {
    console.log('Route completed:', ex.body.details.routeId);
    return ex;
  })
  .to(log());
```

Note: the event adapter filters out `:operation:` and `:exchange:` events internally to prevent infinite loops.

## Logging

Logs go to stdout at `warn` level by default.

- **Env vars**: `LOG_LEVEL` / `CRAFT_LOG_LEVEL`, `LOG_FILE` / `CRAFT_LOG_FILE`
- **CLI flags**: `craft --log-level info --log-file craft.log run <file>`
- **Config**: `craftConfig.log` sets defaults; CLI flags override config for CLI runs

## Documentation

For full guides, adapter reference, and examples, visit [routecraft.dev](https://routecraft.dev).

## Contributing

Contributions are welcome. See the [Contributing Guide](https://github.com/routecraftjs/routecraft/blob/main/CONTRIBUTING.md).

## License

Apache-2.0

## Links

- [Documentation](https://routecraft.dev)
- [GitHub Repository](https://github.com/routecraftjs/routecraft)
- [Issue Tracker](https://github.com/routecraftjs/routecraft/issues)
