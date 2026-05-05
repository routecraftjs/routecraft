# Exchange State Model

Where state of kind X lives on an `Exchange<T>`, and why.

## The model

Two layers per exchange.

| Layer | What it holds | Examples | Persistence |
|---|---|---|---|
| **State (stored fields)** | `body: T`, `headers: ExchangeHeaders` | the payload, every piece of metadata about the exchange (id, route, correlation, split hierarchy, source-emitted facts, cross-cutting concerns like principal/span/tenant) | serialized verbatim; rehydrated verbatim |
| **Derivations (getters / methods on `DefaultExchange`)** | `id`, `principal`, `logger` | `get id()` reads `headers["routecraft.id"]`; `get principal()` reads `headers["routecraft.auth.principal"]`; `get logger()` builds a child logger from the framework's base logger and the exchange's id | not serialized; reconstructed by instantiating `DefaultExchange` around the rehydrated state |

Application-wide singletons (adapter clients, plugin state, schedulers) live in `context.store`, which is orthogonal: it outlives any individual exchange.

## The rules

> **State (must persist):** `body` is the operand the route is processing. `headers` is everything the framework needs to know about the exchange (metadata).
>
> **Derivations (must NOT be stored, must be reconstructible):** anything that's a view over state (id, principal lookup, future span lookup) or depends on runtime services (logger). Exposed as getters so call sites read like properties.
>
> **Singletons (out-of-band):** application-wide things go in `context.store`.

A contributor adding new state asks:

1. Is it the payload the route is operating on? --> `body`.
2. Does the same instance need to outlive the exchange and be shared across routes? --> `context.store` (typed via `StoreRegistry`).
3. Anything else per-exchange that must survive the exchange? --> `headers` (typed via `RoutecraftHeaders` augmentation or `HeaderKeysRegistry`).
4. Want ergonomic dotted access (`ex.foo`) for a known core concern? --> add a getter on `DefaultExchange` that reads from `headers`. Plugin-defined concerns export an external helper (`getTenant(ex)`) instead of patching the prototype.

That's it. No primitive/structured split. No second per-exchange bag. No stored-field "special cases" for cross-cutting concerns. One Principal --> one header key + one getter. One Span (future) --> one header key (and external helper if warranted).

## Halt / continue contract

Persisting an exchange = serializing `{ body, headers }`. Resuming an exchange = `new DefaultExchange(context, { body, headers })` on the resuming process, where `context` is a fresh `CraftContext`.

The getters (`id`, `principal`, `logger`) work immediately because they derive lazily. The `EXCHANGE_INTERNALS` WeakMap (route binding, parse hook, validation hook, startedAt, dropped flag) is NOT serialized -- it's runtime context, rehydrated by re-attaching the route via `headers["routecraft.route"]` on the new context.

The serialization surface is exactly two slots (`body`, `headers`), by construction. A future halt/continue PR does not need to enumerate which fields to serialize; the model dictates it.

## Three exchange forms (by design)

The codebase distinguishes three views of an exchange. They are intentionally separate.

1. **External `Exchange<T>` type** (`packages/routecraft/src/exchange.ts`) -- the public API surface. Type-level only, no implementation. What user code (route steps, plugin authors) sees. Stable.
2. **Internal `DefaultExchange<T>` class** (`packages/routecraft/src/exchange.ts`) -- the implementation. Stored fields are `body` and `headers`. Getters expose `id`/`principal`/`logger`. Internal-only state (route binding, parse hook, dropped flag, startedAt) lives in the `EXCHANGE_INTERNALS` WeakMap, hidden from the external type by design.
3. **Logger projection via `childBindings(ex)`** (`packages/routecraft/src/logger.ts`) -- a flat record (`{ contextId, route, correlationId, exchangeId, auth.subject, auth.issuer }`) built for pino bindings. Different shape from the exchange itself; a deliberately denormalized view for log output.

Halt/continue serializes only the implementation class's stored fields. The log projection is rebuilt on demand on the resuming process.

## Worked examples

### Adding a tracing plugin

Where does the active span go?

