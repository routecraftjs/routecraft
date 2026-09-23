# Round 7g design review

**Verdict: keep the architecture, proceed with feature-fit discovery, and do not freeze these contracts or migrate the executor from this implementation yet.** The installation and participation model is convincing. The continuation implementation still breaks guarantees that the current record describes as closed. Several failures concern public contract shape, not just missing conditionals.

The next useful step is a compatibility ledger against the real executor, with the failures below as fixtures. I would stop treating successive green spike rounds as permission to copy this executor into production. Retain the shipped execution machinery and extract its participation contracts incrementally. Draft public documentation now, but distinguish decisions, demonstrated behavior, and unfinished migration requirements.

## Provenance and measured results

Reviewed source: **`85f7506a158c3e50230a7bf541ddbf66a7e55f3d`**. Before reading repository content, I confirmed both local HEAD and the remote `validation/round-six` ref at that exact commit. I created the requested review branch from it. The shipped reference is `packages/routecraft/src/` at the same commit. I fetched and confirmed the resume branch at **`ce0c38ee57f98ab8eae169525c40e8504f2d8fa5`**, the supplied #818 head, and inspected its actual door, elevation, notification and error-path execution calls.

Every execution figure below was produced in this review against the unchanged source at `85f7506a158c3e50230a7bf541ddbf66a7e55f3d`. The new fixtures are in `validation/round-seven-g-review/`. Their assertions characterize defects, so their passing is evidence of a problem, not acceptance of the behavior.

| Command or stage | Observed result |
|---|---|
| Root `bun install --frozen-lockfile`, final attempt | Exit 0, Bun 1.3.11 with Node 22.23.2 on PATH |
| Spike `bun run verify` | Exit 0 |
| Verification strict typecheck | Pass |
| Verification acceptance tests | 111 pass, 0 fail, 481 assertions |
| Verification mutation harness | 141/141 classified as killed by its behavioral assertions |
| Verification compiler controls | 15/15 rejected |
| Verification import gate | 12 modules, 27 permitted edges, 0 dynamic edges |
| Verification diagram check | 25 edges, 2 example modules omitted |
| Spike `bun run verify:packed` | Exit 0; external consumer and private-subpath checks pass |
| New `probes.test.ts` | 16 pass, 0 fail, 47 assertions |
| New `point-types.ts`, standalone strict compiler invocation | Exit 0; the problematic open-point contract is accepted without casts |

The logs and exact reproduction commands are beside the fixtures. I have not remeasured historical import counts, compiler scale figures, or earlier reviewers' mutation results, and do not adopt their figures as measurements of this head. I added no mutation tally of my own. The existing harness's unchanged-copy control ran successfully; its reported kills are its existing selected behavioral checks, not evidence that every composition was exercised.

Environment qualifications: Bun was initially absent. An initial root install with Bun 1.4.2 and Node 24.19.0 failed in the `better-sqlite3` install script while extracting Node headers (`fchown`, `EINVAL`). That attempt had installed enough dependencies to run the spike. Its verification run reached 110 passing tests and one failure: the scan-stall fixture hit its 500 ms fallback. I then installed Bun 1.3.11 and Node 22 locally, completed root installation, and reran the requested commands successfully. I have not established the cause of the Bun 1.4.2 test failure, so it is an environment/version qualification, not a diagnosed runtime defect. Frozen-lock installation preserved the repository lockfile.

## What I would retain

**The kernel boundary is now defensible.** It owns scheduling, outcomes, continuation addressing, claims, and execution lifecycle. Identity belongs behind an authority and enforcement contract. Storage implementation belongs behind a semantic port. A kernel owning `CONTINUATIONS` is consistent with owning continuation semantics; pretending it knows no persistence-related contract would be inaccurate. The current amendments recognize this.

**One installation protocol with several contribution contracts is the right abstraction.** Ports, handlers, wrappers, instructions and facets solve different problems. Combining them into a single generic callback would hide rather than remove those differences. The packed consumer actually exercises public declarations and execution, including a custom point, source, branching method, facet and replacement provider. That earns more confidence than an internal mock replacement.

