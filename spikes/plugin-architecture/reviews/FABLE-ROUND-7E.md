# Round 7e clean-room review

**Verdict: one more bounded round before the feature-fit rounds treat the continuation contract as settled; Jaco's hands-on review can run in parallel, because nothing found here changes the direction.** Round 7e closed what Astra asked for, by the tests and mutants named in section 3. It also introduced a record shape under ruling 12 that persists more than the shipped `PrincipalRef` and less than the shipped audit (the resumer is on no record when the continuation fails), it opens the parked body to every admission handler before the gate decides, and it calls a codec "the shipped rule set" that lacks seven of the shipped rules. None of that is a redesign. All of it is executable, and the criteria in section 8 are bounded.

Reviewed head: `validation/round-six` at **`63cfcda694f68b891cbccb59ef262cf71a43b1c2`**, checked out and confirmed before reading. Evidence: `validation/round-seven-e-review/` on `validation/round-7e-fable`, with a README that maps every probe and mutant to a finding. Nothing under `src/v2/`, `test/round-two/` or `validation/round-two/` was changed. No pull request.

## 1. Reproduction

All figures measured on `63cfcda6`, Bun 1.3.11, after a root `bun install`, from `spikes/plugin-architecture`.

| Method | Recorded in `verification-round-seven-e.txt` (measured on `7b274530`) | Observed on `63cfcda6` |
|---|---|---|
| `bun run verify`, typecheck stage | pass | pass |
| Its test stage | 81 pass, 0 fail, 328 expect() calls, 5 files | 81 pass, 0 fail, 328 expect() calls, 5 files |
| Its mutation stage | 75/75 killed | 75/75 killed |
| Its import gate | 12 modules, 27 permitted edges, 0 dynamic | 12 modules, 27 permitted edges, 0 dynamic |
| Its compiler controls | 15/15 | 15/15 |
| Its diagram check | 25 edges, 2 omitted | 25 edges, 2 omitted |
| `bun run verify:packed` | both PASS lines | both PASS lines |
| Wall clock of `verify` | not recorded | 1 m 23 s |

No discrepancy. `63cfcda6` differs from `7b274530` only by the verification transcript, so the recorded figures are figures about this head.

## 2. The harness, checked before it was believed

`validation/round-seven-e-review/harness.ts` runs the round-two runner's exact discipline (its pattern builder copied verbatim, a disposable copy, one filtered `bun test` per mutant) against three shapes of broken mutant. Measured on `63cfcda6`:

| Control | Observed | Verdict |
|---|---|---|
| Parse error in `codec.ts` | `bun test` **hangs** on a parse error in an imported module; the runner's 8 second SIGKILL fires; the output carries no `(fail)` marker | classed invalid, not killed, after 8009 ms |
| Import of a missing export | exit 1; the summary line says `4 fail`; no per-test `(fail)` marker | classed invalid in 64 ms |
| Pattern that no longer matches | throws `mutation no longer applies` before running anything | correct |

