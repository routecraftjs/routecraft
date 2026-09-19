# Spike: plugin architecture

Throwaway. Depends on nothing in `packages/`, ships nothing, and exists to
answer one question: **does the proposed architecture survive contact with
TypeScript, or does it only work in prose?**

```bash
cd spikes/plugin-architecture
bun test          # 26 tests
bun run typecheck # strict, exactOptionalPropertyTypes, noUncheckedIndexedAccess
bun run demo      # wires six plugins and runs a route
```

## What it builds

A miniature of the design: core as lifecycle plus two seams, everything else
a plugin.

| Module | Role |
|---|---|
| `contracts/` | Interfaces only. Token, Exchange, Step, Pipeline, RouteView, Source, the four contribution kinds, Plugin, PluginContext. |
| `kernel/` | Plugin host. Topological sort by `dependsOn`, apply then start, health, reverse teardown. |
| `registry/` | `provide` / `require` / `optional` by token. Core never types the values. |
| `events/` | Observation seam. |
| `interventions/` | Participation seam. Wrapper ordering by declared constraints, step table, handlers, exchange extensions. |
| `runtime/` | Minimal exchange and executor. Owns ordering, owns no wrapper and no step. |
| `plugins/` | `operations`, `resilience`, `stores`, `deferral`, `telemetry`, and `audit` (a deliberate stranger). |
| `builder/` | Three candidate answers to the hardest question. See F3. |

The demo output, which is the whole thesis in six lines:

```
install order:  routecraft.stores -> acme.audit -> routecraft.deferral ->
                routecraft.telemetry -> routecraft.operations -> routecraft.resilience
wrapper chain:  routecraft.admission -> routecraft.retry -> acme.audit ->
                routecraft.timeout -> routecraft.concurrency
```

`acme.audit` is a third-party plugin. It lands in the middle of a first-party
resilience chain, consumes a first-party API, and contributes a step, with no
change to core and no change to `resilience`. That is P1 for this surface.

## Findings

### F1. Exchange extensions cost the `ex.deferral` ergonomics

Core cannot type a named property it does not know about, so plugin state is
reachable as `ex.use(DEFERRAL_EXT)` rather than `ex.deferral`. This is a real
regression from today and it is recorded rather than hidden. A plugin can
layer the sugar back with declaration merging, but then it inherits F3.

**Open:** is `ex.use(TOKEN)` acceptable, or does the DSL's readability make
this the one place declaration merging is worth its unsoundness?

### F2. A union of contributions erases its own generic

`contribute(c: Contribution)` collapses `ExchangeContribution<T>` to
`ExchangeContribution<unknown>` at the call site, so the factory's return type
stops being inferred and the body becomes implicitly `any`. `tsc` caught it on
the first run. Fixed with a typed overload ahead of the union.

**Lesson for the real thing:** every generic contribution kind needs its own
overload, or the union silently widens it. This is the same failure mode as
C1's field bag, one level down.

### F3. Declaration merging is type-unsound, and the alternative works

This is the finding that matters, and it is proven by a passing test rather
than argued.

**Candidate B, what `registerDsl` does today.** The runtime half patches a
prototype; the type half is a separate `declare module`. Nothing correlates
them. `builder.test.ts` declares a `ghost()` method, never registers it, and
the code **compiles**. It throws `TypeError` at runtime.

**Candidate C, derive the builder from the installed plugin set.** A plugin
declares its steps in its type (`as const satisfies TypedPlugin`), and the
builder type is computed from the plugins actually passed in. Two consequences:

- There is no second half, so nothing can drift.
- **Declining a plugin removes its method from the type**, not just at
  runtime. The test asserts this with `@ts-expect-error`, which only passes
  because `defer` genuinely is not on the builder when deferral is absent.
  That makes P7 checkable by the compiler.

**Costs, stated:** a `Proxy` at runtime; step contributions become declarative
data on the plugin rather than imperative `ctx.contribute` calls; the builder
type is recomputed per plugin set, which is untested at forty operations and
may be where it falls over.

**Unresolved tension:** if steps are declarative and wrappers are imperative,
the "one interface, tiered by declaration" story splits. Either wrappers
become declarative too, or the split needs a reason better than convenience.

