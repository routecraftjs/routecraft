# Pre-from Filter Chain

The framework runs a fixed, ordered chain of filters around every
exchange before the user pipeline runs (and a small tail after it).
The chain is the contract: it is **not affected** by the order in
which `.input()`, `.authorize()`, `.cache()`, `.error()`, etc. are
called on the builder. Builder order is for ergonomics; runtime
order is the framework's call.

This document is the single source of truth for that order. Future
resilience wrappers (`.retry()`, `.timeout()`, `.circuitBreaker()`,
`.throttle()`) slot into the positions named below.

Inspiration: Spring's `FilterChainProxy` / `WebSecurityConfigurerAdapter`
and Resilience4J's wrapper composition. The framework picks the
order; the user opts filters in by declaring them.

---

## 1. The chain

Outside in. Position 1 is outermost (runs first / wraps everything
below).

| # | Filter | Status | Throws on rejection? | Notes |
|---|---|---|---|---|
| 1 | `error` | shipped (#119, #140) | — | catches throws from everything below; handler picks what to recover |
| 2 | `authorize` (stacks) | shipped | yes (`RC5012` / `RC5015`) | identity gate; deterministic, not retried |
| 3 | `parse` | shipped (source-attached) | yes (`RC5016`) | raw bytes → typed body; deterministic, not retried |
| 4 | `input` | shipped | yes (`RC5002`) | schema validation; deterministic, not retried |
| 5 | `throttle` | planned | yes (`RC5013`) | rate limit valid requests (not pre-auth; that's source-layer DoS protection) |
| 6 | `circuitBreaker` | planned (#139) | yes (new RC code, fast-fail when open) | counts inner failures; trips after threshold |
| 7 | `retry` | planned | yes (final attempt's throw) | re-runs everything below on failure |
| 8 | `timeout` | planned | yes (`RC5011`) | per-attempt deadline |
| 9 | `cacheCheck` | shipped (#112) | yes (`RC5028` / `RC5029`) | hit → short-circuit pipeline |
| — | **user pipeline** | — | — | declaration order; everything after `.from()` |
| 10 | `cacheStore` | shipped (#112) | swallows (`cache:failed phase:"set"`) | best-effort write; runs only on miss-success |

---

## 2. Why this order

### Top half (1-4): deterministic gates

These are guards, not work. They're cheap, deterministic, and run
once per request. Retrying them is pointless — they fail the same
way every time.

- **`error` outermost.** Conceptually filter #1: its try/catch
  wraps the rest of the chain. Same shape as Spring's
  `ExceptionTranslationFilter`. Implementation note: realized as a
  catch boundary around the chain rather than as a step that calls
  `next()`, because the wrap is uniform.
- **`authorize` before `parse`.** Authorize reads the principal
  from headers; it doesn't need a parsed body. Running auth first
  means an unauthenticated caller gets a clean `401` / `403`
  without the framework leaking schema information via a `400`.
- **`parse` before `input`.** Input validates the parsed shape, not
  raw bytes.
- **`input` before resilience wrappers.** A request that fails
  schema is never going to succeed on retry. Reject before any
  resilience layer accepts the cost.

### Middle (5-8): resilience wrappers

These DO retry / time out / fail fast. Standard outside-in.

- **`throttle` outside `circuitBreaker`.** Rate limit comes before
  failure stats. A throttled request shouldn't count as a breaker
  failure (the inner operation didn't even run).
- **`circuitBreaker` outside `retry`.** When the breaker is open,
  fast-fail. Putting `retry` inside the breaker means retries
  happen *within* one breaker call (Resilience4J convention).
- **`retry` outside `timeout`.** Each retry attempt gets its own
  deadline. If `timeout` were outside `retry`, total time would be
  one deadline shared across attempts; per-attempt timeout is more
  useful for the common case.

### Bottom (9-10): cache

Innermost. The pipeline's surface.

- **`cacheCheck` innermost above pipeline.** A hit short-circuits
  the pipeline without triggering retry / breaker / timeout (a hit
  is a successful zero-cost call from those layers' perspective).
- **`cacheStore` below pipeline.** Runs only on miss-success.
  Skipped on cache hit (the check pushed an empty `steps[]`
  short-circuit). Skipped on pipeline drop / failure. Write errors
  are swallowed (`cache:failed phase:"set"`); the work is already
  done.

---

## 3. Composition with `error`

`error` catches every throw from filters 2-9 and the user pipeline.
The handler decides what to recover:

```ts
.error((err) => {
  // Deterministic gate rejections: re-throw so the source can
  // translate (HTTP source → 401 / 403 / 400; MCP source → error
  // response).
  if (['RC5012', 'RC5015', 'RC5002', 'RC5016'].includes(err.rc)) throw err

  // Throttle / breaker: re-throw to surface backpressure to the caller.
  if (['RC5013'].includes(err.rc)) throw err

  // Operational failures: recover with a fallback.
  if (err.rc === 'RC5011') return { fallback: 'timeout' }
  if (err.rc === 'RC5028') return { fallback: 'cache-down', data: lastKnownGood }

  // Anything we didn't whitelist: propagate.
  throw err
})
```

Default (no `.error()`): every throw propagates to the route-level
default error path (`route:<id>:error` + `context:error` +
`exchange:failed`). The route is NOT stopped; the next exchange
processes normally.

---

## 4. Combined-wrapper scenarios

### Timeout fires inside retry

1. `timeout` throws `RC5011` on deadline expiry.
2. `retry` catches the throw, decides whether to re-attempt.
3. After max attempts, the final `RC5011` propagates up through
   `circuitBreaker` (counts as a failure → may trip) → `throttle`
   (no-op) → `error` (handler decides recovery).

### Breaker is open

1. `circuitBreaker` fast-fails with its rejection code BEFORE
   `retry` / `timeout` run.
2. `retry` never sees a real attempt; it propagates the breaker
   rejection upward unchanged (configurable — some users may want
   `retry` to retry past an open breaker for a different breaker
   they own).
3. `error` catches.

### Throttle rejects

1. `throttle` throws `RC5013`.
2. `circuitBreaker` is *inside* throttle, so it doesn't run; doesn't
   count this as a failure.
3. `error` catches.

### Cache hit

1. `cacheCheck` finds a hit, pushes the rewrapped exchange with no
   remaining steps. Pipeline skipped. `cacheStore` skipped.
2. `timeout` / `retry` / `circuitBreaker` see a successful
   zero-cost return.
3. `error` is not invoked. The cached body is returned to the
   source.

### Pipeline throws

1. The throw propagates upward through `cacheStore` (skipped — only
   runs on miss-success) → `cacheCheck` (already passed; just
   re-throws) → `timeout` (still inside deadline; re-throws) →
   `retry` (decides re-attempt) → `circuitBreaker` (counts failure)
   → `throttle` (no-op) → `error`.

### `cacheStore` write fails (custom provider)

1. The write throws inside `cacheStore`.
2. `cacheStore` swallows the throw and emits `cache:failed
   phase:"set"` instead.
3. The exchange completes successfully with the freshly-computed
   body. `error` is not invoked.

Rationale: by the time `cacheStore` runs, the work is done.
Surfacing a cache-backend blip as an exchange failure would discard
the result we just computed, which is worse than failing the cache
write.

---

## 5. What this commits the framework to

- **No reorder API.** Users opt filters in by declaring them; the
  chain order is the framework's call. If a future use case really
  needs a different order, it's an explicit RFC, not a per-route
  knob.
- **All wrappers throw on rejection.** `error` is the universal
  catch; recovery is opt-in per RC code in the handler.
- **Deterministic gates above resilience wrappers.** Auth / parse /
  input run once per request, not retried.
- **Cache is below resilience wrappers.** A timeout / retry /
  breaker around cache means the framework can retry pipeline
  calls that exceeded their deadline; cache hits short-circuit
  without triggering them.

---

## 6. Implementation status

Today (as of #112 / #395 / 0.6.0):

- Filters 1-4 and 9-10 are implemented; the chain runs in the
  order documented above.
- The chain is **first-class data** on `RouteDefinition`:
  - `preParseFilters: Step<Adapter>[]` -- authorize steps in
    declaration order (chain position #2).
  - `postParseFilters: Step<Adapter>[]` -- route-scope cache-check
    filter (chain position #9). Future resilience wrappers
    (`throttle`, `circuitBreaker`, `retry`, `timeout`) slot in
    here between input and cacheCheck once they land.
  - `postFromFilters: Step<Adapter>[]` -- route-scope cache-store
    filter (chain position #10).
  - `errorHandler?: ErrorHandler` -- the `.error()` route-scope
    catch (chain position #1; implemented as the queue loop's
    try/catch boundary rather than a step).
- Parse (chain position #3) is **dynamic per exchange** (set on
  exchange internals by the source adapter), so `runSteps`
  interleaves it at runtime between `preParseFilters` and
  `postParseFilters`.
- The cache key flows from `cache-check` to `cache-store` via
  `internals.cacheKey` on the exchange (per-invocation, no shared
  closure).
- The builder assembles all three arrays in the chain order
  regardless of which `.authorize()` / `.cache()` / `.error()`
  methods were called first on the builder.

Eager input validation (chain position #4 conceptually) still
runs in `Route.buildConsumerHandler()` rather than as a chain
step. This is **a deliberate scoping choice** for the v1
refactor: moving it into the chain alters when `context:error`
fires for cross-route validation failures (the consumer route's
chain fires `context:error` from the runSteps catch instead of
the eager throw-and-propagate path). Folding it in is tracked
as a follow-up; until then, parse-attached sources still stash
the validator on `internals.applyValidation` and the parse step
runs it.

Filters 5-8 (`throttle`, `circuitBreaker`, `retry`, `timeout`)
will be added by their respective issues into the
`postParseFilters` slot at the documented positions. Each adds
~one filter implementation, not ~100 lines of inlined `runSteps`
logic.

---

## 7. Cross-references

- `.standards/resilience-wrappers.md` -- the dual-mode wrapper
  pattern (step-scope wrappers); the route-scope half is this
  chain.
- #112 -- `.cache()` operation (filters 9-10 shipped here).
- #119 -- route-level `.error()` (filter 1 shipped here).
- #140 -- dual-mode wrapper pattern (closed; the contract this
  chain inherits at the route-scope side).
- #139 -- circuit breaker (filter 6 will land here).
- Spring Security `FilterChainProxy`: similar pattern at a
  different scale.
- Resilience4J wrapper composition: the resilience-tier ordering
  follows their convention.
