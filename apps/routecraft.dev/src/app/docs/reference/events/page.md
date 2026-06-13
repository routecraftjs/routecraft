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
| `route:source:failed` | A source gave up producing (e.g. a connection-backed source exhausted its reconnect attempts) and the route is about to stop | `{ routeId, route, adapter?, error }` |

`route:source:failed` is the signal to alarm on for a dead channel: unlike `route:stopping`, it never fires for an orderly shutdown. `adapter` is the `adapterId` of the failed source when the adapter declares one (e.g. `routecraft.adapter.mail`).

## Exchange events

Fired per exchange, scoped to the capability that owns it. `routeId` is the capability ID.

| Event | When it fires | Details |
| --- | --- | --- |
| `route:exchange:started` | Exchange enters the pipeline (parent or child) | `{ routeId, exchangeId, correlationId }` |
| `route:exchange:completed` | Exchange finished successfully (or consumed by aggregate) | `{ routeId, exchangeId, correlationId, duration }` |
| `route:exchange:failed` | Exchange encountered an unrecoverable error | `{ routeId, exchangeId, correlationId, duration, error }` |
| `route:exchange:dropped` | Exchange intentionally removed from the pipeline | `{ routeId, exchangeId, correlationId, reason }` |
| `route:exchange:restored` | Exchange restored from cache, skipping steps | `{ routeId, exchangeId, correlationId, source }` |

The `exchangeId` field is the exchange's own ID, not the correlation ID. Use `correlationId` to group related exchanges (e.g. a parent and its split children share the same correlation ID).

**Lifecycle guarantee:** every `exchange:started` is eventually followed by exactly one of `completed`, `failed`, or `dropped`.

## Operation events

Operation events are scoped to a capability and an operation type. They fire for individual steps in the pipeline.

### Step events

Every pipeline step (transform, to, enrich, filter, and so on) emits a
generic step lifecycle. The step label is `operation`; the adapter's short
label, when one is involved, is `adapter`.

| Event | When it fires | Details |
| --- | --- | --- |
| `route:step:started` | Step begins executing | `{ routeId, exchangeId, correlationId, operation, adapter? }` |
| `route:step:completed` | Step finished successfully | `{ routeId, exchangeId, correlationId, operation, adapter?, duration, metadata? }` |
| `route:step:failed` | Step threw | `{ routeId, exchangeId, correlationId, operation, adapter?, duration, error }` |
| `route:step:error` | Step error surfaced on the route error path | `{ routeId, error, operation, route?, exchange? }` |

Recovery by the route error handler is signaled via `route:error:caught` and the `route:error-handler:*` events below, not a step-level event.

The `metadata` field on `step:completed` is populated by the adapter's `getMetadata()` method. For example, an LLM destination reports `{ model, inputTokens, outputTokens }`.

### Batch operations

| Event | When it fires | Details |
| --- | --- | --- |
| `route:batch:started` | Batch accumulation started | `{ routeId, batchId, batchSize }` |
| `route:batch:flushed` | Batch released for processing | `{ routeId, batchId, batchSize, waitTime, reason }` |
| `route:batch:stopped` | Batch accumulation stopped | `{ routeId, batchId }` |

`reason` is `'size'` when the batch hit its size limit, `'time'` when the flush interval elapsed.

### Split and aggregate

Split and aggregate use standard `step:started`/`step:completed` events (not dedicated operation events). Operation-specific data is in the `metadata` field:

- **Split** `step:completed` includes `metadata.childCount`: the number of child exchanges created
- **Aggregate** `step:completed` includes `metadata.inputCount`: the number of exchanges merged

After a split, each child exchange emits its own `exchange:started`. When aggregate consumes children, it emits `exchange:completed` for each child before continuing on the parent exchange.

### Retry wrapper operations

| Event | When it fires | Details |
| --- | --- | --- |
| `route:retry:started` | Guarded execution began | `{ routeId, exchangeId, correlationId, stepLabel, scope: "route" \| "step", maxAttempts }` |
| `route:retry:attempt` | A failed attempt will be re-attempted after `backoffMs` | Same plus `attemptNumber`, `backoffMs` (the actual wait, exponential applied), `lastError?` |
| `route:retry:stopped` | Final success or failure | Same plus `attemptNumber`, `success`, and `error?` (the final raw error when `success` is false) |

