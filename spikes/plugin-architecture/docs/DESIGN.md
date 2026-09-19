Routecraft · architecture proposal · draft for validation
  
# Everything is a plugin

  

Core keeps the lifecycle and two seams. Everything that makes the framework valuable moves outside it, including what ships as main. Nine principles, what is impossible today, what the code shows, the blocks and their dependency graph, the design that follows, a running spike that tries to falsify it, and an independent validation that refuted sixteen of its figures and overturned its central technical conclusion.
  
    19 September 2026
    Evidence: [Boundary Register](https://claude.ai/artifact/434hdasBY6KJTiZLFZj6TS)
    Spike: `feat/dazzling-fermi-01x3ns`
    Validated once; 16 figures corrected
  

## 0. How to validate this

Written for the agents who will check it before anything is built, and for the one who will check the result afterwards.

  

**Principles may be disputed or amended.** They are stated as positions, not axioms. An amendment that survives argument is a better principle. A principle that cannot be defended should be struck, and the design that rests on it revisited.
  

**Findings must be independently reproduced or refuted.** Every number here is a command away from confirmation. Do not accept one because it is written down. Three claims in earlier drafts of the register were confidently wrong and were caught by reading the tree rather than trusting the signal.
  

**The design is only assessable once the principles are settled.** Judging section 4 against principles you have not accepted produces disagreement about the wrong thing.
  

**This document has been validated once, and sixteen of its figures did not survive.** All are corrected in place rather than deleted; section 8 records what changed and why. The direction of every finding held and several were understated, but **no number here is pinned to a commit**, which is the root cause of four of the sixteen. Treat a figure as a claim until a checked-in script reproduces it.
  

**Section 7 is runnable.** The spike is on branch `feat/dazzling-fermi-01x3ns` under `spikes/plugin-architecture/`. `bun test` and `bun run typecheck` take seconds and depend on nothing else in the repo. Where the spike contradicts this document, the spike wins, because it executes.
  

**Section 2 is the load-bearing evidence.** Each item there is binary and checkable in minutes. Section 3 is interpretive and requires agreeing on method first. If section 2 survives, the case stands whether or not section 3 does.

## 1. Principles

What this architecture is for. Each is traceable to an agreed entry in the register, and each is open to challenge.

  
### P1. Zero difference between inside and outside
 _(register: governing principle)_
  

Anything a first-party package can do, a third party can do through published API. Not "mostly", not "for the common cases". This is the principle every other one serves, and it must be true before 1.0.
  

**Amended after validation.** The original test — "if it compiles with no private import, the interface is real" — is too weak, and I1 shows why: a stranger passes it today by re-deriving a global symbol from its string, and proves nothing, because the thing they depend on is not a contract.
  
> **P1, amended.** Anything a first-party package can do, a third party can do through API that is **exported, documented and covered by the version policy**. A capability reachable only through a name that is not exported is not reachable, whatever the module system permits.
  

**Test:** move one first-party provider into its own workspace package depending only on exported symbols. The ratchet counts undocumented contract surfaces alongside private imports.

  
### P2. Core is lifecycle and interfaces. Nothing in core is logic
 _(register: A1)_
  

Core owns the interfaces and the lifecycle of everything implementing them: context, exchange, route, plugins. Ordering, readiness, health, failure, teardown. Core never owns an operation, an adapter, a transport, a provider, a store schema, or any rule about what data means.

  
### P3. Everything that is not core is a plugin, including main
 _(register: A6)_
  
> **The slogan is struck; the operative sentence is kept.** "Everything is a plugin" has four conceded exceptions written next to it before anything is built: the kernel, the event bus, `from` as a position, and the exchange and route contracts. A principle with four exceptions is not doing work. **Core defines the kinds; nobody in core defines an instance.** That is checkable, and it is the real principle. "Everything is a plugin" survives only as the name of the effort.
  

The package published today as `@routecraft/routecraft` becomes a set of first-party plugins with no privileges. Main ships `from()`, `transform()` and `retry()` through the same door a stranger uses, or the door is not real.

  
### P4. One plugin interface, tiered by declaration
 _(register: A3)_
  

A plugin declares what it participates in and implements only those parts. Two interfaces, one simple and one advanced, recreates the failure this work exists to remove: two things that must agree, maintained by hand.
  
> **P4, amended, because the spike violated it.** One plugin interface, and the type-level declaration of what a plugin contributes is *derived from the same value that is installed*. Two shapes that must agree is the bug, whether they are two interfaces or an interface and a `declare module`. See V3.

  
### P5. Reuse is optional and unprivileged
 _(register: A3, A5)_
  

Shared convenience belongs in an abstract implementation of the same interface, never in a contract above it. The test: someone can write a plugin from scratch against the bare interface, ignore the abstract base entirely, and lose nothing but convenience. If the base grants access to anything the interface alone does not, it is a hidden second interface and P1 has already broken.

  
### P6. Core knows about dependency, not about capability
 _(register: A7)_
  

Core provides a dependency graph and a typed registry. A foundational plugin is one with a high in-degree, not a different kind of thing. There is no middle tier, only a graph that happens to have a middle when drawn.
  
> **P6, amended.** As first written it was contradicted by the design itself: `InterventionPoint` is a closed set of five names, and those names are capabilities. Core *does* learn them; it just does not learn "store". **Core knows the shape of a run and the dependencies between plugins. It knows nothing about the meaning of anything that occupies a position in that run.**

  
### P7. Every plugin can be declined and replaced, first-party included
 _(register: A6)_
  

The test is not that a plugin can be switched off. It is that a context starts and runs with a first-party plugin switched off and a stranger's substituted for it. A capability nobody can decline is one core actually owns, whatever package it sits in.
  
> **P7, amended.** The decline half is proven. The replace half is not: the spike's substitution test installs the stranger *instead of* the first party under the same id, which is absence plus impersonation. With both installed the last `provide` wins silently. **A replacement declares itself one. Core refuses two undeclared providers of the same token, naming both.**

  
### P8. A boundary that is not mechanically enforced does not exist
 _(register: D6)_
  

Lint rules, compiler project references and a CI ratchet, not review. Stated by Jaco as the reason: code that passes tests and lint merges without a human reading it, so a rule that lives only in prose is a rule that is already broken. Where an exception is legitimate it belongs in one file, with a CODEOWNERS entry, so coupling two modules is a pull request that tags a person.

  
### P9. An extension point core does not use to build itself is unproven
 _(register: D5)_
  

Whatever core uses to build itself must be the same thing it hands out, and anything it hands out but does not use is not yet real. This is P1 restated as a build rule, and it is the one that would have caught every gap in section 2 before it shipped.

## 2. What is impossible today

Binary claims, each checkable against a named file. This is the case. If these hold, the architecture needs to change whatever anyone concludes about churn.

  
### I1. ~~A third party cannot write a server plugin~~ — restated
 _[Refuted]_
  

**False as written.** A stranger can do it today with no private import. Every one of the **78** store keys in the codebase uses `Symbol.for` and **zero** use a non-global `Symbol()`, so a third party re-derives `WEB_INGRESSES` from its string, augments `StoreRegistry`, and publishes the same map the first party does. Proof compiles.
  

**The accurate claim is narrower and still worth making:** the contract exists but is *unnamed, undocumented and unversioned*, so writing against it means writing against a private detail that can be renamed without a major version. **That changes the remedy.** Exporting the keys is a one-line change each; it is not an argument for rebuilding the plugin system.
  

**plugins/server/registry.ts:574** · counter-example: `spikes/validation/i1/stranger.ts`

  
### I2. A third party cannot add a resilience wrapper or any pre-from chain position
 _(breaks P1, P3)_
  

The executor imports the timeout, retry, circuit-breaker and concurrency wrappers by name and runs them in a fixed order. The public door, `registerDsl`, accepts a closed set of five kinds and always does the same three things: build a step, push it, return `this`. Its own JSDoc calls it sugar.
  

**pipeline/executor.ts:46-63** · **dsl.ts:41** `PrimitiveKind`

  
### I3. ~~A third party cannot define a source~~
 _[Withdrawn]_
  

**False, and withdrawn rather than deleted because the correction matters.** `Source` is publicly exported (`index.ts:256`) and is a plain interface: `Source<T> extends Adapter { subscribe: CallableSource<T> }`. Anyone can implement it and pass it to `.from()`. There are no `plugin.ts` files under `adapters/` at all, because adapters are values rather than registrations.
  

The accurate narrower claim is that no one can add a *builder method* other than append-a-step sugar, which is already I2. What this correction exposes is a positive finding: **the adapter layer already satisfies P1**, which is exactly why the register found `adapters/` carries the highest churn and the lowest rework. It is the one layer with a real public interface, and it works.
  

The fourth claim in these documents to be confidently wrong and caught by reading the tree. See F7.

  
### I4. A third party cannot add a handler point, and neither could we
 _(breaks P1, P4)_
  

`CHAIN_SURVIVAL` is keyed by `Exclude<keyof RouteDefinition, NonChainField>`, so a chain position must be a field on `RouteDefinition`. Handler points are not fields, so the handler-points work had to add a second, parallel, hand-maintained table on its own branch. **And three of the nine keys are buckets, not positions** (`preParseFilters`, `postParseFilters`, `postFromFilters`), each justifying a whole-bucket policy by citing one member, while the chain standard names eleven positions. Per-contribution survival forces a decision for every position hidden inside a bucket, and nobody has made those decisions.
  

**pipeline/chain-policy.ts** `CHAIN_SURVIVAL` · `POINT_SURVIVAL` is on `feat/816-route-handler-points`, **not on main** — the original claim cited it as current code

  
### I5. Two subsystems cannot share one database, by design
 _(breaks P6)_
  

`shared/sqlite/claims.ts` exists to detect and refuse two subsystems opening the same file, because each stamps its own `PRAGMA user_version`. Sharing one backing store is not merely unsupported; the codebase detects the attempt and rejects it at boot. Only two of the three sqlite consumers even participate, so telemetry can still collide silently.
  

**shared/sqlite/claims.ts** · deferral/config.ts:286 · ai/agent/session/config.ts:187

  
### I6. No third-party store backend can exist without reimplementing deferral semantics
 _(breaks P1, P5)_
  

`DeferralStore` has 15 methods. Four are storage; five encode what "claimed", "expired" and "denied" mean; six are queries. Writing a Postgres backend means reimplementing the state machine and keeping it in step with core's lease semantics forever. `SessionStore` next door is 6 methods with nothing session-specific in its shape.
  

**1,289 lines** to implement `DeferralStore` twice (836 + 453) versus **604** for sessions (277 + 85 + a 242-line semantics layer the first version omitted). Honest saving ~850–1,050, and the win arrives at the **third** backend, not the first.

  
### I7. Core's public type surface cannot be described without pino
 _(breaks P2)_
  

No `Logger` interface exists. `CraftContext.logger`, `Route.logger` and `Exchange.logger` are typed `ReturnType<typeof logger.child>` across 8 declaration sites, and the published `dist/index.d.ts` opens with `import * as pino from 'pino'`. Replacing pino is a breaking change to the public API rather than a dependency swap.
  

8 declaration sites · 68 files reference `.logger` · issue #542, open since August

  
### I8. Deferral cannot be declined, because core references it 202 times
 _(breaks P2, P3, P7)_
  

Deferral is a core feature wearing a config key. `error.ts` 83, `exchange.ts` 68, across exactly 14 core files.
  

**420 occurrences / 14 core files** (218–274 with comments stripped). The first version published 202, which counted lines in some files and occurrences in others and reproduces under neither. The contrast with telemetry's 1 is sharper than first stated.

  
### I9. Replacing a first-party plugin works, but silently and by import order
 _(weakens P7)_
  

Better than expected: installation runs through an open registry keyed by config key, and a plugin is installed only when its key is set, so declining is already just omitting config. But `registerConfigApplier` is a `Map.set`, so replacement is last-write-wins with no diagnostic. Two packages replacing `servers` resolve by import order.
  

**config-applier.ts:89** · `dependsOn` exists at context.ts:105 marked RESERVED and unenforced

## 3. What the code shows

Interpretive rather than binary. These need agreement on method before they mean anything, which is why they sit behind section 2. Full evidence and method are in the register.

  
### F1. The same subsystem class, at 0 and at 202
 _(register: D12)_
  

Telemetry and deferral both observe exchanges, both persist, both carry a config key, both have a lifecycle. Telemetry sits at **0 imports into core** and one reference, hooking in entirely through `ctx.on("*")` and `registerConfigApplier`. Deferral sits at 202. The only difference is that telemetry observes and deferral intervenes, and core publishes a seam for the first and nothing for the second.
  

Of 28 core-candidate files, **12** import into plugin territory, in **75 statements** carrying **~156–190 symbols**. `operations` alone is 122–152 symbols, six times the next folder, and is the real coupling. The first version published 81, which mixed two counting methods.

  
### F2. Four hand-rolled copies of an interface nobody created
 _(register: D9)_
  

`TelemetryLogger`, `EventBusLogger`, `MailFetchLogger` and ai's `Logger`, each a different subset, each carrying a comment saying it matches the pino child shape without pinning to pino's types. Four authors independently wrote down the need for the interface and each declined to create it. This is not a duplicate nobody noticed; it is one everybody noticed.
  

telemetry/types.ts:111 · event-bus.ts:9 · adapters/mail/shared.ts:730 · ai/mcp/stdio-client-manager.ts:22

  
### F3. Six operations use the public door; about fifty-four are class methods
 _(register: D11)_
  

`log`, `debug`, `map`, `schema`, `defer` and `resume` go through `registerDsl`, which is exactly the set needing nothing but an append. Everything else is hard-coded. By AST walk: **23–25 distinct** on `StepBuilderBase` and **25–30** on `RouteBuilder`, a user-visible surface of roughly **54**. The first version said "about seventy", from a regex that swept in overload signatures.
  

P9 with a number attached: the door main uses is not the door it hands out

  
### F4. No folder has a public face, so every import reaches at a file
 _(register: D6)_
  

Only 2 of 9 core folders have an `index.ts`. **312 cross-folder deep imports** reach past a folder root at a specific file, excluding the barrel. The outer surface is **598 exports across an 833-line index.ts**. Discounting `shared/` leaves **239**, not the 90 first published: **the reassurance was the wrong way round**, and step 2 is roughly three times the stated size.
  

The proof this is mechanism and not culture: `@routecraft/ai` imports from core 86 times and never once reaches past the published entry point

  
### F5. `shared/` is the default destination, and four of nine files do not belong
 _(register: D7)_
  

By distinct consumers: genuinely shared are `duration` (**35**), `stale-options` (**11**), `abort` (6); not shared are `runtime-version`, `standard-schema`, `compare` and `iterable`, at one each, which reproduce exactly. Total imports 139, not 103.
  

Proposed rule: a utility earns `shared/` at its third consumer

  
### F6. Churn clusters rather than spreading, and the control group proves the thesis
 _(register: evidence)_
  

**Withdrawn.** Re-run over a full clone, `adapters/` does carry the highest raw churn (27,532) but **not** the lowest rework, at 0.9 edits per file. The lowest is `deferral/` at **0.1, on two commits in twelve months**, because the rename from `suspension/` created it weeks before the measurement — the exact distortion the register itself identified and withdrew as O3. This was the only evidence that a real interface prevents rework, and it does not survive its own command.
  

Reproduce with `git log --since="12 months ago" --numstat` over `packages/*/src/**/*.ts`

  
### F7. The register got three things wrong, and how they were caught
 _(method)_
  

One entry claimed a directory still existed after a completed rename; a completed rename and an abandoned one produce identical churn. One proposed AI-specific sub-interfaces, which would have recreated the two-interface bug one layer down. One overstated a narrow objection about the context store into a rejection. All three were caught by reading the current tree rather than trusting the signal, and the first is kept in the register as withdrawn rather than deleted, because the mistake is about method.
  

Stated here so a validator calibrates: confident prose in these documents is a lead, not a finding

## 4. The blocks

What exists, who owns it, and what it deliberately does not know. Core is the bottom; nothing sits below it and only plugins sit above it.

  
### Core, ten modules, strictly one-directional

  

Each becomes a real module with its own manifest and its own `index.ts`, bundled into one published artifact rather than published separately. The dependency arrows only point downward.
  
```ts
contracts     → (nothing)          // Route, Exchange, CraftContext as interfaces
logger        → (nothing)          // the Logger port, issue #542
errors        → contracts
events        → contracts, errors, logger
registry      → contracts, errors
interventions → contracts, errors
exchange      → contracts, errors, logger, events
route         → contracts, errors, interventions
executor      → contracts, exchange, route, interventions, events
kernel        → all of the above
```

  

**The kernel** reads config, sorts plugins by `dependsOn`, runs `apply → start → stop` and the reverse on teardown, and aggregates health. It cannot be a plugin by construction: the thing that loads plugins cannot itself be loaded by the thing that loads plugins. That bootstrap argument is the cleanest test for what belongs in core, better than any list.
  

**The other nine** do not know plugins exist. The exchange knows about contributions. The event bus knows about subscribers. The executor knows about an assembled chain. None of them knows who supplied any of it.

**! 
  

**Three cycles block this today, and they must be broken first.** `exchange.ts ⇄ route.ts`, `route.ts ⇄ context.ts`, and the triangle through all three. Every one is `import type`, so there is no runtime cycle, but `tsc --build` refuses a cyclic project reference whether the imports are erased or not. **The fix is the `contracts` module itself**: the three implementations each depend on the interfaces and none on each other. Breaking the cycle and building the interface layer are the same job, not two.

  
### The codebase already breaks cycles by hand

  

`deferral/runtime-key.ts` exists as a leaf module purely so that `exchange.ts` can read a key without, in its own words, pulling "the store backends (and, through them, the context) into a runtime cycle rooted at the exchange". That is a manual cycle break carrying a comment that explains itself. Project references turn that from folklore into a build error.

  
### Who owns what, answered directly

  
    
- **The filter chain.** `interventions` owns its assembly, `executor` owns its execution, nobody owns its contents. Order is computed from declared constraints. Main's `resilience` plugin contributes retry, timeout, circuit-breaker, concurrency and throttle with constraints reproducing today's fixed order exactly.
    
- **Building the steps.** `route` owns the builder object and its structural methods: an id, a source slot, a wrapper chain, a step list. Every step method arrives as a contribution. `.from()` is a core position; what you pass into it is a plugin's or a stranger's.
    
- **The existing operations.** Main's `operations` plugin, roughly forty `step` contributions.
    
- **The existing adapters.** Nothing owns them, which is the right answer. They are values.
  

  
### Enforcement, ranked by where it fails _(95% of contributions are agents)_

  

This ranking is a consequence of who edits the code, not a style preference. An agent told to make the tests pass will add an import that lint merely warns about. It cannot add one the compiler rejects.
  
    
- 
### TypeScript project references

Fails `tsc`. An undeclared module dependency or a cycle is a build error with no way around it but fixing the design or asking.
    
- 
### `exports` on the internal manifests

Fails resolution. Stops a reach into another module's internals even when the graph allows the edge.
    
- 
### ESLint `no-restricted-imports`

Fails lint. The backstop for what the compiler cannot express, which is symbol-level privacy: references govern which modules you may reach, `index.ts` plus lint governs which symbols.
    
- 
### CODEOWNERS on the exception file

Needs a human, which is the scarce resource. Reserved for the one file listing deliberate boundary exceptions, so coupling two modules is a pull request that tags a person.
  

## 5. The plugins

The inventory the design must satisfy, and the packaging rule that keeps most of it from needing a plugin at all.

  
### Three tiers of packaging

  

**Tier 0, no plugin.** `file()`, `json()`, `csv()`, `timer()` are functions returning adapters. Import and pass. No config key, no registration, no lifecycle. Most adapters belong here and already are here.
  

**Tier 1, adapters plus a lifecycle plugin.** When a shared connection pool or teardown is needed, the plugin provides the pool through a token and the adapters consume it. `mail` and `carddav` are this.
  

**Tier 2, a plugin that contributes to the run.** Wrappers, steps, handlers, exchange accessors. `resilience`, `deferral`, `auth`.
  

**The rule:** if it needs no context lifecycle, it should not be a plugin. A package that only exports adapter factories is a library, and making it a plugin buys a config key for nothing. This is P5 applied to packaging.

  
### The tree

  
```ts
core
│
├── stores            no deps        ← in-degree 4
├── servers           no deps        ← in-degree 4
├── resilience        no deps
├── operations        no deps
├── auth              no deps
│
├── telemetry         → stores
├── deferral          → stores
├── cache             → stores (optional)
├── http              → servers
├── ops               → servers
├── remotes           → http
│
└── @routecraft/ai    peer package, no privileges
    ├── streaming     no deps
    ├── llm           → streaming
    ├── embedding     no deps
    ├── mcp           → servers
    ├── acp           → servers
    └── agent         → llm, mcp, streaming, stores, deferral
```

  

**Two things fall out of drawing it rather than designing it.** `stores` and `servers` have in-degree 4 while everything else has 0 or 1, so the foundational band is a measurement rather than a tier, and those two are where the in-degree-weighted churn alarm from P8 should point. And `agent → deferral` is the only cross-package edge, which is why the agent session store and the deferral store keep entangling; under this design it becomes a declared edge rather than a shared private key.

**! 
  

**The AI package has a live runtime cycle that must be broken.** `agent/run.ts:10` imports `callLlm` and `streamLlm` as values from `llm/providers`, and `llm/providers/stream-llm.ts:3` imports `normalizeStreamDelta` as a value from `agent/events.ts`. The fix is clarifying rather than awkward: `normalizeStreamDelta` and `AgentDeltaListener` are a streaming-delta concern, not an agent concern, so they move to a `streaming` module both depend on. That is the `streaming` node in the tree above. The rest of the package is already clean: `agent → mcp` has four imports and `mcp → agent` has none.

## 6. The design

What follows from the principles. This is the part that is a proposal rather than an observation.

### The shape

Three bands, but not a tier system. The bands are what the dependency graph happens to look like once it is drawn; core enforces the graph, not the bands.

[diagram omitted in markdown]

Arrows are declared dependencies. Telemetry depends on nothing but core, which is why it already works this way today at zero core imports. Every box above the line uses the same interface and can be declined.

### The plugin interface

One interface. A plugin implements the parts it participates in and leaves the rest absent. This is A3: no simple tier and advanced tier, because two interfaces that must agree is the bug this whole exercise exists to remove.

```ts
export interface Plugin {
  readonly id: string;                     // "routecraft.deferral"
  readonly dependsOn?: readonly string[];  // plugin ids, topologically sorted

  apply?(ctx: PluginContext): void | Promise<void>;
  start?(ctx: PluginContext): void | Promise<void>;
  health?(): Promise<Health>;
  stop?(ctx: PluginContext): void | Promise<void>;
}
```

`PluginContext` is the entire privileged surface. If something is not reachable through it, no plugin can do it, which makes the governing principle checkable by reading one type rather than auditing a package.

```ts
export interface PluginContext {
  readonly id: string;
  readonly logger: Logger;

  // publish and consume other plugins' APIs
  provide<T>(token: Token<T>, value: T): void;
  require<T>(token: Token<T>): T;            // throws, naming the missing plugin
  optional<T>(token: Token<T>): T | undefined;

  // the two seams
  on(event: EventName, handler: EventHandler): Registration;
  contribute(point: InterventionPoint, contribution: Contribution): void;

  onTeardown(fn: () => void | Promise<void>): void;
}
```

  
### Why `token<T>()` rather than today's declaration merging _(decision)_

  

Today a plugin publishes its API by augmenting a global `StoreRegistry` interface with `declare module`. It works, and it is used 44 times. The proposal replaces it with a local branded symbol:
  
```ts
// @routecraft/stores
export const STORE_API = token<StoreApi>("routecraft.stores.api");

// any other package, first or third party
import { STORE_API } from "@routecraft/stores";
const stores = ctx.require(STORE_API);       // typed StoreApi
```

  

The type travels with the import instead of with a global augmentation, so there is no shared interface for two packages to collide in and no ordering dependency on which module loaded first. What is lost is the one property declaration merging has: every key visible in one place. That is worth giving up, because the register's A2 found that the global registry is exactly where private coupling hides.

### The two seams

D12 is the register's headline: core publishes a seam for observing and nothing for participating, so anything that must change what happens next gets hand-threaded through core. Deferral sits at 202 references across 14 core files for this reason. Telemetry, which only observes, sits at zero.

  
### Observation: the event bus, which already exists

  

Unchanged. `ctx.on("*")` and named events. This stays in core against the "everything is a plugin" rule, because it is how core announces the lifecycle transitions A1 leaves it to manage. A plugin cannot announce core's own lifecycle.

  
### Participation: the intervention registry, which does not exist

  

Core defines **where** a plugin may intervene, because that is the shape of an exchange's run and the exchange lifecycle is core's. Core defines **nothing** about what any intervention does.
  
```ts
type InterventionPoint =
  | "source"     // produces exchanges
  | "wrapper"    // wraps the pipeline; ordered by declared constraints
  | "step"       // a DSL operation
  | "handler"    // exchange lifecycle: entry, error, start, stop
  | "exchange";  // one namespaced accessor, e.g. ex.deferral
```

  

Five points, closed on purpose. A new kind of point would mean a different exchange lifecycle, which is a core change by definition. Everything *in* a point is open and unbounded.

  
### Ordering by constraint, not by a hard-coded list

  

The pre-from chain is today a fixed order compiled into `pipeline/executor.ts`, which imports the timeout, retry, circuit-breaker and concurrency wrappers by name. A contribution declares its position relatively instead:
  
```ts
interface WrapperContribution {
  readonly id: string;                      // "routecraft.retry"
  readonly before?: readonly string[];
  readonly after?: readonly string[];
  readonly survives?: readonly DetachedKind[];
  wrap(next: Pipeline, route: RouteView): Pipeline;
}
```

  

Core topologically sorts and refuses a cycle at boot, naming both sides. The framework still ships the default order by giving its own wrappers constraints; what changes is that the order is data rather than code, so a plugin can insert into it.
  

**This is what collapses the two survival tables.** `CHAIN_SURVIVAL` is keyed by `Exclude<keyof RouteDefinition, NonChainField>`, so a chain position must be a field on `RouteDefinition`. Handler points are not fields, so the halted work had to add a second parallel table by hand. With survival declared on the contribution, there is one table and it is derived.

### Dependency and lifecycle

Core knows about dependency, not about stores. That single sentence is what makes a middle band possible without a middle tier.

```ts
defineConfig({
  plugins: [stores(), servers(), deferral(), http(), mcp()],
})

// deferral declares what it needs; core sorts and starts stores first
export function deferral(options?: DeferralOptions): Plugin {
  return {
    id: "routecraft.deferral",
    dependsOn: ["routecraft.stores"],
    apply(ctx) { /* ... */ },
  };
}
```

  
- **A foundational plugin is one with a high in-degree.** Same interface, same lifecycle, same ability to be declined. No second kind of plugin exists.
  
- **Core refuses at boot** when a declared dependency is absent, naming the plugin that wanted it and the one missing, rather than failing later as `undefined is not a function`.
  
- **The missing piece today is small.** `dependsOn` already exists on the plugin type and is marked *RESERVED. Not enforced yet*. Ordering is currently push order: config appliers first, then `config.plugins`.
  
- **Replacement must declare itself.** `registerConfigApplier` is a `Map.set`, so a third party already replaces `servers` by registering later. It works, silently and by import order, which means two packages replacing the same thing resolve by accident. A replacement should have to say it is one.

  
### A metric that falls out _(for CI)_

  

Jaco's rule was that a foundational plugin changing often means something is wrong. Once the graph is explicit, that is measurable as **churn weighted by in-degree**. A plugin with ten dependents changing weekly is what to alarm on. It is the forward-looking inversion of the churn analysis that opened the register, and a better signal, because it prices blast radius rather than edits.

### Worked example: deferral as a plugin

The hardest case in the codebase and therefore the one worth writing out. 202 references across 14 core files today.

```ts
export function deferral(options?: DeferralOptions): Plugin {
  return {
    id: "routecraft.deferral",
    dependsOn: ["routecraft.stores"],

    apply(ctx) {
      const store = ctx.require(STORE_API).open("deferral", RECORD_STORE);
      const api = new DeferralApi(store, signerFrom(options));

      ctx.provide(DEFERRAL_API, api);                 // ops, route adapters, MCP tools

      ctx.contribute("step",     { name: "defer",  factory: deferStep(api) });
      ctx.contribute("step",     { name: "resume", factory: resumeStep(api) });
      ctx.contribute("wrapper",  { id: "routecraft.admission", after: ["routecraft.authorize"], wrap: admission(api) });
      ctx.contribute("handler",  { point: "error", handler: recoveryDefer(api) });
      ctx.contribute("exchange", { key: "deferral", factory: (ex) => affordance(api, ex) });
    },

    async start(ctx) { await api.sweeper.start(); },
    async health()   { return api.store.health(); },
    async stop(ctx)  { await api.sweeper.stop(); },
  };
}
```

Every one of the 202 core references becomes one of these five lines or disappears. `ex.deferral`, built today inside `exchange.ts` by reading a private store key, becomes an `"exchange"` contribution. The admission position, which the halted work bolted on, becomes a `"wrapper"` with a declared constraint. The recovery path becomes a `"handler"`.

## 7. The spike

Branch `feat/dazzling-fermi-01x3ns`, folder `spikes/plugin-architecture/`. Depends on nothing in `packages/`, ships nothing, and exists to answer one question: does this survive contact with TypeScript, or does it only work in prose? **26 tests, strict typecheck clean.**

  
### The folder, in action

  
```ts
spikes/plugin-architecture/
├── src/
│   ├── contracts/     interfaces only: Token, Exchange, Step, Pipeline,
│   │                  RouteView, Source, Contribution, Plugin, PluginContext
│   ├── kernel/        plugin host + the topological sort
│   ├── registry/      provide / require / optional by token
│   ├── events/        observation seam
│   ├── interventions/ participation seam: ordering, steps, handlers, extensions
│   ├── runtime/       minimal exchange + executor
│   ├── builder/       three candidate DSL designs (see below)
│   └── plugins/       operations · resilience · stores · deferral ·
│                      telemetry · audit (a deliberate stranger)
└── test/              kernel · chain · principles · builder
```

  
### The demo output, which is the thesis in two lines

  
```ts
install order:  stores → acme.audit → deferral → telemetry → operations → resilience
wrapper chain:  admission → retry → acme.audit → timeout → concurrency
```

  

`acme.audit` is a deliberate stranger: a plugin written against the published contracts only. It lands in the middle of a first-party resilience chain, consumes a first-party API, and contributes a step, **with no change to core and no change to `resilience`**. That is P1 holding for this surface, demonstrated rather than asserted.

### The DSL question, settled by execution

How does a step contributed by a plugin become a typed method on the builder? This was the hardest open question and the spike answers it.

  
### S1. Declaration merging is type-unsound, and it is what ships today
 _(changes the design)_
  

`registerDsl` patches a prototype at runtime and the plugin author writes a `declare module` separately. Nothing correlates the two halves.
  
```ts
// test/builder.test.ts — `ghost` is declared and never registered
declare module "../src/builder/index.ts" {
  interface FluentBuilder<S extends { body: unknown }> {
    ghost(): this;
  }
}

builder.ghost();   // COMPILES. Throws TypeError at runtime.
```

  

A passing test, not an argument. The gap is structural: two halves maintained by hand, which is the same defect as I4's two survival tables.

  
### S2. Deriving the builder from the installed plugin set is sound
 _(recommended)_
  

A plugin declares its steps in its *type*, and the builder type is computed from the plugins actually passed in. There is no second half, so nothing can drift.
  
```ts
export const typedDeferral = {
  id: "routecraft.deferral",
  dependsOn: ["routecraft.stores"],
  steps: { defer: (reason: string): Step => ({ ... }) },
} as const satisfies TypedPlugin;

const b = derivedBuilder([typedOperations, typedDeferral]);
b.transform(fn).defer("needs approval").build();   // both typed
```

  

**Declining a plugin removes its method from the type, not just at runtime.** The test asserts it with `@ts-expect-error`, which passes only because `defer` genuinely is absent when the plugin is not installed. That makes P7 checkable by the compiler rather than by a runtime assertion.
  
> **Costs, stated.** A `Proxy` at runtime. Step contributions become declarative data rather than imperative `ctx.contribute` calls. The builder type is recomputed per plugin set, untested at forty operations, and that is where it may fall over.
> 
  **Unresolved tension.** If steps are declarative and wrappers are imperative, the "one interface, tiered by declaration" story splits. Either wrappers become declarative too, or the split needs a reason better than convenience.

  
### S3. A union of contribution kinds erases its own generic
 _(fixed in the spike)_
  

`contribute(c: Contribution)` collapsed `ExchangeContribution<T>` to `unknown` at the call site, so the factory's return type stopped being inferred and its body became implicitly `any`. `tsc` caught it on the first run. Fixed with a typed overload ahead of the union.
  

Every generic contribution kind needs its own overload, or the union silently widens it. Same failure mode as C1's field bag, one level down.

  
### S4. `ex.deferral` becomes `ex.use(DEFERRAL_EXT)`
 _(your call)_
  

Core cannot type a named property it does not know about, so plugin state on the exchange is reachable by token rather than by name. This is a real ergonomic regression from today, recorded rather than hidden. A plugin can layer the sugar back with declaration merging, but then it inherits S1's unsoundness.
  

The one finding the spike cannot decide, because it is a taste judgement about the DSL's readability against a known soundness cost.

  
### Four smaller findings, all now enforced in the spike

  
    
- **Ordering constraints against absent plugins must be inert.** Deferral's admission declares `after: ["routecraft.authorize"]` and auth may not be installed. Chose inert over fatal, which means a typo in a constraint id is now silently ignored. The alternative makes every optional dependency a hard one. Neither is free.
    
- **Step-name collisions are unresolvable** and refused at apply, naming both plugins.
    
- **Contributions freeze at start**, or a plugin contributing from its `start` hook silently misses an already-composed chain.
    
- **One topological sort serves both graphs.** Plugins by `dependsOn` and wrappers by `before`/`after` are the same problem. Evidence for A7: core's knowledge of dependency is a single mechanism, not a family.
  

**! 
  

**What the spike does not answer, listed so nobody mistakes a green suite for a validated design.** `from` and type flow is untouched: steps carry no body type through the chain, so how a source fixes a route's type parameters is still open and remains the item most likely to make P3 unreachable. Also untested: halt and continue semantics, teardown under partial exchange failure, the cost of a chain composed per route versus compiled, and the store contract, which is deliberately a mock.

## 8. The validation round

An independent clean-room agent was given the branch and these documents, and no part of the reasoning that produced them. It refuted sixteen figures, broke the proof of concept in four places, and answered all five awkward things with compiling code. Every refutation below was independently re-run before being accepted; one of its own claims was wrong and is not carried over. Its report, counter-examples and 22 tests are at `spikes/plugin-architecture/docs/VALIDATION.md` on branch `validation/clean-room`.

**! 
  

**The single most important result: F8 is false.** The dichotomy "a DSL can be fluent, body-typed and plugin-extensible, or sound, but not both" was argued rather than tested. A fifth encoding gives all four. See V1.

  
### V1. Encoding E: fluent, body-typed, extensible and sound, at once
 _(overturns F8, S1, S2)_
  

The fix is to stop asking TypeScript to infer a type-level relationship out of a value-level generic function, and have the plugin state it directly as a defunctionalised type-level function: the parameter list and the resulting body are computed members on an interface that reads the incoming body through `this`. Nothing is inferred through a generic; everything is applied.
  
> **Verified independently, including by mutation.** Removing the `@ts-expect-error` on a declined plugin's step yields `Property 'defer' does not exist`; removing the one on a wrong key yields a real type error. The assertions are load-bearing, not vacuous.
> 
  **Scale:** 40 chained steps across 40 distinct plugin signatures, body type still flowing and deeply accessible, whole spike typechecks in **1.29s**. The standard objection to HKT encodings does not bite here.
  

**Consequence for the plan.** The design's single largest stated risk — that `from` and type flow make P3 unreachable — was assessed against an encoding set that excluded the one that works. Step 1 of the sequence is still the right first step, aimed at the wrong target.
  

`spikes/validation/src/e-hkt.ts` · `e-hkt.check.ts` · `scale.check.ts`

  
### V2. The proof of concept cannot express deferral, which is its own acceptance test
 _(changes the sequence)_
  

Four passing tests, each demonstrating a failure. **A step cannot halt:** `Step.run` returns `Promise<void> | void`, so the only signal is a throw, which is a failure rather than a halt. **A wrapper can skip everything or nothing, never a suffix:** it receives the whole composed pipeline and a `RouteView` with nothing executable. **Resuming re-runs completed work:** the runtime loops the step list from index 0 and no contribution supplies an entry offset. **The `source` point does not exist:** `RouteSpec.source` is declared and `subscribe` is never called, which I verified.
  
> **This is a sixth thing core must own.** A `Step` outcome (`continue | halt(continuation)`), a continuation value carrying the entry index and each participant's serialized state, and an executor entry point that accepts one. The register already found it as C2, "six carriers of where is this exchange and what re-runs", and the design dropped it.
  

**Consequence.** Discovering the missing concept at step 5 is precisely the failure the sequence was ordered to avoid, and the sequence as written walks into it.

  
### V3. The design contradicts itself in two places, and both were mine
 _(amends P4, P8)_
  

**Two plugin interfaces.** The spike has `Plugin`, used by the kernel, and `TypedPlugin`, used by the derived builder. They share no members, nothing correlates them, and the builder ignores `dependsOn` entirely — so it hands you a `defer` method for a plugin set the kernel would refuse to start. That is the two-halves bug this work exists to remove, reintroduced by the fix for it.
  

**Tokens are a weaker boundary than what they replace.** `token(name)` is `Symbol.for(name)`, a process-global string registry. Two packages choosing `"acme.thing"` get the same key — I ran it, they do — **silently, at runtime**, where declaration merging gave a compile error. By P8's own standard the replacement is worse. The token design is still right for other reasons, but it needs a collision mechanism and package-namespaced names.

  
### V4. All five awkward things have better answers, with code
 _(replaces S4 and the open questions)_
  
  
|  | What this document said | Better answer |
|---|---|---|

    
| a | ex.deferral regresses to ex.use(TOKEN); a real cost | The premise was false. The exchange type is not fixed: the builder already carries a plugin-derived parameter, so add a second for extensions and the named property returns, checked. Strictly better than today, because declining the plugin removes the property, where today it is on the type regardless. Mutation-verified. |
|---|---|---|

| b | Fluent, typed, extensible, sound: pick three | All four. V1. |
|---|---|---|

| c | Steps declarative, wrappers imperative, reason is convenience | The split is not steps versus wrappers, it is value known at module load versus value known after dependency resolution. A step factory closes over nothing; a wrapper closes over what require returned. A thunk over resolved dependencies erases the distinction and one declarative shape serves all five points. |
|---|---|---|

| d | One pipe overload per arity | Moot under (b). |
|---|---|---|

| e | Inert or fatal, neither is free | Inert and recorded, with a nearest-neighbour suggestion. Its implementation found two real unmatched constraints in this design's own demo. |
|---|---|---|

    
  
  
  

(a) and (b) need the same plumbing: step lambdas receive an exchange type parameterised by the plugin set. Do both or neither.

  
### V5. Twelve things missing entirely, ordered by when they hurt
 _(new work)_
  

**1. Versioning of the plugin contract.** The largest omission for a design whose whole purpose is third parties. After this change the public surface is 598 exported names *plus* every token name, wrapper id, step name and handler id — all strings, none under any policy. Put the ids in exported constants so a rename is a compile error, and bring them under `.standards/api-stability.md`.
  

**2. Isolation is claimed and not built.** A2 says "you cannot read what you did not declare". In the spike any plugin can `require` any token it can name and `provide` over one a first-party plugin already published. Either scope the registry by declaration or delete the claim, because it will be quoted later as a security property.
  

**3. Halt, continue and the continuation.** V2.
  

**4–7.** Handler ordering (wrappers get constraints, handlers get install order, and error-classification order decides behaviour). Route-scoped versus context-scoped wrapper state, which is undesigned: circuit breaker and concurrency are per-route today, and one contribution instance serves every route. Observability of the graph: nothing lists installed plugins, resolved order, the wrapper chain, token providers or unmatched constraints, and every one is a support question the ops plugin already exists to answer. An error taxonomy for the seven boot failures, in a codebase whose error policy is a standards document.
  

**8–10.** Streaming: `Pipeline` is `(ex) => Promise<void>`, and SSE on the HTTP source is one of the changes that drove the executor to 2,275 lines. A testing story for plugin authors. Migration, which R2 prices at roughly half the suite.
  

**11. What breaks in year two.** `InterventionPoint` is closed at five and a sixth is "a core change by definition", with no process for it. And relative ordering is a coordination problem that worsens with population: with thirty wrappers most pairs are undetermined, and the sort resolves undetermined pairs by *install order* — the same non-determinism I9 complains about, relocated. Core should detect an under-constrained chain, or define a tiebreak that is not install order.
  

**12. A problem this design creates that today does not have.** Today a wrapper's position is wrong only if someone edits `executor.ts`, one reviewed file. After this change it is a function of every installed plugin's constraints, so installing an unrelated third-party plugin can silently reorder your resilience chain. Items 6 and 11 are what make that tolerable, and both are absent.

## 9. What this deletes

  
- `shared/sqlite/claims.ts`, whose only job is detecting two subsystems colliding on one database file. With namespaces allocated rather than claimed, the collision cannot occur.
  
- `POINT_SURVIVAL`, the hand-maintained twin of `CHAIN_SURVIVAL`.
  
- The duck-type check at `deferral/ops-resource.ts:172` (`typeof store.list !== "function"`), which exists because a user-supplied store might not implement a method.
  
- The four private logger interfaces, once the `Logger` port in issue #542 lands as the same pattern one level down.
  
- Roughly 20 misfiled type imports, once `Source`, `Subscription`, `OnParseError`, `HealthChange`, `CronExpression` and the `Resolved*Options` move to core.

## 10. The sequence

Ordered so the cheapest work unblocks the rest, and so the one thing that could make the design unreachable is discovered before most of the effort is spent.

  
- 
    
### Re-spike `from` against encoding E _(retargeted)_

    

**Still the right first step, now aimed correctly.** The original target was the wrong encoding set (V1). What remains open is not whether a body type can flow — it can, at 40 steps in 1.29s — but how a *source* becomes a contribution, which the spike never demonstrated because it declared `RouteSpec.source` and never subscribed it.
  
  
- 
    
### Move the misfiled types into core _(mechanical)_

    

**Larger than first stated.** The deep-import worklist is 239 after discounting `shared/`, not 90, and roughly half the test suite imports internal paths directly, so test migration is a first-class cost rather than a rounding error. Still safe to land alone, still unblocks everything after it. Also here: break the `logger ↔ exchange` **value** cycle, which a contracts module does not fix because `getExchangeContext` is a function.
  
  
- 
    
### Dependency graph, tokens, `provide` and `require`

    

Enforce `dependsOn`, topologically sort, refuse a missing dependency at boot with a legible error. Add `token<T>()` alongside the existing registry rather than replacing it, so nothing has to migrate on this step.
  
  
- 
    
### Model halt, continue and the continuation _(new, blocking)_

    

A `Step` outcome, a continuation value carrying the entry index and each participant's serialized state, and an executor entry point that accepts one. This is C2 from the register, it is a sixth thing core must own, and V2 shows the five closed points do not cover it. It must precede the registry, not follow it.
  
  
- 
    
### The intervention registry _(the big one)_

    

Wrapper contributions with declared ordering, replacing the hard-coded chain in the executor. Handler, step, source and exchange points. One derived survival table. This is where the risk is and where the review effort should go.
  
  
- 
    
### Move deferral out _(acceptance test)_

    

Rebuild defer and resume as a plugin using steps 2 to 4, with zero core edits. PR #818 is halted in draft carrying the requirements it must still meet. If this works, the architecture is real.
  
  
- 
    
### Then auth, servers, http, mcp, ops

    

In that order, because auth is the smallest (three core imports) and proves the pattern cheaply, and because http, mcp and ops all depend on servers.
  
  
- 
    
### Widen the step door and move main's operations through it

    

Today six operations go through `registerDsl` and roughly seventy are hard-coded builder methods. This is the step that makes main a peer rather than a privileged package, and it is last because it is the largest and the least risky.
  

## 11. How we will know it worked

  
- **Extraction.** Deferral moves to its own workspace package depending only on the published entry point, and its tests pass unchanged.
  
- **Decline.** A context starts and runs with deferral absent from the config.
  
- **Substitution.** A package outside this repo replaces `servers` and http, mcp and ops still mount to it.
  
- **Ratchet.** CI counts core-to-plugin imports *with a checked-in script whose output is quoted*, never a prose number. Today: 12 offending files, 75 statements, ~156–190 symbols. A ratchet on a figure two people cannot reproduce with the same command is a gate nobody trusts.
  
- **Suite.** The existing tests pass throughout — but **129–194 of 265 test files import a deep `src/` path**, so roughly half the suite is coupled to the layout this work changes. That figure is the migration budget. The earlier "96% survives" claim does not reproduce under any method. And a green suite proves preservation, not correctness: #818 was green at 3,841 tests while carrying two defects in the core error path.

## 12. Open questions

  
- **Does `RouteDefinition` survive as a field bag?** C1 says its 21 fields are the list of interventions core hard-codes. If interventions become contributions, the definition may become a contribution map. Not decided, and it changes the shape of step 4.
  
- **Where does `Principal` live?** Proposed as core, because it is exchange identity and `requiresPrincipal` is a route field. The branding stays module-private in the auth plugin. Needs a second opinion; getting this wrong is a security boundary, not a layering preference.
  
- **Are relative ordering constraints expressive enough** to reproduce the current chain's semantics exactly? The fixed order encodes reasoning that is not written down anywhere except the order itself.
  
- **Cost of a registry-driven chain** versus a compiled one, per exchange. Expected to be nil after the chain is built once per route, but it is an assumption, not a measurement.
  
- **The agent loop and the AI package** are out of scope for this pass by decision, not by oversight. The agent plugin stays non-swappable for now, with the `llm` and `agent` cycle break the one exception, since it blocks module separation.
    
- **`from` and type flow, the one that can still kill this.** Steps in the spike carry no body type through the chain. If a source cannot fix a route's type parameters through plugin-contributed steps, the choice is between an untyped DSL and non-contributable steps, and the second kills P3. **This is the recommended next spike and the only remaining question of that weight.**
    
- **Declarative or imperative contributions.** S2 makes steps declarative data on the plugin while wrappers stay imperative calls in `apply`. Either wrappers follow, or the split needs a reason.
    
- **`ex.use(TOKEN)` or declaration-merged sugar.** S4. A readability judgement against a known soundness cost, and yours rather than mine.

  

Validated by an independent clean-room agent, 19 September 2026: report, counter-examples and 22 tests on branch `validation/clean-room`. Every refutation was independently re-run before being accepted here; one of the validator's own claims was wrong and is not carried over. Derived from the [Routecraft Boundary Register](https://claude.ai/artifact/434hdasBY6KJTiZLFZj6TS), which holds the evidence for every claim referenced here. Both are drafts pending independent validation; neither has been reviewed by anyone but its author and Jaco.

