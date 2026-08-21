# Pre-from Filter Chain

The framework runs a fixed, ordered chain of filters around every
exchange before the user pipeline runs (and a small tail after it).
The chain is the contract: it is **not affected** by the order in
which `.input()`, `.authorize()`, `.cache()`, `.error()`, etc. are
called on the builder. Builder order is for ergonomics; runtime
order is the framework's call.

---

## 1-5. The chain (user-facing contract)

Outside in: `error` → `authorize` → `parse` → `input` → `throttle`
→ `circuitBreaker` → `retry` → `timeout` → `concurrency` →
`cacheCheck` → user pipeline → `cacheStore`.

The full contract is documented user-facing at
`apps/routecraft.dev/app/content/docs/advanced/filter-chain/index.mdx`
(site: `/docs/advanced/filter-chain`): the chain table with
per-position rejection RC codes, why the order is fixed
(deterministic gates above resilience wrappers, cache below them),
`.error()` composition including the do-not-collapse rule for the
authorize vocabulary (`RC5023`, `RC5020` and the delegation codes
`RC5034`-`RC5038`; full vocabulary in [security.md](./security.md)),
the combined-wrapper scenarios, and what the chain commits the
framework to (no reorder API, all wrappers throw on rejection,
recovery is opt-in per RC code in the `.error()` handler). That
page is the source of truth for the chain's observable behaviour;
do not re-document it here.

What the docs page does not carry stays below: how each chain
position maps onto `RouteDefinition` and the pipeline executor.

---

## 6. Implementation status