**Keep contract-owned anchors and explicit survival.** Lexical ties are a documented composition rule, and plugin authors own semantically valid ordering. Do not add an attempted universal ordering prover. First-party chains still need explicit constraints and compatibility fixtures. A diagnostic should show effective handler and wrapper order for a particular route and run kind, not only the global contribution list.

**Keep one named facet per namespace.** The state's ownership rule matters more than getter syntax: body and headers persist; facets are reconstructed views or affordances; step state is temporary execution context. R6 shows why that distinction must be enforced across hops, not merely stated.

**Keep the resume/notification asymmetry.** A resume winner must not be silently replayed after a crash. A leased notification claim may be healed. Nothing here justifies reviving the earlier resume-lease proposal, promising exactly-once external effects, or adding distributed transactions to this refactor.

## Findings requiring changes before contract freeze

The priorities below are review judgments. P1 means fix before treating the relevant contract or implementation as a migration target. P2 means a concrete correctness or usability defect that needs a fixture and owner in the migration plan. Source locations refer to the reviewed commit.

### R1, P1: cancellation during the store write still creates a live park

`runtime.ts:949` awaits `store.create` without a cancellation signal in `park` and performs no post-write cancellation check. The pre-write check at `runtime.ts:996` only covers error-path parking before that await.

Both new R1 cases block the store write, abort the caller, and then release the write. Ordinary and error-path deliveries both resolve `deferred`, and their records remain `waiting`. The ordinary case even invokes its notification after cancellation. These are controlled await boundaries, not timing guesses or uncooperative plugin IO.

The shipped `deferral/defer.ts` at the reviewed commit, and #818 at the reference commit, both check after `create`, deny the newly committed record claim-first, and report cancellation before announcement. **Pass the run's cancellation context into the park operation and retain that post-write settlement path.** A pre-check alone cannot implement this guarantee. Add denial-store-failure coverage so diagnostics do not claim a denial that did not commit.

### R2, P1: notification has no cancellation bound

`runtime.ts:955` directly awaits `request.notify(id)`. The probe pauses inside notification after the durable write, aborts the caller, and confirms the delivery remains unsettled with a waiting record. Releasing notification then returns `deferred` despite the abort.

#818's `deferral/defer.ts::runNotify` races notification against its signal, denies on abort or throw, and reports `RC5067`. Its executor passes the intake/timeout signal separately from execution cancellation. This distinction is useful: stopping intake must unblock a hanging notification without pretending arbitrary external IO was retracted. **Carry both meanings through the lifecycle contract and bound notification.** The current synchronous-throw test closes only one notification failure mode.

### R3, P1: the elevation identity check admits a different permanent grant set

`auth.ts:313` compares sorted grant arrays with `.join()`. `["admin,read"]` and `["admin", "read"]` have the same joined text. The R3 route requires `admin`, parks a live requester holding only the single grant `admin,read`, and uses an elevation hook returning the two permanent grants `admin` and `read`, with no lent grants. Resume completes and the route sees both new permanent grants. `read` was never in the refused bound.

No grant grammar in this contract excludes commas. This is not an argument that the host can make hostile plugins safe. It is the framework's advertised elevation validator accepting a result it explicitly promises to reject. **Compare normalized arrays or sets structurally, without a delimiter encoding.** The production identity comparison must also retain #818's structural comparison of all identity inputs outside explicitly permitted verification and lending fields.

### R4, P1: owned work and outcome-bearing work are conflated

`timeoutStep` calls `ctx.track(work)` at `operations.ts:91`. `Runtime.execute` later awaits all tracked promises and throws any rejection at `runtime.ts:1335`, even when an outer retry already handled that rejection.

R4 uses `.retry(2).timeout(1000)` around a step that throws on its first call and succeeds on its second. The successful attempt performs its effect. Delivery nevertheless rejects with the first attempt's transient failure. This can cause a caller to repeat successful work. The shipped `operations/retry-wrapper.ts::executeWithRetry` returns a successful attempt, and the spike's result is wrong even without that comparison.

