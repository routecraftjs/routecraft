---
title: throttle
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
throttle(options: { requestsPerSecond: number } | { requestsPerMinute: number }): RouteBuilder<Current>
```

Rate-limit an operation to a maximum number of calls per time window, so a route does not overwhelm a downstream API or trip its rate limits. Exchanges that exceed the rate are paced (delayed), never dropped.

```ts
craft()
  .id('rate-limited-api')
  .from(source)
  .throttle({ requestsPerSecond: 10 })
  .to(http({ url: 'https://rate-limited-api.example.com' })) // at most 10/second
```

**Mental model:** A token bucket shared across the whole route. Tokens refill at the configured rate, each exchange consumes one, and an exchange that finds the bucket empty waits until a token is available. After an idle window up to `requestsPerSecond` (or `requestsPerMinute`) calls burst through immediately, then admissions settle to the configured rate. The limiter state is per route, not per exchange, so concurrent exchanges queue fairly behind one rate.

**Parameters:**
- `requestsPerSecond` or `requestsPerMinute` - the rate. Supply exactly one; they are mutually exclusive views of the same limit (`requestsPerMinute: 60` is `requestsPerSecond: 1`). Must be a finite number greater than 0. An invalid or doubled-up option is rejected at build time (`RC5003`).

**Dual-mode:** On the route builder, position decides scope.

- **Before `.from()` (route scope):** rate-limits the whole pipeline at [pre-from filter chain](/docs/advanced/filter-chain) position 5, outside the resilience wrappers, so a throttled request never reaches `.retry()` / `.timeout()`. The gate runs before the cache check, so a paced request does not consume a cache lookup until it is admitted.
- **After `.from()` (step scope):** rate-limits the immediately-next step only.

```ts
// Route scope: the whole pipeline is limited to 10/second.
craft()
  .id('limited-pipeline')
  .throttle({ requestsPerSecond: 10 })
  .from(source)
  .process(enrich)
  .to(destination)
```

**Backpressure:** Route-scope throttle paces exchanges *within* the pipeline: it rate-limits the downstream work, but it does not pause the source consumer. Under high concurrency, exchanges queue in flight while they wait for a token. True source backpressure (a consumer that stops pulling) is a planned follow-up.

**Cancellation:** The pacing wait is tied to the route's abort signal. When the route shuts down mid-wait, the remaining wait is skipped and the exchange is admitted, so no exchange is silently dropped by a shutdown.

**Stacking:** Wrappers stack outside-in in declaration order (first-declared outermost):

```ts
// Each retry attempt is rate-limited: the throttle is re-entered per attempt.
craft()
  .from(source)
  .retry({ maxAttempts: 3 })
  .throttle({ requestsPerSecond: 5 })
  .to(http({ url: 'https://api.example.com' }))
```

**Events:** `route:throttle:passed` for every admitted exchange (with `waited`), and `route:throttle:delayed` when an exchange must pace (with `waitMs`). See the [events reference](/docs/reference/events).

**`.throttle()` vs `.delay()`:** Delay is a fixed wait applied to every exchange independently. Throttle shares one rate-limiter across the route, so it caps the aggregate call rate rather than spacing each exchange by a constant.