### F8. `from` and type flow: four encodings, two survive, and the sound one is not fluent

This was the one open question with the weight to kill the design. Four
encodings were tried under `src/typed/`. Each verdict is a compile-time
assertion or a passing test, not an opinion.

| | fluent chain | body type flows | plugin-extensible | sound |
|---|---|---|---|---|
| **A** naive inference from a generic factory | yes | **no** | yes | n/a |
| **B** derived from the installed plugin set | yes | **no** (same reason as A) | yes | yes |
| **C** merged interface with a body type parameter | **yes** | **yes** | **yes** | **no** |
| **D** free functions in a pipe | no | **yes** | **yes** | **yes** |

**A fails on a hard limit of the language, not a detail.** `infer` against a
generic function instantiates its type parameters at their constraints, so
the relationship between a step's input and output body is erased at exactly
the point the builder needs it. `a-naive.check.ts` asserts the erasure at
compile time, so if a future TypeScript fixes it, the assertion breaks and
tells us.

**B inherits A's failure.** The derived builder from F3 is sound and makes
declining a plugin visible to the compiler, but it cannot carry a body type
through the chain for the same reason A cannot.

**C works and is what ships today.** `StepBuilderBase<S extends BuilderState>`
with `Retyped<this, SetBody<S, R>>` is this encoding. The plugin author writes
the whole signature including the return type, so the body relationship
survives. `c-merged.check.ts` proves the body flows through
`{subject, size} -> string -> string -> number` with every argument inferred
rather than annotated. It is also the encoding F3 proved unsound.

**D is sound because the declaration IS the implementation.** An operator is
an ordinary exported function; there is no second half to drift, no global
interface, no prototype patching, no proxy. `d-pipe.check.ts` proves the same
body flow. The cost is the fluent chain, which is Routecraft's most
recognisable surface, plus a `pipe` overload per arity.

**The conclusion, stated plainly.** In TypeScript today you can have a fluent,
body-typed, plugin-extensible DSL, or you can have a sound one. Not both.
Every framework with this shape has made the same trade, and Routecraft
already chose fluency. The design does not change that trade; it only makes
it visible and confines the unsoundness to one mechanism instead of
scattering it.

### F4. Ordering constraints against absent plugins must be inert

`deferral`'s admission wrapper declares `after: ["routecraft.authorize"]`, and
auth may not be installed. The spike treats an unmatched constraint as
satisfied rather than fatal, so the chain still orders.

**The trade:** a typo in a constraint id is now silently ignored. The
alternative, refusing unknown ids, makes every optional dependency a hard one.
Neither is free; the spike picked inert and says so.

### F5. Step name collisions are unresolvable and must fail at apply

Two plugins contributing `transform` cannot both win. Refused at apply,
naming both plugins. Matches today's `registerDsl`, which throws on a name
already present.

### F6. Contributions must freeze at start

A plugin contributing from its `start` hook would silently miss a chain that
was already composed. The registry freezes after apply and throws instead.

### F7. One topological sort serves both graphs

Plugins by `dependsOn` and wrappers by `before`/`after` are the same problem.
`kernel/graph.ts` is used by both, and a cycle in either is named in the
error. This is evidence for A7: core knows about dependency, and that is a
single mechanism rather than a family of them.

## What this spike does not answer

Listed so nobody mistakes a green suite for a validated design. `from` and
type flow moved out of this list in the second round; see F8.

- **Halt and continue semantics.** The executor runs steps to completion or
  throws. The real one has a halt contract this does not model.
- **Teardown under partial failure.** Tested for plugins, not for a failure
  midway through an exchange with handlers registered.
- **Cost.** A registry-driven chain composed per route versus a compiled one
  has not been measured.
- **The store contract.** Deliberately a mock. A5 and D10 are argued in the
  design document and not tested here.

## Relationship to the design documents

- Principles, findings and the full proposal: the plugin architecture artifact
- Evidence for every claim about the current codebase: the boundary register

This spike is the third leg. Where it contradicts either document, the spike
wins, because it executes.