**Separate ownership for drain from participation in a run's result.** A timed-out or retried attempt may remain owned until it settles; that does not grant it the right to determine the final outcome. Make attempt-scoped task ownership and streaming completion explicit, or use distinct tracking operations. This needs contract work around `StepContext.track`, not just a blanket suppression of tracked failures, which would lose genuine stream errors.

### R5, P1: a successful step-state replacement can be ignored by resume

The resume path reads `saved` before the door awaits. `markResumed` returns only `"won" | "lost"`; the continuation runs the earlier snapshot. R5 holds the door, successfully replaces waiting step state from `old` to `new`, then releases admission. The store records `new`, while the winning continuation executes `old`.

**Specify the linearization point and the snapshot a winning resume owns.** Options include a claim returning the current record, or a revision-bound compare-and-swap that forces a retry of admission when relevant state changes. A Boolean CAS plus an unconstrained earlier read does not express this safely.

This is a demonstrated flaw in the proposed contract, not an established new regression relative to shipped. The inspected shipped `revive.ts` also uses a pre-CAS deferral for rehydration and state seeding, despite its richer CAS result. I did not execute the shipped race. Do not claim the migration caused it or that copying shipped code alone fixes it.

### R6, P1: step-owned state leaks across a route dispatch

At `runtime.ts:1240`, `dispatch` spreads the source `Run`, changes its kind to `normal`, and retains `resumption`. State delivery tests only equality of step id. R6 resumes source step `park`, which dispatches to a different route whose unrelated step is also named `park`. The target receives `private-state` in `ctx.stepState`.

Step ids are route-local, so the name collision is legitimate. **Use an execution-scoped, route-qualified state owner and clear resumption when dispatch starts a new route.** Check successful consumption and nested/repeated instruction execution as well as adjacent steps. This is an API isolation defect, not a claim that in-process plugins are security sandboxes.

### R7, P1: a late store swap can start new execution after disposal

The post-door `#accept` check is before `await store.markResumed`. No shutdown check or runtime-owned abort signal guards the work after that await. R7 pauses there, calls the public runtime's `stop(5)`, observes `DRAIN_TIMEOUT` and resource disposal, then releases the store. The suffix starts after disposal and completes.

The test uses a vendor store that remains available after host disposal so the missing fence is observable rather than hidden behind a closed SQLite error. **Own an execution abort/fence in the runtime, apply it at awaited transition boundaries, and ensure a resume that already won records failure without running user code after abandonment.** This is not the accepted limitation on already-running uncooperative IO. The kernel itself starts fresh route work after shutdown.

### R8, P1: the built-in deferral descriptor is not safe to reuse across contexts

`storage.ts:392` allocates `timer` in `deferralPlugin`, outside a context binding. `Application` copies the descriptor but retains those closures. Start contexts A and B from the same descriptor, then stop A: A's disposer clears B's timer, while A's timer is left behind. The exported `deferral` value has exactly this reusable shape.

The final R8 fixture intercepts timer allocation and clearing deterministically. It observes two handles and proves only B's handle is cleared, including after B stops. A manual sweep of B still works. An earlier real-timer probe also encountered the orphan A timer throwing `NOT_RUNNING`; that preliminary failure motivated the controlled fixture and is not counted as a passing characterization.

**A descriptor must be a reusable definition; mutable resources belong to each installation.** Store state per bound context or introduce an installation factory with an explicit lifetime. Do not silently require consumers to know which exported plugin values happen to carry mutable closures. The packed test's second, lean context does not exercise reusing the same stateful plugin.

### R9, P2: refusal discards the decorations that led to it

`handlers` threads a decorated exchange through the ring but its `refuse` result does not contain that exchange (`runtime.ts:241`, `856`). The outer `enter` therefore still holds its original envelope when it invokes the error ring and parks.

R9 decorates body and headers in one admission handler, then refuses in the next. The refuser sees the decoration, but the persisted exchange contains the original body and lacks the added header. **A refusal must carry the current exchange, or the ring API must return exchange and decision separately.** Otherwise an identity decoration, correlation marker or policy input can disappear precisely when error-path recovery needs it. Document whether error-ring decorations themselves affect a subsequent park; do not leave this to accidental variable lifetime.

