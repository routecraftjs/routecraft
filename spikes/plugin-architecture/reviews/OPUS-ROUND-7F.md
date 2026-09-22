# Round 7f clean-room review

**Verdict: the spike is ready for Jaco's hands-on review now, and needs one more bounded round before rounds 7a and 7b treat the resume door and the error-path park as settled, because the continuation never re-asks its route's own gate and the error-path park can re-run or lose committed work.**

Round 7f did what it said for most of the seven criteria, and every figure it recorded reproduces. The door it added has the shape `#818` shipped (two hooks, decided before disclosure and the claim, applied after), but the spike applies it to a continuation that skips the route's gate, so the property the whole step-up exists for, that the refused grant is supplied before the gated work runs, holds only when `elevate` is declared and succeeds (G1, G7). The error-path park copies the happy path of `#818` and none of its four refusals (G3, G4, G5, G11), nor its notify and ttl rules (G10, G12). None of this is a redesign. All of it is executable, and section 9 bounds it.

Reviewed head: `validation/round-six` at **`814748e44824f65e40c58930bfa73781b650180c`**, checked out and confirmed with `git rev-parse HEAD` before anything was read. Shipped reference: `packages/routecraft/src` at the same commit. `#818` reference: `feat/810-error-path-defer` at `ce0c38ee57f98ab8eae169525c40e8504f2d8fa5`. Evidence: `validation/round-seven-f-review/` on `validation/round-7f-opus`, with a README mapping every control, mutant and probe. Nothing under `src/v2/`, `test/round-two/` or `validation/round-two/` was changed. No pull request.

## 1. Reproduction

All figures measured on `814748e4`, Bun 1.3.11, after a root `bun install`, from `spikes/plugin-architecture`.

| Method | Recorded in `verification-round-seven-f.txt` (measured on `760736e6`) | Observed on `814748e4` |
|---|---|---|
| `bun run verify`, typecheck | pass | pass |
| its test stage | 99 pass, 0 fail, 424 expect() calls, 6 files | 99 pass, 0 fail, 424 expect() calls, 6 files |
| its mutation stage | CONTROL line, 121/121 killed | CONTROL line, 121/121 killed; the 121 names identical (`diff` of the KILLED lines is empty) |
| import gate | 12 modules, 27 edges, 0 dynamic | 12 modules, 27 edges, 0 dynamic |
| compiler controls | 15/15 | 15/15 |
| diagram check | 25 edges, 2 omitted | 25 edges, 2 omitted |
| `bun run verify:packed` | both PASS | both PASS, 3.2 s wall |
| `verify` exit | 0 | 0 |

`git diff 760736e6 814748e4 --stat` is the verification transcript alone, so the recorded figures are figures about this head.

**One discrepancy.** `ARCHITECTURE.md` says **97 tests** in three places (lines 70, 1028, 1035). The suite runs **99** (`bun test test/round-two`, both in the transcript and here). The mutation baseline runs 98, the packed consumer excluded by name.

## 2. The harness, checked before it was believed

