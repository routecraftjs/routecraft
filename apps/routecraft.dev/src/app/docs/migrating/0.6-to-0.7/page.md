---
title: Migrating from 0.6.x to 0.7.0
---

What changed between Routecraft 0.6.0 and 0.7.0, and how to update. {% .lead %}

0.7.0 is the pre-v1 architecture release: the contracts that freeze at v1 changed shape once, now, so they do not have to change after. In exchange every route runs ~25% faster (steps wrapped with `.error()` ~45% faster) and event throughput doubles.

Four consumer-visible changes:

1. **Event names are a fixed set; identity moved into the payload.** `route:<id>:exchange:failed` becomes `route:exchange:failed` with `routeId` in `details`. Wildcard subscriptions are replaced by exact names, the `"*"` catch-all, and the `forRoute()` filter helper.
2. **Source adapters receive one `Subscription` object.** The positional `subscribe(context, handler, abortController, onReady?, meta?)` signature is gone. `.from()` additionally accepts async generator functions and iterables.
3. **Custom `Step` implementations return a `StepOutcome`.** Steps no longer receive the engine queue; the executor owns scheduling. Custom aggregators return `{ body, headers? }` instead of a fabricated `Exchange`.
4. **`@routecraft/ai` error codes are renamed.** `RC5025`/`RC5026`/`RC5027` become `AI1001`/`AI1002`/`AI1003`; ecosystem packages now register their own namespaced codes via `registerErrorCodes()`.

Routes built only from the DSL (`craft().from(...).transform(...).to(...)`) with framework adapters need changes **only** if they subscribe to events (change 1). Changes 2-4 affect adapter authors and advanced integrations.

Two behavioural notes that are not API changes: context store seeding for `cron`/`direct`/`mail` config now happens in `initPlugins()` (called automatically by `start()`) instead of the `CraftContext` constructor, and mail/carddav client managers now drain in reverse-plugin-order teardown.

---

## 1. Events: fixed names, identity in the payload

Every hierarchical event name loses its identity segment. The payload already carried `routeId` (and now always does), so subscriptions become exact names plus payload filtering.

| 0.6.x name | 0.7.0 name |
| --- | --- |
| `route:<id>:registered` / `:starting` / `:started` / `:stopping` / `:stopped` | `route:registered` / `route:starting` / `route:started` / `route:stopping` / `route:stopped` |
| `route:<id>:error` / `route:<id>:error:caught` | `route:error` / `route:error:caught` |
| `route:<id>:exchange:started` / `:completed` / `:failed` / `:dropped` / `:restored` | `route:exchange:started` / `:completed` / `:failed` / `:dropped` / `:restored` |
| `route:<id>:step:started` / `:completed` / `:failed` | `route:step:started` / `:completed` / `:failed` |
| `route:<id>:step:<label>:error` | `route:step:error` (step label is `details.operation`) |
| `route:<id>:batch:started` / `:flushed` / `:stopped` | `route:batch:started` / `:flushed` / `:stopped` |
| `route:<id>:error-handler:invoked` / `:recovered` / `:failed` | `route:error-handler:invoked` / `:recovered` / `:failed` |
| `route:<id>:cache:hit` / `:miss` / `:stored` / `:failed` | `route:cache:hit` / `:miss` / `:stored` / `:failed` |
| `route:<id>:operation:choice:matched` / `:unmatched` | `route:operation:choice:matched` / `:unmatched` |
| `route:<id>:agent:*` (all agent events) | `route:agent:*` (same suffixes) |
| `plugin:<pluginId>:registered` / `:starting` / `:started` / `:stopping` / `:stopped` | `plugin:registered` / ... (`pluginId` in payload) |
| `context:*`, `auth:*`, `agent:registered`, `agent:tool:registered` | unchanged |

Migrate by table lookup, not regex: several route ids contain words like `batch` or `started`, and a regex will corrupt names (`route:my-batch:stopped` must become `route:stopped`, but `route:r1:batch:stopped` must become `route:batch:stopped`).

**Per-route subscriptions** use the `forRoute()` helper (or filter on `details.routeId`):

```ts
// Before (0.6.x)
ctx.on('route:orders:exchange:failed', ({ details }) => alert(details.error))

// After (0.7.0)
import { forRoute } from '@routecraft/routecraft'
ctx.on('route:exchange:failed', forRoute('orders', ({ details }) => alert(details.error)))
```

