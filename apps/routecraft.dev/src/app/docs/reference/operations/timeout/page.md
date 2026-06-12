---
title: timeout
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
timeout(timeoutMs: number): RouteBuilder<Current>
```

Bound the next operation with a deadline. When the operation settles in time its result passes through unchanged; when the deadline fires first, `RC5011` (Request timeout) is thrown.

**Mental model:** Dual-mode. After `.from()` it wraps the immediately-next step. Before `.from()` it bounds each run of the whole pipeline (pre-from filter chain position 8, inside `.retry()` so every attempt gets its own deadline).

```ts
// Step scope: bound one slow call
craft()
  .id('timeout-protected')
  .from(source)
  .timeout(5000)
  .to(http({ url: 'https://slow-api.example.com' })) // RC5011 if > 5s
  .transform(format)                                  // not bounded

// Combined with retry: each attempt gets its own 5s deadline
craft()
  .id('retry-slow-calls')
  .from(source)
  .retry({ maxAttempts: 3 })
  .timeout(5000)
  .to(http({ url: 'https://slow-api.example.com' }))
```

**Parameters:**
- `timeoutMs` - Deadline in milliseconds

**Error semantics:** Expiry throws `RC5011`, which is registered `retryable: true`: a wrapping `.retry()` re-attempts timeouts by default, and an `.error()` handler can branch on the code (`if (err.rc === 'RC5011') ...`). A failure of the wrapped operation *inside* the deadline propagates unchanged; `.timeout()` never rewrites other errors.

**No cancellation of the work:** Promises cannot be cancelled. When the deadline fires, the abandoned operation keeps running in the background and its eventual result is discarded; side effects of the abandoned attempt may still happen. The timeout bounds how long the pipeline waits, not the work itself.

**Events:** `route:timeout:started` when the guarded execution begins, `route:timeout:stopped` when it settles in time, `route:timeout:expired` when the deadline fires (followed by the `RC5011` throw). Payloads carry `scope: "route" | "step"`. See the [events reference](/docs/reference/events).

## Route scope

Place `.timeout()` BEFORE `.from()` to bound each run of the entire pipeline:

```ts
craft()
  .id('bounded-pipeline')
  .retry({ maxAttempts: 2 })
  .timeout(10_000)
  .from(direct())
  .enrich(slowUpstream)
  .transform(format)
  .to(noop())
```

Route-scope `.timeout()` sits at position 8 of the [filter chain](/docs/advanced/filter-chain): inside route-scope `.retry()` (each attempt gets its own deadline) and outside the cache check (a cache hit counts as a fast success and never expires). Builder call order does not matter; the framework fixes the chain order.
