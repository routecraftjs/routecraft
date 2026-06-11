---
title: Migrating to 0.6.0
---

The pre-v1 architecture changes that landed on the 0.6.0 canary line, and how to update. {% .lead %}

0.6.0 is the architecture release before v1: the contracts that freeze at v1 changed shape once, now, so they do not have to change after. In exchange every route runs ~25% faster (steps wrapped with `.error()` ~45% faster) and event throughput doubles.

If you are coming from **0.5.x**, start with the [0.5.x to 0.6.0 guide](/docs/migrating/0.5-to-0.6) (AI surface, HTTP source, mail envelope), then apply this page. If you tracked the **0.6.0 canaries**, this page alone covers the contracts that changed during the canary line.

The consumer-visible changes:

1. **Event names are a fixed set; identity moved into the payload.** `route:<id>:exchange:failed` becomes `route:exchange:failed` with `routeId` in `details`. Wildcard subscriptions are replaced by exact names, the `"*"` catch-all, and the `forRoute()` filter helper. `plugin:registered` is removed (subscribe to `plugin:starting`).
2. **Source adapters receive one `Subscription` object.** The positional `subscribe(context, handler, abortController, onReady?, meta?)` signature is gone. `.from()` additionally accepts async generator functions and iterables.
3. **Custom `Step` implementations return a `StepOutcome`.** Steps no longer receive the engine queue; the executor owns scheduling. Per-execution metadata rides the outcome, not the `Step` instance. Custom aggregators return `{ body, headers? }` instead of a fabricated `Exchange`.
4. **`@routecraft/ai` error codes are renamed.** `RC5025`/`RC5026`/`RC5027` become `AI1001`/`AI1002`/`AI1003`; ecosystem packages now register their own namespaced codes via `registerErrorCodes()`.
5. **The builder enforces position in the type system.** `craft()` returns a pre-`from` builder; pipeline operations before `.from()` are now compile errors. Builder generics take a state bag (`RouteBuilder<{ body: T }>`).
6. **Splitters return child bodies.** `.split()` callbacks return values (or `splitChild(body, headers)`) instead of hand-built `Exchange` instances.
7. **Consumers take envelopes and a deps bag.** `Consumer.register` receives the `Message` envelope; consumer classes construct from a single `ConsumerDeps` object.
8. **Header keys are consolidated.** `HeadersKeys` keeps framework keys only; adapter keys move to per-adapter objects (`MailHeaders`, `CronHeaders`, `TimerHeaders`, `FileHeaders`, `CsvHeaders`, `JsonlHeaders`, `CarddavHeaders`). `HEADER_MAIL_*` / `HEADER_CARDDAV_*` constants and `HeaderKeysRegistry` are removed.
9. **`client.send` is now `client.sendDirect`**, and capability discovery is public: `context.capabilities()` replaces reads of the internal direct registry.
10. **Naming sweeps.** `CardDAV*` exports become `Carddav*` (acronym casing, per the `Http` precedent); jsonl's `JsonlSourceOptions` / `JsonlDestinationOptions` / `JsonlCombinedOptions` fold into one `JsonlFileOptions`.

Routes built only from the DSL (`craft().from(...).transform(...).to(...)`) with framework adapters need changes **only** if they subscribe to events (change 1), reorder builder calls in ways that were already runtime errors (change 5), or read adapter header constants (change 8). The rest affects adapter authors and advanced integrations.

New without breaking anything: `.error()` handlers can return `recovery.drop(reason?)` / `recovery.rethrow()` directives; `rcError` accepts a per-occurrence `retryable` override; `RCMeta.category` and `Principal.kind` accept ecosystem-defined strings; plugins can declare a `name` (used as `pluginId`).

Two behavioural notes that are not API changes: context store seeding for `cron`/`direct`/`mail` config now happens in `initPlugins()` (called automatically by `start()`) instead of the `CraftContext` constructor, and plugin teardown plus `registerTeardown` callbacks now unwind in reverse (LIFO) order.

---