`scope` is `"route"` for `.retry()` declared BEFORE `.from()` (the whole pipeline is re-run) and `"step"` for the wrapper attached AFTER `.from()`. `stepLabel` is the wrapped step's label, or `"route"` at route scope. `route:retry:attempt` fires once per re-attempt, so a first-attempt success emits only `started` and `stopped`.

### Delay wrapper operations

| Event | When it fires | Details |
| --- | --- | --- |
| `route:delay:started` | The wait began | `{ routeId, exchangeId, correlationId, stepLabel, scope: "step", delayMs }` |
| `route:delay:stopped` | The wait ended; the wrapped step runs next | Same plus `elapsed`, `cancelled` |

`cancelled: true` means route shutdown cut the wait short; the wrapped step still ran. `.delay()` is step-scope only, so `scope` is always `"step"`.

### Timeout wrapper operations

| Event | When it fires | Details |
| --- | --- | --- |
| `route:timeout:started` | Guarded execution began | `{ routeId, exchangeId, correlationId, stepLabel, scope: "route" \| "step", timeoutMs }` |
| `route:timeout:stopped` | The guarded execution settled within the deadline | Same plus `elapsed` |
| `route:timeout:expired` | The deadline fired first; an `RC5011` throw follows | Same plus `elapsed` |

A failure of the wrapped operation *inside* the deadline does not emit a timeout event; the error propagates unchanged and is observable via `step:failed` / the error path. The abandoned work after an expiry keeps running in the background (promises cannot be cancelled); its eventual result is discarded.

### Throttle wrapper operations

| Event | When it fires | Details |
| --- | --- | --- |
| `route:throttle:delayed` | Delay mode: no token was free, the exchange will pace before admission | `{ routeId, exchangeId, correlationId, stepLabel, scope: "route" \| "step", waitMs, key?, label? }` |
| `route:throttle:passed` | The exchange was admitted through the rate limiter | `{ routeId, exchangeId, correlationId, stepLabel, scope: "route" \| "step", waited, elapsed, key?, label? }` (no `waitMs`; `waited` is true when it had to pace, `elapsed` is total time in the gate) |
| `route:throttle:rejected` | Reject mode: the exchange exceeded the rate and is failed with `RC5013` | `{ routeId, exchangeId, correlationId, stepLabel, scope: "route" \| "step", retryAfterMs, key?, label? }` |

`scope` is `"route"` for `.throttle()` declared BEFORE `.from()` (the whole pipeline is rate-limited) and `"step"` for the wrapper attached AFTER `.from()`. `stepLabel` is the wrapped step's label, or `"route"` at route scope. An exchange admitted from the burst (no wait) emits only `route:throttle:passed` with `waited: false`; a paced exchange emits `route:throttle:delayed` first, then `route:throttle:passed` with `waited: true`. In the default delay mode throttle only ever delays an exchange and never drops one; in `mode: 'reject'` an over-limit exchange instead emits `route:throttle:rejected` and is failed with `RC5013`. `label` is present when `.throttle({ label })` is set, so stacked gates can be told apart.

### Choice operations

| Event | When it fires | Details |
| --- | --- | --- |
| `route:operation:choice:matched` | A `when` or `otherwise` branch matched | `{ routeId, exchangeId, correlationId, branchIndex, branchLabel }` |
| `route:operation:choice:unmatched` | No branch matched and the exchange is dropped | `{ routeId, exchangeId, correlationId }` |

`branchLabel` is `"when"` or `"otherwise"`. `branchIndex` is the zero-based index of the matched branch.

### Error handler operations

| Event | When it fires | Details |
| --- | --- | --- |
| `route:error-handler:invoked` | A `.error()` handler runs (route or step scope) | `{ routeId, exchangeId, correlationId, originalError, failedOperation, scope: "route" \| "step", stepLabel? }` |
| `route:error-handler:recovered` | Handler returned a value; pipeline continues (step scope) or replaces body (route scope) | Same plus `recoveryStrategy` |
| `route:error-handler:failed` | Handler itself threw; rethrows for the next layer (route scope or default error path) | Same |

