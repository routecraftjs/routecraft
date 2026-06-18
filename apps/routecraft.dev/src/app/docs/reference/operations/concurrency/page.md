---
title: concurrency
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
concurrency(options: {
  max: number
  mode?: 'queue' | 'reject'
  maxQueue?: number
  key?: (exchange: Exchange) => string
  maxKeys?: number
  label?: string
}): RouteBuilder<Current>
```

Bound how many exchanges run an operation AT ONCE (a bulkhead). Where `.throttle()` caps a RATE (calls per time window), `.concurrency()` caps SIMULTANEITY (how many are in flight at the same instant): protect a connection pool, a memory-bound step, or a downstream with a hard concurrency cap. The two compose but are not substitutes, a 10/sec throttle still allows unbounded simultaneous calls if each is slow.

```ts
craft()
  .id('reserve-inventory')
  .from(source)
  .concurrency({ max: 5 }) // at most 5 reservations in flight at once
  .to(http({ url: 'https://inventory.internal/reserve' })) // bounded
  .transform(formatReceipt) // NOT bounded
```

**Mental model:** A pool of `max` slots. An exchange takes a slot before the wrapped work and frees it the moment the work settles (success, drop, or failure). When every slot is busy:

```text
queue mode (default):  wait FIFO for a slot (backpressure), bounded by maxQueue
reject mode:           fail fast with RC5026 (no slot, no wait)
```

**Parameters:**

- `max` - maximum simultaneous in-flight exchanges. A finite integer >= 1.
- `mode` - what to do when all slots are busy. `"queue"` (default) waits FIFO for a slot; `"reject"` fails fast with `RC5026`. Mirrors `.throttle()`'s `delay` / `reject`.
- `maxQueue` - queue mode only: cap the wait line. When `max` slots are busy AND `maxQueue` exchanges already wait, the next one fails fast with `RC5026` instead of joining the queue. A finite integer >= 1; omit for an unbounded queue. Passing it in reject mode is a build error (reject is `maxQueue: 0`).
- `key` - partition the limit so each distinct key gets its own independent pool (per user / tenant / connection pool). The selector runs once per exchange and must return a string; coalesce missing values (`?? "anonymous"`).
- `maxKeys` - cap on distinct keys tracked at once when `key` is set; per-key pools live in a bounded LRU. Default `10_000`.
- `label` - tag carried on this limiter's events so sibling bulkheads can be told apart.

Invalid options are rejected at build time (`RC5003`).

## Dual mode: route scope vs step scope

Like the other resilience wrappers, position decides scope.

**Before `.from()` (route scope):** the bulkhead bounds the whole pipeline at the INNERMOST resilience position, inside `.retry()` and `.timeout()`. Innermost means a slot is acquired per attempt and released between retry backoffs, so a scarce slot is never held while a retry sleeps.

```ts
craft()
  .id('bounded-pipeline')
  .concurrency({ max: 10 })
  .from(queue('jobs'))
  .to(db.insert(...))
```

**After `.from()` (step scope):** the bulkhead wraps only the immediately-next step. Later steps run unbounded.

```ts
craft()
  .id('enrich-order')
  .from(direct())
  .concurrency({ max: 5, mode: 'reject' })
  .to(http({ url: 'https://inventory.api/check' })) // bounded, sheds load
  .transform(formatResponse) // NOT bounded
```

The two compose: a route-scope bulkhead over the whole pipeline plus a tighter step-scope one on a single scarce call. Multiple `.concurrency()` calls stack and nest (for example a global `max` plus a per-key `max`).

## State is per route

The slot pool is shared across every exchange on the route, not per exchange, so simultaneity is bounded route-wide. A definition registered into multiple contexts gets an independent pool per route, so the contexts never steal each other's slots. State is in-memory and per instance; sharing a bulkhead across instances is a future addition built on the shared-store abstraction.

## Interaction with `.error()` and `.retry()`

When the bulkhead rejects (reject mode, or a full `maxQueue`) it throws `RC5026`, which flows to a route-scope `.error()` handler if one is defined, so you can shed load deliberately (for example return a `503`):

```ts
.error((err) => {
  if (err.rc === 'RC5026') throw err // surface backpressure to the caller
  throw err
})
```

`RC5026` is retryable: a slot frees as soon as in-flight work completes, so an enclosing `.retry()` (which sits OUTSIDE the bulkhead) can back off and re-acquire one. That gives a useful composition, "do not queue indefinitely, retry-with-backoff instead":

```ts
.retry({ maxAttempts: 4, backoffMs: 50, factor: 2 })
.concurrency({ max: 8, mode: 'reject' })
.to(http({ url }))
```

This differs from `.throttle()`'s reject (`RC5013`), which sits OUTSIDE retry and so can only be handled by `.error()`, never re-attempted by retry. The difference is a direct consequence of the bulkhead's innermost placement.

## `.concurrency()` vs `.throttle()`

| | `.concurrency({ max })` | `.throttle({ rate, per })` |
| --- | --- | --- |
| Bounds | Simultaneous in-flight (how many at once) | Rate (how many per time window) |
| Protects | Connection pools, memory, hard concurrency caps | Downstream rate limits, fair pacing |
| Over-limit | Queue (backpressure) or reject (`RC5026`) | Delay (pace) or reject (`RC5013`) |
| Chain position | Innermost resilience (inside retry/timeout) | Outermost resilience (#5, outside retry/timeout) |

They compose: rate-limit AND cap simultaneity by declaring both.

## Events

The bulkhead emits the `route:concurrency:*` family. See the [events reference](/docs/reference/events) for payload shapes. `scope` is `"route"` when declared before `.from()` and `"step"` for the wrapper after it.

- `route:concurrency:queued` - all slots were busy; the exchange joined the wait queue (queue mode).
- `route:concurrency:acquired` - a slot was acquired and the wrapped work began (`waited` tells you whether it had to queue first).
- `route:concurrency:released` - the held slot was freed when the work settled.
- `route:concurrency:rejected` - the exchange was fast-failed with `RC5026` (`reason` is `"busy"` or `"queue-full"`).