So the runner does refuse to count a parse error as a kill, but for a reason worth knowing: it keys on the per-test `(fail)` marker and never on the exit code or the summary line, and a parse error reaches that branch only because Bun 1.3.11 hangs and the kill timer bounds it. A Bun that stopped hanging and started printing `(fail)` for a file that failed to load would silently turn every parse error into a kill. The runner should assert that at least one test *ran* (the summary's pass count) before it reads the marker.

Two more things the controls found:

- **Two of the 75 shipped patterns are ambiguous.** "lifecycle disclosed before the door" and "a refused resume spends the approval" both match `if (!admitted) return { status: "refused", ... }` twice in `runtime.ts`: the resume door at line 489 and the entry door at lines 741 and 742. `String.replace` edits the first occurrence, which is the intended one today by file order only. A reordering of the two methods would move both mutants to the wrong site and both would still report killed, by a different test. The runner should refuse a pattern that matches more than once; my runner does.
- **Bun elides an unused import.** My first missing-export control referenced nothing and the suite passed: the transpiler dropped the import and the mutant was a no-op reported as SURVIVED. A mutant that touches only an import or a type position proves nothing under Bun in either direction.

### Review mutants

`validation/round-seven-e-review/mutations.ts` runs sixteen mutants of my own against the head's suite. Each is run under a filter, as the shipped runner does, and a survivor is then re-run against the **whole** suite before it is called a survivor. The unchanged copy must pass that whole suite first. That control earned its place immediately: my first confirmation run reported sixteen full-suite kills, and every one was `packed.test.ts` failing because the disposable copy has no `validation/round-two/packed.ts`. The shipped runner's copy lacks it too; the shipped runner is protected only by never running the whole suite.

Measured on `63cfcda6`, with the packed consumer test excluded from the confirmation by name:

| Mutant | Result | What a survivor means |
|---|---|---|
| sweep processes only the first page | survived | The runtime's paging loop has no test; only the store's cursor does. Probe F17 (150 records, two pages) is the test it needs and passes today |
| orphan does not advance the scan cursor | survived | The starvation guarantee is untested at the sweep. Under the mutant, 100 or more orphaned due records ahead of live ones would loop the boot scan forever and the application would never start |
| expiry scan page is unordered | **killed** by "findExpired excludes claimed records and pages by keyset cursor" | The one review mutant the suite sees |
| sweep never purges settled records | survived | Retention is tested at the store, never through the sweep that is supposed to drive it |
| sweep releases live claims, ignoring the lease | survived | The lease deadline is tested at `releaseClaims`, never through the sweep; a sweep releasing live claims would double-deliver nags under concurrent sweepers |
| settle reports expiry even when a concurrent resume won | survived | The "whoever won says what happened" branch in `settle` is untested; a resumer that loses the deadline race to an accepted resume would be told EXPIRED about work that ran |
| claimed record proceeds down the resume path | survived | The `RESUME_SETTLED: claimed` disclosure branch in `resume` is untested |
| lent grants are not honoured by the gate | survived | `lent` is never load-bearing for a pass anywhere in the suite |
| codec accepts a non-finite number | survived | Five codec rules with no test, see F9 for the seven rules that do not exist at all |
| codec drops a symbol value silently | survived | as above |
| codec accepts the reserved date envelope as data | survived | as above |
| codec revives a corrupt date envelope as an invalid Date | survived | as above |
| codec cycle check removed | survived | as above |
| duplicate route id accepted at compile | survived | `DUPLICATE_ROUTE` has no test |
| resumedAt header dropped from the continuation | survived | `routecraft.deferral.resumedAt` is written and never read by a test |
| boot report bounds stranded ids to one | survived | The report bound is untested; trivial |

1 killed, 15 survived, 0 invalid of 16. The 75/75 figure is true and it is a figure about the 75 mechanisms the list names. The sweep's paging, healing and purging as *wired* (rather than as store methods), the codec's refusal rules, and two branches of the resume path are outside it.

## 3. Astra's five exit criteria

Read against the calls, not the comments: `runtime.ts` `resume` (lines 463 to 601), `settle` (432 to 454), `sweep` (611 to 652), `framesOf` (164 to 188), `pendingOf` (190 to 207), `project` (86 to 126); `auth.ts`; `storage.ts` `durableStore` and `deferralPlugin`; `codec.ts`.

| Criterion | Status | Closed by | What remains, with the probe that shows it |
|---|---|---|---|
| 1. Independently branded authority through the existing gate and facet; a refusal that leaves the approval usable; the same for duplicates | **Closed** | Tests "an independently branded authority replaces what the gate and the facet trust", "a provider without the gate satisfies nothing", "an authorization refusal at the door does not consume the approval", "a duplicate passes admission and exposes how the first resume ended". Mutants "gate ignores the selected authority", "facet ignores the selected authority", "a refused resume spends the approval", "lifecycle disclosed before the door", "route requirement unchecked" | The same surface has three holes the criterion did not name: `.authorize()` with no grants is a no-op that admits an anonymous exchange (F1); every admission handler ahead of the gate is handed the parked body before the gate decides (F4); the route is resolved before the door, so an unauthenticated caller learns whether the route exists (F5) |
| 2. The missing result, door, site and state interfaces, the denial transition, keyset scan, retention ownership; a live-tail append and a nested option edit refused, unchanged tails retained | **Closed on the store port, partly on the door and the record** | `markDenied`, `settledAt`, `reason`, `findExpired(now, limit, after)`, `purgeSettled`, `pending`, `replaceStepState`, `stepState`, `RunResult.outcome`, `ResumeIngress`, `Frame`. Tests "a step appended after the defer point invalidates the approval", "an appended step after a trailing defer point is not silently skipped", "a callback nested in a step's declared source is part of the tail hash", "an edited child of a branching step in the tail invalidates the approval". Mutants "frame not anchored at the site", "nested source not projected", "nested child definitions omitted", "mismatch leaves the record resumable" | The door gets the whole serialized exchange, body included, where the shipped `DeferralRecordView` deliberately has no body and does have `deferredAt`, `expiresAt` and `meta` (F4). The resumer's audit identity is still not on the record: it rides a header of a live exchange and is written to the store only inside a cached *completed* outcome, so a failed continuation records nobody (F3). The scan contract is right; its SQLite implementation materialises every due index entry per page (`storage.ts:247` to `264`), so the memory bound Astra asked for is in the port and not in the reference store |
| 3. Claim excludes resume; deadline checks; protected-route expiry notification; actual boot reporting and lease healing; a backlog with claimed and orphaned prefixes | **Closed for what it names** | Tests "a notification claim excludes a resume", "a resume that arrives after the deadline expires the record", "expiry on a protected route reaches its error channel", "boot scans the store", "an orphaned record is skipped", "findExpired excludes claimed records and pages by keyset cursor". Mutants "markResumed ignores a live claim", "resume ignores the deadline", "gate runs on the error channel", "expiry scan returns claimed records", "orphan aborts the sweep", "stranded residue not reported at boot", "boot sweep skips healing" | The deadline is checked once, before the CAS, and never after it (F6). The boot scan runs after sources have subscribed, so new traffic precedes the escalations (F13). With `CONTINUATIONS` replaced the boot report scans a store nothing uses (F11). A sweep in flight when `stop()` begins is abandoned after its claim (F12). No default deadline exists (F14). The sweep's paging, healing and purging as wired have no test (section 2) |
| 4. The shipped persistence rules; best-effort terminal-body cache; completed non-JSON output is not a failure | **Half closed** | Terminal body: test "an unpersistable terminal body does not turn a completion into a failure", mutant "unpersistable terminal body fails the resume". Codec: test "a Map cannot park and a Date round-trips as a Date", mutant "defer boundary does not require plain JSON" | "The shipped persistence rules" is not what `codec.ts` is. Seven rules in `deferral/serialize.ts` are absent: `BRAND.Secret` refusal (line 195), the `__proto__` null-prototype accumulator (289), symbol-keyed property refusal (259), non-enumerable property refusal (274), named array property refusal (227), Date subclass and Date-with-properties refusal (201 to 216), and `decode` refusing a corrupt envelope (317). F9 shows five of them losing data in silence; F10 shows the corrupt envelope resuming as data. Five of the rules that do exist have no test (section 2) |
| 5. Refusal policy enforced for external points and the broad handler type; public claims corrected | **Closed** | Test "an external point's refusal policy is enforced at runtime", type controls 12 to 15, mutants "point policy ignored for an external point", "undeclared point accepted at bind". The claims Astra named are corrected | The residual overpromises are in section 7; none is one Astra listed |

## 4. Ruling 12 against the shipped framework

**The direction is what shipped does. The record is not.**

What shipped does, by the call: `reviveDeferral` rehydrates the parked exchange from its stored headers (`revive.ts:734`), `deserializeExchange` marks the stored principal restored (`serialize.ts:109`), `rehydrate` keeps those headers and adds the payload, the resume time and the resumer (`revive.ts:736` to `748`). The resumer is a `PrincipalRef` (`types.ts:215`): subject, and issuer, clientId and the outermost actor's subject when present, reduced by `principalRef()` (`deferral/principal-ref.ts`) whose comment states the rule: "a full principal carries claims, scopes and a delegation chain that would be resurrected as data with no verification behind it". That reference is written into the record by the CAS itself, `markResumed(id, { at, by })` (`revive.ts:335`), before the continuation runs, and again onto the exchange header `routecraft.deferral.resumedBy`. `security.md` section 3 says the rest: a restored principal is readable and fails `authorize()` with `RC5043`, and the ingress route is where the resumer is authorized.

What the spike does: the continuation runs as the parked exchange with `routecraft.deferral.result`, `resumedAt` and `routecraft.deferral.ingress` added (`runtime.ts:538` to `546`), and `ex.auth.resumedBy` is derived from the ingress header (`auth.ts:130`). A downstream `.authorize()` refuses the restored principal; the 7e policy test and the process test show it, and mutant "ingress headers merged into the continuation" guards it. Confirmed.

Whether recording the whole admitted ingress header set through the codec is an acceptable equivalent of `PrincipalRef`: **no, it records too much and, on one path, too little.**

- Too much (F2). The bag is every header the ingress carried, run through a codec that has no secret rule. A bearer-shaped header beside the principal is written verbatim into the cached outcome under `record/{id}`, and so is the resumer's full grant list. A later permitted caller's duplicate reply hands that bag back in `exchanges[0].headers`. Shipped refuses `BRAND.Secret` at the codec and persists four fields of the resumer. "A shape, never a credential" is true of the principal object's brand and false of the header set as a whole: a credential that was a string is a string after the codec.
- Too little (F3). The bag lives on a header of a live exchange. It reaches the store only when a terminal exchange is persistable and cached. A continuation that throws records `{ status: "failed", exchanges: [] }` and nobody. Shipped has the resumer on the record from the CAS onward, which is what "who authorized this" needs precisely when the payment failed.

The fix is not a redesign: reduce the ingress to a reference at the door (subject and whatever the selected authority chooses to expose, an `Authority.refOf(headers)` beside `principalOf`), write it into `markResumed`, and add a secret rule to the codec. The process test's `resumedBy:bob:restored` assertion survives that unchanged.

One more policy difference, not decided anywhere I can find (F15): the door re-applies the deferred route's own `.authorize()` grants to the resumer, so an approver must hold whatever the requester needed. Shipped separates the two: the deferred route's requirement and the ingress route's `.resume({ authorize })` hook with the two principals side by side. A plugin can express an approver policy with an admission handler that reads `info.resume`, but the framework's own gate today says the requester's policy is the approver's, and nothing records that as a choice.

## 5. Guarantee probes

Eighteen probes in `validation/round-seven-e-review/probes.test.ts`, all characterisations: each asserts what the head does, so the file is green on `63cfcda6` (18 pass, 56 assertions) and every assertion is a reproduced fact. The README maps each to the shipped source. Grouped by the areas the brief named:

**Resume path order.** F5: `this.route(saved.routeId)` at `runtime.ts:474` runs before the door, so an unauthenticated resume of a record for a route this deployment lacks throws `[kernel] UNKNOWN_ROUTE` with no admission handler run. Shipped resolves the route at `revive.ts:210`, after the door. F4: the door's `info.resume.deferred` is the whole serialized exchange, and admission handlers run in contribution order with unconstrained ties broken lexically, so `acme.audit/log` runs before `routecraft.auth/authorize` and is handed `{ iban, amount }` on a resume the gate then refuses. Shipped built `DeferralRecordView` without a body for this exact case. F15 as above.

**Expiry and denial.** F6: with `.defer("a", 30)` and a store whose `markResumed` write takes 80 ms, a resume that arrives in time wins the CAS and runs the continuation after the deadline. Shipped re-checks at `revive.ts:351` because anything between the first check and the CAS can await; the spike has nothing awaiting there today except the store, and the store is enough. When payload validation lands as the ledger says, this window becomes the shipped one. F14: no ttl means no `expiresAt`, so `.defer("a")` never comes due and `pending()` counts it forever; shipped applies `DEFAULT_DEFERRAL_TTL` of 72 hours (`config.ts:208`). F16: a record whose `codec` is not 2 is denied and its route nagged on first contact (`runtime.ts:515` to `525`), which is destructive where a refusal would do.

**Boot scan.** F13: `Runtime.start` subscribes sources (`runtime.ts:334`) before `host.activate()` runs the deferral plugin's start hook (`runtime.ts:349`), so a source that emits during subscription starts an exchange before `deferral:boot` is emitted. Shipped awaits `scanOnStart()` "ahead of anything new arriving" (`config.ts:354` to `356`). The contracts test "start hooks see sources ready" shows the order is deliberate; it is the opposite of the shipped guarantee. F11: `deferralPlugin.start` builds `durableStore(ctx.require(RECORDS))` for its stranded and pending report (`storage.ts:414`) instead of the selected `CONTINUATIONS`, so with a vendor store installed as the docs draft's section 5 describes, the boot event reports `stranded: []` and `pending: 0` about a store nobody uses while the vendor store holds one of each.

**Sweep paging and orphans.** F17: 150 overdue records are retired in one pass across two pages. Correct, and the only test of it is mine. F12: `stop()` during a sweep flips `#accept` synchronously; the sweep's next `errorChannel` call throws `NOT_RUNNING` synchronously (`runtime.ts:658`), before `.catch` can see it, so the pass rejects with the record left claimed and the approver not told until the lease releases it in another process. Shipped subscribes to `context:stopping` before the boot scan and `stop()` awaits the pass in flight (`sweeper.ts:106`, `sweeper.ts:359`). Orphans and starvation: the code is right and untested at the sweep (section 2).

**Codec.** F9 and F10 as in section 3, criterion 4. One consequence worth spelling out: a body parsed from JSON with an own `__proto__` key loses that key on the way in because `codec.ts:69` accumulates into `{}` and the assignment hits the setter; shipped uses a null-prototype accumulator for exactly this (`serialize.ts:289`). `decode` at `codec.ts:98` does the same on the way out, so a stored `__proto__` key would set the prototype of the revived object.

**Tail hash: frames and recursive projection.** The projection is the shipped `describable` rule for rule (`project` at `runtime.ts:86` against `hash.ts:289`), and the 7e tests and mutants cover nested callables, children and the trailing site. Two contract facts the frames model does not state: F7, a defer inside `runPath` is swallowed. `nested` at `runtime.ts:796` maps a deferred nested result to `{ failed: false, dropped: false }`, the parent continues, the route completes, `result.deferrals` is empty, and a waiting record sits in the store that a later resume runs. `PathResult` cannot say "deferred". F8, a branch returning its declared children out of order cannot defer: `framesOf` throws `UNSTRUCTURED_PENDING` because the pending path is no longer a concatenation of suffixes, while `StepOutcome.branch` and `ids()` admit any declared subset in any order. Either `branch` must return a suffix of its declared children or `Frame` must address a list, and the contract says neither.

**Point policy.** Holds. The external point test, the two 7e mutants, the `POINT_IDENTITY` and `DUPLICATE_POINT` refusals in `host.ts:94` to `99`, and the `point()` signature typed against the merged declaration. I found nothing.

**Exit decoration.** Holds. `runtime.ts:751` to `755` and the 7e test and mutant.

**Duplicates.** F18: a duplicate arriving while the first resume is still running is `{ status: "duplicate", exchanges: [], deferrals: [] }` with no `outcome`, which is also what a duplicate of a resume that died mid-run gets. Shipped returns a `failed` continuation with a message saying the first resume has not recorded a result. The JSDoc on `RunResult.outcome` says so; the docs draft does not.

## 6. The stated limits

"What this round did not do" lists four things. Checked against shipped behaviour:

- **Signed resume tokens and payload validation.** Ledger items, as Astra classed them, and the contract can carry them (`ResumeIngress` has the payload; the door has the exchange). What is not a ledger item is the post-CAS deadline check (F6): shipped has it *because* validation awaits, and the spike has already lost it before validation exists.
- **`list` and the action fingerprint.** Both expressible as companion ports over the existing record: the fingerprint is a hash over `routeId`, `site`, `tail` and `exchange.body`, all on `Continuation`. Not a contract gap. The resumer's audit identity is the piece that is a contract gap and is not in this list (F3): the record has no field for it and `markResumed(id, at)` has no parameter for it.
- **One timer per application, stop is disposal, not the `context:stopping` gate.** Understated. The consequence is F12, and it is not expressible by the deferral plugin under the current contract: `Runtime.stop` flips `#accept` before any plugin hears anything, `errorChannel` then refuses synchronously, and `Plugin.stop` runs in `host.dispose()` after the drain. A plugin that kept its own in-flight promise and awaited it in `stop()` would await a pass that already failed. This is a shipped guarantee the spike's contract cannot express today: it needs either a pre-drain stopping signal to plugins or the kernel owning the sweep as work it drains.
- **Chain order scoped to route-level layers.** Correct as scoped. `retry` wraps `timeout` in `operations.ts` (breaker, retry, timeout, concurrency, outer to inner), so "each retry attempt runs inside its own timeout" is true of the POC's route wrappers.

Not listed and also not out of scope by any ruling: the default deadline (F14) and the boot order (F13) are shipped guarantees dropped without a note. Ruling 6 names "TTL expiry with lease-healed escalation" as explicitly not out; a TTL that defaults to never is half of that.

## 7. The public documents, read as a consumer

Every sentence below overpromises against the code at `63cfcda6`. Sentences Astra named and 7e corrected are not repeated.

`DOCS-ARCHITECTURE-DRAFT.md`:

- "The ask cannot fail open by absence." True. But `.authorize()` with no grants admits anyone (F1), so the ask can fail open by argument, and the sentence reads as a general guarantee.
- "the same approval presented twice is answered from the first time rather than run twice, including how the first time ended: completed, failed, or parked again further on." A duplicate during the first run, or after a mid-run death, carries no outcome at all (F18). Add "or not yet recorded".
- "Who is allowed to carry it on is decided when the approval arrives, from the identity that arrives with it, never from who parked it." The criterion applied is the route's own requester grants (F15), and any admission handler ahead of the gate sees the parked body before that decision is made (F4).
- "that identity is a record of who they were, not a credential." True of the principal object. The header set recorded beside it is whatever the ingress carried, credential-shaped strings included (F2).
- "It is reported when the application next starts." Only when the deferral plugin's own store is the selected one (F11), and only after new traffic has already started (F13).
- Section 5, "Install yours and declare that it replaces ours, and yours is the one everyone gets." Everyone except the boot report (F11).

`DIAGRAMS-MECHANISM.md`:

- Section 3, box I: "start() each plugin, sources subscribe." Sources subscribe before any start hook runs (`runtime.ts:334` then `349`); the box implies the reverse and the consequence is F13.
- Section 5, sequence diagram: "admission over the INGRESS before the record's state is disclosed; a refused resumer learns nothing and spends nothing." Learns whether the route exists (F5); and the other admission handlers learn the body (F4).
- Section 5, prose: "a holder that dies mid-run leaves residue that the deferral plugin reports when the application next starts." With the F11 and F13 qualifications.
- Section 1: "every edge not drawn is a build failure." It is a `verify` failure; nothing in the build runs the gate.

`DIAGRAMS.md`:

- "the test is building a plugin against a published tarball." A locally packed tarball. Nothing is published.
- Otherwise it promises nothing the code does not do; it is the one document I would leave alone.

`ARCHITECTURE.md`, post-7e section: "`codec.ts` is the shipped rule set" is false by seven rules (section 3, criterion 4). Ruling 12's "the admitted ingress headers are recorded on it through the persistence codec ... (a shape, never a credential ...)" is false of the header set (F2).

## 8. Verdict and bounded exit criteria

Ready for Jaco's hands-on review now: the installation half, rulings 5, 8, 9 and 11, the point policy, the exit decoration, the frames and the projection all hold under execution and under my mutants. Not ready for 7a and 7b to publish the continuation and door contracts as settled, and ruling 12 should not be confirmed as implemented until F2 and F3 are closed, because the shape being confirmed is the shape that persists a bearer and loses the resumer.

One bounded round, no redesign, in parallel with Jaco's review:

1. **Ruling 12's record.** Reduce the ingress to a reference at the door, chosen by the selected authority; write it into `markResumed`; add a secret rule to the codec. Demonstrate: a bearer-shaped ingress header never reaches the store, a failed continuation still records who resumed it, the process test's `resumedBy:bob:restored` line unchanged. Mutants: the reference not written on failure; the secret rule removed.
2. **The door.** Hand admission handlers a record view without the body and with `parkedAt`, `expiresAt` and the step's state descriptor; resolve the route after the door. Demonstrate F4 and F5 inverted. Decide and record whether the door applies the requester's grants to the resumer (F15) or an approver policy of its own.
3. **The codec.** Add the seven absent rules from `deferral/serialize.ts` or strike "the shipped rule set" from `ARCHITECTURE.md` and name the difference. Demonstrate F9 and F10 inverted with one test per rule and one mutant per rule; the five existing untested rules get the same.
4. **Deadline and defaults.** Re-check the deadline after the CAS; give `deferralPlugin` a default ttl. Demonstrate F6 and F14 inverted with a slow store, and a mutant that removes the recheck.
5. **Boot and stop.** Run the boot scan before sources subscribe, or record the inversion as a decision with its consequence; read the selected store in the boot report; give the sweep a pre-drain stopping signal or make it kernel-owned work. Demonstrate F11, F12 and F13 inverted, with sweep-level tests for paging past 100 orphans, purging and lease healing so the four surviving sweep mutants die.
6. **Frames.** State the contract for a defer under `runPath` and under a reordered branch: either `PathResult` gains `deferred` and the parent must halt, or a nested path may not defer; either `branch` must return a suffix or `Frame` addresses a list. Demonstrate F7 and F8 inverted.
7. **The harness.** Refuse a pattern that matches more than once; require at least one test to have run before reading the `(fail)` marker; add an unchanged-copy control. Then re-run the 75 and the 16.

## 9. Method notes for the standing rules

Three additions to section 10 of `ARCHITECTURE.md`, each earned here:

- **A survivor under a filter is not a survivor, and a kill under a full run is not a kill, until the unchanged copy has passed the same run.** My full-suite confirmation manufactured sixteen kills from one missing script. Rule 10 again, from the other side.
- **A mutant that only touches an import or a type is a no-op under Bun.** The transpiler elides it and the harness reports whatever the unmutated code does.
- **A pattern must match once.** Two shipped mutants are at the right site by file order. Assert the count.

The rule that generates the rest still holds: 81 green tests and 75 dead mutants, and fifteen more mutants that nothing noticed, on the mechanisms one layer below the ones the last review named.