```ts
// In the tracing plugin package
declare module "@routecraft/routecraft" {
  interface RoutecraftHeaders {
    "routecraft.tracing.span"?: TraceSpan;
  }
}

// Setting:
const next = { ...ex, headers: { ...ex.headers, "routecraft.tracing.span": span } };

// Reading (via an external helper exported from the plugin):
export function getSpan(ex: Exchange): TraceSpan | undefined {
  return ex.headers["routecraft.tracing.span"];
}
```

The plugin does NOT add a getter on `DefaultExchange` (that would require prototype patching, which arms-races between plugins). Plugin-defined concerns expose ergonomic helpers as named exports.

### Adding a tenancy plugin

Same pattern.

```ts
declare module "@routecraft/routecraft" {
  interface RoutecraftHeaders {
    "routecraft.tenancy.tenant"?: TenantContext;
  }
}

export function getTenant(ex: Exchange): TenantContext | undefined {
  return ex.headers["routecraft.tenancy.tenant"];
}
```

### Building an HTTP source adapter

Where do inbound HTTP headers go? Translate at the adapter boundary into namespaced exchange-header keys.

```ts
const exchangeHeaders = {
  "http.request.method": req.method,
  "http.request.url": req.url,
  ...Object.fromEntries(
    Object.entries(req.headers).map(([k, v]) => [`http.request.${k}`, v]),
  ),
};
```

Don't introduce a "wire-mapped header bag" parallel to `headers`. The framework has one bag.

### Building an HTTP destination adapter

Outbound headers come from the adapter's own config (e.g. `http({ headers: { authorization: "..." } })`), not from `ex.headers`. The exchange's headers are in-process metadata, not a transport envelope. (Same as today; this didn't change with the model.)

## Non-rules (deliberately)

- **No PII enforcement at the framework type level.** PII is a logging-policy concern, not a framework-type concern. log4j doesn't ban strings to prevent PII leaks; the log statement and the aggregator filter handle that.
- **No second bag for "structured" data.** No surveyed framework splits on primitive-vs-structured; frameworks that split (Camel, Koa, Hono) split on wire-vs-app. Routecraft has no wire-mapped bag and won't grow one (wire concerns translate at adapter boundaries).
- **No ambient-context API yet.** AsyncLocalStorage breaks across queue / split / aggregate / retry boundaries; the source of truth must be on the exchange. A `currentExchange()` helper inside a single operation is a possible future ergonomic on top, not a replacement.
- **Plugins do not extend `DefaultExchange`'s prototype.** Adding a getter for plugin-defined concerns would lead to arms races and conflicts. Plugins export external helpers (`getTenant(ex)`).
- **No deep-clone of structured header values in tap snapshots.** Headers are shallow-frozen (and the constructor shallow-freezes structured values like `Principal`). Mutating nested fields of any structured header value (`ex.principal.claims.foo = ...`) is an anti-pattern the framework does not prevent and does not isolate against. Tap is for observation, not mutation.

## Why one bag named `headers`

A survey of Camel, Spring Integration, NestJS, Express/Koa/Hono/Fastify, gRPC, Apollo, OpenTelemetry, Temporal, and middy was the basis for this model.

- **Spring Integration is the direct precedent.** `MessageHeaders implements Map<String, Object>`. Typed by constants. Holds correlation ids, source-emitted facts, AND auth tokens. The JVM elephant for this exact problem space, and nobody confuses it with HTTP headers.
- **Wire-vs-app is the only load-bearing split** in frameworks that split, but Routecraft does NOT wire-map a bag (sources/destinations translate at adapter boundaries), so the split would buy nothing here.
- **Cross-cutting concerns work badly via ambient context** in message-passing systems because async chains break at queue / split / aggregate / retry boundaries. Source of truth must live on the exchange.

The "HTTP headers go on the wire" connotation is real but mild and addressable via docs. Spring Integration runs on this naming for over a decade without confusion.

## Implementation references

- `packages/routecraft/src/exchange.ts` -- `RoutecraftHeaders`, `HeadersKeys`, `ExchangeHeaders`, `DefaultExchange`, `DefaultExchange.rewrap`
- `packages/routecraft/src/auth/types.ts` -- module augmentation for `routecraft.auth.principal`
- `packages/routecraft/src/logger.ts` -- `childBindings` (the third / log-projection form)
- `packages/routecraft/test/exchange-state-model.test.ts` -- end-to-end smoke test for the halt/continue contract
