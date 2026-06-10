# Architecture Spike Findings (2026-06)

Exploratory development spike on branch `claude/routecraft-architecture-review-7m3c6b`,
baseline commit `074589c`. Everything below was implemented, measured, and
verified (1,557 tests green, `bun run all` at the end); the branch is a
working prototype, not a merge decision. Each change carries a verdict and
a keep / rework / drop recommendation so the productionization story can
cherry-pick.

All benchmarks: Bun 1.3.11, `scratch/bench/`, 3-run medians.

## Headline numbers

| Metric | Baseline | After spike | Delta |
|---|---|---|---|
| emit hot path (telemetry-style subscriptions) | 751k emits/s (1331 ns) | 1.50M emits/s (667 ns) | **2.0x** |
| plain route (direct -> 3 transforms -> noop) | 32.2 us/exchange | 24.3 us/exchange | **-25%** |
| `.error()`-wrapped route (3 wrapped transforms) | 49.1 us/exchange | 25.9 us/exchange | **-47%** |
| split(10) -> transform -> aggregate | 156.2 us/exchange | 120.1 us/exchange | **-23%** |
| `packages/routecraft/src` code lines (cloc, comments/blanks excluded) | 14,720 | 14,649 | **-71** |
| `packages/routecraft/src` comment lines | 8,914 | 8,987 | +73 (new contract JSDoc) |
| largest file (`route.ts`) | 1,870 | 843 | -55% |
| `context.ts` / `types.ts` | 1,004 / 802 | 781 / 525 | -22% / -35% |
| typecheck wall time | 7.7 s | 8.1 s | noise |
| tests | 1,523 | 1,557 | +34 |

Honest LOC verdict: raw `wc -l` is flat (+29), but split by cloc the
executable code SHRANK by 71 lines while comments grew by 73 -- the flat
total is contract JSDoc on the new public surfaces (StepOutcome,
Subscription, EventDetailsMap, registerErrorCodes), not code growth. The
-71 is net of two additions it had to pay for: the generator-source
feature (~60 code lines) and the error-registry runtime (~80).
`packages/ai` grew +24 code lines: exactly the declaration-merge blocks
for the error codes and MCP events it now owns instead of core. Still,
the original "-150 to -250 LOC" estimate for the step-outcome change
alone was wrong; the real payoff was the 47% wrapper overhead reduction
and the deleted footgun, with size roughly neutral.

## Per-change verdicts

### A. Quick wins -- KEEP ALL

- **A1 dedupe `isParseError`** (e0170da): trivial, zero fallout.
- **A2 stale excludes**: 17 entries for deleted test files removed from
  tsconfig/eslint.
- **A3 factory tagging + conformance test** (cec564b): BETTER, and it
  caught real bugs. 11 untagged factories fixed, plus two untagged return
  paths inside factories believed tagged (html transformer mode, json
  transformer mode) -- `mockAdapter(html)` / `mockAdapter(json)` silently
  no-oped for those modes. Conformance-test-over-lint-rule was the right
  call (an ESLint rule cannot see through multi-branch factories).
- **Baseline bug fixed** (7ae394b): `mock.module("../src/mcp/dispatch.ts")`
  leaked across bun test files (module mocks are process-global and not
  restorable), breaking 3 tests in full-suite runs only. Replaced with
  recording managers in `MCP_STDIO_MANAGERS`. Lesson: prefer store-seam
  fakes over `mock.module`; audit the remaining `mock.module` sites
  (llm providers, sdk client) if their real modules ever need testing.

### B. Structural refactors -- KEEP ALL

- **B1 EventBus extraction** (9c690dc): pure win, no behavior change,
  emit perf identical pre-D9. Gave D9 an isolated landing zone.
- **B2 config appliers / DIP fix** (2f55da4): core `CraftConfig` now
  carries only `name/store/on/once/plugins`; cron, direct, mail, telemetry,
  and http keys live in per-module config appliers (the http precedent,
  copied). One gotcha worth remembering: `start()` awaiting `initPlugins()`
  unconditionally added a single microtask and reordered events in 14
  interleaving-sensitive tests; a synchronous `pluginsInitialized` guard
  fixed it. Behavior changes (intentional, breaking): store seeding moves
  to initPlugins; mail drain moves to reverse-plugin-order teardown.
- **B3 route.ts decomposition** (7310d23, bc71a30, 9539dc3):
  1,870 -> 843 lines across `pipeline/synthetic-steps.ts` (379),
  `pipeline/validation.ts` (291), `pipeline/executor.ts` (~500). Verbatim
  moves with deps objects; event order provably unchanged.

