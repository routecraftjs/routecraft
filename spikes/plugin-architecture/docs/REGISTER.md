Routecraft · internal architecture
  
# Boundary Register

  

Where the framework has no interface, and what each missing boundary has cost. A working list: entries move from open to diagnosed to agreed, and nothing is built from here until it has been validated independently.
  
    Opened 19 Sep 2026
    Churn window: 12 months
    Trigger: PR #818 halted
  

   _[Agreed]_Problem and direction both settled. How is still open.
   _[Diagnosed]_Problem evidenced. Direction proposed, not settled.
   _[Open]_Churn signal only. Needs the same evidence treatment.
   _[Withdrawn]_Checked against the tree and did not survive. Kept, not deleted.
   _[Confirmed]_Operator observation, verified against code.
   _[Corrected]_Right instinct, wrong target. Both recorded.

## The governing principle

Everything below is measured against one test.

**! 
  

**There should be zero difference between what is possible inside the framework and outside it.** Every capability is a plugin against the same interface, including the first-party ones: HTTP, WebSocket, MCP, server, hooks. Not true at 0.7.0, likely not at 0.8.0, and required before 1.0.

The test is executable rather than aspirational. Move one first-party provider out of `packages/routecraft` into its own workspace package that depends only on the published entry point. If it compiles and its tests pass, the interface is real. If it needs one private import, that import is the gap, named and located. Once the first provider passes, the check goes in CI and the count of providers still importing privately becomes a number that only goes down.

**! 
  

**Two extension points already work exactly this way, and they are the model to copy.** Error codes: `ErrorCodeRegistry` is declaration-merged for types and `registerErrorCodes` supplies runtime metadata, and `@routecraft/ai` uses both. Config keys: `config-applier.ts` is a registry keyed on a global symbol, mapping a merged `CraftConfig` key to a plugin, so an outside package's config key behaves like `deferral` does. Neither has a privileged path. Start design arguments from `config-applier.ts` rather than from a whiteboard.

## Agreed

Three entries. The problem and the direction are settled; the mechanism is not, and none of this is designed yet.

  
    
### A1. Core is lifecycle management and interfaces. Nothing in core is logic

     _[Agreed]_
  
  

An earlier version of this entry said "interfaces and nothing else". Jaco corrected it (J17): the code that starts a store, health-checks it, hands it to the plugin that declared it and tears it down is core's, and so is the same machinery for the exchange, the context, and the plugins themselves. What core never holds is a decision about behaviour.
  
> **Core owns:** the interfaces, and the lifecycle of everything implementing them -- context, exchange, stores, plugins. Ordering, readiness, health, failure and teardown.
> 
  **Core never owns:** an operation, an adapter, a transport, a provider, a store schema, or any rule about what the data means.
  

The boundary is not a separate npm artifact. It exists so that extending an interface is a small, visible, human-reviewed change, separate from the change that then uses it. The ordering is the point: a new generic capability lands in the interface first, and only then can a feature be built on it. That is what stops the next capability carving a private hole, which is exactly what happened with the store keys in A2.

  
    
### A6. Everything that is not core is a plugin, including what ships as main

     _[Agreed]_
  
  

Two modules rather than one boundary: **core** (lifecycle and interfaces) and **main**, the package published today as `@routecraft/routecraft`, which becomes a set of first-party plugins with no privileges. MCP, LLM, HTTP, servers, adapters, operations: all plugins. `@routecraft/ai` is a peer of main, and so is a stranger's package.
  

**Core defines the kinds; nobody in core defines an instance.** Core states that a source, a step, a wrapper and a filter-chain position exist and what contract each satisfies. It ships none of them. Main ships `from()`, `transform()`, `retry()` and the rest through the same door a third party uses, or the door is not real.
  

**Every plugin is disableable and replaceable, first-party included.** The acceptance test is not that a plugin can be switched off; it is that a context still starts and runs with a first-party plugin switched off and a stranger's substituted for it. A capability nobody can decline is a capability core actually owns, whatever package it sits in.

  
    
### A2. Plugins declare the stores they provide and require, with typed contracts

     _[Agreed]_
  
  

Today `serversPlugin` publishes its registry with `setStore(WEB_INGRESSES, …)` and the HTTP adapter reads `getStore(HTTP_MOUNTS)`. Neither key is exported from the package index, so the contract between two first-party plugins cannot be named by anyone outside it. That single fact is why a third party cannot replace the server plugin, the HTTP plugin or MCP.
  
> **12** store reads and writes across `adapters/`, including `HTTP_PLUGIN_REGISTERED`, an adapter checking whether one specific plugin was installed.
  

Declared contracts make the dependency visible, make startup fail fast when a contract has no provider, and make substitution possible. Isolation then falls out for free: you cannot read what you did not declare. Note this is more capable than today, not less, because today sharing works only for code that can import a private const.
  

**Do not build on `dependsOn`.** It exists on `CraftPlugin`, marked reserved and unenforced, and it names plugins. Naming a plugin forbids replacement; naming a contract permits it. The reserved field should be retired rather than implemented.

  
    
### A3. One plugin interface, tiered by declaration rather than by type

     _[Agreed]_
  
  

A single interface where a plugin declares what it participates in and implements only those parts, with sensible defaults for the rest. The simple case declares two things and the advanced case declares eight, but there is one contract and one place to change it.
  

Two separate interfaces, one simple and one advanced, would recreate the exact failure this register exists to fix: two things that must agree, maintained by hand. The framework already has that bug at table scale, in C1.
  

Shared convenience belongs in an **abstract implementation of that same interface**, never in a contract above it. One rule keeps that safe, and it is where this pattern usually rots: **reuse must be optional and unprivileged.** The test is whether someone can write a plugin from scratch against the bare interface, ignore the abstract base entirely, and lose nothing but convenience. If the base grants access to anything the interface alone does not, it is a hidden second interface and the principle has already broken.

  
    
### A4. Stores split by default and consolidate by configuration; servers are the other way round

     _[Agreed]_
  
  

Core ships two store adapters, `memory()` and `sqlite()`, and owns no store schema. Zero configuration yields **several named stores already defined**, each on its own SQLite file, which is exactly today's behaviour reached through the uniform mechanism instead of three bespoke ones. Consolidating onto one Postgres is a config change; a customer writes that adapter, or does not.
  

**Servers do not work this way today, and Jaco is right that they should.** Verified: `serversPlugin` iterates only what you declared, and `requireWebIngress` throws RC5003 for a missing `"default"` (`registry.ts:576`). Four consumers depend on it -- HTTP mounts, MCP, ACP and Ops -- so all four fail until a server block exists. `"default"` is a naming convention wearing the costume of a default.
  

**The asymmetry between the two is real and has a rule behind it.** Stores want isolation by default: separate files cannot collide on `PRAGMA user_version`, cannot share a blast radius, and carry independent retention. Servers want consolidation by default: one port, one TLS configuration, one CORS policy, and a second listener is usually a mistake rather than an intention.
  