**Wildcard patterns** are removed from `ctx.on()` / `ctx.once()`. The only pattern is the catch-all `"*"`, which observes every event. Patterns like `route:*` or `route:**` now throw `RC2001` with migration guidance.

```ts
// Before: ctx.on('route:*:exchange:*', handler) / ctx.on('**', handler)
ctx.on('*', (payload) => sink.write(payload._event, payload.details))
```

The `event()` **source adapter** keeps its pattern support (`event('route:*')` still works there); patterns match against the emitted name behind a single catch-all subscription.

**Ecosystem events** are declared by merging into `EventDetailsMap` (the same pattern as `StoreRegistry`):

```ts
declare module '@routecraft/routecraft' {
  interface EventDetailsMap {
    'plugin:myext:thing:happened': { routeId: string; thing: string }
  }
}
```

## 2. Sources: the `Subscription` object

`CallableSource` collapses from five positional parameters to one object. Everything you had is still there under a named field, plus `complete()` replaces the abort-to-finish idiom:

```ts
// Before (0.6.x)
async subscribe(context, handler, abortController, onReady) {
  onReady?.()
  while (!abortController.signal.aborted) {
    await handler(await poll(), { 'x-origin': 'poll' })
  }
  abortController.abort() // finite source done
}

// After (0.7.0)
async subscribe(sub: Subscription<T>) {
  sub.ready()
  while (!sub.signal.aborted) {
    await sub.emit({ message: await poll(), headers: { 'x-origin': 'poll' } })
  }
  sub.complete() // finite source done
}
```

Field map: `context` -> `sub.context`, `handler(msg, headers, parse, parseFailureMode)` -> `sub.emit({ message, headers, parse, parseFailureMode })`, `abortController.signal` -> `sub.signal`, `abortController.abort()` -> `sub.complete(reason?)`, `onReady?.()` -> `sub.ready()`, `meta` -> `sub.meta` (now always present).

New since the same release, built on this contract:

```ts
// Generator sources: each yield is one exchange
.from(async function* (sub) {
  while (!sub.signal.aborted) yield await poll()
})

// Bare (async) iterables work too
.from(someAsyncIterable)
```

For driving a source directly in unit tests, `@routecraft/testing` adds `testSubscription({ context, handler, abortController })`.

## 3. Custom steps and aggregators

`Step.execute` no longer receives the remaining steps and the engine queue. Steps return what happened; the executor schedules:

```ts
// Before (0.6.x)
async execute(exchange, remainingSteps, queue) {
  const next = DefaultExchange.rewrap(exchange, { body: transform(exchange.body) })
  queue.push({ exchange: next, steps: remainingSteps })
}

// After (0.7.0)
async execute(exchange: Exchange): Promise<StepOutcome> {
  const next = DefaultExchange.rewrap(exchange, { body: transform(exchange.body) })
  return { kind: 'continue', exchange: next }
}
```

Outcomes: `continue` (run remaining steps), `complete` (skip remaining steps, success), `drop` (halted; emit your drop events and `markDropped` first), `branch` (prepend steps, then remaining), `fanOut` (schedule each child). Join-style steps consume pending siblings via the `StepContext` second argument (`ctx.takePending(predicate)`).

Wrapper authors (`WrapperStep` subclasses): `runInner(exchange, ctx)` now returns the inner's `StepOutcome` and there is no `innerQueue` buffer to manage; recovery returns a substitute outcome.

Custom **aggregators** return the combined body (plus optional headers) instead of a fake exchange:

```ts
// Before: return { ...exchanges[0], body: merged } as Exchange
// After:
.aggregate((exchanges) => ({ body: merge(exchanges.map((e) => e.body)) }))
```

## 4. Error codes: `AI` namespace

`@routecraft/ai`'s agent-block codes moved out of core and were renumbered:

| 0.6.x | 0.7.0 | Meaning |
| --- | --- | --- |
| `RC5025` | `AI1001` | Agent block resolution failed |
| `RC5026` | `AI1002` | Agent block name collision |
| `RC5027` | `AI1003` | Agent block misconfigured |

Update any code or alerting that matches on `error.rc`. Core `RC####` codes are otherwise unchanged (one addition: `RC1003`, error-code registration failed).

Ecosystem packages can now own codes under a claimed namespace:

```ts
declare module '@routecraft/routecraft' {
  interface ErrorCodeRegistry {
    ACME1001: RCMeta
  }
}
registerErrorCodes('ACME', { ACME1001: { ... } }, 'my-package')
```

Namespaces are claimable by exactly one package; `RC` is reserved for core; codes are the namespace plus four digits.
