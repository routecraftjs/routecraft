# Corrected branch contract review

**Verdict: one more bounded correction round before implementation planning.** The installation model remains a sound direction. I would not publish the continuation, authority-substitution, or open handler-point contracts in their current form. This does not change the decision to ship 0.7 independently.

Reviewed and reproduced baseline: **`d6823df6f06f54d653dd848669ff89ba1dfa1f1c`**, verified as the head of `validation/round-six` before reading. Executable review evidence: **`763d26aa2ef847d10dfb2dad716d6ec27086a980`**, on `validation/round-six-astra`. That evidence commit changes only files under `spikes/plugin-architecture/validation/contract-review/`; the implementation, existing acceptance tests, and shipped framework are identical to the baseline. References below are to those unchanged sources. No production changes or pull request.

## Reproduction

All reported figures reproduce on **`d6823df6f06f54d653dd848669ff89ba1dfa1f1c`**, with Bun 1.3.11. Root `bun install`, followed by the requested commands from the spike:

| Method | Observed |
|---|---|
| `bun run verify`, strict typecheck stage | Pass |
| Its acceptance-test stage | 56 pass, 0 fail, 215 assertions |
| Its behavioral-mutation stage | 51/51 killed |
| Its compiler-control stage | 12/12 rejected |
| Its import gate | 11 modules, 23 permitted import edges, 0 dynamic edges |
| Its diagram check | 21 edges; 2 example modules deliberately omitted |
| `bun run verify:packed` | External consumer and private-subpath checks pass |

There is no reported-number discrepancy. Setup initially failed because an install script could not find Bun on its inherited PATH; setting PATH and rerunning root installation succeeded. A verification attempt made before installation finished stopped at missing `tsc`; it is not a framework failure. The successful reproduction above is the completed run.

The correction history matters. Round six's resume-lease change introduced replay of half-run continuations. Reverting it restores the correct distinction. The missing duplicate result, expiry machinery, per-exchange identifiers, incomplete hash, principal laundering, per-step cloning, and unbounded drain were defects in the earlier rebuild, not consequences of that lease change. Round six also correctly found its earlier suite's handler-survival, tag-selection, and import-gate gaps. Round seven's historical probes are evidence for their recorded API, not runnable acceptance checks for this head.

## New evidence and mutations

Measured on **`763d26aa2ef847d10dfb2dad716d6ec27086a980`**:

| Method | Observed |
|---|---|
| `bun test validation/contract-review/probes.test.ts` | 18 characterizations pass, 46 assertions. These assert observed defects and controls, not desired behavior |
| `bun run validation/contract-review/language.ts` | Compiler accepts the documented positive counterexamples; 4 independently removed negative markers produce compiler errors |
| `bun run validation/contract-review/bundling.ts` | Plain-to-minified rejects; identical minified input resumes; an edited minified callable rejects |
| `bun run validation/contract-review/mutations.ts` | 7 new mutants: 1 killed, 6 survive |

Each mutant runs the full existing acceptance suite, including its packed consumer, in a disposable copy. The unchanged copy and a no-op must pass before mutation. Syntax and missing-import controls must be invalid, not killed; an intentional behavioral change must fail assertions. My first disposable copy omitted the packed test's parent tsconfig. The unchanged-copy check caught that failure and stopped the runner before counting any mutant. I corrected the copy, then ran the controls and measurements. Test-process failure alone never counts as a kill.

New-mutant results, measured by that runner on **`763d26aa2ef847d10dfb2dad716d6ec27086a980`**:

| Mutation, absent from the existing mutation list | Result |
|---|---|
| Omit nested child definitions from the tail hash | Survives |
| Stop freezing the minted principal's grant array | Survives |
| Ignore the deadline in `findExpired` | Survives |
| Let `markExpired` settle unclaimed waiting records | Survives |
| Remove exchanges from the cached duplicate reply | Survives |
| Let stored headers override resume ingress headers | Killed by the process-restart assertion |
| Make `Authority.effective()` always return no grants | Survives |

Survival means the baseline suite does not detect that change. It does not mean the mutated behavior is acceptable. The last survivor is particularly informative: the auth gate does not consume that service at all.

## Findings that change the contracts