> **The generalisable rule: a default may be implicit when the resource it creates is private and free, and must be explicit when the resource is shared, scarce, or externally reachable.** Creating `.routecraft/deferrals.db` on your behalf surprises nobody. Binding `0.0.0.0:8080` because you added an MCP tool is a security event.
  

That rule resolves the servers question without copying the store answer wholesale: servers should get an implicit default *object* so the four consumers stop failing, but it must still bind nothing until something mounts to it, and its port must remain a stated decision. The convenience Jaco wants is the absent definition, not an absent port.

  
    
### A5. A store's lifecycle is managed by the store plugin, not by core

     _[Agreed]_
  
  

Settled with Jaco across several rounds, correcting two of my own proposals on the way (J15). The layering:
  
  
| Layer | Owns | Knows about data |
|---|---|---|

    
| core | the plugin lifecycle, which the store plugin reuses. Core never learns the word "store" | nothing |
|---|---|---|

| store plugin | naming, lifecycle and health of stores, using core's plugin lifecycle one level down | nothing |
|---|---|---|

| shared | RecordStore and KeyValue, contracts only | the contracts, no implementations |
|---|---|---|

| adapters | memory, sqlite, postgres, redis | implement one or both contracts |
|---|---|---|

| plugins | their own API, their own key design | choose a contract, or neither |
|---|---|---|

    
  
  
  

**Consolidation onto one Postgres happens at the contract, not at the core.** One `postgres()` adapter implementing `RecordStore` serves deferrals, sessions and telemetry because those three chose that contract. Cache chose `KeyValue`, so it needs its own adapter or stays in memory, which is correct: a cache trades durability for latency by definition, and routing every hit through a syscall charges everyone for something few asked for. A plugin that wants neither contract writes its own and loses nothing but the shared adapters.
  

This is A3 one level out. The shared contracts are the abstract base: useful, optional, and granting nothing the bare `ManagedStore` does not. The test is that a plugin can ignore `RecordStore` entirely and still be a first-class store.
  
> **Two additions to plain CRUD that are not optional.** "Save, retrieve, update, delete, list" does not carry deferrals, and deferrals are the consumer the consolidation story lives or dies on:
> 
  **A version on update and delete.** "Exactly one concurrent caller wins the resume" is the correctness core of deferral, and read-then-write cannot provide it. `SessionStore.replace(key, expectedVersion, value)` already has this shape.
> 
  **A list that takes filter, order and cursor.** `releaseClaims(before)` and `findExpired(now, limit, after)` are ordered range reads, not enumerations.
  

**Naming.** Not `SqlStore`. The contract is CRUD plus an ordered list, which Postgres, Mongo, DynamoDB and SQLite all satisfy; calling it SQL implies relational and invites SQL strings, which is the passthrough trap that makes an interface unportable while looking portable.
  

**What this deletes.** `shared/sqlite/claims.ts` exists only to detect two subsystems colliding on one database file. With namespaces allocated by core rather than claimed by settings, the collision is structurally impossible and the mechanism goes.

  
    
### A7. There is no foundational tier. There is a dependency graph

     _[Agreed]_
  
  

Jaco's doubt (J18) was that stores and servers feel like a middle layer every other plugin needs, and that core cannot expose them if core does not know them. The resolution is that **core knows about dependency, not about stores**.
  

The store plugin publishes a token and its type from its own package. The deferral plugin imports that token and declares `dependsOn: ["routecraft.stores"]`. Core topologically sorts, starts stores first because the graph says so, and refuses at boot with a legible error when a required plugin is absent. Core never types the token.
  

So a foundational plugin is only one with a high in-degree. Same interface, same lifecycle, same ability to be declined. No second kind of plugin is needed, which is what the doubt was really asking for.
  
> **The one missing piece is small.** `dependsOn` already exists on the plugin type and is marked *RESERVED. Not enforced yet* (`context.ts:105`). Ordering today is push order: registered config appliers first, then `config.plugins`. Nothing can state what breaks when a plugin is declined, which A6's disable requirement needs.
  

**This also turns Jaco's instinct into a metric.** "If a foundational plugin changes frequently, something is wrong" becomes churn weighted by in-degree: a plugin with ten dependents changing weekly is what CI should alarm on. That is the inverted, forward-looking version of the churn analysis that opened this register, and a better signal than raw churn because it prices the blast radius rather than the edit.

## Where this came from

Jaco's observations, recorded as stated. These are the originating hypotheses rather than findings: they come from a year of reading pull requests and reviewing findings, not from reading the current code. Each carries what checking it against the code produced, including where the instinct was right and the target was wrong.

  
    **J1.**  _[Confirmed]_
    
> We focus too much on the DSL, and what that led to is a patch job. I've cared only about the DSL that is customer facing and not the implementation, and that's starting to bite me where I'm seeing more and more time being spent on every feature.
    

This is the originating diagnosis and the churn data supports it directly. The one subsystem with a real published interface, `adapters/`, has the lowest rework rate in the codebase. Everything reached only through the DSL and never through an interface sits above it.
  

  
    **J2.**  _[Corrected]_
    
> Our plugins are not properly designed plugins. HTTP, servers, mounts are built directly into the core, which is why we fix one thing and break something else.
    

Right that something is broken, wrong about what. Core does not import the transports: `context.ts`, `route.ts`, `builder.ts` and `executor.ts` contain zero references to http, server or mount. The coupling is through private store keys instead, which a grep for imports does not show. See A2. The conclusion survives the correction: they are not replaceable.
  

  
    **J3.**  _[Confirmed]_
    
> Can someone write a server plugin, an MCP alternative, an HTTP plugin, or a WebSockets plugin mounted at a specific point, and disable ours, without changing a single line of the framework? If the answer is no to any of them, we don't have a clear interface.
    

No to all four. The contracts between first-party plugins travel through keys that are not exported, so a replacement cannot be written. WebSockets is the sharpest case: a plugin and adapter are possible, but mounting on the existing server is not, because `WEB_INGRESSES` is private. This test became the governing principle.
  

  
    **J4.**  _[Confirmed]_
    
> Do user-defined plugins and operations have the same interface we have as framework owners?
    

No for operations. `OperationType` is a closed TypeScript enum the executor switches on. `registerDsl` takes a `kind: PrimitiveKind` and its own doc calls it "the core primitive step kind this DSL method delegates to". A user's operation is sugar over one of ours. We can add a primitive; they cannot.
  

  
    **J5.**  _[Not yet checked]_
    
> Every plugin should define a context store scope only it can access, and declare in code what else it reads, so you can see which adapters access which stores.
    

Recorded as A2, promoted from the nice-to-have Jaco called it. Declared contracts are what make substitution possible, so this is not an isolation feature bolted on, it is the mechanism J3 needs. What is not yet checked is whether every current store use fits a provide/require shape, or whether some need a third mode.
  

  
    **J6.**  _[Confirmed]_
    
> The AI things should be peers rather than an AI plugin that defines its own interfaces. Maybe AI has an abstract implementation, but the agent loop itself should be overridable. Today it is the Vercel adapter.
    

