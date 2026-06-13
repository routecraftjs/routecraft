---
title: throttle
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
throttle(options: {
  rate: number
  per?: 'second' | 'minute' | 'hour' | 'day'
  burst?: number
  key?: (exchange: Exchange) => string
  maxKeys?: number
}): RouteBuilder<Current>
```

Rate-limit an operation to a maximum number of calls per time window, so a route does not overwhelm a downstream API or trip its rate limits. Exchanges that exceed the rate are paced (delayed), never dropped.

```ts
craft()
  .id('rate-limited-api')
  .from(source)
  .throttle({ rate: 10, per: 'second' })
  .to(http({ url: 'https://rate-limited-api.example.com' })) // at most 10/second
```

**Mental model:** A token bucket. Tokens refill at `rate` per `per` window, each exchange consumes one, and an exchange that finds the bucket empty waits until a token is available. After an idle window up to `burst` calls pass immediately, then admissions settle to the configured rate.

**Parameters:**
- `rate` - allowed requests per `per` window. A finite number greater than 0.
- `per` - the time window, one of `'second'` (default), `'minute'`, `'hour'`, `'day'`.
- `burst` - bucket capacity: the most calls admitted back-to-back after an idle window before pacing kicks in. Defaults to `rate` (one window's worth). Set it lower for strict pacing, higher to tolerate spikes. Because it is independent of `per`, `{ rate: 600, per: 'minute' }` does not silently allow a 600-wide burst unless you also ask for `burst: 600`.
- `key` - partition the limit per user / IP / tenant (see below). Omit for one shared bucket across the route.
- `maxKeys` - cap on distinct keys tracked at once when `key` is set (default `10_000`).

Invalid options are rejected at build time (`RC5003`).

## Per-key throttling

By default `.throttle()` is a single bucket shared across the whole route (a global limit). Pass a `key` selector to give each distinct key its own independent bucket, so one caller cannot consume another's allowance:

```ts
craft()
  .from(source)
  // 10 requests/second PER authenticated principal
  .throttle({ rate: 10, key: (ex) => ex.principal?.sub ?? 'anonymous' })
  .to(destination)
```

Common selectors: `ex.principal?.sub` (per user), `ex.headers['x-forwarded-for']` (per IP), `ex.headers['x-tenant-id']` (per tenant). The selector must return a string for every exchange, so coalesce missing values (`?? 'anonymous'`); a selector that throws fails the exchange like any user callback. `maxKeys` must be between 1 and 1,000,000 (the per-key store pre-allocates to its bound).

The per-key buckets live in an LRU bounded by `maxKeys`, and an idle key's bucket is evicted once it would have fully refilled (a full bucket is indistinguishable from a fresh one, so this is lossless). A key seen again after eviction simply starts with a full bucket. This keeps memory bounded even with an unbounded key space.

> **In-memory only.** The limiter state lives in process memory, so it resets on restart and is not shared across instances. That is fine for second-to-day smoothing, but a durable "N per month" quota that must survive restarts needs persistent, shared storage (a separate concern).

## Stacking independent limits

Multiple `.throttle()` calls compose: an exchange must be admitted by **all** of them. Use this to combine a global ceiling with per-key limits:

```ts
craft()
  .throttle({ rate: 1000, per: 'minute' })                                 // global ceiling
  .throttle({ rate: 60,   per: 'minute', key: (ex) => ex.principal?.sub }) // per-user
  .throttle({ rate: 10,   per: 'second', key: (ex) => clientIp(ex) })      // per-IP burst guard
  .from(mcpTool)
  .to(destination)
```

**Dual-mode:** On the route builder, position decides scope.

- **Before `.from()` (route scope):** rate-limits the whole pipeline at [pre-from filter chain](/docs/advanced/filter-chain) position 5, outside the resilience wrappers, so a throttled request never reaches `.retry()` / `.timeout()`. The gate runs before the cache check, so a paced request does not consume a cache lookup until it is admitted.
- **After `.from()` (step scope):** rate-limits the immediately-next step only.

**Backpressure:** Route-scope throttle paces exchanges *within* the pipeline; it rate-limits the downstream work but does not pause the source consumer, so under high concurrency exchanges queue in flight while they wait for a token. True source backpressure (a consumer that stops pulling) is a planned follow-up.

**Cancellation:** The pacing wait is tied to the route's abort signal. When the route shuts down mid-wait, the remaining wait is skipped and the exchange is admitted, so no exchange is silently dropped by a shutdown.

**Stacking with other wrappers:** Wrappers stack outside-in in declaration order (first-declared outermost):

```ts
// Each retry attempt is rate-limited: the throttle is re-entered per attempt.
craft()
  .from(source)
  .retry({ maxAttempts: 3 })
  .throttle({ rate: 5 })
  .to(http({ url: 'https://api.example.com' }))
```

**Events:** `route:throttle:passed` for every admitted exchange (with `waited`, and `key` when keyed) and `route:throttle:delayed` when an exchange must pace (with `waitMs`, and `key` when keyed). See the [events reference](/docs/reference/events).

**`.throttle()` vs `.delay()`:** Delay is a fixed wait applied to every exchange independently. Throttle shares a rate-limiter across the route (or per key), so it caps the aggregate call rate rather than spacing each exchange by a constant.
