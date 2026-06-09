---
title: Events
---

Full catalog of lifecycle and runtime events emitted by the Routecraft context. {% .lead %}

{% event-namespaces /%}

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

### Choice operations

| Event | When it fires | Details |
| --- | --- | --- |
| `route:{routeId}:operation:choice:matched` | A `when` or `otherwise` branch matched | `{ routeId, exchangeId, correlationId, branchIndex, branchLabel }` |
| `route:{routeId}:operation:choice:unmatched` | No branch matched and the exchange is dropped | `{ routeId, exchangeId, correlationId }` |

`branchLabel` is `"when"` or `"otherwise"`. `branchIndex` is the zero-based index of the matched branch.

### Error handler operations

| Event | When it fires | Details |
| --- | --- | --- |
| `route:{routeId}:error-handler:invoked` | A `.error()` handler runs (route or step scope) | `{ routeId, exchangeId, correlationId, originalError, failedOperation, scope: "route" \| "step", stepLabel? }` |
| `route:{routeId}:error-handler:recovered` | Handler returned a value; pipeline continues (step scope) or replaces body (route scope) | Same plus `recoveryStrategy` |
| `route:{routeId}:error-handler:failed` | Handler itself threw; rethrows for the next layer (route scope or default error path) | Same |

`scope` is `"route"` for the catch-all set via `.error()` BEFORE `.from()`, and `"step"` for a wrapper attached AFTER `.from()`. `stepLabel` is the label of the wrapped step when `scope === "step"`. Wildcard subscribers (`route:*:error-handler:*`) keep matching.

### Cache wrapper operations

| Event | When it fires | Details |
| --- | --- | --- |
| `route:{routeId}:cache:hit` | A cached value was reused; the wrapped step (or whole pipeline, at route scope) was skipped | `{ routeId, exchangeId, correlationId, stepLabel, scope: "route" \| "step", key }` |
| `route:{routeId}:cache:miss` | No cached value; the wrapped step ran (or was dropped) | Same plus `dropped?: true` when the wrapped step dropped the exchange |
| `route:{routeId}:cache:stored` | A fresh value was written to the cache | Same plus `ttl?: number` when a per-call TTL was set |
| `route:{routeId}:cache:failed` | Key derivation, a provider read/write, or the wrapped step threw | `{ ..., stepLabel, scope: "route" \| "step", phase: "key" \| "get" \| "inner" \| "set", error, key? }` |

Failure phases:
- `phase: "key"` - key derivation threw (no `key` field, since none was produced). Raised as `RC5029` (not retryable).
- `phase: "get"` - the provider read threw before the wrapped step ran. Non-RoutecraftError provider failures are raised as `RC5028` (retryable).
- `phase: "inner"` - the wrapped step itself threw. The original error is rethrown unchanged so outer wrappers / route-level handlers cascade as usual. This event fires **alongside** the wrapped step's own `step:failed` event for the same exchange; they describe one failure, so do not double-count them.
- `phase: "set"` - the wrapped step succeeded but the provider write threw. The bundled in-memory provider never fails on write, so this only applies to custom providers. Step-scope rethrows as `RC5028` (retryable); **route-scope does NOT fail the exchange** (the result was already computed and returned to the source), it just emits the event for observability.

At route scope, `cache:hit` is accompanied by an `exchange:restored` event with `source: "cache"` (per the exchange lifecycle).

Concurrent exchanges that share one computation (stampede dedupe) currently emit `cache:hit` for the waiters at step scope, which can inflate hit-rate metrics. A distinct dedupe signal is planned and needs a provider-interface change. Route scope does not dedupe concurrent same-key callers at all in this release: each runs the pipeline once.

### Reserved operation-error events

| Event | When it fires | Details |
| --- | --- | --- |
| `route:{routeId}:operation:error:invoked` | Reserved for the planned `.onError()` operation | `{ routeId, exchangeId, correlationId }` |
| `route:{routeId}:operation:error:recovered` | Reserved for the planned `.onError()` operation | `{ routeId, exchangeId, correlationId }` |
| `route:{routeId}:operation:error:failed` | Reserved for the planned `.onError()` operation | `{ routeId, exchangeId, correlationId, error }` |

### Agent operations

Emitted by `agent()` destinations. These are the **coarse decision events**: broadcast to every subscriber, no opt-in needed. For token-level streaming use `AgentOptions.onDelta` instead (a separate per-call channel).

| Event | When it fires | Details |
| --- | --- | --- |
| `route:{routeId}:agent:started` | Agent dispatch began, before the first model call | `{ routeId, exchangeId, correlationId, agentName?, model, toolNames, maxTurns }` |
| `route:{routeId}:agent:tool:invoked` | Agent decided to call a tool (input validated, before guard) | `{ routeId, exchangeId, correlationId, toolCallId, toolName, _snapshot: { input } }` |
| `route:{routeId}:agent:tool:result` | Tool handler returned a value | `{ routeId, exchangeId, correlationId, toolCallId, toolName, _snapshot: { output }, duration }` |
| `route:{routeId}:agent:tool:error` | Tool handler / guard / input validation threw | `{ routeId, exchangeId, correlationId, toolCallId, toolName, error, duration }` |
| `route:{routeId}:agent:block:loaded` | Progressive block loader returned a value to the model | `{ routeId, exchangeId, correlationId, toolCallId, blockName, _snapshot: { output }, duration }` |
| `route:{routeId}:agent:block:error` | Progressive block resolver threw during load | `{ routeId, exchangeId, correlationId, toolCallId, blockName, error, duration }` |
| `route:{routeId}:agent:finished` | Agent dispatch returned a consolidated result | `{ routeId, exchangeId, correlationId, agentName?, model, finishReason, inputTokens?, outputTokens?, totalTokens? }` |
| `route:{routeId}:agent:error` | Provider / transport error during dispatch | `{ routeId, exchangeId, correlationId, agentName?, model, error }` |