### R10, P1: an open point may promise defer while its invocation erases defer

The merged type and `point` descriptor accept `defer: true` for a plugin point. A handler may declare `mayDefer` and return a valid defer request. But `StepContext.invoke` returns only `Exchange | null`; `runtime.ts:1254` maps every non-allow result to null, discarding the request.

The no-cast strict compiler fixture is accepted. The execution fixture invokes such a point and completes with null and no parked record. **Either restrict parking to the kernel error point in the public type, or return a typed decision that the point's owner can interpret at its own execution site.** An open point does not magically acquire a lifecycle, but the caller needs access to the decision the contract allowed. This is the same class of type/runtime disagreement earlier rounds were intended to close.

### R11, P2: the codec still differs from the shipped array rules

Two direct comparisons with `packages/routecraft/src/deferral/serialize.ts` were executed at the reviewed commit:

- A sparse array retains holes through `encode` and a structured-clone backend, but JSON storage turns them into null slots. The shipped encoder produces explicit null slots before either backend. `object.map` at `codec.ts:85` skips holes.
- An array with the own property `"4294967295"` is silently encoded without that property. The digit regex at `codec.ts:81` treats it as an index although it is not one. The shipped encoder rejects it as a named property.

**Use one codec contract suite across every store backend, including sparse arrays and numeric-looking non-indices.** Where the rule set should remain identical, extract/reuse the shipped codec rather than maintaining a second approximation. The wire tag also differs (`$date` versus `$routecraft.date`); that is a separate, explicit format-migration decision, not a promise of stored-row compatibility.

### R12, P1: removing a deferred route removes its door policy

`runtime.ts:530` looks up the route before running handlers. If it is absent, the fallback spec has empty options and tags. That removes the auth hook and the route-specific ask on which the door depended.

R12 parks a route whose declared resume authorizer always returns false. Anonymous resume returns `refused` while the route exists. A new context with the same store and auth plugins, but without that route, answers `UNKNOWN_ROUTE: protected` to the same caller. The record stays waiting, but the refusal/disclosure guarantee is lost.

**Resolve the trusted ingress door independently of the deferred route, as #818 does, or provide an explicit fail-closed policy for an unavailable route.** More than one door per route was already a required migration item; this is another concrete reason to settle that separation before publishing `.resumable` as the final consumer model. The current phrase "before the route is even looked up" is factually false and masks a policy dependency, not merely a harmless preliminary map read.

### R13, P2: an ordinary park emits the deferred terminal event twice

`park` emits `exchange:deferred` at `runtime.ts:963`. `enter` emits it again from `result.status`. R13 observes both for one delivery. The first `id` is the continuation id including `#1`; the second is the exchange id. Same event name, different identifier meanings.

**Choose one owner of terminal events and define their typed payloads.** A separate checkpoint-committed event is fine if needed. Two deferred terminal events are not. The corresponding shipped/#818 defer path explicitly places its single terminal announcement after durable write and successful notification. Diagnostics and telemetry plugins need this contract as much as storage plugins do.

### R14, P2: post-claim decoding can leave false crash residue

`revive(saved.exchange)` at `runtime.ts:649` runs after the winning CAS and before the catch that records a failed continuation. R14 injects a corrupt date envelope in the stored body. Resume throws `CORRUPT_ENVELOPE`, but the record is `resumed` with no outcome and appears in `resumedWithoutOutcome`, although the process did not crash.

The #818 implementation puts rehydration and state decoding inside the post-claim failure-recording scope. **Enclose all post-claim work, not only route execution, in that scope.** Retain best-effort outcome persistence without disguising a known decoding failure as an unknown half-run.

## What should change in the design and migration plan

**Use a state-transition ledger, not another flat list of methods.** For each awaited door, store transition, notification and execution entry, state which snapshot is authoritative, which signal applies, what can still fail, whether a claim has been spent, and what gets recorded. R1, R2, R5, R7 and R14 are all missing answers at such boundaries. An API inventory will miss them again.

