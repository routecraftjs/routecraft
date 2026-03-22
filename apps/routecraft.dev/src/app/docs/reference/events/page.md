---
title: Events
---

Full catalog of lifecycle and runtime events emitted by the Routecraft context. {% .lead %}

## Event payload

All events share the same envelope:

```ts
{
  ts: string       // ISO timestamp
  context: CraftContext
  details: {...}   // event-specific fields (see tables below)
}
```

## Context events

| Event | When it fires | Details |
| --- | --- | --- |
| `context:starting` | Before the context starts | `{}` |
| `context:started` | After all capabilities have started | `{}` |
| `context:stopping` | Before shutdown begins | `{ reason? }` |
| `context:stopped` | After all capabilities have stopped | `{}` |

## Route events

"Route" here refers to a registered capability internally.

| Event | When it fires | Details |
| --- | --- | --- |
| `route:registered` | Capability registered with the context | `{ route }` |
| `route:starting` | Just before a capability starts | `{ route }` |
| `route:started` | Capability is running | `{ route }` |
| `route:stopping` | Capability is stopping | `{ route, reason?, exchange? }` |
| `route:stopped` | Capability has stopped | `{ route, exchange? }` |

## Exchange events

Fired per exchange, scoped to the capability that owns it. `routeId` is the capability ID.

| Event | When it fires | Details |
| --- | --- | --- |
| `route:{routeId}:exchange:started` | Exchange enters the pipeline (parent or child) | `{ routeId, exchangeId, correlationId }` |
| `route:{routeId}:exchange:completed` | Exchange finished successfully (or consumed by aggregate) | `{ routeId, exchangeId, correlationId, duration }` |
| `route:{routeId}:exchange:failed` | Exchange encountered an unrecoverable error | `{ routeId, exchangeId, correlationId, duration, error }` |
| `route:{routeId}:exchange:dropped` | Exchange intentionally removed from the pipeline | `{ routeId, exchangeId, correlationId, reason }` |
| `route:{routeId}:exchange:restored` | Exchange restored from cache, skipping steps | `{ routeId, exchangeId, correlationId, source }` |

The `exchangeId` field is the exchange's own ID, not the correlation ID. Use `correlationId` to group related exchanges (e.g. a parent and its split children share the same correlation ID).

**Lifecycle guarantee:** every `exchange:started` is eventually followed by exactly one of `completed`, `failed`, or `dropped`.

## Operation events

Operation events are scoped to a capability and an operation type. They fire for individual steps in the pipeline.

### Adapter operations

| Event | When it fires | Details |
| --- | --- | --- |
| `route:{routeId}:operation:from:{adapterId}:started` | Source adapter activated | `{ routeId, exchangeId, correlationId, operation, adapterId, metadata? }` |
| `route:{routeId}:operation:from:{adapterId}:stopped` | Source adapter completed | `{ routeId, exchangeId, correlationId, operation, adapterId, duration, metadata? }` |
| `route:{routeId}:operation:to:{adapterId}:started` | Destination adapter invoked | `{ routeId, exchangeId, correlationId, operation, adapterId, metadata? }` |
| `route:{routeId}:operation:to:{adapterId}:stopped` | Destination adapter completed | `{ routeId, exchangeId, correlationId, operation, adapterId, duration, metadata? }` |

The `metadata` field is populated by the adapter's `getMetadata()` method. For example, the HTTP adapter returns `{ method, url, statusCode, contentLength }`.

### Batch operations

| Event | When it fires | Details |
| --- | --- | --- |
| `route:{routeId}:operation:batch:started` | Batch accumulation started | `{ routeId, batchId, batchSize }` |
| `route:{routeId}:operation:batch:flushed` | Batch released for processing | `{ routeId, batchId, batchSize, waitTime, reason }` |
| `route:{routeId}:operation:batch:stopped` | Batch accumulation stopped | `{ routeId, batchId }` |

`reason` is `'size'` when the batch hit its size limit, `'time'` when the flush interval elapsed.

### Split and aggregate

