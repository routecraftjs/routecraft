# Round 7e clean-room review: executable evidence

Evidence for `reviews/FABLE-ROUND-7E.md`. Everything here was measured on
`validation/round-six` at `63cfcda694f68b891cbccb59ef262cf71a43b1c2` with
Bun 1.3.11 after a root `bun install`. Nothing under `src/v2/`,
`test/round-two/` or `validation/round-two/` was changed.

Run everything from `spikes/plugin-architecture`:

```bash
bun test validation/round-seven-e-review/probes.test.ts   # 18 characterisations
bun run validation/round-seven-e-review/harness.ts        # controls on the mutation harness
bun run validation/round-seven-e-review/mutations.ts      # 16 review mutants, survivors reported
```

## Files

| File | What it is |
|---|---|
| `runner.ts` | The round-two mutation discipline factored out: the same pattern builder, a disposable copy, one filtered run per mutant, and a three-way verdict (killed, survived, invalid). A run whose output has no per-test `(fail)` marker is never a kill |
| `harness.ts` | Three controls on the harness by execution, plus an ambiguity report over the shipped mutant list |
| `mutants.ts` | Sixteen mutants aimed at mechanisms the shipped list does not touch |
| `mutations.ts` | Runs them against the head's own suite. A survivor under its filter is re-run against the whole suite before it is called a survivor, and the unchanged copy must pass that whole suite first |
| `probes.test.ts` | Eighteen characterisation tests, F1 to F18. Each asserts what the code does at this head, so the file is green here and every assertion is evidence. Which ones describe a defect is stated below and in the report |

## Harness controls (`harness.ts`)

| Control | Observed |
|---|---|
| Parse error in `codec.ts` | `bun test` hangs; the 8 second kill timer fires; no `(fail)` marker; verdict INVALID. Took 8009 ms |
| Import of a missing export | Exit 1, summary says `4 fail`, no `(fail)` marker; verdict INVALID in 64 ms |
| Pattern that no longer matches | Throws `mutation no longer applies` before any run |
| Ambiguous patterns in `validation/round-two/mutants.ts` | 2 of 75: "lifecycle disclosed before the door" and "a refused resume spends the approval" match twice in `runtime.ts` (the resume door at line 489 and the entry door at lines 741 and 742). `String.replace` edits the first, which is the intended one today by file order only |

Two things learned while building the controls, both recorded because they
change how a figure should be read:

- The first version of the missing-export control used an import that
  nothing referenced. Bun's transpiler elided it, the suite passed, and the
  harness reported SURVIVED. A mutant that touches only an import or a type
  position is a no-op under Bun and must not be counted either way.
- The first full-suite confirmation in `mutations.ts` reported sixteen kills.
  Every one was `packed.test.ts` failing because the disposable copy carries
  no `validation/round-two/packed.ts`, which is also true of the shipped
  runner's copy. The unchanged-copy control now runs first and that test is
  excluded from the confirmation by name. The shipped runner never runs the
  whole suite, so it never met this; its per-mutant filter is what protects
  it.

## Review mutants (`mutations.ts`)

Measured on `63cfcda6`. Filter is the shipped discipline; "full suite" is the
whole of `test/round-two` minus the packed consumer test.

| Mutant | Filtered | Full suite |
|---|---|---|
| sweep processes only the first page | survived | survived |
| orphan does not advance the scan cursor | survived | survived |
| expiry scan page is unordered | killed by "findExpired excludes claimed records and pages by keyset cursor" | |
| sweep never purges settled records | survived | survived |
| sweep releases live claims, ignoring the lease | survived | survived |
| settle reports expiry even when a concurrent resume won | survived | survived |
| claimed record proceeds down the resume path | survived | survived |
| lent grants are not honoured by the gate | survived | survived |
| codec accepts a non-finite number | survived | survived |
| codec drops a symbol value silently | survived | survived |
| codec accepts the reserved date envelope as data | survived | survived |
| codec revives a corrupt date envelope as an invalid Date | survived | survived |
| codec cycle check removed | survived | survived |
| duplicate route id accepted at compile | survived | survived |
| resumedAt header dropped from the continuation | survived | survived |
| boot report bounds stranded ids to one | survived | survived |

1 killed, 15 survived, 0 invalid of 16. What each survivor means is in the
report, section 2.

## Probes (`probes.test.ts`)

| Probe | What it characterises | Defect against shipped behaviour? |
|---|---|---|
| F1 | `.authorize()` with no grants admits an anonymous exchange | Yes: `auth/authorize.ts` throws `RC5012` with no principal whatever the criteria |
| F2 | The resumer's whole header set, a bearer-shaped header and the full grant list included, is written to the store under `routecraft.deferral.ingress` and replayed to a later duplicate caller | Yes: shipped records a `PrincipalRef` (`deferral/principal-ref.ts`) and refuses `BRAND.Secret` at the codec (`serialize.ts:195`) |
| F3 | A failed continuation leaves no record of who resumed it | Yes: shipped `markResumed(id, { at, by })` writes the resumer into the record before the run |
| F4 | An admission handler ordered ahead of the gate reads the parked body of a resume the gate then refuses | Yes: shipped `DeferralRecordView` carries no body for exactly this reason (`deferral/authorize.ts:12`) |
| F5 | A resume of an orphaned record throws `UNKNOWN_ROUTE` before any admission handler runs | Yes: shipped resolves the route after the door (`revive.ts:210`) |
| F6 | A resume whose `markResumed` write is slow runs the continuation after the deadline | Yes: shipped re-checks the deadline after winning the CAS (`revive.ts:351`) |
| F7 | A defer inside `runPath` completes the outer route, drops the deferral id from the result, and leaves a resumable record | Spike defect: `PathResult` cannot say "deferred" |
| F8 | A branch returning its declared children out of order cannot defer (`UNSTRUCTURED_PENDING`) | Spike contract contradiction: `branch` admits any declared subset, `Frame` needs a suffix |
| F9 | An own `__proto__` key, a symbol-keyed property, a non-enumerable property, a named array property and a Date's extra property are all lost in silence | Yes: `serialize.ts` refuses each by path |
| F10 | A corrupt stored date envelope resumes as a plain object | Yes: shipped `decode` throws `RC5042` |
| F11 | With `CONTINUATIONS` replaced, the boot event reports the stranded and pending figures of a store nothing uses | Spike defect in `deferralPlugin.start` |
| F12 | `stop()` during a sweep abandons the retirement after the claim: the sweep rejects `NOT_RUNNING`, the record stays claimed, the approver is not told | Yes: shipped awaits the pass and gates it on `context:stopping` (`sweeper.ts:106`, `sweeper.ts:359`) |
| F13 | A source delivers before the boot scan has retired what came due while the process was down | Yes: shipped awaits `scanOnStart()` before anything new arrives (`config.ts:356`) |
| F14 | A defer without a ttl never comes due | Yes: shipped defaults to 72 hours (`sweeper.ts:33`, `config.ts:208`) |
| F15 | The door applies the deferred route's own `.authorize()` grants to the resumer | Design difference: shipped separates the door policy from the route's requester policy |
| F16 | A record under another codec version is denied and its route nagged on first contact | Observation: destructive where a refusal would do |
| F17 | One sweep retires a 150 record backlog across two pages | No defect; this is the test the first review mutant needed |
| F18 | A duplicate arriving while the first resume is running carries no outcome | Observation: "still running" and "died mid-run" are indistinguishable to the caller |