**Extract contracts around the existing executor instead of adopting the miniature executor.** The design goal is supported participation for installed plugins, not a second execution engine. The current spike has become a parallel implementation of a substantial continuation subsystem. That duplication explains why named fixes repeatedly restore one path while losing a neighboring one. Feature-fit should move the real behavior behind ports, not translate it from memory into this loop.

**Keep semantic storage ports, but stop treating a shorter signature as simplification.** R5 needs an atomic snapshot contract. The current reference store's full waiting-index reads per page remain an explicitly documented limitation; do not advertise bounded backend work based only on `limit`. Preserve crash and concurrency fixtures against every actual provider. Do not introduce a generic storage engine solely to reduce interface method count.

**Separate provider selection from capability composition.** The documented fact that displaced plugins still bind and contribute is honest. It is also a trap: replacing the continuation provider does not remove the default deferral plugin's records dependency, lifecycle policy or DSL. Prefer small provider, policy and convenience packages, and show both supported replacement recipes: install the alternative alone, or deliberately retain the default's other contributions. State who owns migrations, shutdown and default TTL when the provider changes.

**Freeze the public model only after resolving its consumer assembly story.** Prefer a project-typed route factory driven by a side-effect-free project definition over importing a live Application singleton into route modules. The CLI, tests and inspection tools should all build from that definition. This is a recommendation, not a tested CLI implementation. It preserves an installed tuple without rebuilding global ambient DSL registration. Ruling 10 already identifies the decision; it needs a fixture before the consumer DSL is documented as final.

**Make plugin-author effort visible.** A normal plugin tutorial needs a port owner/version, namespace, lifecycle, optional DSL family, facet derivation, and selected run kinds. A basic library adapter should not need any lifecycle package. Provide helpers for common method families and descriptor construction; keep the low-level protocol available. Do not make authors copy the generic family machinery to contribute an ordinary side effect.

**Version the non-TypeScript contract now.** Point names, anchors, namespace and option keys, event names/payloads, error codes, continuation codec, instruction identities and hash projection rules are all consumer dependencies. The `PORT_IDENTITY` diagnostic correctly makes duplicate contract-module identity loud; packaging guidance must say which packages are peers/shared instances. A new namespace cannot by itself make a changed string or event payload compatible.

**Expand evidence by composition, not by accumulating headline totals.** Retain mutation checks, but derive new fixtures from crossing mechanisms: retry plus timeout plus stream, stop during each store await, decoration plus refusal plus park, shared plugin plus two live contexts, state replacement plus a waiting door, and a missing route plus a restrictive door. My new fixtures assert current failures deliberately. Invert them when fixing the behavior, and add mutations that target the intended correction. A large set of single-path mutants cannot establish these compositions by arithmetic.

## Consumer documentation changes before publication

The narrative is clearer than the old design, but it still mixes an intended 0.8 architecture, the current framework and a narrower spike. Label examples by what they actually demonstrate and provide one complete installation, route and replacement example using the intended public API.