The design correction is right and it caught a real error in this register's first draft, which had proposed AI-private sub-interfaces: that would recreate the two-interfaces bug one layer down and give AI plugins a privilege a third party lacks. On the fact, the Vercel coupling is shallower than assumed: only three files import the SDK, all under `llm/providers/`. The agent loop is the real gap, and it is concrete rather than interfaced. See O1.
  

  
    **J7.**  _[Confirmed]_
    
> Our LLM config lets you define the ones we think are relevant plus a custom escape hatch, and custom is not at the same level. All providers need the same interface whether custom or not, and you should just pass them and give them a name.
    

Confirmed and worse than stated. Custom is not a provider with fewer options; it is a different kind of thing. The six named providers are declarative and get peer loading, install hints and settings handling. Custom carries one field and gets a shape check. See D4.
  

  
    **J8.**  _[Not yet checked]_
    
> Maybe plugins declare their peer dependencies, so `loadOptionalPeer` becomes a list on the plugin interface that core calls underneath.
    

Consistent with A3 and worth designing in, because a third-party provider should get the same `RC5017` install hint a first-party one gets. Unchecked: whether peer loading is always plugin-scoped, or whether some loads are per-call and cannot be hoisted to a declaration.
  

  
    **J9.**  _[Confirmed]_
    
> Look at the git history for which files change the most, and you know which ones are the tangled pieces that need an interface.
    

The method that produced the evidence table below, with one refinement it needed: raw churn alone cannot tell growth from tangle, and edits per file can. It also has a failure mode, recorded at O3: a completed rename and an abandoned one look identical.
  

  
    **J10.**  _[Confirmed]_
    
> We have very high test coverage, which means many of these refactors should be testable: everything still works, but it's now cleaner.
    

**Refuted in validation.** 129–194 of 265 test files import a deep `src/` path, so roughly half the suite is coupled to the internal module layout the refactor exists to change. This number is the migration budget, not a rounding error. The original 12-of-270 figure does not reproduce under any method. The qualification: a green suite proves preservation, not correctness. PR #818 was green at 3,841 tests while carrying two Major defects in the core error path, and `settleOrAbort`, the bound on every user hook, had zero tests.
  

  
    **J11.**  _[Corrected]_
    
> Every plugin defines its own store. There is no way, like with servers, to set up a named store, a Postgres deployed somewhere with credentials, and have every store draw from it with its own database or schema. I like the SQLite file per concern, but not everyone wants that. Is that not an opportunity for the context store? Things save into it, and it gets backed by SQLite or memory or whatever.
    

The diagnosis is right and is D8. My first answer called the context store "not a candidate", which overstated a narrow objection into a rejection; he pushed back and was right (J13). What survives: today's API is synchronous whole-value get/put over live objects, which cannot express async CAS or a scan, and 37 of its 44 keys must not survive a restart. What does not survive: none of that rules out the name and the ergonomic moving to a durable store that plugins opt into per declaration.
  

  
    **J12.**  _[Confirmed]_
    
> What are we using as an external interface that makes it difficult to replace? One is Pino, and we have a ticket. And what do we have several implementations of that are closely the same, with no interface?
    

