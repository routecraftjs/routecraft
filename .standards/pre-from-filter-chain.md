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

As of 0.8 (see [plugin-architecture.md](./plugin-architecture.md) section 3):

- All positions 1-10 are implemented; the chain runs in the order
  documented above.
- **The definition carries configuration, never the thing that does the
  work.** `RouteDefinition` holds `authorize` (one entry per
  `.authorize()` call), `throttle` (one per call), `circuitBreaker`,
  `retry`, `timeout`, `concurrency` (one per call) and `cache` as
  resolved options, plus `errorHandler` (position #1, the run's catch
  boundary rather than a step). The position options are plain data, safe
  to share across applications; the definition as a whole is not, since it
  also carries the route's `sources`, its `steps` and the `errorHandler`
  closure.
- **Providers fill the positions per application.** When a route compiles
  (before any route starts), `compilePositions()` in
  `packages/routecraft/src/pipeline/positions.ts` asks the application's
  `RESILIENCE`, `CACHE` and `ENFORCEMENT` providers for each configured
  position. The defaults (`routecraft.resilience`, `routecraft.cache`,
  `routecraft.auth`) are installed in every application; a plugin that
  `replaces` the port fills the position instead. A configured position
  with no provider is `RC1111` and the application does not start. A
  breaker's window and a bulkhead's slots are built once per route by the
  provider, so they are the route's own.
- **One position step.** The executor wraps the tail in one generic step
  per surrounding position (`buildPositionStep` in
  `packages/routecraft/src/pipeline/executor.ts`), handing the provider a
  `PositionRun`: `attempt(signal)` runs the tail once through a nested
  executor that rethrows instead of failing the exchange, plus `signal`
  (intake or abandon), `abandon`, `mustWait`, `forward` and `emit`. The
  provider decides how often, and whether, the tail runs; the executor owns
  what one run of it is. Gates (`authorize`, `throttle`) and the cache
  pair are ordinary steps the providers return.
- **Plugin hooks sit in named slots between positions**: `beforeAuth`
  before `authorize`, `afterAuth` after it, `admitted` once `input` has
  run, `perAttempt` inside `retry` and outside `timeout`, `exit` after
  the pipeline and before the output stage, and `error` beside the
  catch boundary. Order within a slot is phase first (observe, mutate,
  validate), then the plugin list; see plugin-architecture.md section 3.
- Parse (chain position #3) is **dynamic per exchange** (set on exchange
  internals by the source adapter), so `runPipeline` interleaves it at
  runtime between `authorize` and the rest of the chain.
- The cache key flows from `cache-check` to `cache-store` via
  `internals.cacheKey` on the exchange (per-invocation, no shared
  closure). `cache-check` derives it after `authorize` and `input` have
  run; the default key hashes the route id, a fingerprint of the pipeline
  a hit skips (`RouteDefinition.cachePipeline`, set at build), the
  principal's issuer and subject with each `actor` hop, and the validated
  body, and a custom `key` is used verbatim (see `.standards/security.md`
  section 4). Because `cache-check` runs before the pipeline, a route whose
  pipeline contains `.authenticate()` refuses route-scope `.cache()` at
  build (`RC5003`): a hit would skip authentication.
- The builder records the configuration in the chain's terms regardless of
  which `.authorize()` / `.cache()` / `.error()` methods were called first.

