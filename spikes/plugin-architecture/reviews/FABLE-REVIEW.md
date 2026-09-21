# Round seven: clean-room review of the round-six head

**Reviewed:** `e5d160352e6082a1f53c43941dae06e8798a146e` on `validation/round-six`.
**Environment:** Linux, Bun 1.3.11, TypeScript 5.9.3. Root `bun install`, then everything from `spikes/plugin-architecture`.
**Added:** `validation/round-seven/` (three probe scripts and a README), pushed to `validation/round-six-fable`. Nothing under `src/v2`, `test/round-two` or outside the spike folder was changed. No pull request.

Every figure below names the method that produced it. Where I say the shipped framework does something, I cite the file. Where I claim a limit, I ran it.

---

## 1. What reproduced

All of it, at this head:

| Reported | Observed |
|---|---|
| 36 tests, 0 fail | `36 pass, 0 fail, 154 expect() calls` |
| 27 of 27 mutants killed | `27/27 runtime mutations killed by behavioral assertions` |
| 10 of 10 compiler negative controls | `10/10 compiler negative controls detected` |
| Import gate | `BOUNDARIES: 10 modules (all declared), 21 permitted import edges (0 dynamic)` |
| Diagram check | `DIAGRAM: module graph matches src/v2 (18 edges, 2 example modules omitted by design)` |
| Packed consumer | both `PASS` lines; real tarball, fresh directory, private subpath refused |
| `bun run demo` | exit 0, plan printed |
| Strict typecheck | clean |

The round-five report says Bun 1.4.2; round six and this review measured on 1.3.11. No number moved.

One correction to a recorded figure. `validation/round-two/verification-round-six.txt` says "Measured on: 3b69bfda". That is the base round six reviewed. The two fixes it reports live in `8d8d7c7` and `a0d07e7`, so the numbers in that file hold at `a0d07e7` and later, not at the commit it names. Rule 1 of section 10 applies to the verification file too.

## 2. What did not reproduce, and what I added

Nothing reported failed to reproduce. What follows is what the reported evidence does not cover.

### 2.1 Sixteen new mutants: three killed, thirteen survived

`bun run validation/round-seven/mutants.ts`. Same runner discipline as round two (disposable copy, non-zero exit AND a literal `(fail)`), run against the contracts, process and round-six suites. The packed test is excluded on purpose: it resolves `tsc` from the repository's `node_modules`, which the copy does not have, so it fails for every mutant. My first run included it and reported 16/16 killed. All thirteen of those kills were that artifact. That is worth recording because it is exactly the failure mode round six warned about, and it caught me.

| Mutant | Result | What a survivor means |
|---|---|---|
| `saved.codec !== 1` removed | SURVIVED | a continuation from another codec executes |
| `saved.pending.some(!route.steps.has)` removed | SURVIVED | a pending id the route no longer has passes the plan check |
| `store.finish(id, "failed")` on a throwing resume removed | SURVIVED | a failed resume leaves the claim held until the lease |
| `save` duplicate guard (`version: 0` condition) removed | SURVIVED | a second save under one id overwrites the first continuation |
| route retry `structuredClone(run.exchange)` removed | SURVIVED | attempts share one exchange object |
| observer payload `structuredClone` removed | SURVIVED | an observer can mutate what later observers see |
| `known.execute !== s.execute` in `ids()` removed | SURVIVED | a branch can substitute a different function under a declared id |
| `DUPLICATE_ANCHOR` check removed | SURVIVED | two contributions claim one anchor, last wins |
| runtime `FACET_COLLISION` removed | SURVIVED | a facet may shadow an exchange field at attach |
| exit handlers never run | KILLED | |
| `dispatch` inherits caller's run kind | SURVIVED | a hop from a resumed run applies resume survival on the target |
| late `onDispose` accepted | SURVIVED | a disposer registered during teardown is dropped |
| `compile` after `start` accepted | SURVIVED | routes compile against a frozen chain |
| disabled route still delivers | KILLED | |
| selected but unprovided port accepted | KILLED | |
| step `ctx.require` rewired to `host.service` | SURVIVED | a step reads a service its plugin never declared |