## 1. Events: fixed names, identity in the payload

Every hierarchical event name loses its identity segment. The payload already carried `routeId` (and now always does), so subscriptions become exact names plus payload filtering.

| Old name | 0.6.0 name |
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
| `plugin:<pluginId>:starting` / `:started` / `:stopping` / `:stopped` | `plugin:starting` / ... (`pluginId` in payload); `plugin:<pluginId>:registered` is removed (subscribe to `plugin:starting`) |
| `context:*`, `auth:*`, `agent:registered`, `agent:tool:registered` | unchanged |

Migrate by table lookup, not regex: several route ids contain words like `batch` or `started`, and a regex will corrupt names (`route:my-batch:stopped` must become `route:stopped`, but `route:r1:batch:stopped` must become `route:batch:stopped`).

**Per-route subscriptions** use the `forRoute()` helper (or filter on `details.routeId`):

```ts
// Before
ctx.on('route:orders:exchange:failed', ({ details }) => alert(details.error))

// After (0.6.0)
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
// Before
async subscribe(context, handler, abortController, onReady) {
  onReady?.()
  while (!abortController.signal.aborted) {
    await handler(await poll(), { 'x-origin': 'poll' })
  }
  abortController.abort() // finite source done
}

// After (0.6.0)
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
// Before
async execute(exchange, remainingSteps, queue) {
  const next = DefaultExchange.rewrap(exchange, { body: transform(exchange.body) })
  queue.push({ exchange: next, steps: remainingSteps })
}

// After (0.6.0)
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

| Old code | 0.6.0 code | Meaning |
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

## 5. Builder position is type-enforced

`craft()` returns a pre-`from` builder exposing only the staging methods (`id`, `title`, `description`, `input`, `output`, `tag`, `batch`, `authorize`, route-scope `error` / `cache`) plus `.from()`. Pipeline operations before `.from()` no longer compile (they were already `RC2001` / `RC2002` runtime errors):

```ts
// Compile error now (was a runtime error)
craft().transform(fn).from(source)

// Correct order
craft().id('orders').from(source).transform(fn)
```

Builder generics also moved to a state bag. If you annotate builder types, `RouteBuilder<T>` becomes `RouteBuilder<{ body: T }>`; for heterogeneous lists of finished builders use `AnyRouteBuilder`. DSL extensions via `registerDsl` augment `StepBuilderBase<S extends BuilderState>` and advance the bag with `Retyped<this, SetBody<S, NewBody>>`.

## 6. Splitters return bodies

`.split()` callbacks return the child values; the framework builds the child exchanges (fresh id, inherited headers, split hierarchy). Per-child header overrides use the `splitChild` envelope:

```ts
// Before: hand-built child Exchange instances
.split((exchange) => exchange.body.items.map((item) =>
  DefaultExchange.rewrap(exchange, { body: item })))

// After (0.6.0): return the bodies
.split((exchange) => exchange.body.items)

// Per-child header overrides
.split((exchange) => exchange.body.lines.map((line, i) => splitChild(line, { 'x-line': i })))
```

## 7. Consumer SPI: envelopes and a deps bag

Custom `Consumer` implementations construct from one `ConsumerDeps` object and register a handler that receives the same `Message` envelope sources enqueue:

```ts
// Before
class MyConsumer implements Consumer {
  constructor(context, definition, channel, options) { ... }
  register(handler) {
    this.channel.setHandler((m) => handler(m.message, m.headers, m.parse, m.parseFailureMode))
  }
}

