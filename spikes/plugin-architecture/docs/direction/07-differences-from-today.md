# Differences from today

Capability by capability: what a consumer meets today, what changes, and what
stays. "Today" is the shipped framework under `packages/routecraft/src/`,
cited by file. "After" is the direction, labelled as in the
[index](README.md). A row that says **same** is a guarantee the migration
carries unchanged; it is listed so nobody assumes it was dropped.

## Plugins

| | Today | After |
|---|---|---|
| The interface | `CraftPlugin { apply(ctx), start?, teardown?, dependsOn? }`; `dependsOn` is reserved and not enforced (`context.ts:98`) | a descriptor with `requires`/`provides`/`replaces`, enforced at start by name |
| What it can reach | the whole `CraftContext`: events, stores, routes, teardown | the ports it declared, the points that exist, and `observe` |
| Adding a route method | `registerDsl` patches the base prototype; post-`.from()` only; the base "is not a public extension point" (`index.ts:419`) | a family on the descriptor, typed, before or after `.from()`, present only when installed |
| Adding a chain position | not possible; positions are internal fields of `RouteDefinition` (`route.ts:202`) | a wrapper contribution placed by anchor |
| Data on the exchange | augment `RoutecraftHeaders` and export a helper; no prototype patching (`exchange-state-model.md:93`) | a typed facet under the plugin's namespace |
| Declaring a moment | not present | a point on the descriptor, with its honoured decisions |
| Replacing a store | `deferral: { store }` in config (`deferral/config.ts:74`) | provide the port and declare `replaces` |
| First-party wiring | the same `CraftPlugin` shape, plus internal symbols a third party is told not to use (`deferAside`, `reviveDeferral`, `getExchangeContext`, `markAuthentic`) and relative imports into private modules | the same descriptor and the same verbs; no private path exists to reach |

## The filter chain

| | Today | After |
|---|---|---|
| The order | fixed: error, authorize, parse, input, throttle, circuitBreaker, retry, timeout, concurrency, cacheCheck, pipeline, cacheStore (`advanced/filter-chain`) | the same positions, as wrappers and handlers with declared anchors; the framework still owns the default order |
| Who fills a position | shipped operations only | any plugin, by anchor |
| Which positions re-run on a resume | a fixed per-position table (`chain-policy.ts:97`) | each contribution's own `survival` |

**Migration decision:** which shipped positions become wrappers and which
become handlers, and whether `parse`, `input`, `cacheCheck` and `cacheStore`
stay route-owned steps. The proof of concept has four wrappers and the four
kernel points; the rest is feature-fit work.

## Steps and outcomes

| | Today | After |
|---|---|---|
| The outcome set | `continue`, `complete`, `drop`, `branch`, `fanOut`, `defer` (`types.ts:173`) | **same** |
| Who may return them | a framework `Step`; a user callable gets `continue`, `.filter()` drops, `.choice()` branches, `.split()` fans out; a `defer` without the framework's request is `RC5032` | any step, including yours, any outcome, including `defer` with a plain request |
| Halting from an adapter | throw `DeferSignal` from a `markDeferCapable` adapter (`deferral/sites.ts`) | return the `defer` outcome |
| Nested paths | `runPath`, `runPaths`, `dispatch` | **same**, plus `invoke` of a point |

## Waiting and resuming