The last row matters for a recorded claim. The round-five ledger says steps have "declaration-scoped service lookup" and "undeclared access is refused". The test that backs it (`contracts.test.ts:1337`) asserts on `host.requireFor` directly. The wiring from the step context to that method is not asserted, so the claim holds for the method and not for the path a step actually takes. Round six's "removing the declaration check is killed" is about the same method. Stage 1's "every fixture needs a mutation" should read "including the wiring".

The survivors cluster in two places: the resume path (`codec`, `pending`, failed-resume settlement, duplicate id, branch identity) and the isolation claims (observer clone, attempt clone, step-scoped require). Both are where the design's guarantees live.

### 2.2 Ten guarantee probes against the shipped framework: eight regressions

`bun run validation/round-seven/guarantees.ts`. Each probe runs a real `Application` in process. Detail in section 3.

```text
per-exchange deferral id     REGRESSION second delivery: [routecraft.deferral] DUPLICATE_DEFERRAL: approval
hash: unrelated plugin       REGRESSION unrelated plugin added: PLAN_MISMATCH
hash: edited suffix          REGRESSION suffix lambda edited: resumed, body 2000 (shipped refuses with RC5048)
hash: route option           REGRESSION route option changed: PLAN_MISMATCH (shipped hashes the tail only)
duplicate resume             REGRESSION second resume: CLAIM_LOST
principal forgery            REGRESSION dispatch to a route gated on grant "admin" returned "completed"; gate saw ["sink:mallory:admin"]
non-JSON bodies              REGRESSION function body, ReadableStream body: "The object can not be cloned"; class instance loses its prototype
displaced provider           INFO       selected acme.store; displaced default's database WAS opened on disk
refuse at exit               INFO       exit handler refused, run reported completed
bounded shutdown             REGRESSION still draining after 500ms (shipped forces after shutdown.timeout, default 30s)
handler sort per exchange    INFO       30 handlers, 200 exchanges: 0.53 ms per exchange through four handler points
lease re-runs continuation   REGRESSION released 1; second process resume: completed; "pay" executed 2 times
```

### 2.3 Type-level scale at twenty and forty plugins

`bun run validation/round-seven/scale.ts`. Generated fixtures against `src/v2/dsl.ts` (the encoding that would ship, not the historical `e-installed.ts` that `e-scale.check.ts` measured). Each plugin has two methods and one facet; the chain alternates plugin methods and a two-argument `transform` that reads a header and a facet. `tsc --extendedDiagnostics`, figures read from the compiler's own report.

| Fixture | Check time | Instantiations | Types | Memory |
|---|---|---|---|---|
| 5 plugins, 12 steps | 1.44 s | 88,365 | 23,187 | 110 MB |
| 20 plugins, 40 steps | 3.39 s | 233,232 | 38,254 | 226 MB |
| 20 plugins, 40 steps, no facets | 3.25 s | 232,998 | 38,141 | 180 MB |
| 40 plugins, 80 steps | 10.85 s | 500,151 | 58,346 | 230 MB |

No errors at any size. Instantiations grow close to linearly in plugins times steps; check time grows faster than that between 20 and 40 (3.2x for 2x the product), so there is a curve, but no cliff at the realistic size. Facets cost nothing measurable. What this does not measure: editor latency on a single keystroke, or a method family with heavy types of its own. The 20-plugin question is answered for the compiler; it is open for the editor.

---

## 3. Findings, ranked

### Tier A: would change the design

#### A1. Round six's headline correction misreads the shipped contract, and the fix regresses a shipped guarantee

Round six reclassified "recovery after a crash during an already-claimed resume" from scope limit to regression, citing `releaseClaims`, the sixty-minute lease and the "second axis" JSDoc, and changed the spike so a resume takes a leased claim that `releaseClaims` hands back. ARCHITECTURE.md, DIAGRAMS-MECHANISM.md section 5 and sequence challenge 1 all carry that reading.

The shipped contract has two different mechanisms and round six merged them:

- **Resume is `markResumed`**, a compare-and-swap OUT of `waiting`, taken BEFORE the continuation runs (`revive.ts`, the `markResumed` call precedes `runContinuation`). It is exactly the "state transition" shape round five built.
- **The lease heals `claimExpiry`**, the delivery claim for expiry and denial NOTIFICATIONS (`types.ts`, `claimExpiry` JSDoc: "Winning it is the right to notify the route"). `sweeper.ts:121` runs `releaseClaims` and the released records are redelivered to the error channel. The "one duplicate escalation after the lease elapses, which is the accepted at-least-once trade" that round six quoted is about re-sending a nag.
- **A crash between `markResumed` and `recordContinuation` is reported and never re-run.** `types.ts`, `resumedWithoutContinuation`: "this residue is a half-run CONTINUATION and is only ever reported. Re-running a continuation whose side effects may have half happened needs a lease on the resumed outcome and idempotent continuations, which is the admission-and-idempotency work tracked separately." And: "The asymmetry with the delivery claim is deliberate: expiry NOTIFICATIONS heal by redelivery because re-sending a nag is safe."

So the shipped guarantee is: an approval is consumed exactly once; a half-run continuation is surfaced at boot, not repeated. The round-six spike does the opposite. The probe parks, begins a resume whose payment step runs and then hangs, releases the stale claim as a sweeper would, and resumes from a second application: `"pay" executed 2 times`. That is the behaviour the shipped design refused to build, adopted under the belief that it was restoring one.

What round five actually lacked against the shipped contract was different: `recordContinuation` with a `duplicate` reply for the second resume, `claimExpiry` for notifications, and expiry itself. The port needs both mechanisms, not one. Round five's report ("A claimed record can remain running" is a gap needing "leases/fencing and replay/idempotency rules") was the correct framing; the round-six diagram 5 is not, and rounds 7a and 7b will inherit it as ground truth unless it is corrected first.

#### A2. The continuation contract is not the shipped one, in five ways a stage-2 port cannot paper over

Ground truth: `deferral/types.ts`, `hash.ts`, `revive.ts`, `exchange-state.ts`.

1. **Identity.** `.defer("approval")` bakes the continuation id into the route (`storage.ts:554`, `runtime.ts:560`). The second exchange through the route fails with `DUPLICATE_DEFERRAL`. Shipped ids are `{exchangeId}#{sequence}` (`types.ts`, `DeferralListCursor` JSDoc), derivable BEFORE the defer via `ex.deferral.id` so a notification step can embed a working link. The spike's facet `ex.deferral.request(id)` lets a step choose an id at runtime, but the primary DSL cannot express the shipped behaviour and the demo, the process test and the docs draft all use the route-static form.
2. **Hash scope.** `runtime.ts:113` hashes every step id, every contribution's owner, id, kind and survival, and the route options. Adding an unrelated exit-observing plugin, or changing `retry` from 2 to 3, invalidates every parked approval (`PLAN_MISMATCH`, both probed). `hash.ts` hashes the tail only and explains why: "including them would invalidate every approval in flight on any deploy that touched the route, and the approver would discover it by clicking a dead link." The spike rebuilt the design the shipped code calls "the one that made it unusable".
3. **Hash content.** The spike never reads a callable. Editing the suffix lambda from `n * 2` to `n * 1000` resumes with body `2000`. Shipped folds in the source text of the tail's callables verbatim and refuses with `RC5048`; `hash.ts` has a page on why it must never normalise that text. This is a security property ("an approval cannot authorize steps that were edited under it", `revive.ts` step 5), and the spike drops it while its plan-version check gives the impression of covering it.
4. **Resume door.** `Execution.resume(id)` takes no payload. Shipped: a signed single-use token, a `callBinding` check, the door's `authorize` hook with the record's `meta`, payload validation against the deferring step's live Standard Schema, `resumedBy` recorded from the live ingress principal, and the ordered refusal sequence `revive.ts` documents as "the security contract". None of it is modelled, and the acceptance criteria do not ask for it.
5. **Duplicates and expiry.** A second resume throws `CLAIM_LOST` (probed, and asserted as correct at `contracts.test.ts:896`). Shipped returns `status: "duplicate"` with the cached `SerializedOutcome`, because "an approver double-clicks, a webhook is redelivered" is the normal case. There is no `expiresAt`, no `findExpired`, no `markExpired`, no error-channel re-ask on expiry: the 72-hour default TTL and its escalation, the only shipped consumer of the lease, are absent.

Some of these are feature-fit items. Identity, hash scope, hash content and the duplicate reply are not: they are the shape of the port. Publishing `ContinuationStore` and `Continuation` in stage 2 as they stand publishes a contract that has to break.