`scope` is `"route"` for the catch-all set via `.error()` BEFORE `.from()`, and `"step"` for a wrapper attached AFTER `.from()`. `stepLabel` is the label of the wrapped step when `scope === "step"`. Subscribe to the exact names and branch on `scope` in the payload.

### Cache wrapper operations

| Event | When it fires | Details |
| --- | --- | --- |
| `route:cache:hit` | A cached value was reused; the wrapped step (or whole pipeline, at route scope) was skipped | `{ routeId, exchangeId, correlationId, stepLabel, scope: "route" \| "step", key }` |
| `route:cache:miss` | No cached value; the wrapped step ran (or was dropped) | Same plus `dropped?: true` when the wrapped step dropped the exchange |
| `route:cache:stored` | A fresh value was written to the cache | Same plus `ttl?: number` when a per-call TTL was set |
| `route:cache:failed` | Key derivation, a provider read/write, or the wrapped step threw | `{ ..., stepLabel, scope: "route" \| "step", phase: "key" \| "get" \| "inner" \| "set", error, key? }` |

Failure phases:
- `phase: "key"` - key derivation threw (no `key` field, since none was produced). Raised as `RC5029` (not retryable).
- `phase: "get"` - the provider read threw before the wrapped step ran. Non-RoutecraftError provider failures are raised as `RC5028` (retryable).
- `phase: "inner"` - the wrapped step itself threw. The original error is rethrown unchanged so outer wrappers / route-level handlers cascade as usual. This event fires **alongside** the wrapped step's own `step:failed` event for the same exchange; they describe one failure, so do not double-count them.
- `phase: "set"` - the wrapped step succeeded but the provider write threw. The bundled in-memory provider never fails on write, so this only applies to custom providers. Step-scope rethrows as `RC5028` (retryable); **route-scope does NOT fail the exchange** (the result was already computed and returned to the source), it just emits the event for observability.

At route scope, `cache:hit` is accompanied by an `exchange:restored` event with `source: "cache"` (per the exchange lifecycle).

Concurrent exchanges that share one computation (stampede dedupe) currently emit `cache:hit` for the waiters at step scope, which can inflate hit-rate metrics. A distinct dedupe signal is planned and needs a provider-interface change. Route scope does not dedupe concurrent same-key callers at all in this release: each runs the pipeline once.

### Agent operations

Emitted by `agent()` destinations. These are the **coarse decision events**: broadcast to every subscriber, no opt-in needed. For token-level streaming use `AgentOptions.onDelta` instead (a separate per-call channel).

| Event | When it fires | Details |
| --- | --- | --- |
| `route:agent:started` | Agent dispatch began, before the first model call | `{ routeId, exchangeId, correlationId, agentName?, model, toolNames, maxTurns }` |
| `route:agent:tool:invoked` | Agent decided to call a tool (input validated, before guard) | `{ routeId, exchangeId, correlationId, toolCallId, toolName, _snapshot: { input } }` |
| `route:agent:tool:result` | Tool handler returned a value | `{ routeId, exchangeId, correlationId, toolCallId, toolName, _snapshot: { output }, duration }` |
| `route:agent:tool:error` | Tool handler / guard / input validation threw | `{ routeId, exchangeId, correlationId, toolCallId, toolName, errorName, _snapshot: { error }, duration }` |
| `route:agent:block:loaded` | Progressive block loader returned a value to the model | `{ routeId, exchangeId, correlationId, toolCallId, blockName, _snapshot: { output }, duration }` |
| `route:agent:block:error` | Progressive block resolver threw during load | `{ routeId, exchangeId, correlationId, toolCallId, blockName, errorName, _snapshot: { error }, duration }` |
| `route:agent:finished` | Agent dispatch returned a consolidated result | `{ routeId, exchangeId, correlationId, agentName?, model, finishReason, inputTokens?, outputTokens?, totalTokens? }` |
| `route:agent:error` | Provider / transport error during dispatch | `{ routeId, exchangeId, correlationId, agentName?, model, error }` |

`agentName` is present only for by-name agents (`agent("id")`); inline agents are identified by their `routeId`. `model` is the resolved `providerId:modelName`.