`validation/round-seven-f-review/harness-controls.sh` runs `validation/round-two/mutations.ts` **unchanged** against disposable copies of the whole spike, with the mutant list replaced by a control (and, for C1, the copy's source broken). Measured on `814748e4`, 20 s wall:

| Control | Claim | Result |
|---|---|---|
| C1 a copy whose Date encoding is broken | the unchanged copy passes the whole suite first | **holds**: `unchanged copy does not pass`, nothing runs |
| C2 `return refused();` (three sites) | a pattern must match exactly once | **holds**: `mutation pattern is ambiguous (3 sites)` |
| C3 a pattern that is not in the file | a stale pattern is refused | **holds**: `mutation no longer applies` |
| C4 secret rule removed | positive control | KILLED |
| C5 parse error in `codec.ts` | a parse error is never a kill | **holds**: SURVIVED or invalid; Bun printed the parse errors. I did not time this control separately, so I do not know whether it hung until the kill timer as the 7e review observed |
| C6 `throw` at module load | a load error is never a kill | **holds** |
| C7 filter matching no test | a kill requires a test to have run | **holds**: `matched 0 tests`, not a kill |
| C8 synchronous infinite loop | a hang is never a kill | **holds**: not a kill (not timed separately; the runner bounds a filtered run at 8 s) |

All four stated claims hold by execution. One property to know: the runner reports a survivor and an invalid mutant in one bucket ("SURVIVED or invalid") and fails the run for both, which is the safe direction.

### Review mutants

`validation/round-seven-f-review/mutations.ts` runs thirty mutants of my own, each against the **whole** suite (packed consumer excluded by name) after the unchanged copy passes that same run (98 pass). Measured on `814748e4`, 31 s wall: **19 killed, 11 survived, 0 invalid.**

| Survivor | File | What it means |
|---|---|---|
| entry does not re-ask the gate of the lend | `auth.ts:318` | The documented property "the route's own gate is asked again and the lend has to satisfy it" has no test. G7 shows what happens when it fires: a silent spent approval |
| elevation's grant ring not compared | `auth.ts:280` | A door may re-mint the parked identity with **wider permanent grants** and pass; every "changes identity" test changes the subject or is killed earlier by authenticity |
| parked lent grants dropped from the bound | `auth.ts:271` | Re-lending what an earlier elevation already carried is untested |
| held elevation never released | `auth.ts:311` | The lifetime of the held elevation is untested; G6 is what that lifetime costs |
| error-ring park at a step drops the refusal | `runtime.ts:965` | A step-site park's bound is untested (and per G2 should not come from there at all) |
| nested failures carry a site | `runtime.ts:1233` | Under the mutant a parent that rethrows a nested failure parks at the **nested** step's position, outside its parent; nothing tests that a nested site never reaches a park |
| notify failure swallowed | `runtime.ts:927` | What a failing `notify` does is untested; G12 is the head's answer and it differs from `#818` |
| step state handed to every step | `runtime.ts:1099` | Step-state scoping to the parking step is untested |
| sweep ignores a stop between records | `runtime.ts:738` | F12's "ends between records when a stop begins" is untested |
| sweep ignores a stop between pages | `runtime.ts:734` | as above, at the page boundary |
| purge deletes waiting records | `storage.ts:326` | **Equivalent mutant, not a gap**: a waiting record has no `settledAt`, so the next clause skips it. Listed for completeness |

Ten real survivors. The 121/121 figure is true about the 121 mechanisms the list names; the stop half of F12, the grant-ring half of the identity rule, the entry re-check and notify failure are outside it.

## 3. The seven exit criteria of `FABLE-ROUND-7E.md`

Read against the calls: `runtime.ts` `resume` (511 to 701), `settle` (477 to 499), `runSweep` (717 to 776), `handlers` (795 to 875), `park` (881 to 931), `enter` (932 to 1044), `framesOf` (176 to 210), `pendingOf` (212 to 231); `auth.ts` door (242 to 296) and entry handler (298 to 328); `storage.ts` `durableStore` and `deferralPlugin`; `codec.ts`.

| # | Criterion | Status | By | What remains |
|---|---|---|---|---|
| 1 | Ruling 12's record: a reference at the door, written into `markResumed`, a secret rule | **Closed** | Test "F2, F3"; shipped mutant list plus my "door records the full principal" (killed), control C4 "secret rule removed" (killed) | Nothing for this criterion |
| 2 | The door: a bodiless view with `parkedAt`, `expiresAt` and the step's state descriptor; the route resolved after the door; F15 decided | **Partly** | Tests "F4, F5", "ruling 13"; my mutants "door handed the parked body", "route resolved before the door" (killed) | The view has no step-state descriptor or `meta` (shipped `DeferralRecordView.meta` is where a defer site's policy inputs travel). The view hands **every** admission handler the whole parked header set before the gate decides (`runtime.ts:539`), where `#818` gives its hooks the restored principal alone and no headers: the same over-disclosure F4 found for the body, one field over. F15 is decided as ruling 13, but the door it decides is not the one `#818` has (section 5) |
| 3 | The codec: seven rules, one test and one mutant each | **Partly** | Test "F9, F10"; my mutant "decode accumulates on an ordinary prototype" (killed) | The write side now matches shipped. The read side does not: shipped `decode` revives an **ordinary** prototype through `defineProperty` precisely because "a null-prototype body would break `instanceof Object` and `hasOwnProperty` call sites" (`serialize.ts`); the spike revives null-prototype objects (G13). `-0` is not normalised (G14). "Revives what shipped revives" (the F9, F10 test name) is false |
| 4 | Deadline re-check after the swap; a default ttl | **Partly** | Test "F6"; my mutants "post-swap deadline read from the pre-door clock", "post-swap expiry does not tell the route" (killed); "F14" test, "default ttl dropped" (killed) | The default applies only through `.defer()` and the facet. An error-path park and a hand-written defer outcome get none and are never swept (G10). Shipped and `#818` apply it in `deferExchange` to every park |
| 5 | Boot and stop: boot order, the selected store, a stopping signal for the sweep, sweep-level paging, orphans, purge, lease | **Partly** | Tests "F11", "F12" (two), "sweep as wired", "a scan that does not advance"; my mutants "boot report reads the plugin's own store", "error channel refused during the drain", "stall check removed" (killed) | Boot order: 7f is right (section 4). The sweep's stop between records and between pages survives two mutants. A resume in flight at the door is not owned work and outlives `stop()` (G9, G9b) |
| 6 | Frames: `runPath` and a reordered branch | **Closed for what it names** | Tests "F7", "F8"; my mutants "defer inside runPath parked", "frames never bounded" (killed) | The same class is open one construct over: a defer inside a **fan-out** is not refused (G5), and an error-path park inside one drops its siblings (G4). The criterion named `runPath` because shipped refuses a park inside a split; the spike's split is `fanOut` |
| 7 | The harness | **Closed** | Controls C1 to C8 | Nothing |