Split and aggregate use standard `step:started`/`step:completed` events (not dedicated operation events). Operation-specific data is in the `metadata` field:

- **Split** `step:completed` includes `metadata.childCount`: the number of child exchanges created
- **Aggregate** `step:completed` includes `metadata.inputCount`: the number of exchanges merged

After a split, each child exchange emits its own `exchange:started`. When aggregate consumes children, it emits `exchange:completed` for each child before continuing on the parent exchange.

### Retry operations

| Event | When it fires | Details |
| --- | --- | --- |
| `route:{routeId}:operation:retry:started` | Retry sequence started | `{ routeId, exchangeId, correlationId, maxAttempts }` |
| `route:{routeId}:operation:retry:attempt` | One retry attempt made | `{ routeId, exchangeId, correlationId, attemptNumber, maxAttempts, backoffMs, lastError? }` |
| `route:{routeId}:operation:retry:stopped` | Retry sequence ended | `{ routeId, exchangeId, correlationId, attemptNumber, success }` |

### Error handler operations

| Event | When it fires | Details |
| --- | --- | --- |
| `route:{routeId}:operation:error:invoked` | `.onError()` handler called | `{ routeId, exchangeId, correlationId }` |
| `route:{routeId}:operation:error:recovered` | Handler succeeded | `{ routeId, exchangeId, correlationId }` |
| `route:{routeId}:operation:error:failed` | Handler also failed | `{ routeId, exchangeId, correlationId, error }` |

## Plugin events

Plugin events are scoped to a plugin ID.

| Event | When it fires | Details |
| --- | --- | --- |
| `plugin:{pluginId}:registered` | Plugin registered | `{ pluginId, pluginIndex }` |
| `plugin:{pluginId}:starting` | Plugin is about to start | `{ pluginId, pluginIndex }` |
| `plugin:{pluginId}:started` | Plugin has started | `{ pluginId, pluginIndex }` |
| `plugin:{pluginId}:stopping` | Plugin is about to stop | `{ pluginId, pluginIndex }` |
| `plugin:{pluginId}:stopped` | Plugin has stopped | `{ pluginId, pluginIndex }` |

## Authentication events

Emitted by auth-enabled adapters (currently MCP HTTP) on every auth attempt. The `source` field identifies which adapter emitted the event.

| Event | When it fires | Details |
| --- | --- | --- |
| `auth:success` | Token validated and principal resolved | `{ subject, scheme, source }` |
| `auth:rejected` | Auth failed (missing header, bad scheme, or invalid token) | `{ reason, scheme, source }` |

`reason` is one of `"missing_header"`, `"unsupported_scheme"`, or `"invalid_token"`.

## MCP plugin events

Events emitted by the MCP plugin during server and tool lifecycle. Subscribe with wildcards (e.g. `plugin:mcp:tool:**`) for broad observability.

### Server events

| Event | When it fires | Details |
| --- | --- | --- |
| `plugin:mcp:server:listening` | HTTP server is ready to accept connections | `{ host, port, path }` |
| `plugin:mcp:server:tools:exposed` | Tool list logged for the first time | `{ tools, count }` |

### Session events

| Event | When it fires | Details |
| --- | --- | --- |
| `plugin:mcp:session:created` | New HTTP client session initialized | `{ sessionId }` |
| `plugin:mcp:session:closed` | HTTP client session transport closed | `{ sessionId }` |

### Tool call events

| Event | When it fires | Details |
| --- | --- | --- |
| `plugin:mcp:tool:called` | Tool invocation started | `{ tool, args }` |
| `plugin:mcp:tool:completed` | Tool invocation succeeded | `{ tool }` |
| `plugin:mcp:tool:failed` | Tool invocation failed | `{ tool, error }` |

---

## Related

{% quick-links %}

{% quick-link title="Events" icon="theming" href="/docs/introduction/events" description="How to subscribe, use wildcards, emit custom events, and common patterns." /%}
{% quick-link title="Configuration" icon="presets" href="/docs/reference/configuration" description="Subscribe to events via craft.config.ts." /%}

{% /quick-links %}
