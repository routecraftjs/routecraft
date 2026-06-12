---
title: Pre-from Filter Chain
---

How `.authorize()`, `.input()`, `.cache()`, `.error()` (and future
`.retry()` / `.timeout()` / `.circuitBreaker()` / `.throttle()`)
compose around your route. {% .lead %}

Routecraft runs a **fixed ordered chain** of framework filters
around every exchange before and after your user pipeline. The
chain order is the framework's call -- the order you happen to
type `.authorize()`, `.input()`, or `.cache()` on the builder does
not change runtime behaviour. This is the same idea as Spring's
`FilterChainProxy` or ASP.NET middleware: the framework picks the
order; you opt in by declaring which filters you want.

## The chain

Outside in (position 1 wraps everything below):

| # | Filter | Status | Opts in via | Reads / produces |
|---|---|---|---|---|
| 1 | `error` | shipped | `.error(handler)` | catches throws from everything below |
| 2 | `authorize` (stacks) | shipped | `.authorize({ roles, scopes, predicate })` | principal on `exchange.headers` |
| 3 | `parse` | shipped | source adapter (HTTP, mail, CSV, ...) | raw body bytes → typed body |
| 4 | `input` | shipped (eager) | `.input(schema)` | typed body / headers |
| 5 | `throttle` | planned | `.throttle({...})` | rate limit on the route |
| 6 | `circuitBreaker` | planned ([#139](https://github.com/routecraftjs/routecraft/issues/139)) | `.circuitBreaker({...})` | failure stats; fast-fails when open |
| 7 | `retry` | shipped | `.retry({...})` | re-runs everything below on failure |
| 8 | `timeout` | shipped | `.timeout(ms)` | per-attempt deadline |
| 9 | `cacheCheck` | shipped | `.cache({...})` | validated body → cache key |
| - | **your pipeline** | - | `.transform()`, `.to()`, `.process()`, ... | the work |
| 10 | `cacheStore` | shipped | `.cache({...})` | terminal body, written best-effort |

{% callout type="note" title="Position #4 (`input`) runs eagerly today" %}
`.input()` schema validation runs in the framework's consumer handler **before** `runSteps`, not as a step in the chain. It still happens at conceptual position #4 (after auth + parse), and an invalid body still gets rejected before `cacheCheck` or any user step runs. The behavioural difference: an `.input()` failure does NOT flow through `.error()` the way a step throw does -- it emits `exchange:dropped` and propagates to the source's caller directly. Folding it into the chain is tracked as a follow-up to the filter chain refactor.
{% /callout %}

## What this means in practice

### The chain runs in this order regardless of how you typed it

These three routes behave identically:

```ts
craft()
  .id('list-employees')
  .authorize({ roles: ['hr'] })
  .input(schema)
  .cache({ ttl: 60_000 })
  .from(http({ path: '/employees' }))
  .enrich(loadEmployees)
  .to(noop())

craft()
  .id('list-employees')
  .cache({ ttl: 60_000 })
  .input(schema)
  .authorize({ roles: ['hr'] })
  .from(http({ path: '/employees' }))
  .enrich(loadEmployees)
  .to(noop())

craft()
  .id('list-employees')
  .input(schema)
  .cache({ ttl: 60_000 })
  .authorize({ roles: ['hr'] })
  .from(http({ path: '/employees' }))
  .enrich(loadEmployees)
  .to(noop())
```

All three run `error` → `authorize` → `parse` → `input` →
`cacheCheck` → `enrich` → `to` → `cacheStore`. The DSL is
declarative; you state which filters apply, not what order they
run in.

### Each filter throws on rejection; `.error()` decides what to recover

Filters 2-9 propagate failures upward by throwing. `.error()` is
the outermost catch:

```ts
.error((err) => {
  // Deterministic rejections: re-throw so the source can translate
  // (e.g. HTTP returns 401, 403, or 400).
  if (['RC5012', 'RC5015', 'RC5002', 'RC5016'].includes(err.rc)) throw err

  // Backpressure: re-throw so the caller sees it.
  if (err.rc === 'RC5013') throw err

  // Operational failures: recover with a fallback.
  if (err.rc === 'RC5011') return { fallback: 'timeout', data: stale }
  if (err.rc === 'RC5028') return { fallback: 'cache-down', data: stale }

  throw err
})
```

Without `.error()`, every throw goes to the route's default error
path (`route:<id>:error` + `context:error` + `exchange:failed`).
The route is **not** stopped -- the next exchange processes
normally.

## Why this order

### Top half (1-4): deterministic gates

These are guards, not work. They're cheap, deterministic, and run
once per request. Retrying them is pointless.

- **`error` outermost.** Conceptually filter #1: its try/catch
  wraps the rest. Same shape as Spring's
  `ExceptionTranslationFilter`.
- **`authorize` before `parse`.** Authorize reads the principal
  from headers; it doesn't need a parsed body. Running it first
  means an unauthenticated caller gets a clean `401` / `403`
  without the framework leaking schema information via a `400`.
- **`parse` before `input`.** Input validates the parsed shape, not
  raw bytes.
- **`input` before resilience wrappers.** A request that fails
  schema is never going to succeed on retry. Reject early.

### Middle (5-8): resilience wrappers

These DO retry / time out / fail fast. Standard outside-in
following Resilience4J conventions.

- **`throttle` outside `circuitBreaker`.** A throttled request
  shouldn't count as a breaker failure (the inner operation didn't
  even run).
- **`circuitBreaker` outside `retry`.** When the breaker is open,
  fast-fail. Retries happen *within* one breaker call.
- **`retry` outside `timeout`.** Each retry attempt gets its own
  deadline; per-attempt timeout is more useful than a shared budget.

### Bottom (9-10): cache

Innermost. The pipeline's surface.

- **`cacheCheck` just above the pipeline.** A hit short-circuits
  the pipeline without triggering retry / breaker / timeout (a hit
  is a successful zero-cost call from those layers' perspective).
- **`cacheStore` just below the pipeline.** Runs only on
  miss-success. Cache write errors are swallowed (the result is
  already computed); they emit `cache:failed phase:"set"` for
  observability but don't fail the exchange.

## Combined scenarios

### Authorize fails

```
error
  └─ authorize throws RC5012  (no principal) or RC5015 (forbidden)
       └─ everything below is skipped
```

`.error()` catches. If your handler re-throws auth errors (the
default for most apps), the source translates: HTTP returns 401 /
403, MCP returns an auth error.

### Cache hit

```
error
  └─ authorize  PASS
       └─ parse  PASS
            └─ input  PASS
                 └─ cacheCheck  HIT  → cached body returned, pipeline skipped
```

The pipeline (including `cacheStore`) never runs. Filters 2-4 still
ran, so an unauthorized caller never sees a hit.

### Pipeline throws

```
error
  └─ authorize  PASS
       └─ parse  PASS
            └─ input  PASS
                 └─ cacheCheck  MISS
                      └─ pipeline  THROWS
                           └─ cacheStore  SKIPPED  (only runs on success)
```

The throw propagates up through `cacheCheck` (already passed; just
re-throws), out to `.error()`. Nothing is cached. Next request with
the same body re-runs the pipeline.

### Retry outside timeout

With route-scope `.retry()` and `.timeout()` declared on the route:

```
error
  └─ authorize  PASS
       └─ parse  PASS
            └─ input  PASS
                 └─ retry  attempt 1
                      └─ timeout  hits 5s deadline → throws RC5011
                 ←  retry catches RC5011, attempt 2
                 └─ timeout  pipeline returns in 800ms → SUCCESS
                      └─ cacheStore  writes result
```

Per-attempt deadlines. Retry sees individual failures and decides
whether to re-attempt.

## What the chain commits the framework to

- **No reorder API.** You opt filters in by declaring them; the
  order is the framework's call. If a future use case really needs
  a different order, it's an explicit RFC, not a per-route knob.
- **All wrappers throw on rejection.** `.error()` is the universal
  catch; recovery is opt-in per RC code in the handler.
- **Deterministic gates above resilience wrappers.** Auth, parse,
  input run once; they're not retried.
- **Cache is below resilience wrappers.** A timeout / retry /
  breaker around cache means the framework retries pipeline calls
  that exceeded their deadline; cache hits short-circuit without
  triggering them.

## Reference

- The full contract (with implementation notes for contributors)
  lives at [`.standards/pre-from-filter-chain.md`](https://github.com/routecraftjs/routecraft/blob/main/.standards/pre-from-filter-chain.md).
- Operation reference pages link back here from their "where this
  slots into the chain" section.
- The step-scope wrapper pattern (for `.error()` / `.cache()`
  applied *after* `.from()` to wrap a single step) is documented
  separately at [`.standards/resilience-wrappers.md`](https://github.com/routecraftjs/routecraft/blob/main/.standards/resilience-wrappers.md).