## 4. F13, adjudicated

**Round 7f is right, and the 7e review was wrong: shipped starts plugins, and so runs the deferral boot scan, after route sources are started.**

By the call, in `packages/routecraft/src/context.ts` at `814748e4`: `run()` emits `context:started`, starts every route (`route.start()`, which subscribes the source) inside `running`, then `await routes.ready` (every route has signalled `route:started` or the readiness bound fired), and only then `await this.startPlugins()`. The deferral plugin's `start` (`deferral/config.ts:343`) builds the sweeper and awaits `scanOnStart()`. So a shipped source is live and may emit before the boot scan runs, exactly as in the spike (`runtime.ts:378` subscribes, `394` activates). What shipped does guarantee is that `start()` and `whenStarted()` do not resolve until the scan completes, and the spike's `start()` does not resolve until `host.activate()` completes either.

The 7e review read the comment. `config.ts:354` says "what expired during the outage reaches its routes ahead of anything new arriving", and `sweeper.ts:268` says "An operator restarting after an outage gets the escalations before the new traffic". Both comments overpromise against `context.ts`. That is a shipped documentation defect outside this spike; it belongs in an issue against the main repository, not in the spike.

## 5. The door against `#818`

**Same contract where it is local to the door; not the same guarantee, because the continuation the door admits does not re-enter the gate.**

What matches, by the call (`auth.ts:252` to `295` against `#818` `revive.ts:199` to `230` and `authorize.ts`):

- `authorize` is a boolean over the live resumer, the restored parked principal, the raw payload and a bodiless record; declared, it is the whole policy.
- `elevate` returns a live principal; a restored or self-asserted one is refused; identity may not change; the lend is capped by what the park recorded as refused, and an absent bound refuses any lend.
- Both run before the lifecycle is disclosed and before the claim; the answer is applied after the claim. A refusal leaves the record waiting (asserted in "step-up").

Where it differs, and whether the difference loses a guarantee. The `#818` side of each row is read from its code and JSDoc at `ce0c38ee`, not executed; the spike side is executed by the probe named:

| Difference | Loses a guarantee? | Evidence |
|---|---|---|
| The continuation does not re-run the route's gate. Admission is skipped on a resume (`runtime.ts:980`) and the entry handler re-asks only when an elevation is held (`auth.ts:309`). `#818` parks a refusal at the route's admission site and the continuation re-runs `.authorize()` (`rehydrate` JSDoc: the elevated principal "is what lets the continuation re-run `.authorize()` and pass") | **Yes.** Without `elevate`, a step-up park resumed by anyone the door admits runs the gated route as the refused requester, holding nothing. With a declared `authorize` that admits a manager lacking the grant, nobody who holds `payout:write` was ever asked | G1 |
| An entry refusal after the claim is `refused`, not a failure: no error ring, no loop-closing rule | **Yes.** An insufficient lend spends the approval and tells nobody; `#818` routes it through the error handler and refuses a second park for the same scopes | G7; survivor "entry does not re-ask the gate of the lend" |
| The bound is `failure.detail.refused` from **any** refusing admission handler or any thrown `Fault` (`runtime.ts:965`, `975`; `fault()` preserves the instance). `#818` reads it only from the framework's insufficient-authority error | **Yes.** A rate limiter or a step authors what the door may lend | G2 |
| The held elevation lives in a plugin-level `Map` keyed by record id (`auth.ts:228`), not in the resume call | **Yes.** A concurrent loser's lend is applied to the winner's run while the record names the winner; stale entries are never released on any path that stops before entry | G6; survivor "held elevation never released" |
| Hooks are not bounded and their failures are not one refusal | **Yes.** A throw rejects with the hook's own message (an oracle, which `runAuthorizer` exists to prevent); an unsettled hook outlives `stop()` and can run the continuation on a stopped application | G8, G9, G9b |
| One grant ring and one lent ring, rather than subject and actor rings | **No, in the spike.** The spike's gate always reads `grants ∪ lent`, and grants must be identical, so no scope can move between rings. Production carries the per-ring count, and the identity comparison must be structural by exclusion as `comparableIdentity` is, not two named fields | survivor "elevation's grant ring not compared" shows even the two fields are half-tested |
| The door sits on the deferred route, not on an ingress route | **Partly.** Lost: token verification and call binding ahead of the hook (ledger items); the ingress route's own abort signal as the hooks' bound (G9); and more than one door per deferred route (an approval by chat and by web with different policies is expressible in `#818`, not here). Gained nothing | G9; reading |
| The bound read from a refusal recorded at the park | **No**, as a model; the loss is the provenance above | G2 |

