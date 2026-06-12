---
title: delay
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
delay(delayMs: number): RouteBuilder<Current>
```

Wait a fixed time before the next operation runs. Pass-through: the exchange is unchanged by the wait, and the body type flows through untouched.

```ts
craft()
  .id('paced-processor')
  .from(source)
  .delay(1000)
  .process(operation) // executes after a 1s wait
  .to(destination)
```

**Mental model:** Step scope only. `.delay()` wraps the immediately-next step; there is no route-scope form, because a delay over the whole pipeline is equivalent to a delay before the first step. Calling `.delay()` before `.from()` is a compile error.

**Parameters:**
- `delayMs` - Milliseconds to wait before the next operation runs

**Cancellation:** The wait is tied to the route's abort signal. When the route shuts down mid-wait, the remaining wait is skipped and the wrapped step still runs, so no exchange is silently dropped by a shutdown. The `route:delay:stopped` event carries `cancelled: true` in that case.

**Stacking:** Wrappers stack outside-in in declaration order (first-declared outermost), so the position relative to other wrappers decides what is repeated:

```ts
// Wait before EVERY attempt: retry re-runs the delay-wrapped step.
craft()
  .id('paced-retry')
  .from(source)
  .retry({ maxAttempts: 3, backoffMs: 1000 })
  .delay(500)
  .to(http({ url: 'https://api.example.com' }))
```

**Events:** `route:delay:started` when the wait begins; `route:delay:stopped` when it ends (with `elapsed` and the `cancelled` flag). See the [events reference](/docs/reference/events).

**`.delay()` vs `.throttle()`:** Delay is a fixed wait per exchange. Rate limiting to N requests per second across concurrent exchanges is `.throttle()` (planned), which shares route-level limiter state.