| Location | What a reader can misunderstand | Required correction |
|---|---|---|
| Public draft, sections 1 and 3 | Every operation hands one exchange onward; a pipeline sounds necessarily linear | Introduce drop, fan-out, branch and defer as explicit exceptions to that introductory model |
| Public draft, section 4 | All contributions, including DSL methods, arrive in `bind` | Distinguish static declaration/method assembly from resource binding and execution contributions |
| Public draft, section 5 | Replacing a provider means the original capability is gone | Keep the existing qualification, add a complete alternative-alone recipe and explain retained contributions/dependencies |
| Public draft, section 6 | A cancelled park cannot leave a live link; a failed notification is fully handled | Qualify as intended guarantees until R1/R2 are corrected |
| Public draft, section 6 | The door runs before any route lookup | Correct R12 and distinguish ingress policy resolution from deferred-route resolution |
| Public draft, sections 3 and 6 | A point's declared decisions are all usable; failure recovery sees prior decorations | Resolve R9/R10 before promising that contract |
| Mechanism diagram, exchange flow | `drop` reaches completed; all routes run the same admission path | A drop has no terminal exchanges and no exit-handler iteration; resume has a door and conditional re-admission, while admission refusals can park |
| Mechanism diagram, continuation sequence | The second resume goes straight to the store for a duplicate | Show the door preceding duplicate disclosure as well as first resume |
| Overview and mechanism introductions | All diagrams are mechanically checked | Only the marked module graph is checked by `verify:diagram`; behavioral diagrams are manually maintained |
| Mechanism limits paragraph | All external effects have at-least-once delivery | That is not a general guarantee. A crash after resume CAS and before an effect can mean no effect. Explain notification redelivery separately from continuation execution and external side effects |
| `DeferRequest.ttl` JSDoc | Absent means never | Absent uses the selected provider's default; describe explicit opt-out separately |
| `Frame` introductory JSDoc | Pending paths are only concatenated suffixes | The implementation supports bounded slices and arbitrary selected ordering; document that actual contract |
| Architecture acceptance checklist | `AUTHORITY` is the protected route requirement; auth is an entry handler | The current ask requires `ENFORCEMENT` and the gate is at admission. Remove stale present-tense checklist statements |

The architecture record should retain historical corrections, but have one short current contract section that readers do not have to reconstruct from superseding rounds. Keep the history as evidence, not as the primary way to discover today's API.

## Readiness and bounded work

**Ready:** hands-on evaluation, an explicitly provisional user-facing explanation, and feature-fit discovery of the real framework. The parity thesis, dependency direction, installation protocol and replaceable authority are worth carrying forward.

**Not ready:** final public plugin contracts, an executor replacement, or a statement that shipped deferral/resume guarantees have all survived. No production migration approval is implied.

Before the affected contracts become the accepted implementation target:

1. Settle cancellation, notification and shutdown ownership together. Correct R1/R2/R7 and test every store-await boundary with controlled latches.
2. Settle attempt/task outcome ownership, state consumption and the claim snapshot. Correct R4/R5/R6, preserving real streaming failures and retry success.
3. Correct the elevation comparison and ingress-door placement. Demonstrate R3/R12 inverted. Carry the already-required token verification, call binding, schema validation, multiple doors and per-ring lending into explicit migration tickets.
4. Make descriptor reuse and handler decision propagation real. Demonstrate R8/R9/R10 inverted, including two live contexts using the same exported plugin value.
5. Restore codec, terminal-event and post-claim recording laws. Demonstrate R11/R13/R14 inverted and run them against the shipped behavior where applicable.
6. Correct the consumer claims, then select one production capability from the feature ledger and prove its external replacement against an actual packed production artifact.

Do not wait for a hypothetical universal proof before starting the ledger. Do not use the ledger as permission to call the known failures acceptable. These are bounded acceptance conditions on the migration, not grounds for another registry redesign.

## Assumptions and limits

- The provided branch head is the review baseline; #818 is the supplied reference commit, not an instruction to merge or modify that branch.
- The specified report filename and branch name are treated as required path identifiers. The report and evidence content do not identify a model.
- Only the allowed report and evidence paths are authored. Root dependency installation and the requested verification scripts produce their own ignored/transient outputs; no tracked implementation, acceptance fixture or shipped package is changed.
- Executable evidence is the spike plus two direct shipped-codec comparisons at the reviewed commit. Other shipped/#818 comparisons above are explicitly source inspection, not a claim to have run their entire suites or completed feature-fit for AI, OS and CLI.
- The R5 stale-snapshot issue may also exist upstream. The Bun 1.4.2 fallback failure is not diagnosed. Neither is reported as a proven migration regression.
- R8 uses controlled timer interception in its final fixture to make ownership deterministic. R7 uses a still-available vendor store to expose execution after disposal. Those choices are part of the reproducible preconditions.
- Plugins remain trusted in-process code. These findings concern documented protocol behavior and plausible compositions, not sandboxing, arbitrary malicious mutation, exactly-once external effects or automatic replay of half-run continuations.