### C2. Namespaced open error registry (443a57a) -- KEEP

`RCCode` is now `keyof ErrorCodeRegistry` (declaration-merged) plus
`registerErrorCodes(namespace, codes, owner)`. Namespaces are claimable by
exactly one owner package; a second claim throws RC1003 naming BOTH
packages (TypeScript silently merges identical declarations, so the
compiler alone cannot catch cross-package code collisions). `RC` is
reserved for core; codes must be namespace + 4 digits. `@routecraft/ai`
owns `AI1001-AI1003` (formerly RC5025-RC5027). The closed union earned its
keep on the way out: the compiler found every moved-code reference.

### C1. Step outcome contract + takePending (6c70515) -- KEEP

`Step.execute(exchange, ctx) => Promise<StepOutcome>`; the executor owns
all scheduling. Two design findings vs the original sketch:

1. The 3-variant outcome union was insufficient. Five are needed:
   `continue` / `complete` (route-cache hit skips remaining steps,
   successfully) / `drop` / `branch` (choice prepends its branch steps) /
   `fanOut` (split).
2. `StepContext.takePending(predicate)` reproduces aggregate's sibling
   splice byte-identically (survivor-only collection; never waits on
   filter-dropped children). The textbook correlation-buffer aggregator
   was REJECTED: a count-based barrier waits forever on children dropped
   between split and aggregate; completion-criteria machinery is a v1+
   feature RFC, not a refactor.

The wrapper buffer/relay protocol (capture inner pushes, re-relay with
remaining steps, clear on recovery) is deleted; wrappers try/catch the
inner's outcome. This removes the correctness rule every future
retry/timeout/circuitBreaker wrapper would have had to honour, and makes
partial-fan-out corruption structurally impossible. Found en route: the
old engine silently discarded a wrapped choice's branch steps under
`.cache()`; now a loud RC5003. The split wrapper ban stays (recovery
would collapse N children into 1 recovered exchange, changing pipeline
cardinality); the aggregate ban stays (shared join state via takePending).
S2 landed here: `CallableAggregator` returns `AggregateResult` ({ body,
headers? }) instead of a fabricated `Exchange`.

Measured: wrapper overhead vs plain went from +53% to ~0-7%.

### C3. Subscription-object source contract (85dcbb4) -- KEEP

`CallableSource` collapses from five positional parameters to
`(sub: Subscription<T>)` with `{ context, signal, meta, ready(),
complete(reason?), emit(Message<T>) }`. The pre-existing `Message` type is
finally used at the boundary it was written for. Found en route: the MCP
source passed a 5th positional `principal` argument the engine never
accepted (dead since the headers unification). File-family adapters
(json/csv/html) now delegate by deriving a subscription with a
parse-attaching emit -- markedly cleaner than re-threading positionals.
New `@routecraft/testing` `testSubscription()` helper made the direct
subscribe tests a one-line migration. S1 landed here: `Adapter` declares
the optional `adapterId` it always relied on; the `getAdapterLabel` casts
and the no-empty-object-type lint suppression are gone.

### D9. Fixed event names, identity in payload (d31a119) -- KEEP, biggest single win

Event names are a fixed finite set (`route:exchange:failed`, routeId in
the payload); `EventDetailsMap` is one flat declaration-mergeable
interface replacing seven template-literal unions and a ~250-line nested
conditional payload mapper. The bus supports exact names plus a single
catch-all `"*"`; legacy patterns throw RC2001 with migration guidance;
`forRoute(routeId, handler)` is the per-route filter. The event source
adapter keeps its pattern UX by matching against `payload._event` behind
one catch-all subscription (cold path). `@routecraft/ai` declares its
`plugin:mcp:*` events by merging (they previously leaned on an open
`plugin:${string}` template escape hatch).

Measured: emit 2x; whole-pipeline -24% (plain) to -27% (split-agg) on top
of C1's wrapper win. The wildcard matcher was a real fraction of pipeline
cost, not just subscription-time overhead, because every emit scanned all
wildcard patterns.

Migration notes for the real PR: my mechanical rename pass corrupted a
handful of names whose first payload segment parsed as a route id
("route:batch:stopped" -> "route:stopped"); a diff-pairing audit caught
them all, but the production migration should use an explicit old->new
name table, not a regex.

### E. Blank-canvas experiments

- **E1 generator/iterable sources (3d48ea4) -- KEEP.** Implemented:
  `.from(async function* (sub) { yield item })` and bare (async)
  iterables, ~120 lines on top of C3 including tests. The Subscription
  object made this nearly free, which is itself evidence for C3.