#### A3. `Principal` is decided in core, as a plain object, in the direction the security standard forbids

`contracts.ts:28-39` puts `principal: Principal` as a stored field of the core `Exchange`, a plain object with `grants` and `lent` arrays. `Continuation` persists it verbatim and `resume` trusts it unchanged. Acceptance criterion "a lent elevation survives admission on a resumed continuation" and the process test's `principal:alice:approve` assert that a grant read back from SQLite authorises a hop on another route after a restart.

`.standards/security.md` section 3: "A principal that came back from storage is restored, never authentic. ... fails `authorize()` with RC5043. Do NOT re-mark a rehydrated principal authentic: nothing re-checked the signature, the expiry, or revocation ... Authorize the resume ingress route instead." `auth/restored.ts` says deferral "is the easiest way to reintroduce laundering" and exists to close it. `.standards/exchange-state-model.md` says one principal is one header key plus one getter, never a stored field.

Probe: a plain step rewrites `ex.principal` to `{ subject: "mallory", grants: ["admin"] }` and dispatches to a route whose entry handler requires `admin`. The gate sees `sink:mallory:admin` and allows. There is no authenticity brand to check, so no handler can tell a minted principal from a fabricated one. Open ruling 5 asks where `Principal` lives; the code has answered it, and the answer regresses the shipped model. The right shape is the shipped one: core carries opaque headers, an auth plugin owns the header key, the brand and the `authorize` handler, and the continuation store never resurrects authenticity.

#### A4. The exchange model is a different exchange model, and it conflicts with a written standard

Two parts.

**Facets versus the standard.** `.standards/exchange-state-model.md`, Non-rules: "Plugins do not extend `DefaultExchange`'s prototype. Adding a getter for plugin-defined concerns would lead to arms races and conflicts. Plugins export external helpers (`getTenant(ex)`)." The spike's typed facets are exactly plugin-defined getters on the exchange, and ARCHITECTURE.md section 6 calls them "strictly better than today" without mentioning that a standard says the opposite. The facet design may well be the better answer; the standard then has to be changed with a recorded reason, and the docs draft's "typed data your plugin hangs on the exchange" is teaching what the standard forbids.

**Clone at every step.** `runtime.ts:42` `structuredClone`s the exchange at every step boundary and every handler decoration. A body containing a function or a `ReadableStream` fails with "The object can not be cloned"; a class instance loses its prototype and `b.vat is not a function` (probed). The shipped model requires plain JSON only at the defer boundary (`RC5042`) and passes one exchange object down the chain. HTTP streaming bodies and adapter result objects are ordinary shipped bodies. This is not a spike shortcut that a comment excuses: the acceptance test "drain owns streaming response" passes because the stream is tracked out of band, not carried on the body.

### Tier B: would change the plan

#### B1. The string surface has no namespace and no policy, and it already collides

`host.ts:198` checks contribution ids across ALL plugins, while ordering keys them as `owner/id`. Two plugins that both name a handler `h` fail at boot with `DUPLICATE_CONTRIBUTION` (my ordering probe hit this by accident; the packed fixture and the anchors test both name a wrapper `audit`, and a second third party choosing `audit` cannot install). Facet names are one flat namespace per application. Route option keys are bare strings (`route.options["retry"]`) that two plugins can silently share. Handler point names are global by declaration merging. Only ports carry a version, by the `@1` convention in their name. `.standards/api-stability.md` covers TypeScript symbols. Missing item 4 from the consolidation (versioning of the string surface) is still missing at this head, and stage 2 is where it stops being cheap.

#### B2. Lifecycle bounds the shipped framework has are absent, and one was recorded as a limit

- `Runtime.stop` (`runtime.ts:647`) awaits every owned promise with no bound. The probe's `stop()` had not resolved at 500 ms with one hung step. Shipped: `shutdown.timeout`, default 30 s, then `forceStageTwo` (`context.ts:1620-1640`). Round five's "graceful drain can wait forever on uncooperative work" was recorded as a legitimate limit; the shipped framework bounds it.
- `keepsAlive` and route-driven auto-stop (`context.ts:1445`) are absent. `craft run` on finite routes depends on the latter.
- `TeardownInfo` (`partial`, `started`) is absent; `dispose()` calls `stop(ctx)` for a plugin whose `start()` never ran.
- `whenStarted()` readiness has no equivalent. `@routecraft/testing` awaits it.

