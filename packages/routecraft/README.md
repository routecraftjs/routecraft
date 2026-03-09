# @routecraft/routecraft

Give AI access to your automation, not control over your system.

RouteCraft is a TypeScript-first framework for building automation capabilities that agents can invoke. Write deterministic pipelines for Software 1.0. Hand them to an AI agent as tools for Software 3.0. Both, from the same code.

## Installation

```bash
npm install @routecraft/routecraft
```

or

```bash
pnpm add @routecraft/routecraft
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

Run it directly:

```bash
npx @routecraft/cli run capabilities/timer-ping.ts
```

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
import { context } from '@routecraft/routecraft';

const ctx = context()
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

RouteCraft emits structured events throughout a capability's lifecycle, useful for observability, cost tracking, and debugging.

### Event Naming

Events follow a hierarchical, colon-separated pattern:

```text
context:started
route:registered
route:<routeId>:exchange:started
route:<routeId>:operation:to:<adapterId>:stopped
plugin:<pluginId>:started
```

### Subscribing

```typescript
import { context } from '@routecraft/routecraft';

const ctx = context()
  .routes([...])
  .on('route:*:exchange:completed', ({ details }) => {
    console.log('Exchange completed on', details.routeId);
  })
  .on('route:*:operation:to:llm:stopped', ({ details }) => {
    const { inputTokens, outputTokens, model } = details.metadata;
    console.log(`LLM cost: ${model}, ${inputTokens + outputTokens} tokens`);
  })
  .build();
```

Use `*` as a wildcard at any segment. Subscribe to `*` to capture every event.

### Full Event Reference

```text
context:starting / started / stopping / stopped
route:registered / starting / started / stopping / stopped
route:<id>:exchange:started / completed / failed
route:<id>:operation:from:<adapterId>:started / stopped
route:<id>:operation:to:<adapterId>:started / stopped
route:<id>:operation:<processingType>:started / stopped
route:<id>:operation:batch:started / flushed / stopped
route:<id>:operation:split:started / stopped
route:<id>:operation:aggregate:started / stopped
route:<id>:operation:retry:started / attempt / stopped
route:<id>:operation:error:invoked / recovered / failed
plugin:<pluginId>:registered / starting / started / stopping / stopped
error
```

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
- **CLI flags**: `craft run <file> --log-level info --log-file craft.log`
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