Input validation (chain position #4) is folded into the chain
(#447). Like parse, it is dynamic per exchange:
`Route.buildConsumerHandler()` stashes the validator on
`internals.applyValidation` for every source shape, and
`runPipeline` runs it inside the synthetic parse step when the
source attached a parser (input validates the parsed body, so #3
and #4 collapse into one step) or as a standalone synthetic input
step (`buildInputValidationStep`, `operation: "input"`, adapter id
`routecraft.input`) when it did not. Both paths throw `RC5065`
through the chain catch boundary, so `.error()` (position #1) can
observe and recover a validation failure regardless of source
shape, and the old eager path's `exchange:dropped` emission is
gone: an unrecovered RC5065 takes the normal
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

The surrounding positions nest, from the inside out: `concurrency`
(innermost, so a slot is held per attempt and freed between retry backoffs,
and a `reject`-mode `RC5026` can be re-attempted by an outer retry; stacked
calls nest with the first declared outermost), `timeout` (every attempt gets
its own deadline), the `perAttempt` slot, `retry`, then `circuitBreaker`
(outside retry, so one exhausted run of attempts records one failure). The
`throttle` gates run once per exchange outside all of them, so a retried
attempt never re-acquires a token. The route-scope breaker fast-fails
(fallback or `RC5025`) when open but does NOT yet pause the source consumer
during cooldown; true source backpressure is a tracked follow-up (see
`.standards/resilience-wrappers.md` section 7).

---

## 7. Resume re-enters partway down the chain

Four runs re-enter a route partway down its pipeline: a `.resume()` reviving a `.defer()`, a `.debounce()` release, an `enterErrorChannel()` re-entry pushing a failure at an exchange that is not running, and an **admission** resume of an exchange parked from the error path before the route admitted it. None re-enters the chain by traversing it, so which positions apply is **declared per position** in `pipeline/chain-policy.ts` rather than implied by how the run is executed.

`CHAIN_SURVIVAL` is keyed by `Exclude<keyof RouteDefinition, NonChainField>` and valued by a record over every kind, so each position states an answer for all four, with its own reason for each. Adding a field to `RouteDefinition` fails the build until it is either excluded as a non-chain field or given a policy; adding a fourth kind fails every row until each says what it means. `detachedDefinition()` builds the executed definition from that record, and `ExecutorDeps["definition"]` is the same type it produces, so the fields the executor consumes cannot drift from the fields the policy classifies.

Per-kind reasons are not ceremony. The same position is off for genuinely different reasons: `circuitBreaker` is off for a resume because a continuation runs after the deferral is claimed, so refusing there spends an approval, and off for the error channel because an open breaker must not suppress the report of a failure.

As declared today, a resume carries `error` (#1), `retry` (#7), `timeout` (#8) and `concurrency` (#8.5); a debounce release and an error-channel re-entry each carry `error` alone.

An **admission** resume carries those four and `authorize` (#2) as well, and it is the only kind that does. It exists because `recovery.defer()` can park a failure raised in the chain ITSELF, above the pipeline, so execution one never finished admitting the exchange: the continuation has to do it. The reason the `resume` column turns `authorize` off does not hold there, because a door's `elevate` hook supplied a LIVE principal, so `RC5043` does not fire and the gate that refused gets to read the lent scope; without it the lend would never be checked against the gate it was lent for. `input` (#4) runs too, rebuilt from `discovery.input`, which the live route still holds. `parse` (#3) does NOT: a source-attached parser arrives per message on the queue envelope and is neither storable with the record nor re-derivable from the route, so an admission park raised while one is pending is refused with `RC5051` rather than resumed against an unparsed body. Every other position keeps the answer it gives an ordinary resume, and for the same reasons: a position that REFUSES work without attempting it must not sit below the store transition. A re-entrant defer site (a defer-capable `.to()` / `.enrich()` step such as the agent step) resumes under the same policy; the only difference is that its continuation begins with the deferring step itself, which re-runs to finish the work it deferred in the middle of. The user-facing per-position table with the reasoning is on the [filter chain page](https://routecraft.dev/docs/advanced/filter-chain); do not re-document it here. The reasons also live beside each entry in the policy record, which is what a maintainer reads first.

One caveat belongs here rather than on the docs page, because it is a property of the chain ORDER this standard fixes: `timeout` (#8) wraps `concurrency` (#8.5), so a route declaring both can have a resume's deadline elapse while its continuation is still queued for a slot, failing work that never started. Narrowing that needs the order to differ per kind, which section 2 does not allow.

`error` (#1) is load-bearing rather than incidental: without it, a re-ask would have nowhere to run, since the ingress route cannot notify the approver. Note the split it carries: a continuation failure reaches the deferred route's handler, and so do `RC5047` (expired) and `RC5048` (changed continuation), because each strands an approver at the moment it is discovered. `RC5046` (unknown deferral), `RC5049` (rejected answer) and `RC5050` (denied) stay in the resume ingress route only. `RC5050` is worth stating explicitly because it reads as though it belongs with the first group: it is raised from `settled()`, which fires on a replay against an already-terminal record, and the single notification for that denial already went out as `RC5048` when the denial was recorded. Re-asking again per replay is the amplifier the transition latch exists to prevent.

**A continuation that needs a position that stays off delegates to a route that has it** (`.to(direct('...'))` after the defer). That target is an ordinary route, so all ten positions apply to it and it authorizes on its own terms rather than on a restored principal. This is the documented answer to "my post-approval work needs `authorize` or a circuit breaker", and it is why the framework does not grow a second chain for continuations.

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