None of these is architecture. All of them are guarantees a naive port drops, which is the column the ledger brief added.

#### B3. Contact with the CLI is a design question, not a migration cost

`packages/cli/src/project.ts:194` recognises a plugin by duck-typing a callable `apply`; `start.ts:324` loads default exports from `plugins/`; routes are separate files built with a free `craft()`. Under the spike, a route's typed chain comes from `app.route()` on an `Application<P>` value, so a route module cannot be compiled without the plugin list in scope. The DSL work has answered "can a fluent typed extensible DSL exist" and not "how does a `routes/` file get its application". The testing package and the TUI are cheaper than feared: the TUI imports only types from the package root, and `@routecraft/testing` touches `ctx.start`, `on`, `defer`, `getStore`, `drain`, `getRoutes`, `whenStarted` and `startAndWaitReady`, all public surface. The `CraftPlugin` consumers to carry: 25 `apply(ctx)` sites in first-party packages, 22 `StoreRegistry` augmentations in core and 14 augmentations in `ai` and `os`, 12 `registerConfigApplier` sites.

#### B4. What the docs draft promises that the code does not do

See section 6.

### Tier C: would change a document

- DIAGRAMS-MECHANISM.md section 3 draws contributions ordered once at freeze. `runtime.ts:331` re-sorts every contribution on every handler point of every exchange. At 30 handlers it costs 0.53 ms per exchange, so it is not a performance finding; it is the diagram not matching the code its check claims to verify (the check covers the module graph only).
- DIAGRAMS-MECHANISM.md section 5 (claim as a second axis over `waiting`, lease hands the continuation back) describes the round-six semantics and attributes them to the shipped framework. See A1.
- `verification-round-six.txt` names the wrong commit. See section 1.
- ARCHITECTURE.md section 6 should record that facets reverse `exchange-state-model.md`. See A4.

---

## 4. The nine principles

| | Position | Why |
|---|---|---|
| P1 equal reach | **Keep, amended, and add the string surface** | The amendment ("exported, documented, covered by the version policy") is right. It has to cover contribution ids, anchors, facet names, point names and option keys, none of which the version policy currently mentions (B1). |
| P2 core owns a small execution protocol | **Keep as amended, and name what that protocol is** | The code already decides it: `runtime.ts` owns resume, the claim, the plan hash and the continuation format, and imports the `CONTINUATIONS` port by name. That is fine under amended P2 and it should be said plainly, because P6 and the docs draft both imply otherwise. |
| P3 everything is a plugin | **Struck, agree** | The two operative sentences are the content. "If it needs no context lifecycle, it is a library" is the sentence that keeps the CLI, the testing package and most adapters out of this. |
| P4 one installation protocol | **Keep as amended; the code demonstrates it** | `Plugin extends Installation` carries methods, facets and lifecycle in one value; declining resilience removes retry from the type and the chain together (`types.check.ts:88`, and the round-five fix that moved retry onto resilience). This one earned its place. |
| P5 unprivileged reuse | **Keep** | `infrastructure()` is a factory, not a base class. Nothing in it grants access the bare interface does not. |
| P6 dependency, not capability | **Amend again, or accept that the kernel names one capability** | The runtime names `CONTINUATIONS` at `runtime.ts:247`, `549`, `551` and `563`. Either the continuation port is kernel-owned under amended P2 (my recommendation) or P6 is violated at its first line. As written it is a slogan the runtime contradicts. |
| P7 declined and replaced | **Amend: "a provider can be replaced; a plugin can be declined when nothing requires its ports"** | Replacement works and refuses two undeclared providers by name. But a displaced provider still runs `bind`, still acquires (the default SQLite file is created on disk, probed), still contributes its wrappers and its DSL methods; only its `provide` is silently dropped (`host.ts:178`). "Ours steps aside" overstates it. |
| P8 mechanical boundary | **Keep the rule; drop "does not exist"** | The gate is real over ten files. Production has 12 core files importing plugin territory in 75 statements. A boundary is graded, and "does not exist" is a slogan that will be quoted against a partial ratchet that is nonetheless progress. |
| P9 core uses its own extension points | **Merge into P1 as a proof obligation, agree** | The packed consumer is the right test. It should install alongside a first-party default it displaces, which the packed fixture does not: `acme.store` there is the first-party `sqlite()` factory under another id with no default present. The unit test at `contracts.test.ts:128` does displace a default; the packed proof should too. |

