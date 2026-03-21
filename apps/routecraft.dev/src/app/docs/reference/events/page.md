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
| `route:{routeId}:exchange:started` | Exchange enters the pipeline | `{ routeId, exchangeId, correlationId }` |
| `route:{routeId}:exchange:completed` | Exchange finished successfully | `{ routeId, exchangeId, correlationId, duration }` |
| `route:{routeId}:exchange:failed` | Exchange failed | `{ routeId, exchangeId, correlationId, duration, error }` |

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

### Split and aggregate operations

| Event | When it fires | Details |
| --- | --- | --- |
| `route:{routeId}:operation:split:started` | Exchange being split into items | `{ routeId, exchangeId, correlationId }` |
| `route:{routeId}:operation:split:stopped` | Split completed | `{ routeId, exchangeId, correlationId }` |
| `route:{routeId}:operation:aggregate:started` | Aggregation started | `{ routeId, exchangeId, correlationId }` |
| `route:{routeId}:operation:aggregate:stopped` | Aggregation completed | `{ routeId, exchangeId, correlationId }` |

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

Scoped per tool name. Use `plugin:mcp:tool:**` to capture all tool events.

| Event | When it fires | Details |
| --- | --- | --- |
| `plugin:mcp:tool:{toolName}:called` | Tool invocation started | `{ tool, args }` |
| `plugin:mcp:tool:{toolName}:completed` | Tool invocation succeeded | `{ tool }` |
| `plugin:mcp:tool:{toolName}:failed` | Tool invocation failed | `{ tool, error }` |

## System events

| Event | When it fires | Details |
| --- | --- | --- |
| `error` | Any unhandled error in a capability or the context | `{ error, route?, exchange? }` |

---

## Related

{% quick-links %}

{% quick-link title="Events" icon="theming" href="/docs/introduction/events" description="How to subscribe, use wildcards, emit custom events, and common patterns." /%}
{% quick-link title="Configuration" icon="presets" href="/docs/reference/configuration" description="Subscribe to events via craft.config.ts." /%}

{% /quick-links %}