**The ordering claim** ("decided before disclosure and the claim, applied after") holds at the door: the shipped mutant "lifecycle disclosed before the door" and mine "route resolved before the door" are killed. **What a refused elevation leaves behind**: nothing in the store (asserted), and nothing in the map, because the entry is set only after every check passes. What an **accepted** elevation leaves behind when the resume stops before entry (duplicate, claimed, expired, changed plan, lost swap, a later admission handler refusing) is a map entry for the life of the process; G6 is its one observable consequence.

## 6. Guarantee probes

Fifteen probes in `validation/round-seven-f-review/probes.test.ts`, all characterisations: green on `814748e4` (15 pass, 43 expect() calls), so every assertion is a reproduced fact. By area:

**Resume path order and disclosure.** F4 and F5 hold for the body and the route. The parked header set still reaches every admission handler before the gate decides (section 3, criterion 2). G8: a hook that returns `false` yields `{ status: "refused" }`, a hook that throws rejects `resume` with `ldap://10.0.0.7 unreachable` in the message. G9: a hook awaiting a latch holds `resume` across `stop()`; when the latch opens the resume proceeds to the swap and fails with `MARK_RESUMED: Cannot use a closed database`, not `NOT_RUNNING`. G9b: with a vendor store that is not closed at dispose, the same late door **wins the swap and runs the suffix after `stop()` resolved**; the record is `resumed`. `resume` checks `#accept` once (`runtime.ts:512`), before the door, and only the post-claim run is owned work (`647`).