Slogans rather than constraints, as they stand: P3 (already struck), P6 as written, and the "does not exist" half of P8.

---

## 5. Open rulings and the sequence challenges

1. **Open or closed handler points.** Open, as built, with the declaring package owning the invocation site. Two additions: a point name is public API under the string policy (B1); and a point must declare which decisions it honours, because today refusal is honoured at `admission` and `entry`, ignored at `error` (`runtime.ts:346`) and discarded at `exit` (`runtime.ts:384`) while the docs draft says a handler can refuse.
2. **Named anchors or numeric slots.** Named, contract-owned anchors. Agree with the recorded position. Numbers underneath are fine as long as no third party can write one.
3. **Tie-break.** Disagree with "plugin id, lexicographic". `tie-replacement.ts` shows a replacement flipping an unconstrained pair, and A3 shows the pair that matters is security versus resilience. Tie-break on a contract-owned contribution identity (port name plus contribution id), fall back to owner only when identities are equal, and report every unconstrained pair of wrappers that share a surviving run kind in `dump()` as a warning. Determinism is necessary and not sufficient when the pair is an authorisation gate and a retry.
4. **Isolation.** Not a goal. Delete the A2 claim. Keep declaration-scoped `require` as API discipline, and close the step-path gap from 2.1.
5. **Where `Principal` lives.** Not in core. See A3. Core carries headers; the auth plugin owns the key, the brand, the `authorize` handler, and the rule that a continuation store never resurrects authenticity. The acceptance criterion about lent elevation surviving a resume should be inverted: a resumed continuation authorises at the ingress, never from storage.
6. **Scope of the not-doing list.** Explicitly out: exactly-once external effects, one transaction across the session and deferral stores, sandboxing, automatic migration of a changed plan, retracting uncooperative IO. Explicitly NOT out, because shipped: per-exchange deferral ids, tail-only hash including callable source, duplicate-resume idempotency with a cached outcome, TTL expiry with lease-healed escalation, restored-principal refusal, bounded shutdown, `keepsAlive` and auto-stop, `TeardownInfo`, resume payload validation and the signed token. Round six's rule (an existing guarantee cannot be discarded by calling it out of scope) needs this list written down before 7a and 7b, or each will re-derive it.
7. **#542 in parallel.** I did not read the issue and cannot add to the two validators' assessment that it is independent. Nothing in this review touches it.

**Sequence challenge 1** (continuation contract in stage 2): agree, with the correction that the contract to settle is the shipped one, `markResumed` plus `recordContinuation` plus `claimExpiry`, per-exchange ids, tail-only hash with callable source. Settling the spike's contract in stage 2 would fix the wrong shape early.
**Challenge 2** (gate mechanisms, not just imports): agree, and the enforcement's own tests must cover wiring, per 2.1.
**Challenge 3** (stage 3 by guarantee density): agree. Deferral is the obvious candidate; this review is a first draft of its "guarantee at risk" column.

---

## 6. The public docs draft against the code

The page is good writing and most of it is fair. These are the promises the proof of concept does not keep, in page order:

- **Section 2, the layers.** The page describes the shipped chain (authorize before validate, cache innermost). The spike has four anchors under one `RESILIENCE` port. No `authorize`, `parse`, `input`, `throttle` or `cache` position exists, so the sentence "authorization always happens before validation" describes 0.6, not the POC.
- **Section 3, "A handler can refuse the exchange or add to it."** Only at two of four points. See ruling 1.
- **Section 3, "Deferral is a provider plus an operation" and "There is no sixth kind that only we are allowed to use."** The resume protocol, the claim, the plan hash and the continuation format are kernel code (`runtime.ts:245-305`, `548-571`). A third party can add a store and a step; it cannot change how a continuation is claimed or resumed. That is defensible under amended P2, and the page should say the kernel owns it rather than imply a plugin does.
- **Section 4, "a plain object that declares three things."** Needs and offers are declared. Contributions are calls made inside `bind(ctx)`; nothing can read them off the value without running it. Opus's "make the plugin a value, not a protocol" was not adopted for contributions, and the page describes the version that was.
- **Section 5, "ours steps aside."** It keeps binding, acquiring, contributing and adding DSL methods. Only its `provide` is dropped. See P7.
- **Section 6, "Work that already happened does not happen twice."** False under the round-six semantics after a lease expiry (A1), and false under route-scope `retry`, which survives `resume` and re-runs the suffix on a failed attempt by design.
- **Missing concept.** Run-kind survival, which decides whether a security handler or a breaker re-runs on a resumed approval versus a debounce release versus an error-channel entry, is not on the page. A plugin author must set it, getting it wrong has security consequences, and there is no public word for it. By the page's own test, that is a finding against the design: a policy dimension that cannot be explained on the extender page.

The concept that explained well: ports. Section 5 is the clearest thing in the folder.

---

## 7. What everyone missed

In the order I would want to have known them:

1. The claim-lease correction is a misreading, and the corrected code re-runs half-run continuations (A1).
2. The plan hash is both too wide (whole route, every plugin, options) and too shallow (no callable source), which is the inverse of the shipped hash on both axes (A2.2, A2.3).
3. `.defer("approval")` parks one exchange per route (A2.1). Four rounds ran the demo and nobody delivered twice.
4. `Principal` is a forgeable core field and the acceptance criteria assert the laundering the security standard exists to prevent (A3).
5. Facets reverse a written standard without saying so; `structuredClone` per step makes the exchange model incompatible with shipped bodies (A4).
6. Contribution ids are one flat namespace; two third parties cannot both name a wrapper `audit` (B1).
7. Bounded shutdown, auto-stop and teardown info are shipped guarantees the spike lacks, one of them recorded as a limit (B2).
8. The CLI's `routes/` and `plugins/` layout does not fit a DSL that starts from an `Application` value (B3).
9. Thirteen of sixteen new mutants survive, concentrated in the resume path and the isolation claims; one recorded claim is asserted on the method and not on the wiring (2.1).
10. The compiler is fine at 20 plugins and 40 steps (3.4 s) and at 40 and 80 (10.9 s). Nobody had measured the encoding that would ship (2.3).
11. A mutation harness can report 16/16 kills from a path error. Mine did.

---

## 8. Verdict

**Proceed to hands-on review of the installation half; send the continuation and exchange half back for one bounded round first, and correct the round-six narrative before 7a and 7b read it.**

Would I stake the next two releases on this design? On the kernel shape, yes: ports resolved to providers with named refusals, contract-owned anchors with presence, one topological sort for two graphs, freeze before compose, per-route wrapper binding, and a DSL whose methods and runtime come from one installed value. Those reproduced, survived my mutants where the suite covers them, and scale at the compiler. Jaco's hands-on review of routes and configuration can proceed on that half, with the facets-versus-standard question and the CLI layout question on the table.

On the continuation contract, the exchange model and the principal as written, no. A hands-on review of representative routes would be reviewing a `.defer("approval")` that cannot park two exchanges, a plan hash that strands every approval on any deploy and passes an edited payout, and a security model the repository's own standard forbids. Those are not feature-fit items to be discovered in 7a; they are the shape of the contracts stage 2 would publish. One bounded round should: adopt the shipped continuation shape (per-exchange id, tail-only hash over step definitions including callable source, `markResumed` plus cached outcome plus `claimExpiry`, expiry), move `Principal` out of core, decide facets against the standard on the record, drop the per-step clone, and rewrite ARCHITECTURE.md's post-round-six section and DIAGRAMS-MECHANISM.md section 5 to say what the shipped framework actually guarantees.

Where I am most likely to be wrong, so it can be checked: A1 rests on reading `types.ts`, `revive.ts` and `sweeper.ts` as I have quoted them; if there is a shipped path that re-runs a continuation after a crash, I did not find it. The lease probe simulates the sweeper with `releaseClaims(Date.now() + 1)` rather than waiting out a lease. The scale fixture's method families are trivial. The principal probe is in-process, which is the only kind of forgery the shipped `WeakSet` brand defends against anyway.