Tool input/output (and block-load output) ride in a `_snapshot` envelope. So does the thrown error on `:tool:error` / `:block:error`: error messages routinely echo the rejected input (schema validation, guards), so they are gated the same way. In-process subscribers always receive the envelope, but the SQLite telemetry sink persists it only when `captureSnapshots` is enabled (`telemetry({ sqlite: { captureSnapshots: true } })`), mirroring how exchange bodies are gated. The non-sensitive fields (`toolName`, `toolCallId`, `errorName`, `duration`) are always persisted.

Synthetic block-loader invocations (`_block_load_<blockName>` tools) emit on the `:agent:block:*` channel, not `:agent:tool:*`. Subscribe to the right family for what you care about: `:agent:tool:*` covers user-declared tools only, `:agent:block:*` covers framework-synthesised block loads. This split keeps post-dispatch user-tool assertions (`AgentResult.toolCalls`) clean.

Subscribe to the exact names (`route:agent:tool:invoked`, `route:agent:block:loaded`, `route:agent:finished`, ...) and filter by `details.routeId` (or `forRoute(routeId, handler)`) for cross-cutting telemetry, dashboards, and TUIs.

```ts
ctx.on('route:agent:tool:invoked', ({ details }) => {
  log.info({ tool: details.toolName }, 'Agent called tool');
});

ctx.on('route:agent:finished', ({ details }) => {
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
| `route:step:started` (`operation: "parse"`) | Synthetic parse step begins, before any user step | `{ routeId, exchangeId, correlationId, operation: "parse", adapter: "parse" }` |
| `route:step:completed` (`operation: "parse"`) | Parse succeeded; user steps run next | `{ ..., duration }` |
| `route:step:failed` (`operation: "parse"`) | Parse threw `RC5016` | `{ ..., error }` |

What follows depends on the adapter's `onParseError` mode:

- `'fail'` (default) → `exchange:failed` (or `error:caught` if a route `.error()` handler recovers).
- `'abort'` → `exchange:failed` for the bad item, then the source aborts and `context:error` fires.
- `'drop'` → `exchange:dropped` with `reason: "parse-failed"` (no `step:failed` fires; the parse step catches and drops cleanly).

Subscribe with a glob to count source parse failures across all routes:

```ts
ctx.on('route:step:failed', ({ details }) => {
  if (details.operation === 'parse') metrics.increment('source.parse.failed');
});
ctx.on('route:exchange:dropped', ({ details }) => {
  if (details.reason === 'parse-failed') metrics.increment('source.parse.dropped');
});
```

## Plugin events

Plugin events are scoped to a plugin ID.

| Event | When it fires | Details |
| --- | --- | --- |
| `plugin:starting` | Plugin is about to start | `{ pluginId, pluginIndex }` |
| `plugin:started` | Plugin has started | `{ pluginId, pluginIndex }` |
| `plugin:stopping` | Plugin is about to stop | `{ pluginId, pluginIndex }` |
| `plugin:stopped` | Plugin has stopped | `{ pluginId, pluginIndex }` |

## Authentication events

Emitted by auth-enabled adapters (currently MCP HTTP) on every auth attempt. The `source` field identifies which adapter emitted the event.

| Event | When it fires | Details |
| --- | --- | --- |
| `auth:success` | Token validated and principal resolved | `{ subject, scheme, source }` |
| `auth:rejected` | Auth failed (missing header, bad scheme, or invalid token) | `{ reason, scheme, source }` |

`reason` is one of `"missing_header"`, `"unsupported_scheme"`, or `"invalid_token"`.

## MCP plugin events

Events emitted by the MCP plugin during server and tool lifecycle. Subscribe to the exact names (`plugin:mcp:tool:called` / `completed` / `failed`) for broad observability, or use the catch-all `"*"`.

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

{% quick-link title="Events" icon="theming" href="/docs/introduction/events" description="How to subscribe, filter by payload identity, emit custom events, and common patterns." /%}
{% quick-link title="Configuration" icon="presets" href="/docs/reference/configuration" description="Subscribe to events via craft.config.ts." /%}

{% /quick-links %}