### D1. Authority substitution changes provider selection, not authorization

`auth.ts:93` and `auth.ts:132` call the module-local `principalOf`. Neither the facet nor the gate reads the selected `AUTHORITY`. The replacement probe installs `vendor.jwt` alongside the default, verifies that it is selected, and supplies an authority that recognizes a principal. The gate refuses it, and the replacement receives no calls. A principal minted by the original module still passes.

A JWT verifier can use exported `mint` after verification and interoperate with this module's brand. That is integration with this implementation, not replacement of authority through its port. Replacing the whole auth plugin and reimplementing its handler is possible; the provider interface does not require that handler or make its semantics follow selection.

The corresponding failure-open probe is concrete: build a route with `.authorize("pay")`, then start that `RouteSpec` with an independently named provider using namespace `auth` and implementing the complete `Authority` interface, but no default auth handler. Its service returns no principal and no grants. The route requirement passes, and the protected body executes. This is an incomplete enforcement contract, not a claim that the kernel can make a malicious plugin trustworthy.

**Required correction:** separate the auth surface/gate from the default authority provider, make both facet and gate consume the resolved service, and make the route requirement name an enforcement contract whose semantics are tested under replacement. Core can remain identity-blind.

### D2. The continuation port still cannot express several shipped guarantees

The corrected CAS/cache/notification distinction is right, but it is not a complete replacement for `DeferralStore`:

- `ContinuationRecord` includes `denied`, but `ContinuationStore` has no denial transition. Shipped continuation-mismatch handling claims, notifies, then calls `markDenied` (`revive.ts:496`, `revive.ts:507`). Throwing `PLAN_MISMATCH` while leaving the record waiting cannot express that protocol.
- `findExpired(now, limit)` has no cursor. The shipped keyset cursor advances past records that cannot be retired, preventing an orphaned prefix from starving later work (`types.ts:607`, `sweeper.ts:147`). Increasing a limit indefinitely loses the bounded-memory guarantee.
- `Execution.resume(id, headers)` has no distinct payload and trusted door, cancellation signal, or structured acknowledgment. `RunResult` cannot return the cached failure/status as the shipped `ResumeAcknowledgment.continuation` does. All failed duplicates and unfinished first resumes collapse to `duplicate` with empty arrays.
- The record/request contract omits the live-schema reference/descriptor, call binding, policy metadata, resumer audit identity, action fingerprint, and opaque step-owned state. Arbitrary headers are not a substitute for the shipped `stepState` lifetime: it must survive retries of its owning step but not leak into a later deferral.
- There is no atomic `replaceStepState`, management projection/listing, pending summary, or settled-record purge. Expiry and denial also lack settlement timestamps needed for retention measured from settlement. These are shipped store capabilities, not new distributed-system guarantees (`types.ts:571`, `types.ts:640`, `types.ts:687`).

Some can be companion ports, but their ownership and compatibility fixtures must be settled before calling this stage-2 contract complete. The schema, token, and payload work is already a ledger item; acknowledging that work does not make the present API capable of carrying it unchanged.

### D3. Tail compatibility validates the stored instruction list, not the current continuation

`runtime.ts:319` recomputes the hash using `saved.pending`. The appended-tail probe parks under a route containing a payment step, then installs a route with an additional audit step after it. Resume succeeds and skips the new audit step. The new live continuation was never compared. Shipped `revive.ts:283` resolves the current defer site and hashes its current continuation.

`runtime.ts:79` also stringifies only top-level functions in `Step.source`. A callback nested in an explicitly supplied option object disappears through `JSON.stringify`. Changing that callback from one bank target to another resumes successfully in the probe, while shipped `continuationTailHash` changes. This is not an undiscoverable captured closure: the callback was explicitly present in the declared source object.

**Required correction:** specify how a stored continuation locates and compares its live continuation graph, and define recursive source projection/canonicalization. Reuse the shipped bounded projection rules where applicable. An optional `source` array with undefined serialization semantics is insufficient as a compatibility contract.

A separate prefix-insertion probe rejects because generated transform IDs contain absolute step positions. I do **not** classify this as a demonstrated shipped regression: the shipped defer-site address is also positional. Tail-only hashing does not promise compatibility across every addressing change.

