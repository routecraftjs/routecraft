---
title: circuitBreaker
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
circuitBreaker(options: {
  failureThreshold: number
  windowMs?: number
  cooldownMs?: number
  halfOpenMax?: number
  fallback?: (exchange: Exchange) => unknown
  onStateChange?: (state: 'closed' | 'open' | 'half-open') => void
  isFailure?: (error: Error) => boolean
  label?: string
}): RouteBuilder<Current>
```

Stop hammering a downstream that is already failing. The breaker counts failures over a sliding window; once they reach `failureThreshold` it trips OPEN and fast-fails subsequent calls (returning a `fallback`, or throwing `RC5025`) without running the protected work. After `cooldownMs` it goes HALF-OPEN and lets a probe through: a success closes it, a failure re-opens it.

```ts
craft()
  .id('charge-customer')
  .from(source)
  .circuitBreaker({ failureThreshold: 5, cooldownMs: 30_000 })
  .to(http({ url: 'https://api.stripe.com/charge' })) // protected
  .transform(formatReceipt) // NOT protected
```

**Mental model:** A three-state switch.

```
CLOSED  --[failures >= threshold in window]-->  OPEN
OPEN    --[cooldownMs elapsed]-------------->   HALF-OPEN
HALF-OPEN --[probe succeeds]--------------->    CLOSED
HALF-OPEN --[probe fails]------------------>    OPEN
```

**Parameters:**

- `failureThreshold` - counted failures within `windowMs` that trip the breaker. A finite integer >= 1.
- `windowMs` - sliding window over which failures are counted. Failures older than this stop counting. Default `60_000`.
- `cooldownMs` - how long the breaker stays open before admitting a probe. Default `30_000`.
- `halfOpenMax` - maximum concurrent probe calls in the half-open state. Default `1`. Values above 1 are best-effort: the first probe to succeed closes the breaker.
- `fallback` - value returned when a call is rejected (open, or half-open at capacity). When set, the rejected exchange's body becomes `fallback(exchange)` and the pipeline continues; when omitted, the breaker throws `RC5025`.
- `onStateChange` - side-effect callback fired on every transition (`closed` / `open` / `half-open`). For logging or metrics; it must not throw.
- `isFailure` - decide whether a failed call counts toward the threshold. Default: count everything except `RoutecraftError`s flagged `retryable: false` (auth `RC5012`, validation `RC5002`, ...), which are deterministic and not evidence the downstream is unhealthy.
- `label` - tag carried on this breaker's events so sibling breakers can be told apart.

Invalid options are rejected at build time (`RC5003`).

## Dual mode: route scope vs step scope

Like the other resilience wrappers, position decides scope.

**Before `.from()` (route scope):** the breaker protects the whole pipeline (pre-from filter chain position 6). When open, the pipeline is skipped entirely and the `fallback` becomes the body (or `RC5025` is thrown). It sits OUTSIDE `.retry()` and `.timeout()`, so a fully exhausted retry attempt is recorded as a single breaker failure, not one per retry, and when the breaker is open it fast-fails before retry or timeout run.

```ts
craft()
  .id('resilient-route')
  .circuitBreaker({ failureThreshold: 10, fallback: () => ({ degraded: true }) })
  .from(direct())
  .to(http({ url: 'https://flaky.api/endpoint' }))
```

**After `.from()` (step scope):** the breaker wraps only the immediately-next step. Later steps run normally.

```ts
craft()
  .id('enrich-order')
  .from(direct())
  .circuitBreaker({ failureThreshold: 3, windowMs: 30_000 })
  .to(http({ url: 'https://inventory.api/check' })) // protected
  .transform(formatResponse) // NOT protected
```

The two compose: a route-scope breaker over the whole pipeline plus a tighter step-scope breaker on one flaky call.

## State is per route

Breaker state (the failure window and the open/half-open machine) is shared across every exchange on the route, not per exchange, so failures accumulate toward the threshold and one tripped breaker fast-fails the whole route. A definition registered into multiple contexts gets an independent circuit per route, so the contexts never trip each other. State is in-memory and per instance; sharing a breaker across instances is a future addition built on the shared-store abstraction.

## Interaction with `.error()` and `.retry()`

`.circuitBreaker()` and `.error()` are complementary: the breaker prevents calls when the target is known to be down (fail fast), while `.error()` recovers unexpected failures that slip through. When the breaker is open and no `fallback` is set, the thrown `RC5025` flows to a route-scope `.error()` handler if one is defined.

`RC5025` is non-retryable, so an enclosing `.retry()` does not burn attempts against an open breaker. Because the breaker sits outside retry, retries happen inside one breaker call: only the final, exhausted outcome counts as a breaker failure.

## Events

The breaker emits the `route:circuitBreaker:*` family. See the [events reference](/docs/reference/events) for payload shapes. `scope` is `"route"` when declared before `.from()` and `"step"` for the wrapper after it.

- `route:circuitBreaker:opened` - the breaker tripped (threshold reached, or a probe failed).
- `route:circuitBreaker:halfOpen` - cooldown elapsed; a probe call was admitted.
- `route:circuitBreaker:closed` - a probe succeeded; the breaker recovered.
- `route:circuitBreaker:rejected` - a call was fast-failed (a `fallback` ran, or `RC5025` was thrown).

## MCP integration

When a route-scope breaker trips on a route sourced from `mcp()`, an MCP server plugin can subscribe to `route:circuitBreaker:opened` and mark the tool unavailable in `listTools` (re-adding it on `route:circuitBreaker:closed`) so the model stops calling a tool that is known to be down.