`agentName` is present only for by-name agents (`agent("id")`); inline agents are identified by their `routeId`. `model` is the resolved `providerId:modelName`.

Tool input/output (and block-load output) ride in a `_snapshot` envelope. In-process subscribers always receive it, but the SQLite telemetry sink persists it only when `captureSnapshots` is enabled (`telemetry({ sqlite: { captureSnapshots: true } })`), mirroring how exchange bodies are gated. The non-sensitive fields (`toolName`, `toolCallId`, `duration`) are always persisted.

Synthetic block-loader invocations (`_block_load_<blockName>` tools) emit on the `:agent:block:*` channel, not `:agent:tool:*`. Subscribe to the right family for what you care about: `:agent:tool:*` covers user-declared tools only, `:agent:block:*` covers framework-synthesised block loads. This split keeps post-dispatch user-tool assertions (`AgentResult.toolCalls`) clean.

Wildcard subscriptions (`route:*:agent:tool:*`, `route:*:agent:block:*`, `route:*:agent:finished`) work for cross-cutting telemetry, dashboards, and TUIs.

```ts
ctx.on('route:*:agent:tool:invoked', ({ details }) => {
  log.info({ tool: details.toolName }, 'Agent called tool');
});

ctx.on('route:*:agent:finished', ({ details }) => {
  metrics.histogram('agent.tokens.total', details.totalTokens ?? 0);
});
```

When the context starts, `agentPlugin` announces the agents and fns it registered so dashboards and the TUI can list them before they run:

| Event | When it fires | Details |
| --- | --- | --- |
| `agent:registered` | On `context:started`, once per registered agent | `{ agentId, description, model?, source: 'registered' }` |
| `agent:tool:registered` | On `context:started`, once per registered fn | `{ toolName, description?, tags?, source: 'registered' }` |

### Source-parse operations

Parsing source adapters (`json`, `html`, `csv`, `jsonl`, `mail`) defer parsing
to a synthetic first pipeline step so parse failures become normal pipeline
events. The synthetic step appears in the standard `step:*` events with
`operation: "parse"`.

| Event | When it fires | Details |
| --- | --- | --- |
| `route:{routeId}:step:started` (`operation: "parse"`) | Synthetic parse step begins, before any user step | `{ routeId, exchangeId, correlationId, operation: "parse", adapter: "parse" }` |
| `route:{routeId}:step:completed` (`operation: "parse"`) | Parse succeeded; user steps run next | `{ ..., duration }` |
| `route:{routeId}:step:failed` (`operation: "parse"`) | Parse threw `RC5016` | `{ ..., error }` |

What follows depends on the adapter's `onParseError` mode:

- `'fail'` (default) → `exchange:failed` (or `error:caught` if a route `.error()` handler recovers).
- `'abort'` → `exchange:failed` for the bad item, then the source aborts and `context:error` fires.
- `'drop'` → `exchange:dropped` with `reason: "parse-failed"` (no `step:failed` fires; the parse step catches and drops cleanly).

Subscribe with a glob to count source parse failures across all routes:

```ts
ctx.on('route:*:step:failed', ({ details }) => {
  if (details.operation === 'parse') metrics.increment('source.parse.failed');
});
ctx.on('route:*:exchange:dropped', ({ details }) => {
  if (details.reason === 'parse-failed') metrics.increment('source.parse.dropped');
});
```

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

## HTTP plugin events

Events emitted by the HTTP plugin (configured via `defineConfig({ http })`). The plugin also emits the framework's [authentication events](#authentication-events) (`auth:success` / `auth:rejected`) with `source: "http"` when an `auth` strategy is configured.

| Event | When it fires | Details |
| --- | --- | --- |
| `plugin:http:server:listening` | The HTTP server has bound its port | `{ port, host }` |
| `plugin:http:server:closed` | The HTTP server has shut down (on context stop) | `{}` |
| `plugin:http:request:completed` | A request finished (after the response is built) | `{ method, path, status, durationMs, routeId?, principal? }` |

`plugin:http:request:completed` fires for every request by default; disable it with `http: { events: { perRequest: false } }`. Built-in endpoints (`/health`, `/ready`, `/openapi.json`) do not emit it.

---

## Related

{% quick-links %}

{% quick-link title="Events" icon="theming" href="/docs/introduction/events" description="How to subscribe, use wildcards, emit custom events, and common patterns." /%}
{% quick-link title="Configuration" icon="presets" href="/docs/reference/configuration" description="Subscribe to events via craft.config.ts." /%}

{% /quick-links %}