- **E2 typed route handles (`ctx.route(handle).send()`) -- EVALUATED,
  NOT BUILT.** `CraftClient.send(routeId, body)` plus the
  `DirectEndpointRegistry` declaration-merge already gives typed direct
  invocation; a handle API would be a third way to do the same thing.
  Revisit only if the registry approach proves insufficient at v1.
- **E3 outcome-returning user steps -- EVALUATED, NOT BUILT.** Exposing
  `drop` from `.process()` duplicates `.filter()` (which already supports
  `{ reason }` results) and would blur the exchange-state-model halt
  contract. The internal StepOutcome should stay internal until a concrete
  use case cannot be expressed with filter/choice/halt.

## Deferred items (unchanged from the review, with rationale)

D1 Store class extraction (trivial delegation); D2 splitting
exchange.ts/types.ts (cohesive; types.ts shrank 35% anyway); D3
mail/shared.ts internal split (B2 fixed the only boundary violation); D4
file adapter double cast (documented type-level design); D5 generic
options-discriminator (standard mandates structural checks); D6
MCP/Express coupling (contained behind optional peer; OAuth seam at
server.ts ~:700-990); D7 test-runner unification (the single vitest file
is deliberate cross-runtime infrastructure; the initial review claim that
bun tests were the minority was inverted -- it is 108 bun files vs 1);
D8 ESLint tagging rule (superseded by the A3 conformance test);
TS project references (typecheck is 8s; not worth a multi-day migration).

## Cost/value audit (decided and kept, recorded so the next review does not re-measure)

cosine+group (~300 LOC, zero examples), html adapter (514 LOC, zero
examples), telemetry plugin (~1.5K LOC, Bun-only SQLite sink), CLI TUI
(~3K LOC). All evaluated, all kept by explicit decision.

## Known stale surfaces (must be fixed in productionization)

- `.standards/adapter-architecture.md`, `.standards/resilience-wrappers.md`,
  `.standards/exchange-state-model.md`, and `skills/` authoring guides
  still document the positional subscribe signature, the wrapper buffer
  protocol, and hierarchical event names.
- Docs site: events pages were mechanically updated; introduction/monitoring
  and FAQ pages were touched but deserve a prose pass. The configuration
  reference table now drifts further from code (B2 moved keys into
  per-module config appliers) -- fold into the existing codegen ticket.
- The root `bun run craft` shortcut invokes `dist/index.js` via node, but
  the built CLI now exits with "requires Bun" -- this contradicts the
  CLAUDE.md note and is PRE-EXISTING on the baseline (reproduced at
  074589c). Decide: fix the script to use bun, or restore node support.

## Draft user story (productionization)

> **As a** Routecraft maintainer **I want** the pre-v1 architecture
> changes from the 2026-06 spike landed as reviewable PRs **so that**
> the v1 API freezes on the safer contracts and the measured performance
> wins ship.
>
> Slices (each independently shippable, in order):
> 1. Quick wins + baseline test fix (A1-A3, mock.module fix) -- non-breaking.
> 2. Structural extractions (B1-B3) -- non-breaking.
> 3. Namespaced error registry (C2) -- breaking: RC5025-27 -> AI1001-03.
> 4. Step outcome contract (C1+S2) -- breaking for custom Steps/aggregators.
> 5. Subscription source contract (C3+S1) + generator sources (E1) --
>    breaking for all source adapters and inline sources.
> 6. Fixed event names (D9) -- breaking for all event subscribers; use an
>    explicit old->new name table for the migration, never regex; include
>    the standards/docs/skills rewrite.
>
> Acceptance: all suites green; telemetry event-ordering suite proves
> emission order; benchmarks reproduce within 10% of the spike numbers
> (emit >= 1.3M/s, wrapped overhead <= 10%); standards docs updated.

## Process learnings

- The conformance-test pattern (factory tagging, error registry) catches
  what lint rules and code review structurally cannot; prefer it for any
  "every X must do Y" contract.
- Declaration-merged registries (errors, events, config keys, stores,
  headers) are now the uniform extension mechanism; each needs its
  interface EXPORTED from the package index or augmentations silently
  fail to merge (hit twice during the spike).
- Single-wildcard catch-all + payload filtering covers every observed
  subscriber need (telemetry, TUI, event adapter); nothing in the repo
  needed real pattern matching on the hot path.
- Two pre-existing silent bugs surfaced only because contracts got
  stricter: untagged factory branches (A3) and cache-wrapped choice
  discarding branch steps (C1).