**The error-path park.**
- *Site*: a failure raised inside a step parks at that step and re-enters it (7f's test holds). A failure with **no** step site parks the whole route from its first step (`runtime.ts:967`): G3 shows a route-scope timeout that fires while the route waits on a tracked stream, and an exit handler that throws after the route completed; each resume re-runs the committed `charge` step. `#818` refuses both with `RC5051` for exactly this reason. (A route timeout that fires *inside* a step is parked at that step, because `abortable` lets the step's catch stamp the site on the shared `Fault`; that case is right, by a side effect.)
- *Fan-out*: G4, a failure in the second of three children parks that child, the route reports `deferred` with **no** exchanges, the first child's completion is gone from the result, and the third child never runs and is not parked. G5, a `.defer()` after a fan-out whose children keep the parent id parks the first child and then fails the route with `DUPLICATE_DEFERRAL`, leaving a live record behind a failed run.
- *The bound*: G2.
- *Notify ordering*: told after the durable write and before the event, as documented (7f's step-up test, and my two ordering mutants killed). A notify that **throws** leaves the record waiting and resumable while the caller is told `NOTIFY` (G12); `#818` denies the record claim-first so the link is dead.
- *Cancellation*: G11, a run whose caller aborted mid-step is parked from the error ring and leaves a live link. `#818` refuses with `RC5054` before the write and denies a record whose write raced the abort.
- *Nested*: a defer under `runPath` is refused (F7). A nested failure's site does not reach the park today, but the survivor "nested failures carry a site" says nothing tests it.

**Expiry and denial.** The post-swap re-check records a failed outcome and tells the route once (killed mutants). Denial on a changed plan claims, re-asks and denies (shipped mutants). G10: error-path parks and hand-written defer outcomes have no `expiresAt` under the default plugin.

**Boot scan and sweep.** Paging past the first page, past more than a page of orphans, purge and lease healing are tested as wired (7f's "sweep as wired"), and `SCAN_STALLED` is killed. The stop between records and between pages is not tested (two survivors). The reference store's `findExpired` still reads every waiting index entry per page (`storage.ts:250` to `270`); the memory and time bound is in the port, not in the store.

**The codec.** G13 and G14 above; everything the 7e review listed on the write side is present and tested.

**The tail hash.** Frames with `to` and recursive projection hold under the F8 test and the killed "frames never bounded" mutant. Frames are positional, so inserting a step or a sibling **before** a frame's `from` changes what it addresses and the hash refuses the approval destructively; shipped is positional too ("changed after position N"), so this is parity, not a regression.

**Point policy, exit decoration, duplicates.** I found nothing new; the 7e review's findings hold and F18 is documented.

## 7. The stated limits, challenged

"What this round did not do" lists four items. Existing guarantees cannot be discarded by calling them out of scope, so each is checked against what shipped or `#818` already guarantees.

- **Signed resume tokens and payload validation, "ledger items".** Acceptable as sequencing, not as optional. Shipped refuses any resume without a token the context signed (`RC5041`) and binds a credential to its call (`RC5055`). Today a spike route with no `.authorize()` grants and no `.resumable` admits an anonymous resume by id alone, since the default door has nothing to ask. The ledger must carry these as **migration blockers**, per section 1's own rule.
- **`list` and the action fingerprint, companion ports.** Agreed.
- **`whenStarted` and `context:stopping` are ledger items; "the sweep's own stop is now correct without them".** The stop is untested (two survivors), and the resume door is not covered by it at all (G9b). "Correct" is not established.
- **Subject and actor rings not in the principal.** Agreed as scoped (section 5).

**Not listed, and not out of scope by any ruling**, each a guarantee `#818` or shipped provides: the gate on the continuation (G1, G7), the provenance of the bound (G2), the four refusals of an error-path park (G3, G4 and G5, G11), notify failure denying the record (G12), the default ttl on every park (G10), hooks bounded by a signal and failing as one refusal (G8, G9), the elevation held per call (G6), the ordinary prototype on revival (G13), and more than one door per deferred route (section 5).

## 8. The public documents, read as a consumer

Every sentence below overpromises against the code at `814748e4`.

`DOCS-ARCHITECTURE-DRAFT.md`:

- Section 6: "A wait inside a fan-out cannot park, because nothing could revive the parent that is still waiting on it; the attempt is refused before anything is written." False for a fan-out (G5); true only for `runPath`.
- Section 6: "An error handler ... may answer a failure by parking the exchange where it failed". A failure with no step site is parked at the top and the resume re-runs committed steps (G3); a failure inside a fan-out drops the siblings (G4).
- Section 6: "the same door may lend the parked identity exactly the grants it was refused, and no more ... the run then passes the gate that refused it, and the record says who lent." The bound is whatever a failure's detail says (G2); without `elevate` the run passes no gate at all (G1); and the lend applied may be another resumer's while the record names the winner (G6).
- Section 6: "The door decides before it learns anything about the record". It is handed the parked headers, the site, the times and the refusal; what it does not learn is the lifecycle state and the body.
- Section 6: "so the approver's authority does not become the run's authority." True, and misleading beside G1: the requester's lack of authority does not stop the run either.
- Section 7: "An authorisation check applies to a first delivery and to the door of a resume". And not to the continuation (G1), which is what a reader will assume "applies to a resume" means. "a refusal leaves the approval usable by its rightful holder": true at the door, false for a refusal at entry after a lend (G7).

`DIAGRAMS-MECHANISM.md`:

- Section 4 flowchart: `fault --> error handlers --> exit handlers --> completed`. A fault never runs exit handlers and never completes (`enter`'s catch rethrows after the error ring); the error ring's **defer** branch, the one this round added, is not drawn.
- Section 4 flowchart: "branch: run declared children, isolated nested path". A branch splices its children into the same loop (`runtime.ts:1186`); the isolated nested path is `runPath`.
- Section 5 sequence: "run the SUFFIX only". Not for a site-less error-path park, which runs from the first step (G3).

`DIAGRAMS.md`:

- "The kernel keeps only two jobs: run the lifecycle ... and define the contracts. It has no opinion about retries, storage, agents or HTTP". The kernel also owns the continuation protocol: park, the tail hash, the codec, the claim, the sweep, the refusal bound's plumbing (`runtime.ts`). The docs draft states this as its "one honest exception"; the overview does not.

`ARCHITECTURE.md`, post-7f section:

- "97 tests" in three places: 99.
- "Without `elevate` the continuation runs as the restored parked principal and any downstream gate refuses it." True downstream; the route's own gate is not asked (G1).
- "the answer is held at the door and applied at entry of the run the claim let through". Applied to whichever run reaches entry for that id first (G6).
- F7 "as shipped refuses a park inside a split": the spike does not refuse one inside its split (G5).
- F9, F10 "null-prototype accumulation both ways": shipped accumulates on a null prototype on the way **in** only (G13).
- F12 "it ends between records when a stop begins": untested (two survivors).
- F14 "applies it wherever `.defer()` or the facet names none": literally true, and every other park has none (G10).

## 9. Verdict and bounded exit criteria

**Ready for Jaco's hands-on review now.** The installation half, rulings 5, 8, 9 and 11, the point policy, exit decoration, frames, projection, the record reference (ruling 12's record), the swap-side deadline and the harness all hold under execution and under my mutants. Nothing found here changes the direction.

**Not ready for 7a and 7b to treat the door and the error-path park as settled contracts.** Whether a continuation re-enters its route's gate decides what `elevate` means, which failures may park, and what the loop-closing rule has to guard; that is contract shape, and the ledger would otherwise record the spike's shape as the target. One bounded round, no redesign, in parallel with Jaco's review:

1. **The gate on the continuation.** A resume re-asks the route's own gate of the principal the continuation carries, restored or lent, and a refusal there is a failure that reaches the error ring, with `#818`'s loop-closing rule refusing a second park for grants already lent. Demonstrate G1 and G7 inverted; kill "entry does not re-ask the gate of the lend"; add a mutant removing the loop rule.
2. **The bound's provenance.** Only the enforcement port's own refusal records a bound, by a brand the auth plugin mints, not `detail` from any handler or `Fault`. Demonstrate G2 inverted, with a mutant that accepts an unbranded detail.
3. **The elevation's lifetime.** Held per resume call (for example returned through the door's record channel and applied by the kernel), never in a plugin map. Demonstrate G6 inverted; kill "held elevation never released" or make it moot; kill "elevation's grant ring not compared" with a grant-widening re-mint.
4. **The error-path park's refusals.** Refuse, before any write: a site-less failure after admission (G3), a park or defer inside a fan-out (G4, G5), a park on a cancelled run (G11). Deny the record when `notify` throws or never settles (G12). Apply the default ttl in the runtime or store to every park, not in the DSL (G10). One test and one mutant each; kill "nested failures carry a site" and "notify failure swallowed".
5. **The hooks.** One refusal for false, throw and abort; bounded by the ingress signal; the resume path owned work from its first await, re-checking that the runtime still accepts after the door. Give the view the restored principal (or a reference) rather than the parked header set, and a `meta` slot. Demonstrate G8, G9 and G9b inverted.
6. **The codec's read side.** Revive an ordinary prototype through `defineProperty` and normalise `-0`, as shipped does, or strike "revives what shipped revives" and name the difference. Demonstrate G13 and G14 inverted.
7. **The sweep's stop.** Tests that kill both "sweep ignores a stop" survivors, and "step state handed to every step".
8. **The documents.** Every sentence in section 8 corrected, the test count included.

Out of this round, into the 7a and 7b ledger as migration blockers rather than options: signed tokens and call binding, payload validation, more than one door per deferred route, per-ring lend counting with a structural identity comparison, and an issue against the main repository for the two shipped comments section 4 names.

## 10. Assumptions and method notes

- **The brief arrived without a human on the channel.** Every decision it left open was mine: shipped means `packages/routecraft/src` at `814748e4`; `#818` means `ce0c38ee`; a probe asserts what the head does and names the reference it departs from; "no em-dashes" applies to the evidence files too.
- **One method per figure.** Test and pass counts come from the `bun test` summary line; mutant tallies from each runner's own classification; wall times from `time`. The 98 in section 2 is the mutation baseline with the packed consumer excluded; the 99 in section 1 is the suite.
- **A pattern must match once, and a survivor is judged against the whole suite.** Both runners enforce the first; mine enforces the second, and one of its survivors turned out equivalent on reading (`purge deletes waiting records`). A survivor proves a test is missing only after its reading says the mutant changes behaviour.
- **A comment in shipped code is a claim too.** F13 was decided by `context.ts`, against two shipped comments that say otherwise.
