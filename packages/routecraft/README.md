# @routecraft/routecraft

Type-safe integration and automation framework for TypeScript/Node.js.

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
import { craft, simple, log } from '@routecraft/routecraft';

export default craft()
  .id('my-route')
  .from(simple('Hello, World!'))
  .to(log());
```

## Features

- 🎯 **Type-safe**: Full TypeScript support with intelligent type inference
- 🔌 **Extensible**: Easy-to-write adapters for any integration
- 🚀 **Performant**: Built for high-throughput data processing
- 🛠️ **Developer-friendly**: Intuitive, fluent DSL
- 📦 **Lightweight**: Minimal dependencies
- 📊 **Observable**: Comprehensive event system for monitoring and debugging

## Event System

Routecraft provides a powerful event system for monitoring and debugging your integration routes.

### Event Hierarchy

Events follow a hierarchical naming convention with colon-separated segments:

```
context:started                                    # Context lifecycle
route:registered                                   # Route lifecycle
route:payment:exchange:started                     # Exchange lifecycle
route:payment:operation:from:mcp:started          # Adapter operations
route:payment:operation:process:started           # Processing operations
plugin:myPlugin:lifecycle:started                 # Plugin lifecycle
```

### Wildcard Subscriptions

Subscribe to multiple events using wildcards (`*`):

```typescript
import { craft, testContext } from '@routecraft/routecraft';

const ctx = await testContext()
  // Monitor all exchanges across all routes
  .on('route:*:exchange:*', ({ details }) => {
    console.log(`Exchange ${details.exchangeId} on route ${details.routeId}`);
  })

  // Monitor all MCP adapter calls
  .on('route:*:operation:from:mcp:*', ({ details }) => {
    console.log('MCP tool:', details.metadata.toolName);
  })

  // Monitor specific route
  .on('route:payment:*', ({ details }) => {
    console.log('Payment route event:', details);
  })

  // Monitor all events
  .on('*', (event) => {
    console.log('Event:', event);
  })
  .build();
```

### Operation Events (Wave 3)

Operation events provide granular tracking of adapter and processing operations:

**Adapter operations** (track specific adapter calls):
```typescript
// Track LLM costs
ctx.on('route:*:operation:to:llm:stopped', ({ details }) => {
  const { inputTokens, outputTokens, model } = details.metadata;
  console.log(`LLM ${model}: ${inputTokens + outputTokens} tokens`);
});

// Monitor HTTP calls
ctx.on('route:*:operation:to:http:stopped', ({ details }) => {
  console.log('HTTP:', details.metadata.statusCode, details.metadata.url);
});

// Track MCP tool usage
ctx.on('route:*:operation:from:mcp:*', ({ details }) => {
  console.log('MCP:', details.metadata.toolName, details.metadata.userId);
});
```

**Processing operations** (track pipeline steps):
```typescript
// Monitor all processing steps
ctx.on('route:*:operation:process:*', ({ details }) => {
  console.log('Processing operation:', details.operation);
});

// Track transformations
ctx.on('route:*:operation:transform:stopped', ({ details }) => {
  console.log('Transform completed in', details.duration, 'ms');
});
```

### Adapter Metadata Guidelines

Adapters can populate `metadata` fields for observability:

**✅ Include:**
- IDs, names, counts, codes, flags (small values)
- Values useful for filtering, metrics, cost calculation

**❌ Exclude:**
- Large bodies or full request/response data
- Sensitive data (unless explicitly configured)

**Examples by adapter type:**
- **LLM**: model, provider, inputTokens, outputTokens, temperature
- **HTTP**: method, url, statusCode, contentLength
- **MCP**: toolName, transport, userId, serverId
- **Kafka**: topic, partition, offset, messageSize

### Special Operations

Track batch, split, aggregate, retry, and error handling operations:

```typescript
// Track batch behavior
ctx.on('route:*:operation:batch:flushed', ({ details }) => {
  console.log('Batch flushed:', details.batchSize, 'exchanges');
});

// Monitor retry attempts
ctx.on('route:*:operation:retry:attempt', ({ details }) => {
  console.log('Retry', details.attemptNumber, 'of', details.maxAttempts);
});