Both questions land on the same file set. Pino's child-logger type is core's public contract at 8 declaration sites with no interface behind it, and the four hand-rolled subsets of that missing interface are the best near-duplicate case in the codebase. D9. The ticket, [#542](https://github.com/routecraftjs/routecraft/issues/542), is already scoped correctly and has been open since August.
  

  
    **J13.**  _[Confirmed]_
    
> Is there a way to fix the generic store thing so that core does not provide it, but core provides the means for a plugin to define its own store? Each store belongs to a plugin. So instead of each plugin having its own store, each plugin picks which store to mount. You say the context store is not the right shape. It is not the right shape today, yes. But we just said we need a way for every plugin to define what it saves.
    

The challenge lands. Judging a candidate by its current shape is the wrong test in an exercise whose subject is changing shapes, and I made it. "Each plugin picks which store to mount" is the correct framing and is now D8's mechanism; the per-declaration opt-in it implies also answers the objection I raised, because the 37 keys that must not persist simply never declare a store. What the pushback also surfaced is D10, which is the thing that actually blocks the design and which neither of us had looked at.
  

  
    **J14.**  _[Confirmed]_
    
> If it is a generic store, it needs generic methods, and the store interface needs to add things in a generic fashion before they can be used. A store can be of any type, it always has the same interfaces, and you can write an adapter. By default we ship with two, SQLite and in-memory, and we choose already which one we use, and a customer can build a Postgres one or not. For stores we split by default, but you can consolidate. The one thing I do not like about servers is that the default server is not a default. You have to define it.
    

Right on all three counts, and one of them corrects me. My two-primitive split (keyed records plus an append-only log) was an over-split: the log is keyed records with an ordered key and a range delete, so one interface serves all four stores. D10 is rewritten accordingly. The servers observation is verified: there is no implicit default and four consumers fail without one. The split-by-default versus consolidate-by-default asymmetry he drew is correct and now carries a rule in A4.
  

  
    **J15.**  _[Confirmed]_
    
> Why does the core need any real methods on the store except getting the instance, checking it is running, and a startup and shutdown hook? Anything to do with getting, saving, looking up or deleting data is not required to be understood by the core at all. In shared we have an interface for a generic data store, and most of the plugins we develop choose it so they can be consolidated. Other plugin developers do not have to.
    

This is A5, and it corrects me twice. I proposed a seven-method keyed store *in core*, carrying #601's framing forward without re-testing it against "everything is a plugin". The test settles it: if deferral is a plugin, what deferral stores is deferral's business, and core shipping a data contract because four of its own subsystems want one is the reasoning that put HTTP and servers in core. Putting the shared contracts in `shared` rather than core also resolves the Postgres question I could not close: consolidation happens at the contract, so one adapter serves every plugin that opted in, and core stays ignorant.
  

  
    **J16.**  _[Not yet checked]_
    
> What I want is an interface that is managed by the core, where the core does not care what happens inside it. That is the same for servers. Maybe servers should not even be in the core. That is the next-level unlock. And everything not in the core needs to be a plugin.
    

The generalisation of A5 beyond stores, and the register's next target. Stores were the worked example; the claim is that the same shape applies to servers, transports, mounts and the agent loop. Not yet checked: the specific boundaries for each, and whether anything in core genuinely resists the pattern. That is the work after the store entries.
  

  
    **J17.**  _[Confirmed]_
    
> Core manages lifecycle and defines interfaces. Core does not dictate logic. We will have main plugins that we ship as part of the main module, and each of them defines operations the same way the AI plugin would, or John's plugin, or DevOptix's. The core does lifecycle management of the entire exchange, the context, all stores, all plugins. And you should be able to disable any plugin, including the core ones, so you can build your own if you do not like the way we do it.
    

Corrects A1, which said core holds interfaces and nothing else, and adds A6. The second half is checkable and mostly fails today: D11 finds six operations registered through the public door and roughly seventy hard-coded as builder class methods, with sources, wrappers and branch operators impossible to define from outside. Declining and replacing a first-party plugin already works through the config-applier registry, which is better than expected, but silently and by import order rather than by declaration.
  

  
    **J18.**  _[Confirmed]_
    
> There is a server plugin that manages and lets you define servers, and a third layer, MCP and HTTP, that mounts to it. The core only manages plugins, context, exchanges and routes. But plugins need to know about stores and plugins need to know about servers, and if core does not know about them, how would they be exposed to one another? That is my big next question.
    

The nesting is right and improves A5: the store plugin does for stores what core does for plugins, so core needs one lifecycle mechanism rather than two and never learns the word "store". The doubt resolves into A7: core knows about dependency, not about stores, so a foundational plugin is only one with a high in-degree. The missing piece is that `dependsOn` is declared and unenforced.
  

  
    **J19.**  _[Confirmed]_
    
> Could authentication and authorization not be a plugin? They add the ability for servers to be authenticated and bring in operations. And the filter chain you say is hard-coded, is that true when a plugin could add things to it, including the handlers? The error handler, and the entry, start and stop handlers from the ticket, are just extra things in the filter chain decided by a plugin. Deferral is not a plugin, it probably should be. Everything is a plugin.
    

All four confirmed in D12. Auth is three core imports and the branding is already module-private, so it moves with a type left behind. The chain is hard-coded and the handlers are chain positions, which is why the halted work needed a second parallel survival table. Deferral at 202 core references is the clearest case in the codebase. The one exception argued back: the event bus stays core, because it is how core announces the lifecycle it is left to manage.
  

## The evidence

Churn alone does not identify tangle, because a healthy subsystem grows. Edits per file separates the two: growth adds files, tangle rewrites the same ones.

  Source churn by subsystem, 12 months, `packages/*/src/**/*.ts`. Churn is lines added plus deleted.
  
| Subsystem | Churn | Files | Per file | Edits / file |
|---|---|---|---|---|

  
  
| routecraft/pipeline | 3,564 | 4 | 891 | 5.8 |
|---|---|---|---|---|

| ai/agent | 13,436 | 31 | 433 | 3.7 |
|---|---|---|---|---|

| ai/llm | 2,668 | 14 | 191 | 2.9 |
|---|---|---|---|---|

| routecraft/plugins | 11,674 | 42 | 278 | 2.8 |
|---|---|---|---|---|

| routecraft/deferral | 2,501 | 11 | 227 | 2.6 |
|---|---|---|---|---|

| ai/acp | 2,826 | 10 | 283 | 2.3 |
|---|---|---|---|---|

| routecraft/suspension | 6,970 | 19 | 367 | 1.9 |
|---|---|---|---|---|

| routecraft/auth | 2,841 | 12 | 237 | 1.9 |
|---|---|---|---|---|

| routecraft/operations | 9,298 | 41 | 227 | 1.7 |
|---|---|---|---|---|

| ai/mcp | 7,012 | 26 | 270 | 1.7 |
|---|---|---|---|---|

| routecraft/adapters | 14,549 | 106 | 137 | 1.3 |
|---|---|---|---|---|

  

**! 
  
> **WITHDRAWN. This table does not survive its own command.** Re-run over a full clone: `adapters` does have the highest raw churn (27,532) as claimed, but it is **not** the lowest rework at 0.9 edits per file. The lowest is `deferral/` at **0.1, on two commits in twelve months** — the subsystem this whole register calls the most tangled in the codebase.
  

**The cause is the failure mode this register already identified and withdrew as O3.** `deferral/` was created by the rename from `suspension/` weeks before the measurement, so its files have had no time to accumulate edits. The register caught that a completed rename distorts churn, then left the distortion in the row it called its control group.
  

**Consequence.** This was the only evidence offered that a real interface prevents rework. The thesis may still be true; this table is not the reason to believe it. Either re-derive it with `--follow` and a stated commit window, or drop it and rest the case on the impossibility claims, which do reproduce.

## Diagnosed

Evidenced against the code. A direction is proposed for each; none is settled.

  
    
### C1. The route definition is a field bag, so nothing can extend the pipeline

     _[Diagnosed]_
  
  

`RouteDefinition` carries **19** fields on main. Six are identity and wiring, and thirteen are cross-cutting capability state bolted onto a route's identity: nine chain keys, three deferral resolver outputs, one principal flag. *Corrected: the published "21 fields, five resolver outputs" was measured on the halted PR's branch, not on main.* `CHAIN_SURVIVAL` is keyed by `Exclude<keyof RouteDefinition, NonChainField>`, a policy table keyed by that bag. **Three of its nine keys are buckets, not positions** (`preParseFilters`, `postParseFilters`, `postFromFilters`), each justifying a whole-bucket policy by citing one member, while the pre-from chain standard names eleven positions. Per-contribution survival therefore forces a decision for every position currently hidden inside a bucket, and nobody has made those decisions.
  
> `pipeline/` is **4 files at 5.8 edits each**, the worst ratio in the codebase. `executor.ts` alone: **11 commits, 2,275 lines**. Those commits include SSE streaming on the HTTP source, a concept rename, error-path parking and the handler registry. Adding a transport feature edits the executor.
  

The clearest evidence is a workaround in our own follow-up work: the handler points could not join `CHAIN_SURVIVAL`, because a handler point is not a `RouteDefinition` key, so a parallel `POINT_SURVIVAL` table was built. Two tables answering one question for two kinds of participant.
  

**Direction.** One contributed participant concept that owns its own placement, its own continuation policy and its own state slot. Cache, throttle, breaker, retry, timeout, concurrency, authorize, error, defer, resume and the handler points all become contributions that answer for themselves. Both survival tables and the carve-out list disappear.

  
    
### C2. Six carriers of "where is this exchange and what re-runs"

     _[Diagnosed]_
  
  

Position information is threaded through `errorPathSites`, a separately stamped `admissionSite`, a `failingSteps` WeakMap keyed by error object, an `admitted` boolean, the step the executor happens to hold, and `CHAIN_SURVIVAL`. Every structural defect found on PR #818 was two of those six disagreeing: a park landing at position 0 with the whole body as continuation, an admission park recorded for a timeout that had already run two steps, the builder copying five resolver fields while the context copied two.
  

**Direction.** One continuation value computed once at park time, carrying where to resume, which participants re-run, and each participant's serialized state. Nothing re-derived, nothing inferred from an error object's identity, no policy consulted at resume.

  
    
### C3. Continuation state lives on headers, which are an open caller-writable bag

     _[Diagnosed]_
  
  

Six `routecraft.deferral.*` header keys carry whether an exchange is a continuation, what it is resuming, and which scopes were refused. Headers propagate through `forward()` and `direct()`, so every route ingress needs a strip, maintained by hand. A caller can supply `routecraft.deferral.refusedScopes` as ordinary input.
  

Compare the principal, which solves the same problem the opposite way: trust is a module-private WeakSet, unforgeable and un-propagatable.
  

**Direction.** A participant's state slot rather than a header: not caller-writable, not propagated by default, serialized into the continuation explicitly. This is a behaviour change and needs an explicit decision, not just an internal refactor.

  
    
### D6. Seven of nine core folders have no public face, so nothing can import through them

     _[Diagnosed]_
  
  
> Only `deferral/` and `telemetry/` have an `index.ts`. **312 cross-folder deep imports** inside core reach past a folder root at a specific file, excluding the barrel, which must reach at files. The package's outer surface is **598 exports across an 833-line index.ts**. *Corrected in validation: the register first published 193 and 663/846, none of which reproduce.*
  

There is nothing to import through, so every import reaches at a file. This is an absent mechanism rather than a cultural problem, and the proof is next door: `@routecraft/ai` imports from `@routecraft/routecraft` 86 times and **never once** reaches past the published entry point. The team respects a boundary when one exists and is enforceable.
  

**The reassurance was the wrong way round.** Discounting `shared/` leaves **239**, not 90. The count of distinct target files reached is 125. This makes step 2 of the sequence roughly three times the size first stated, and it is the step everything else waits on.
  

**Direction.** An `index.ts` per folder, then `no-restricted-imports` path patterns denying everything but `shared/` and each folder's own index. The exception list lives in the ESLint config, so coupling two modules becomes a visible diff in one file; a CODEOWNERS entry on that file means the only way to couple two modules is a pull request that tags Jaco. Everything else keeps merging on green.
  

**Sequence.** Folder boundaries first, because they are internal and cost users nothing. Shrinking the 663-export outer surface is a separate and riskier job, since every removal is a breaking change, and it becomes answerable only once each folder has a curated index to answer from.
  

This is the only entry in the register that is **enforced mechanically forever after** rather than reviewed, which makes it unusually cheap to keep. Same ratchet argument as the extraction test.

  
    
### D7. `shared/` is the default dumping ground, and four of nine files do not belong there

     _[Diagnosed]_
  
  

Challenged by Jaco, measured, and he was close to exactly right: he guessed half, it is four of nine.
  
> By distinct consumers, discounting the root index which only re-exports:
> 
  **Genuinely shared:** `duration` (**35**), `stale-options` (**11**), `abort` (6)
> 
  **Marginal:** `safe-json` (2), `thenable` (2)
> 
  **Not shared:** `runtime-version`, `standard-schema`, `compare`, `iterable` (1 each)
  

Import volume tells the other half of the story: three files account for the large majority of **139** imports, and the four that do not belong account for **six imports total**. So both things are true. Nearly half the files do not earn their place, and moving all four is a twenty-minute job rather than a refactor.
  

The duplication argument already has evidence in this repo: `@routecraft/ai` keeps its own `isThenable` rather than widening core's `@internal` export. Someone already made that call and it was right.
  

**Rule to adopt.** A utility earns `shared/` at its **third** consumer. Below that it lives in the folder that uses it, and a second consumer copies rather than couples. Three is where copies start to drift faster than an import would cost.

  
    
### D8. Two unrelated things are both called "store", and only the one that cannot persist is shared

     _[Diagnosed]_
  
  
> `StoreRegistry` holds **44 keys declared across 20 files**. Not one of them is a data row. They are live runtimes (`AgentSessionRuntime`, `DeferralRuntime`, `McpToolRegistry`), registration maps, booleans, `Set`s and connection pools, kept in a synchronous `Map` at `context.ts:538`.
  

`context.getStore()` is a service locator. It is the dependency-injection container under another name, and the name is the whole problem: it is why "can plugins persist into the context store" is the natural question to ask, and why the answer is no. Backing it with SQLite would mean serialising an open IMAP connection pool.
  
> The things that actually persist are four, each configured separately and none of them sharing anything above the driver:
> 
  `DeferralStore` (`deferral/types.ts:523`) via `deferral: { store }` to `.routecraft/deferrals.db`
> 
  `SessionStore` (`ai/agent/session/port.ts:44`) via `sessions: { store }` to `.routecraft/sessions.db`
> 
  telemetry's `SqliteConnection` via `telemetry: { sqlite: { dbPath } }` to `.routecraft/telemetry.db`
> 
  `CacheProvider` (`operations/cache-provider.ts:35`), in-memory only, no persistent implementation exists
  

The first two take the same four-armed config (`path` | `{ path }` | `"memory"` | an instance) and neither knows the other exists. Telemetry takes a path only: no memory arm, no instance arm, so a deployment with a real database cannot point telemetry at it at all.
  

**The tell is a mechanism built to refuse sharing.** `shared/sqlite/claims.ts` exists so that two subsystems aimed at one file fail at boot with both setting names, because each store stamps its own `PRAGMA user_version` into the file and the second one to open would refuse. Sharing one backing store is not merely unsupported; the codebase detects the attempt and rejects it. And only two of the three sqlite consumers participate: telemetry never claims, so it can still silently collide.
  
> The pattern Jaco wants already exists one subsystem over. `servers?: Record<string, HttpServerDefinition>` (`plugins/server/config.ts:7`), consumers select with `server?: string` defaulting to `"default"` (`registry.ts:576`). HTTP, MCP and Ops each mount to a named server, and a fourth could without core changing. Nothing equivalent exists for stores.
  

**A ticket exists and is better than this entry.** [#601](https://github.com/routecraftjs/routecraft/issues/601), milestone 0.9.0, opened from the same observation in August 2026. It already carries the named provider, the per-subsystem override precedence, the exclusion of agent memory, and the argument that a route author is the fourth consumer. It should be read before anything here is redesigned.
  

**What is new is a conflict with the governing principle.** #601 shapes the provider as a bundle of named slots: `{ deferralStore(), telemetrySink(), consoleStore() }`. That enumerates the subsystems core knows about, so a third-party WebSockets plugin needing durable state cannot get a slot without core adding a method to the provider interface. Same closed-set failure as D4's LLM providers, arriving fresh in a design not yet built.
  

**The mechanism, stated concretely.** `stores?: Record<string, StoreProvider>` on `defineConfig`, exactly parallel to `servers`. Core ships `memory()` and `sqlite()` providers and owns *no* store schema. A plugin declares the store it needs and names a provider, defaulting to `"default"`. Everything after that is the servers precedence rule, which the codebase already runs.
  

**One place stores can beat servers.** `"default"` is only a conventional name for a server, not an implicit one: an undefined `default` throws RC5003 (`registry.ts:576`), because a port is a decision nobody can make for you. A store default *can* be implicit, because `.routecraft/<plugin>.db` is already the zero-config behaviour of all three subsystems. So a plugin that never thinks about storage keeps working, and a deployment that names one provider moves everything at once. Both of Jaco's halves, the file-per-concern default he likes and the single Postgres he does not want to wire five times, come from the same construct.
  

**This mechanism alone does not deliver it.** See D10: the contracts a provider would have to realise are state machines, not storage. Order matters here, and it is the opposite of the intuitive one. Shrink the contracts first; the registry is the easy half.

  
    
### D9. Pino's API is the logger contract, and four files have each hand-rolled a private subset of it

     _[Diagnosed]_
  
  
> No `Logger` interface exists in core. `CraftContext.logger`, `Route.logger` and `Exchange.logger` are typed `ReturnType<typeof logger.child>` across **8 declaration sites**; **68 source files** reference `.logger`. The published `dist/index.d.ts` opens with `import * as pino from 'pino'`.
  

Core's public API cannot currently be described without pino. Replacing it is therefore a breaking change to the type surface rather than a dependency swap, which is the answer to "where are we using an external interface as our own".
  
> Four private re-declarations of the same missing interface, each a different subset, each carrying a comment that says what it is:
> 
  `TelemetryLogger` (`telemetry/types.ts:111`) -- `warn` only
> 
  `EventBusLogger` (`event-bus.ts:9`) -- `warn`, `error`, with `unknown` bindings
> 
  `MailFetchLogger` (`adapters/mail/shared.ts:730`) -- `debug`, `warn`, as properties not methods
> 
  `Logger` (`ai/mcp/stdio-client-manager.ts:22`) -- four levels, not exported
  

Each comment says some version of "matches the pino child shape without pinning to pino's types". Four authors independently wrote down the need for the interface and then, each time, declined to create it. That is the clearest answer in the register to "several implementations that are nearly the same with no interface": it is not a near-duplicate that nobody noticed, it is one that everybody noticed. The test kit pays the same bill differently, monkey-patching the module singleton and casting through `as unknown as ReturnType<typeof logger.child>` at `testing/src/test-context.ts:453`.
  

**A ticket exists and is already scoped correctly.** [#542](https://github.com/routecraftjs/routecraft/issues/542), milestone 0.9.0, breaking, specifies the port, the module-level seam (correctly noting that a context-only seam fails because `Exchange` builds children off the module singleton before any context exists), the dual call shapes, `silent`, and a safe default serialiser. It needs no re-scoping. It needs building.
  

**Why it belongs here rather than in its own backlog.** It is A1 and A3 in miniature, already fully written down and unbuilt for six weeks: define the interface in core, make the incumbent an implementation, swap providers freely. If the overhaul does not carry this one, the register's claim that the team knows the pattern but has nowhere to put it is confirmed by its own worked example going unbuilt again. Jaco's stated driver is independent of any of that: pino raises Docker image scanning findings at a client.

  
    
### D10. The store contracts are state machines, so no adapter can serve a plugin it was not written for

     _[Diagnosed]_
  
  
> `DeferralStore` has **15 methods**. Four are storage. Five encode deferral *semantics*: `markResumed`, `claimExpiry`, `markExpired`, `markDenied`, `recordContinuation`. Six are queries. `SessionStore`, next door, is **6 methods** with nothing session-specific in its shape, arrived at independently.
  

Writing a Postgres backend for deferrals today is not implementing storage. It is reimplementing what "claimed", "expired" and "denied" mean and keeping that in step with core's lease semantics forever. That, not a missing registry, is why no third-party store exists.
  
> **In lines:** `DeferralStore` implemented twice costs **1,289** (836 sqlite, 453 memory). `SessionStore`'s two backends cost 362, *but that omits `session/store.ts`, 242 lines, which is the typed semantics layer over them*. The like-for-like figure is **604**. Under A5 a Postgres author writes one `RecordStore` adapter and serves every plugin that chose the contract. The honest saving is 1,289 collapsing to roughly 850–1,050 including deferral's own semantics layer, **and the real win arrives at the third backend rather than the first**.
  

**Where the 15 methods go.** They do not disappear; they move from the store contract into the plugin, written once instead of once per backend. The state transitions become versioned writes. The queries become ordered reads over index keys the plugin maintains itself: `idx/expiry/<deadline>/<id>`, `idx/claim/<claimedAt>/<id>`. Key design is the real work and is where a plan that says "just use a generic store" has stopped too early.
  
> **Two constraints found by reading the contract rather than assuming.**
> 
  `list()` returns a projection on purpose: its JSDoc says returning whole records "would page a hundred thousand exchange bodies through memory on the way to dropping them". The summary and the body must therefore be separate records, or the listing regresses.
> 
  Index maintenance becomes the plugin's correctness problem, and a missed index delete is a bug a SQL `WHERE` could never have. This is the strongest argument against the design. It is survivable only because index writes ride in the same atomic write as the record, so a crash cannot desynchronise them; only a coding error can, which the existing three-way contract suites catch.
  

**One thing improves rather than holding level.** `findExpired` and `list` currently warn that a cursor "must only ever be replayed against the store that produced it", because byte ordering differs per backend. A contract with a stated collation, code point order, which `SessionStore.keys()` already specifies, makes cursors portable and deletes the caveat.
  

**Not in #601.** The ticket proposes one connection with a bundle of per-subsystem slots hanging off it. That centralises where a connection is declared and leaves all 15 methods in the contract, so a Postgres author still writes the 858 lines. #601 solves the wiring complaint and not this one.

  
    
### D11. The public door adds sugar over five fixed kinds; main uses the private door for everything else

     _[Diagnosed]_
  
  
> `registerDsl`'s contract is `PrimitiveKind = "process" | "transform" | "tap" | "filter" | "validate"`, a closed set of five, and its implementation always does the same three things: build a step, push it, return `this`. Its own JSDoc calls it "DSL sugar".
  

Through the public door a third party adds a step delegating to one of five primitives. It cannot define a **source** (`from` lives on `craft()`, `builder.ts:618`, and fixes the route's type parameters), a **resilience wrapper** (retry, timeout, circuit breaker, throttle and concurrency occupy pre-from filter-chain positions), a **branch operator** (`choice`, `multicast`, `split`, `aggregate` shape the chain rather than appending to it), or a **new position in the filter chain** at all.
  
> **Six operations go through the public door:** `log`, `debug`, `map`, `schema`, `defer`, `resume`, which is exactly the set needing nothing but an append. Everything else is a class method. By AST walk: **23–25 distinct on `StepBuilderBase`** and **25–30 distinct on `RouteBuilder`** (1,899 lines), so a user-visible surface of roughly **54 distinct methods**. *Corrected: the first count used a regex that swept in overload signatures and published "roughly seventy", overstating by about a third.*
  

This is D5's rule with a number attached. The door main uses to build itself is not the door it hands out, and the gap is not a detail: it is sources, wrappers and branch operators, which is most of what makes the DSL worth using.
  

**`from` is the one that will resist.** It is not on the step builder and it decides the route's type parameters, so making it externally definable means the type-level machinery becomes part of the published contract rather than a class signature. Design it first, not last; if it cannot be done, A6 is not reachable and the register should say so rather than route around it.
  

**What is already better than expected.** Plugin installation runs through `getConfigAppliers()`, an open registry keyed by config key, and a plugin is installed only when its key is set, so declining a first-party plugin is already just omitting its config. Replacement works too, because `registerConfigApplier` is a `Map.set` and the last registration wins. Both by accident rather than by design: the overwrite is silent and load-order dependent, so two packages replacing `servers` resolve by import order with no diagnostic. Under A6 a replacement should have to declare itself one.
  
> **Core still knows about specific plugins.** `context.ts` reads `DEFERRAL_RUNTIME` and `CAPABILITY_REGISTRY`; `adapters/http/source.ts` reads `HTTP_MOUNTS`. Each is a place where core, or a main adapter, holds knowledge A6 says belongs to a plugin. Plugin `dependsOn` exists in the type and is marked RESERVED and not enforced, so nothing today can state what breaks when a plugin is declined.

  
    
### D12. Core has a public seam for observing and none for intervening, which is the whole register in one sentence

     _[Diagnosed]_
  
  
> Of 28 core-candidate files, **12 actually import into plugin territory**, making **75 import statements** carrying **~156–190 symbols**: `operations` 52 statements and **122–152 symbols**, `deferral` 9, `adapters` 9, `consumers` 2, `auth` 2, `plugins` 1, **`telemetry` 0**. *Corrected: the published 81 mixed statement counts and symbol counts inside one figure and reproduces under neither method; 28 was the population, not the offenders.*
  

**Telemetry and deferral are the same class of subsystem.** Both observe exchanges, both persist, both carry a config key, both have a lifecycle. Telemetry sits at **0 imports and one reference** in core (`context.ts:220`, validating its own config key), hooking in entirely through `ctx.on("*")` and `registerConfigApplier`. Deferral sits at **420 occurrences across 14 core files** (218–274 with comments stripped): `error.ts` 83, `exchange.ts` 68. *Corrected: the published 202 counted matching lines in some files and occurrences in others. The file count of 14 is exact, and the contrast is sharper than first stated, not weaker.*
  

**The only difference between them is that telemetry observes and deferral intervenes.** Core publishes an observation seam, the event bus, and nothing for participation. So anything that needs to change what happens next is hand-threaded through core instead of plugged into it.
  

That one absence accounts for the rest of this register. C1's field bag is the list of interventions core hard-codes. C2's six carriers are what interventions use because no shared one exists. D11's missing wrapper door is an intervention point. And PR #818 became a patch job because every new handler point had to be threaded by hand through fourteen files.
  
> **The chain already broke under exactly this.** `CHAIN_SURVIVAL` is keyed by `Exclude<keyof RouteDefinition, NonChainField>`, so a chain position must be a field on `RouteDefinition`. Handler points are not, so the halted work added a second, parallel, hand-maintained table, `POINT_SURVIVAL`. Two tables that must agree, one derived by the type system and one written by hand.
  

**The blockers sort into three groups, not eighty problems.**
  
    
- **A, misfiled types, about 20 sites, mechanical.** `Source` and `Subscription` in `operations/from.ts`; `OnParseError` in `adapters/shared/parse.ts`; `HealthChange` in `plugins/ops/types.ts`, so core's own `types.ts` depends on the ops plugin; `CronExpression` in `adapters/cron/types.ts`, so route enablement depends on the cron adapter; the four `Resolved*Options`. Core kinds filed in instance folders. Moving them changes no behaviour.
    
- **B, the hard-coded chain.** `pipeline/executor.ts` imports the timeout, retry, circuit-breaker and concurrency wrappers by name and runs them in a fixed order. One real design job: the chain becomes an ordered registry of contributions.
    
- **C, deferral.** Not a plugin. A core feature wearing a config key.
  
  

**Auth is smaller than it looks and can move.** Three core imports: `Principal` (`exchange.ts`), `authorize` (`builder.ts`), `insufficientAuthorityOf` (`executor.ts`). The principal branding is already a module-private `WeakSet` in `auth/authentic.ts`, and its unforgeability comes from module privacy rather than from sitting in core, so it works identically inside a plugin package. The split: `Principal` as a type is exchange identity and stays; JWT, JWKS, `authenticate()`, `authorize()`, the branding and the error classification all leave. The executor's import dissolves once the auth plugin can contribute an error classification.
  
> **The acceptance test is free, because the work already exists.** Rebuild defer and resume as a plugin with zero core edits. PR #818 is halted in draft carrying the requirements; if they can be met from outside, the architecture is real. If they cannot, this register should say so rather than route around it.
  

**One thing stays in core against the "everything is a plugin" rule.** The event bus itself. Telemetry is the plugin and already is one; the bus is how core announces lifecycle transitions, and lifecycle announcement is the only job A1 leaves core. The symmetry to build toward is two core seams, observation and intervention, with everything else a plugin.

  
    
### M1. How this register got sixteen numbers wrong, and the eight habits that produced them

     _[Method]_
  
  

An independent clean-room agent checked every load-bearing figure against the tree. **Sixteen were refuted, misleading or unreproducible.** Each has been corrected in place above rather than deleted. The direction of every finding survived; several were understated. But the errors were not sixteen accidents, they were eight habits, and the habits are the durable lesson.
  
> **1. Measured on the wrong branch and never said which.** `POINT_SURVIVAL`, "21 fields", "five deferral resolver outputs" and the 858+456 line counts all came from `feat/810-error-path-defer`, the halted PR, written as facts about main. On main they are: absent, 19, three, and 836+453. **This one habit produced four of the sixteen.**
> 
  **2. Grepped for what was suspected instead of enumerating.** Three import cycles were reported; `madge` finds **71**, one of them a value cycle.
> 
  **3. Mixed two counting methods inside one figure.** The "81 core-to-plugin imports" took two folders from a statement count and two from a symbol count. No method yields 81.
> 
  **4. Counted lines where occurrences were meant.** "202 deferral references" was lines in some files and occurrences in others; the real figure is 420 occurrences.
> 
  **5. Used a regex where an AST was needed.** "48 methods on `RouteBuilder`" swept in overload signatures; an AST walk gives 25–30 distinct.
> 
  **6. Reasoned about a language limit instead of testing it.** F8's "fluent or sound, not both" was argued, not run. A fifth encoding disproves it.
> 
  **7. Declared without wiring.** The spike declared `RouteSpec.source` and never subscribed it, so sources were never demonstrated at all.
> 
  **8. Omitted the file that undercut the comparison.** `session/store.ts`, 242 lines, is the semantics layer D10 proposes deferral acquire, and leaving it out made the saving look 3.6x when the honest figure is smaller and arrives at the third backend.
  

**What follows for anyone using this register.** Every number here is now either reproduced or corrected, but none of them is pinned to a commit, and that is the root of habit 1. Before any of these figures gates a decision, pin them: one checked-in script per claim, quoted output, and a stated commit. A ratchet on a figure two people cannot reproduce with the same command is a gate nobody will trust.
  

**What this does not change.** D12, the headline, is confirmed by every count re-run, and the coupling it names is *larger* than first published: `operations` alone carries 122–152 imported symbols into core, six times the next folder. The thesis was never the weak part. The arithmetic was.

## Open

Churn signal and a first reading only. Each needs the same treatment the diagnosed entries got: read the code, find the mechanism, then propose.

  
    
### O1. The agent loop is concrete, and the AI package has no peer structure

     _[Diagnosed]_
  
  
> `ai/agent`: **31 files, 3.7 edits each, 13,436 lines**. Second worst ratio, largest absolute churn of any tangled subsystem. The SDK itself is imported by **only 3 files**, all under `llm/providers/`.
  

The model-provider seam is already in roughly the right place and the Vercel coupling is shallow. What is welded is one layer up: `agent/run.ts` does `import { callLlm } from "../llm/providers/index.ts"`, a direct function import rather than a contract, and `AgentRun.runUntilDone` and `runStream` are concrete. Someone wanting a different loop, tool-call protocol or stopping rule has nowhere to stand.
  

**Direction, per J6.** `agentPlugin`, the LLM provider, `mcpPlugin`, `acpPlugin` and embedding are **peers against the one core interface**, not children of an AI plugin that defines its own extension system. An AI-owned extension point would give AI plugins a privilege a third party lacks, which breaks the governing principle directly. Shared code goes in an abstract implementation under the A3 reuse rule.
  

This entry moved from open to diagnosed once the SDK coupling was measured. The remaining unknowns are how many contracts the loop actually needs and whether sessions and tool selection are separate ones.

  
    
### D4. The LLM provider set is closed, and custom is a hole rather than a provider

     _[Diagnosed]_
  
  

A closed discriminated union of seven variants with a `switch` and a `never` exhaustiveness check. Six named providers carry their own config shape and get declarative treatment: the framework resolves the SDK, handles the optional peer import, emits `RC5017` with an install hint when it is missing, and applies settings. The seventh, `custom`, carries one field, a pre-built model or a factory, and gets a shape check.
  

They are not the same kind of thing. And the `never` check makes it structural: adding a provider is a core edit. Nobody outside can add `case "mistral"`; they can only pass a finished object through `custom` and forfeit everything the named path does.
  

**Direction.** A provider is a name, a way to build a model from an id, and a config shape. That is an interface with three members. The six named ones become implementations that ship in the box, `custom` disappears because it has no reason to exist, and a third party registers by name exactly as ours do. Keep `loadOptionalPeer` and its install hint, and hand it to implementations rather than leaving them to solve peer loading alone, per J8.
  

**Best first proof.** Small, self-contained, obviously correct, and it demonstrates an outside provider behaving identically to a first-party one. A better candidate for the extraction test than HTTP: less risk, same proof.

  
    
### D5. The clean extension points are the unused ones; the used ones are private

     _[Diagnosed]_
  
  

`registerDsl` is public and neither `@routecraft/ai` nor `@routecraft/os` calls it once: only core's own sugar uses it. It also patches a shared prototype and throws on a name collision, so two plugins claiming `.retry()` is an unresolvable import-time crash. Meanwhile `setStore` is exercised constantly and every key it carries is private.
  

Stated as a rule, this sharpens the governing principle: **whatever core uses to build itself must be the same thing it hands out, and anything it hands out but does not use is not yet real.** An extension point no first-party package exercises is unproven by construction.

  
    
### O2. The HTTP dispatcher does transport, admission and auth in one place

     _[Open]_
  
  
> `plugins/http/dispatcher.ts`: **1,050 lines churned, 6 commits.**
  

It stamps the authenticated principal into the header bag before an exchange exists, which is correct behaviour and also the reason nothing downstream can participate in admission. There is no seam between accepting a request, establishing who is calling, and producing an exchange.
  

**First reading.** Likely three contracts rather than one file. This entry is what the halted handler-points work was really trying to reach.

  
    
### O3. ~~Two directory names for one concept~~

     _[Withdrawn]_
  
  

**Wrong. Recorded rather than deleted, because the mistake is about the method.** `suspension/` does not exist; it was renamed to `deferral/` and the rename completed. Its 6,970 lines of churn were the deletion.
  

A completed rename and an abandoned one produce the same churn signature. Churn says where the work happened, never whether it finished, so every entry in this register has to be confirmed against the current tree before it earns a place here. That check is what turned this entry from diagnosed to withdrawn.

  
    
### O4. The ops plugin keeps renegotiating its own boundary

     _[Open]_
  
  
> Four of its files appear in the twenty most-committed source files: `management.ts`, `types.ts`, `mount.ts`, `plugin.ts`.
  

A plugin whose files all churn together is one whose internal seams are not settled. Worth a read once A2 exists, because a management surface that declares its contracts may simply fall out.

  
    
### O5. Two connection-pool managers, same job, no shared contract

     _[Open]_
  
  
> `MailClientManager` (**420 lines**, 11 methods) and `CarddavClientManager` (**126 lines**, 5 methods). Both hold pooled remote connections, both resolve options, both drain on teardown, and **they share no method name**. Both are parked in the service locator (`MAIL_CLIENT_MANAGER`, `CARDDAV_CLIENT_MANAGER`), which is the only thing they have in common.
  

**Lead, not a finding.** Mail is genuinely the harder problem: two protocols, reservations, mailbox tracking. Whether a `ClientPool` contract that mail extends is worth having, or whether these are two different problems that merely rhyme, needs a read of both rather than a line count. Recorded so it is not lost, and marked open because it has not been earned.
  

The comparison that matters is D9's: four logger interfaces are a duplicate everyone saw and nobody fixed, which is evidence. Two pools with no overlapping names may simply be two pools.

## What this register does not yet contain

No design. No chosen mechanism. No file layout. The entries state what is wrong, what it has cost, and roughly where the boundary belongs.

**Where this now points.** The register has reached a single headline diagnosis (D12), seven agreed positions, and one method entry (M1) that matters more than any individual number. The design that follows from them lives in a separate artifact rather than here, because this one is a record of what is wrong and the other is a proposal for what to build. What remains uninvestigated here: the event bus internals, `capabilities.ts`, `consumers/`, and the open entries O1, O2, O4 and O5, which are still churn signal rather than diagnosis.

The sequence from here is: complete the open entries to the same evidence standard, then have a clean-room agent independently validate the diagnoses without access to this reasoning, then turn the surviving entries into concrete patterns, and only then build. The first thing built should be the executable test under the governing principle, because a principle with no gate rots quietly, and this codebase has already demonstrated that.

**Who does what.** Fable implements, in an expected one to four pull requests. Astra validates the design before implementation and the result after it. Both must agree on the design or it does not get built. This register exists so neither starts from scratch, and so the difference between what Jaco observed and what the code says is visible rather than blended.

**Validated once, and it did not go well.** A clean-room agent checked every load-bearing figure and refuted, corrected or could not reproduce **sixteen** of them. All sixteen are corrected in place above; M1 records the eight habits that produced them. The direction of every finding survived and several were understated, but treat any number here as pinned to nothing until M1's remedy is applied. **For whoever validates this next.** Every number here is reproducible from the commands in the footer. The J entries are hypotheses from experience, not measurements, and two of them are explicitly unchecked. Three claims in earlier drafts of this register were wrong and were caught by checking the tree rather than the signal: O3 entirely, the plugin-coupling target in J2, and the AI sub-interface proposal in J6. Treat confident prose here as a lead, not a finding.

  

Validated by an independent clean-room agent on 19 September 2026; its full report, counter-examples and 22 tests are on branch `validation/clean-room` at `spikes/plugin-architecture/docs/VALIDATION.md`. Every refutation in it was independently re-run before being accepted here; one of its own claims (a line number in `config-applier.ts`) was wrong and is not carried over. Opened from the PR #818 post-mortem, 19 September 2026. PR #818 is halted in draft, green at ce0c38e, carrying the requirements this work must preserve. Churn figures are reproducible with `git log --since="12 months ago" --numstat` over `packages/*/src/**/*.ts`.