// After (0.6.0)
class MyConsumer implements Consumer {
  constructor(deps: ConsumerDeps) { ... } // { context, definition, channel, options }
  register(handler: (envelope: Message) => Promise<Exchange>) {
    this.channel.setHandler(handler)
  }
}
```

`Message`, `ProcessingQueue`, `ConsumerType`, and `ConsumerDeps` are exported from the barrel. `deps.options` is `unknown`; the consumer owns narrowing its own options.

## 8. Header keys: per-adapter objects

`HeadersKeys` now carries framework keys only (`ID`, `OPERATION`, `ROUTE_ID`, `CORRELATION_ID`, `SPLIT_HIERARCHY`, `AUTH_PRINCIPAL`). Adapter keys live on per-adapter objects exported next to each adapter:

| Old | New |
| --- | --- |
| `HeadersKeys.TIMER_*` | `TimerHeaders.*` |
| `HeadersKeys.CRON_*` | `CronHeaders.*` |
| `HeadersKeys.FILE_LINE` / `FILE_PATH` | `FileHeaders.LINE` / `FileHeaders.PATH` |
| `HeadersKeys.CSV_ROW` / `CSV_PATH` | `CsvHeaders.ROW` / `CsvHeaders.PATH` |
| `HeadersKeys.JSONL_LINE` / `JSONL_PATH` | `JsonlHeaders.LINE` / `JsonlHeaders.PATH` |
| `HEADER_MAIL_UID`, `HEADER_MAIL_FROM`, ... | `MailHeaders.UID`, `MailHeaders.FROM`, ... |
| `HEADER_CARDDAV_UID`, ... | `CarddavHeaders.UID`, ... |

The wire keys (`routecraft.timer.time`, `routecraft.mail.uid`, ...) are unchanged, so code that used raw strings keeps working. `HeaderKeysRegistry` is removed: adapters and ecosystem packages declare typed headers by merging into `RoutecraftHeaders` directly. The whole `routecraft.*` header namespace is reserved; `.header()` now rejects every engine-owned key (`routecraft.id`, `routecraft.operation`, `routecraft.route`, `routecraft.split_hierarchy`) up front.

## 9. Client and capability discovery

`CraftClient.send` is renamed `sendDirect`, and its response generic defaults to `unknown` (narrow explicitly):

```ts
// Before
const result = await client.send<Req, Res>('greet', { name })

// After (0.6.0)
const result = await client.sendDirect<Req, Res>('greet', { name })
```

Capability discovery is public API: `context.capabilities()` returns every discoverable direct endpoint with its route's metadata (`endpoint`, `title`, `description`, `input`, `output`, `tags`). The internals it replaces (`ADAPTER_DIRECT_REGISTRY`, `getDirectChannel`, `sanitizeEndpoint`, `DirectRouteMetadata`) are no longer exported.

## 10. Renames: Carddav casing and JsonlFileOptions

Acronyms in identifiers are cased as words (`Http` precedent), so every `CardDAV*` export is now `Carddav*`: `CarddavAdapter`, `CarddavClientManager`, `CarddavOptions`, `CarddavAction`, `CarddavDriverClient`, `CarddavTargetExtractor`, `CarddavWriteResult`, `CarddavDeleteResult`, `CarddavContextConfig`, `CarddavAccountConfig`, `throwCarddavError`, `ResolvedCarddavConnection`. `CARDDAV_CLIENT_MANAGER` and `DEFAULT_CARDDAV_SERVER_URL` are unchanged.

The jsonl adapter folds its file options into one type, matching `JsonFileOptions` / `CsvFileOptions`: `JsonlSourceOptions`, `JsonlDestinationOptions`, and `JsonlCombinedOptions` become `JsonlFileOptions` (discriminated by `mode`, plus `chunked`). Call sites are unchanged; only type annotations need the new name.

## 11. New, non-breaking

- **Recovery directives**: `.error()` handlers (route scope and step scope) may return `recovery.drop(reason?)` to discard the failing exchange (emits `route:exchange:dropped`) or `recovery.rethrow()` to decline recovery, instead of recovering with a body or throwing manually.
- **`rcError` retryable override**: `rcError(code, cause, { retryable })` flips the retry classification for one occurrence.
- **Open categories and kinds**: `RCMeta.category` and `Principal.kind` accept ecosystem-defined strings alongside the known values.
- **Plugin identity**: plugins may declare `name` (used as `pluginId` on events and logs) and reserve `dependsOn` for future ordered initialisation. `context.getRoutes()` returns a copy.