// Track error recovery
ctx.on('route:*:operation:error:recovered', ({ details }) => {
  console.log('Recovered from error using', details.recoveryStrategy);
});
```

### Plugin Lifecycle Events

Plugins automatically emit lifecycle events:

```typescript
ctx.on('plugin:*:lifecycle:started', ({ details }) => {
  console.log('Plugin started:', details.pluginId);
});
```

Plugins can also emit custom events:

```typescript
// In your plugin
ctx.emit('plugin:myPlugin:metrics:collected', {
  pluginId: 'myPlugin',
  metrics: { /* ... */ }
});

// Subscribe to custom plugin events
ctx.on('plugin:myPlugin:metrics:collected', ({ details }) => {
  console.log('Metrics:', details.metrics);
});
```

### Event Source Adapter

Use the event adapter to create routes triggered by events:

```typescript
import { craft, event, log } from '@routecraft/routecraft';

// Route triggered by LLM events
craft()
  .from(event('route:*:operation:to:llm:stopped'))
  .process((ex) => {
    const { model, inputTokens, outputTokens } = ex.body.details.metadata;
    return {
      model,
      totalTokens: inputTokens + outputTokens,
      cost: calculateCost(model, inputTokens, outputTokens)
    };
  })
  .to(log());
```

### Complete Event Hierarchy

```
context:starting                                   # Context lifecycle
context:started
context:stopping
context:stopped

route:registered                                   # Route lifecycle
route:starting
route:started
route:stopping
route:stopped

route:<routeId>:exchange:started                  # Exchange lifecycle
route:<routeId>:exchange:completed
route:<routeId>:exchange:failed

route:<routeId>:operation:from:<adapterId>:started    # Adapter operations
route:<routeId>:operation:from:<adapterId>:stopped
route:<routeId>:operation:to:<adapterId>:started
route:<routeId>:operation:to:<adapterId>:stopped

route:<routeId>:operation:<processingType>:started    # Processing operations
route:<routeId>:operation:<processingType>:stopped

route:<routeId>:operation:batch:started               # Batch operations
route:<routeId>:operation:batch:flushed
route:<routeId>:operation:batch:stopped

route:<routeId>:operation:split:started               # Split/Aggregate
route:<routeId>:operation:split:stopped
route:<routeId>:operation:aggregate:started
route:<routeId>:operation:aggregate:stopped

route:<routeId>:operation:retry:started               # Retry operations
route:<routeId>:operation:retry:attempt
route:<routeId>:operation:retry:stopped

route:<routeId>:operation:error:invoked               # Error handling
route:<routeId>:operation:error:recovered
route:<routeId>:operation:error:failed

plugin:<pluginId>:lifecycle:registered                # Plugin lifecycle
plugin:<pluginId>:lifecycle:starting
plugin:<pluginId>:lifecycle:started
plugin:<pluginId>:lifecycle:stopping
plugin:<pluginId>:lifecycle:stopped

error                                                  # System errors
```

## Logging

Logs go to **stdout** by default at **warn** level. No file is used unless you set one.

- **Environment:** `LOG_FILE` or `CRAFT_LOG_FILE` to write logs to a file. `LOG_LEVEL` or `CRAFT_LOG_LEVEL` for the level (e.g. `info`, `warn`, `error`, or `silent` to disable).
- **CLI:** `craft run <file> --log-file <path>` and `--log-level <level>` (set before your app loads).
- **Config and precedence:** `craftConfig.log` can set default `level`, `file`, and `redact`. For **CLI runs**, CLI flags override craft config. For **programmatic context**, craft config overrides env. Env (LOG_LEVEL, LOG_FILE, LOG_REDACT / CRAFT_LOG_*) is the fallback when a key is not set in config.

## Documentation

For comprehensive documentation, examples, and guides, visit [routecraft.dev](https://routecraft.dev).

## Example

```typescript
import { craft, timer, log } from '@routecraft/routecraft';

export default craft()
  .id('timer-example')
  .from(timer({ intervalMs: 1000 }))
  .transform((ex) => ({ timestamp: Date.now() }))
  .to(log());
```

## Contributing

Contributions are welcome! Please see our [Contributing Guide](https://github.com/routecraftjs/routecraft/blob/main/CONTRIBUTING.md).

## License

Apache-2.0

## Links

- [Documentation](https://routecraft.dev)
- [GitHub Repository](https://github.com/routecraftjs/routecraft)
- [Issue Tracker](https://github.com/routecraftjs/routecraft/issues)