| | Today | After |
|---|---|---|
| A resume is won once (CAS) | yes (`revive.ts:334`) | **same** |
| A duplicate is answered from the record | yes (`revive.ts:559`) | **same** |
| A notification is leased and re-sent | yes, `claimExpiry` (`revive.ts:642`) and `releaseClaims` (`sweeper.ts:121`) | **same** |
| A winner that dies is reported, never re-run | yes, `resumedWithoutContinuation` at boot (`sweeper.ts:288`) | **same** (`resumedWithoutOutcome`) |
| Where the continuation resumes | a `position` in a flat list | a `site` plus `frames`, so a park inside a branch resumes inside that branch |
| What is hashed | the steps from `position + 1` plus the schema | the remaining steps, including a callable source and nested children |
| Persistence rules | plain JSON, dates enveloped, secrets refused (`serialize.ts`) | **same**; the envelope tag and two array edge cases are a **migration decision** (reuse `serialize.ts`) |
| A park from the error path | not on main; `recovery.defer` on the parked branch | the error point honours `defer`; declined by name when reviving would be wrong |
| Token verification and call binding | yes (`RC5041`, `RC5055`) | **migration decision**, a blocker before the door is published |
| Payload validation against the live schema | yes (`RC5049`) | **migration decision**, a blocker |
| Store contract | fifteen methods, CAS results carry the record | the same transitions; the claim returning its record is **intended** |

## The door

| | Today | After |
|---|---|---|
| Declared where | on the ingress route: `.resume(mapper, { authorize })`; `elevate` on the parked branch | on the deferred route: `.resumable({ authorize, elevate })`; an ingress-route door is a **migration decision** |
| Default policy | bearer: whoever holds the token (`resume.ts:62`) | the route's own grants asked of the approver |
| Refusal | `RC5056`, before the claim | one refusal, before disclosure and the claim, bounded by the approval's signal |
| Elevation | re-mints within `errorPath.refusedScopes`, structural identity comparison | re-mints within the recorded refusal; structural comparison is **intended** |
| More than one door per record | yes, one per ingress route | **migration decision** |

## Identity

| | Today | After |
|---|---|---|
| Where the principal travels | one header, `routecraft.auth.principal` (`exchange.ts:114`) | **same** shape: one header owned by the `principals` plugin |
| Authenticity | a private `WeakSet` (`auth/authentic.ts:21`) | **same** mechanism, owned by a replaceable provider |
| Restored is not authentic | yes (`auth/restored.ts`), `RC5043` | **same** |
| The principal shape | `scopes`, `roles`, `actor`, delegation depth, verification fields | `subject`, `grants`, `lent`; roles, actors and delegation rings are a **migration decision** |
| Without the auth plugin | `.authorize()` exists and throws `RC5012` at run time | `.authorize()` does not exist to call; a route carrying the ask refuses to compile |

## Errors

| | Today | After |
|---|---|---|
| Route and step `.error()` handlers | yes (`builder.ts:521`, `step-builder-base.ts:329`) | a route handler is a handler at the error point; a step handler is a wrapper on that step |
| A handler may drop, rethrow, replace the body | yes | **same**, plus park |
| Handlers outside the route | not on main; `registerHandler("error")` on the parked branch | any plugin, at the error point, with declared survival |
| Codes | `RC` codes with a registry | faults with an owner and a code; the numbering is a **migration decision** |

## Events

| | Today | After |
|---|---|---|
| Names | `route:exchange:*`, `route:error-handler:*`, `plugin:*` (`reference/events`) | kernel events without a route prefix, plugin events under the plugin's namespace; the names are a **migration decision** |
| Subscribing | `ctx.on(name)`, exact names, `"*"` | `observe` in `bind` |

## Assembling an application

| | Today | After |
|---|---|---|
| The builder | `craft().id().from().to()` | **same** words on a builder that is typed by the installed plugins |
| The context | `ContextBuilder().with(config).routes(...).build()` | `application([...plugins])`, then `.route(id)...build()` and `start([specs])` |
| Discovery | the CLI reads `craft.config.ts`, `plugins/`, `capabilities/` | **migration decision**: a project-typed route factory over a side-effect-free definition, so the CLI, tests and inspection tools build from one place |

## What the proof of concept is not

It is not the executor that ships. Each row above that says **same** is a
guarantee the shipped code already provides and the migration keeps by
keeping that code; the contracts are extracted around it. The fixtures that
exposed each **intended** row are the ledger's acceptance tests, inverted.