Today (as of #112 / #395 / 0.6.0):

- All filters 1-10 are implemented; the chain runs in the order
  documented above.
- The chain is **first-class data** on `RouteDefinition`:
  - `preParseFilters: Step<Adapter>[]` -- authorize steps in
    declaration order (chain position #2).
  - `postParseFilters: Step<Adapter>[]` -- route-scope cache-check
    filter (chain position #9). Route-scope `throttle` (#5) is a
    one-shot gate but must sit OUTSIDE the retry / timeout segments,
    which wrap this array, so it rides on its own field (below)
    rather than here.
  - `circuitBreaker?: CircuitBreakerController` -- route-scope
    `.circuitBreaker()` (#6). Unlike the cache filters it is not a
    flat step: it scopes OVER the tail (when open it skips the tail;
    when closed it runs it and observes the outcome) and holds
    persistent per-Route state (the failure window + open/half-open
    machine), so the builder stores the live controller here once and
    the executor wraps the tail in a breaker segment around it,
    OUTSIDE the retry (#7) / timeout (#8) segments.
  - `postFromFilters: Step<Adapter>[]` -- route-scope cache-store
    filter (chain position #10).
  - `errorHandler?: ErrorHandler` -- the `.error()` route-scope
    catch (chain position #1; implemented as the queue loop's
    try/catch boundary rather than a step).
- Parse (chain position #3) is **dynamic per exchange** (set on
  exchange internals by the source adapter), so `runPipeline`
  interleaves it at runtime between `preParseFilters` and
  `postParseFilters`.
- The cache key flows from `cache-check` to `cache-store` via
  `internals.cacheKey` on the exchange (per-invocation, no shared
  closure).
- The builder assembles all three arrays in the chain order
  regardless of which `.authorize()` / `.cache()` / `.error()`
  methods were called first on the builder.

Input validation (chain position #4) is folded into the chain
(#447). Like parse, it is dynamic per exchange:
`Route.buildConsumerHandler()` stashes the validator on
`internals.applyValidation` for every source shape, and
`runPipeline` runs it inside the synthetic parse step when the
source attached a parser (input validates the parsed body, so #3
and #4 collapse into one step) or as a standalone synthetic input
step (`buildInputValidationStep`, `operation: "input"`, adapter id
`routecraft.input`) when it did not. Both paths throw `RC5002`
through the chain catch boundary, so `.error()` (position #1) can
observe and recover a validation failure regardless of source
shape, and the old eager path's `exchange:dropped` emission is
gone: an unrecovered RC5002 takes the normal
`step:failed` -> `route:error` / `context:error` /
`exchange:failed` path.

The fold intentionally re-specified cross-route `context:error`
timing (#447's known constraint): a consumer-side validation
failure now fires the CONSUMER route's error path first (from its
own runPipeline catch) and then rejects the producer's
`.to(direct())` step, which fires the producer's error path too --
two `context:error` events for one bad message, identical to any
other consumer-route failure. Previously the eager path emitted
`exchange:dropped` on the consumer and only the producer fired
`context:error`. Covered by
`packages/routecraft/test/input-chain.bun.test.ts` and the
cross-route accounting notes in
`packages/routecraft/test/direct-validation.bun.test.ts`.

Filters 7-8 (`retry` #148, `timeout` #147) are shipped. They are
NOT flat `postParseFilters` entries: each scopes OVER the chain
tail below it (retry re-runs it, timeout bounds each run), which a
sequential filter in a flat step queue cannot express. They live as
`retry` / `timeout` fields on `RouteDefinition`; the pipeline
executor wraps the tail (`postParseFilters` + user steps +
`postFromFilters`) in segment steps that re-enter `runPipeline`
with `rethrowUnhandled` so a failed attempt surfaces to the
wrapping segment instead of firing the default error path per
attempt. See `buildRetrySegmentStep` / `buildTimeoutSegmentStep`
in `packages/routecraft/src/pipeline/executor.ts`.

Filter 5 (`throttle` #151) is shipped. It is a one-shot admission
gate (it neither re-runs nor bounds the tail), so it is a flat
`buildThrottleCheckStep` rather than a segment; but because the chain
places it OUTSIDE retry (#7) / timeout (#8), the executor prepends it
to the tail AFTER those segments wrap, so a retried attempt re-runs
only the tail below it and never re-acquires a token. It rides on the
`throttle` field of `RouteDefinition` (built once per route around a
shared token bucket), not in `postParseFilters` (which the segments
wrap). See `buildThrottleCheckStep` in
`packages/routecraft/src/pipeline/synthetic-steps.ts` and the
`deps.definition.throttle` placement in
`packages/routecraft/src/pipeline/executor.ts`.

Filter 8.5 (`concurrency` #448) is shipped. Like the circuit breaker it
scopes OVER the tail (acquires a slot, runs the tail, releases on settle)
and holds persistent per-Route state (the slot pool / semaphores), so its
live `ConcurrencyController`(s) ride on the `concurrency` field of
`RouteDefinition` (built once per route; one controller per stacked
`.concurrency()` call) and the executor wraps the tail in a bulkhead
segment per controller. It is the INNERMOST resilience segment, wrapped
BEFORE retry (#7) / timeout (#8) so each is outside it: a slot is held per
attempt and freed between retry backoffs, and a `reject`-mode `RC5026` can
be re-attempted by an outer retry. See `buildConcurrencySegmentStep` in
`packages/routecraft/src/pipeline/executor.ts`.

Filter 6 (`circuitBreaker` #139) is shipped. Like retry / timeout it
scopes OVER the tail (it conditionally runs and observes it), so it is
a segment, not a flat `postParseFilters` entry. Unlike them it also
holds persistent per-Route state, so its live `CircuitBreakerController`
rides on the `circuitBreaker` field of `RouteDefinition` (built once per
route) and the executor wraps the tail in a breaker segment around it,
OUTSIDE the retry (#7) / timeout (#8) segments and INSIDE the throttle
(#5) gate. See `buildCircuitBreakerSegmentStep` in
`packages/routecraft/src/pipeline/executor.ts`. The route-scope breaker
fast-fails (fallback or `RC5025`) when open but does NOT yet pause the
source consumer during cooldown; true source backpressure is a tracked
follow-up (see `.standards/resilience-wrappers.md` section 7).

---

## 7. Resume re-enters partway down the chain

Three runs re-enter a route partway down its pipeline: a `.resume()` reviving a `.suspend()`, a `.debounce()` release, and an `enterErrorChannel()` re-entry pushing a failure at an exchange that is not running. None re-enters the chain by traversing it, so which positions apply is **declared per position** in `pipeline/chain-policy.ts` rather than implied by how the run is executed.

`CHAIN_SURVIVAL` is keyed by `Exclude<keyof RouteDefinition, NonChainField>` and valued by a record over every kind, so each position states an answer for all three, with its own reason for each. Adding a field to `RouteDefinition` fails the build until it is either excluded as a non-chain field or given a policy; adding a fourth kind fails every row until each says what it means. `detachedDefinition()` builds the executed definition from that record, and `ExecutorDeps["definition"]` is the same type it produces, so the fields the executor consumes cannot drift from the fields the policy classifies.

Per-kind reasons are not ceremony. The same position is off for genuinely different reasons: `circuitBreaker` is off for a resume because a continuation runs after the suspension is claimed, so refusing there spends an approval, and off for the error channel because an open breaker must not suppress the report of a failure.

As declared today, a resume carries `error` (#1), `retry` (#7), `timeout` (#8) and `concurrency` (#8.5); a debounce release and an error-channel re-entry each carry `error` alone. A re-entrant suspend site (a suspend-capable `.to()` / `.enrich()` step such as the agent step) resumes under the same policy; the only difference is that its continuation begins with the suspending step itself, which re-runs to finish the work it parked in the middle of. The user-facing per-position table with the reasoning is on the [filter chain page](https://routecraft.dev/docs/advanced/filter-chain); do not re-document it here. The reasons also live beside each entry in the policy record, which is what a maintainer reads first.

One caveat belongs here rather than on the docs page, because it is a property of the chain ORDER this standard fixes: `timeout` (#8) wraps `concurrency` (#8.5), so a route declaring both can have a resume's deadline elapse while its continuation is still queued for a slot, failing work that never started. Narrowing that needs the order to differ per kind, which section 2 does not allow.

`error` (#1) is load-bearing rather than incidental: without it, a re-ask would have nowhere to run, since the ingress route cannot notify the approver. Note the split it carries: a continuation failure reaches the suspended route's handler, and so do `RC5047` (expired) and `RC5048` (changed continuation), because each strands an approver at the moment it is discovered. `RC5046` (unknown suspension), `RC5049` (rejected answer) and `RC5050` (denied) stay in the resume ingress route only. `RC5050` is worth stating explicitly because it reads as though it belongs with the first group: it is raised from `settled()`, which fires on a replay against an already-terminal record, and the single notification for that denial already went out as `RC5048` when the denial was recorded. Re-asking again per replay is the amplifier the transition latch exists to prevent.

**A continuation that needs a position that stays off delegates to a route that has it** (`.to(direct('...'))` after the suspend). That target is an ordinary route, so all ten positions apply to it and it authorizes on its own terms rather than on a restored principal. This is the documented answer to "my post-approval work needs `authorize` or a circuit breaker", and it is why the framework does not grow a second chain for continuations.

## 8. Cross-references

- `.standards/resilience-wrappers.md` -- the dual-mode wrapper
  pattern (step-scope wrappers); the route-scope half is this
  chain.
- #112 -- `.cache()` operation (filters 9-10 shipped here).
- #119 -- route-level `.error()` (filter 1 shipped here).
- #140 -- dual-mode wrapper pattern (closed; the contract this
  chain inherits at the route-scope side).
- #139 -- circuit breaker (filter 6, shipped here).
- Spring Security `FilterChainProxy`: similar pattern at a
  different scale.
- Resilience4J wrapper composition: the resilience-tier ordering
  follows their convention.