### D4. Open handler points lose their refusal policy at runtime

`HandlerPoints` carries the policy only in erased types. `Runtime.handlers` hardcodes `error` and `exit` (`runtime.ts:469`); an external point declaring `refuse: false` has no runtime policy descriptor. A JavaScript-style refusal at that point returns `null`, not `REFUSE_UNSUPPORTED`.

The compiler fixture also accepts a default-generic `Handler` whose `point` is `exit` and whose decision is `refuse`, including its submission to `contribute`. A directly contextualized literal and `Handler<"exit">` reject correctly. The default generic is a union without a preserved point/decision correlation.

**Required correction:** retain the policy in a runtime point identity and correlate handler variants in the public type. This is a gap in the open-point contract, not grounds to close the extension mechanism.

## Findings that change the implementation plan

### P1. Resume and expiry still violate the preserved lifecycle

The probes establish these independently:

- `storage.ts:154` lets `markResumed` win after an expiry claim. The shipped memory store refuses the same sequence through `resumable`; SQLite uses `state = 'waiting' AND claimed_at IS NULL`. The notification claimant must exclude resume.
- `Runtime.resume` executes a continuation whose TTL has already elapsed if no sweep has run. Shipped revival checks the deadline before validation and again after winning CAS.
- The auth plugin checks at entry, after `markResumed`. An identity-free resume consumes a protected approval, returns `refused`, and makes the subsequent legitimate attempt a duplicate. Admission runs before CAS, but this authorization check does not.
- Duplicates return before admission or any auth handler. A duplicate probe confirms the admission counter does not advance. The shipped door policy and call-binding checks precede lifecycle disclosure.
- Expiry on a protected route runs the restored principal through entry auth, gets refused before the error handler, then still marks the record expired. The notification probe sees no nag. Shipped `enterErrorChannel` reaches the error path without that route-entry gate.
- `findExpired` includes claimed records despite its own contract. An entirely claimed oldest page hides an available due record behind it. An orphan route is claimed before lookup, and its lookup failure aborts the sweep before later valid work.

The claim/TTL issues are implementation fixes expressible with the current basic fields. Correct pre-consumption authorization needs D1/D2, and starvation-free paging needs D2. Do not replace resume CAS with a lease again.

### P2. Cloneability is not the persistence codec, and caching can falsify success

`serialize` uses `structuredClone` (`runtime.ts:58`). SQLite then JSON-stringifies. The probe parks a `Map` and resumes `{}`; a `Date` resumes as a string. Shipped serialization rejects the Map and preserves Date through its tagged envelope. The missing guarantees also include branded-secret rejection and other invalid-value checks in `deferral/serialize.ts`.

A resumed suffix that performs its effect and returns a function throws `NOT_SERIALIZABLE` while building the cached outcome, outside the best-effort recording catch (`runtime.ts:380`). The record is left without an outcome although the work finished. Shipped `runContinuation` deliberately omits an unpersistable terminal body while recording completion (`revive.ts:790`). Cache projection must not turn completed work into a reported execution failure.

### P3. Available reporting and healing methods are not wired lifecycle behavior

The boot probe supplies a store containing resumed residue and a scan spy. Startup never calls `resumedWithoutOutcome`. The method can report residue when called manually; the application does not report it at boot. Similarly, `sweep` never calls `releaseClaims`, and no periodic sweeper is installed. The correction test manually releases the claim.

Plan explicit startup scanning, scheduled lease healing/expiry, retention, and shutdown ownership. Keep the already acknowledged `keepsAlive`, auto-stop, `TeardownInfo`, and readiness ledger items. The existing drain test establishes a bound on in-flight work; `Runtime.stop` still awaits source unsubscription before starting that deadline and awaits disposal afterward, so it should not be described as a bound on every teardown callback.

## Continuation audit against the shipped call path

This is the ordered path I followed, not an inference from lease JSDoc:

| Shipped source and action | Corrected spike | Judgment |
|---|---|---|
| `revive.ts:174`: verify token, load record | Loads by raw ID | Signed ingress remains unimplemented; separate trusted-door contract needed |
| `revive.ts:186`: call binding | No corresponding field/check | Cannot preserve through the current request/record contract |
| `revive.ts:192`: door authorizer with record, payload and principals | Admission sees exchange/route; auth runs at entry | Wrong information and ordering for this guarantee |
| `revive.ts:206`, `revive.ts:559`: settled/claimed response after authorization | Early duplicate, then waiting check only | Skips policy, loses outcome, accepts claimed waiting records |
| `revive.ts:229`: overdue arrival | No deadline check in resume | Regression |
| `revive.ts:246`, `revive.ts:283`: resolve live site and hash tail plus schema | Hash old pending IDs, no schema descriptor | Incomplete compatibility contract |
| `revive.ts:303`: live payload validation | No payload parameter | Ledger work requiring API design |
| `revive.ts:335`: CAS before execution | CAS before execution | Correct shape; missing unclaimed guard |
| `revive.ts:351`: deadline after asynchronous validation | No corresponding recheck | Must survive the payload-validation port |
| `revive.ts:390`: rehydrate and seed step state | Rebuild envelope and overlay ingress headers | No step-state channel; changes continuation identity semantics |
| `revive.ts:412`: run resolved continuation | Executes saved pending suffix | Correct halt/resume direction; D3 remains |
| `revive.ts:418`, `revive.ts:443`: preserve primary failure and best-effort cache | Execution failures recorded; successful projection can throw first | P2; duplicate must expose cached outcome |
| `revive.ts:496`, `revive.ts:642`: notification claim, re-ask, finalize | Expiry only; entry gate can suppress notification | Missing denial transition and correct error-channel entry |
| `sweeper.ts`: heal, page, skip orphans, scan at boot, purge | Manual single-page sweep and standalone store methods | Partly unimplemented; cursor/retention contract absent |

There is another policy difference to decide explicitly. Shipped rehydration preserves the deferred principal as restored and records the resumer separately. It does not install the approver's authority on the entire continuation. The spike overlays all ingress headers, and its process test expects the resumer's authentic identity to authorize a downstream hop. Ruling 5's statement that ingress authorizes resumption does not by itself decide this authority transfer. Keep it separate from the valid prohibition on trusting a stored principal.

Ruling 6's exclusions remain legitimate: no exactly-once external effects, distributed transaction across stores, sandbox, automatic plan migration, or retraction of uncooperative IO. The included guarantees are not all restored: identifiers work on the covered path, CAS prevents repeat execution, and the store can retain outcomes and release claims; TTL enforcement, full duplicate acknowledgment, reliable escalation, and boot reporting remain incomplete. Signed tokens and payload validation remain required ledger work, not exclusions. The lease also serves denial notifications in shipped code, not only expiry notifications.

## Positions on the five rulings

| Ruling | Position |
|---|---|
| **5: Principal outside core** | Agree with ownership and the private WeakSet brand. I would not have accepted the current provider/gate coupling or called the runtime requirement a complete fail-closed fix. Separate ingress permission from authority transferred to resumed work |
| **8: Facets and the standard** | Agree with one top-level facet per namespace. The composite-facet runtime and compiler probes show identity and conversation can coexist under it. Independently installable concerns can be separate plugins. I would amend the proposed text to preserve the state/derivation distinction explicitly |
| **9: Owner-qualified strings** | Agree with checked namespaces and per-owner contribution IDs. This is collision detection, not universal compile-time prevention. Raw option strings compile; DSL method names and handler-point names remain shared surfaces. Cover all these in the version policy and document the exceptions |
| **10: CLI route modules deferred** | Agree to defer to feature-fit, with a required decision before DSL migration. Prefer a project-typed route factory invoked by the CLI. Its plugin tuple must come from a side-effect-free project definition, not a live app singleton. The compiler fixture demonstrates that shape retains facet typing; the actual CLI/TUI/testing integration remains unproved |
| **11: Refusal policy in types** | Agree with the decision, disagree that implementation is complete. Specific handler types work; the broad handler type and custom runtime points do not preserve the policy. Add the runtime descriptor and correlated union |

As a maintainer, I would replace ruling 8's amendment with:

> Plugins do not patch `DefaultExchange`'s prototype. An installed plugin may declare one top-level facet named by its namespace through the plugin protocol. Installation contributes that facet to this application's exchange type. Duplicate namespaces and collisions with reserved core fields are rejected before execution. A facet is a view or affordance derived from exchange state and runtime services, not another persistence slot. Persistent exchange state remains in `body` and `headers`; step-owned continuation state follows its separate lifecycle contract. Facet factories must be reconstructible after rewrapping and resume. Other accessors may remain exported helpers.

The namespace/type rules justify controlled facets. They do not justify silently allowing a new mutable state bag that disappears at the next envelope or persistence boundary.

For ruling 10, `project.ts:194` and `start.ts:324` confirm the existing `apply` recognition/load path. A factory approach needs an explicit loader change, a runtime identity check against the project descriptor, and fixtures for CLI discovery, multiple test contexts, and TUI inspection. A bare callback cannot infer a specific plugin tuple from future filesystem discovery. The project-bound callback in the compiler probe has that tuple explicitly. A free global registry would give up the installation-specific guarantee this work earned.

## Public documentation audit

The new wording still overpromises:

- **“An ask never fails open.”** D1's transferred authorized route is the counterexample. A required provider is not yet a required enforcing gate.
- **“Two plugins cannot collide on a string, and the compiler tells you...”** Runtime namespace/DSL collision rejection is real. `configure({"ghost.retry": 2})` compiles without that plugin. Say which errors are compile-time and which are construction-time. Do not imply open point names or DSL methods are automatically owner-qualified.
- **“The same approval presented twice is answered from the first time.”** Repeat execution is prevented, but failure, deferral and unrecorded-result details are omitted. Say this only after the acknowledgment contract is corrected.
- **“It is reported” after a mid-resume crash.** Discoverable through a manually called store method today; not reported automatically at boot.
- **A handler can add to the exchange at every point.** Exit decoration reaches the next exit handler but is discarded from the returned result. State that scope or propagate it.
- **Layer order.** The draft explicitly labels the drawn chain as today's framework, which is a legitimate caveat. Its unconditional prose about retry being inside timeout is not the POC's route wrapper order: `RETRY` is declared before `TIMEOUT`. Distinguish route configuration from step wrappers and require a compatibility fixture before publishing the universal statement.

The revised explanation of displaced providers, the kernel-owned resume protocol, and run-kind survival is materially better. Keep those qualifications. `DIAGRAMS-MECHANISM.md` now draws the correct CAS-versus-notification distinction, but its boot-reporting/cache language inherits the gaps above. The diagram check verifies its module graph, not the behavior of every picture. `ARCHITECTURE.md` also retains stale acceptance totals in its provenance/appendix; use the reproduced table rather than treating those older totals as current evidence.

## Bounded exit criteria

Do not restart a general architecture exercise. Close these before implementation planning publishes the contracts:

1. Demonstrate an independently branded authority replacement with the existing gate/facet surface, and an authorization refusal that leaves an approval usable by its rightful caller. Apply the same policy to duplicate replies.
2. Specify the missing continuation result/door/site/state interfaces, denial transition, keyset scan, and retention ownership. Demonstrate a live-tail append and nested option edit being refused, with the permitted unchanged-tail cases retained.
3. Restore claim-versus-resume exclusion, deadline checks, protected-route expiry notification, actual boot reporting and lease healing. Use a backlog with claimed and orphaned prefixes.
4. Use the shipped persistence rules and best-effort terminal-body cache behavior. Demonstrate that successfully completed non-JSON output does not become an execution failure.
5. Finish refusal-policy enforcement for external points and the broad handler type, then correct the public claims.

What surprised me most was not another lease misunderstanding. It was that a service can be selected without governing its advertised behavior, and a hash can accurately compare the wrong instruction list. The new namespace and required-port checks make installation stricter, but do not close those execution contracts.

My falsifiable position: retaining one grouped facet is sufficient for the legitimate two-concern example tested here, and verbatim emitted-source hashing should remain. The bundling probe shows why its false rejection after a build-setting change is expected, while identical emitted input works. It does not promise compatibility across bundlers, captured-value changes, or every minifier. The demonstrated unsafe hash cases are the unexamined live tail and lost nested callable, not the choice to hash verbatim source.
