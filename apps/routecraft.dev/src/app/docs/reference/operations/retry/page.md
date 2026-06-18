---
title: retry
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
retry(options?: {
  maxAttempts?: number;
  backoffMs?: number;
  factor?: number;
  maxBackoffMs?: number;
  jitter?: 'none' | 'full' | number;
  retryOn?: (error: Error) => boolean;
}): RouteBuilder<Current>
```

Re-attempt a failing operation with configurable backoff, so transient failures recover without manual intervention.

**Mental model:** Dual-mode. After `.from()` it wraps the immediately-next step. Before `.from()` it re-runs the whole pipeline on failure (pre-from filter chain position 7, outside `.timeout()` and inside `.error()`).

```ts
craft()
  .id('resilient-processor')
  .from(source)
  .retry({ maxAttempts: 3, backoffMs: 1000, factor: 2, jitter: 'full' })
  .to(http({ url: 'https://flaky-api.example.com' })) // retried
  .transform(format)                                   // not retried
```

**Parameters:**
- `maxAttempts` - Maximum total attempts, including the first (default: 3)
- `backoffMs` - Base wait between attempts (default: 1000ms)
- `factor` - Growth multiplier per attempt: the wait before attempt `n` is `backoffMs * factor^(n - 1)`. `1` (default) is fixed backoff; `2` doubles each time (`1000, 2000, 4000, ...`); any value `>= 1` is allowed. (Replaces the old `exponential` boolean: `exponential: true` is now `factor: 2`.)
- `maxBackoffMs` - Upper bound on a single wait so an exponential `factor` cannot grow without limit; the computed wait is clamped to this before jitter (default: the platform timer ceiling, effectively unbounded)
- `jitter` - Randomise each wait to de-sync retry storms: `'none'` (default), `'full'` (uniform in `[0, computed]`), or a number in `[0, 1]` (keep `1 - jitter` to `1` of the wait). Jitter only ever shortens a wait, so it never exceeds `maxBackoffMs`.
- `retryOn` - Predicate deciding whether a failed attempt is re-attempted (see default behavior below)

**Attempt semantics:** Every attempt receives the same (frozen) exchange, so a re-attempt always starts from the input that failed, never from partial output. The attempt counter is internal loop state, not an exchange header; observers track attempts via the `route:retry:attempt` events. After the final attempt fails, the original error propagates unchanged to outer wrappers, the route-level `.error()` handler, or the default error path.

**Cancellation:** Backoff waits are tied to the route's abort signal. When the route shuts down during a backoff, retry gives up immediately and propagates the last real error instead of waiting out the backoff or burning attempts during teardown.

#### Default retry behavior

By default, `retry` checks the error's `retryable` property:

```ts
// Default retryOn logic
(error) => {
  if (error instanceof RoutecraftError && error.retryable === false) {
    return false;
  }
  return true;
}
```

This means:
- Errors with `retryable: false` are **not retried** (e.g., validation, auth, and config errors, which fail the same way every time)
- Errors with `retryable: true` **are retried**, including timeouts (`RC5011`), connection failures (`RC5010`), and rate limits (`RC5013`)
- Unknown/third-party errors **are retried** (optimistic default)

See the [errors reference](/docs/reference/errors) for which errors are retryable by default.

Override with a custom predicate when needed:

```ts
// Retry everything, including non-retryable errors
craft()
  .id('retry-all')
  .from(source)
  .retry({ maxAttempts: 3, retryOn: () => true })
  .process(operation)
  .to(destination)

// Retry only timeouts
craft()
  .id('retry-timeout-only')
  .from(source)
  .retry({ maxAttempts: 3, retryOn: (e) => (e as RoutecraftError).rc === 'RC5011' })
  .timeout(5000)
  .process(slowOp)
  .to(destination)
```

**Events:** `route:retry:started` when the guarded execution begins, `route:retry:attempt` before each backoff wait and re-attempt (with `attemptNumber`, the actual `backoffMs`, and `lastError`), `route:retry:stopped` on final success or failure. Payloads carry `scope: "route" | "step"`. See the [events reference](/docs/reference/events).

## Route scope

Place `.retry()` BEFORE `.from()` to re-run the entire pipeline on failure:

```ts
craft()
  .id('resilient-pipeline')
  .retry({ maxAttempts: 3, backoffMs: 2000, factor: 2, maxBackoffMs: 10_000 })
  .timeout(10_000)
  .from(direct())
  .enrich(flakyUpstream)
  .transform(format)
  .to(noop())
```

Route-scope `.retry()` sits at position 7 of the [filter chain](/docs/advanced/filter-chain): outside `.timeout()` (each attempt gets its own deadline) and inside `.error()` (the handler sees the final attempt's failure, not every intermediate one). Builder call order does not matter; the framework fixes the chain order.

**Re-attempts re-run side effects.** A route-scope re-attempt runs the whole pipeline again, including every `.to()` and `.tap()` that completed before the failure (and any `.split()` fan-out). When the rest of the pipeline must not repeat, wrap only the flaky step with step-scope `.retry()` instead. Note that route-scope `.cache()` composes well here: a value cached by a previous attempt short-circuits the next one.

**Split children are not individually retried.** With a `.split()` in the pipeline, every child still processes to completion on each attempt, but only a failure of the *main* exchange triggers a re-attempt; a failed split child resolves through the per-child failure events exactly as it would without `.retry()`. To re-attempt a flaky per-child step, wrap that step with step-scope `.retry()` after the split instead.
