# Round six: independent execution review of the rebuilt proof of concept

**Reviewed:** `3b69bfda4bd1ac8901299061070805c23b99b806` (`spike/astra-round-five`).
**Round-five implementation measured by its own report:** `045c034d`.
**This round:** branch `validation/round-six`. No production package was changed.
No pull request was opened.

The round-five report is accurate. Everything it claims reproduced, its stated
limits are stated honestly, and its self-criticism is not decoration. This
review nevertheless found four defects it missed, one of which changes a
conclusion, and fixed all four with evidence.

## 1. Reproduction

`bun install` at the root, then from `spikes/plugin-architecture`:

| Reported | Reproduced |
|---|---|
| 32 tests, 0 fail | 32 pass, 0 fail, 137 expect() calls |
| 22 behavioral mutants killed | 22/22 |
| 10 compiler negative controls | 10/10 |
| Strict typecheck | clean |
| Import gate | `7 modules, 12 permitted import edges` |
| Packed external consumer | both assertions pass |
| `bun run demo` | exits 0, prints the route plan |

No discrepancy. The `verify` script covers typecheck, tests, mutations,
boundaries and type controls; `verify:packed` is not in that chain but
`test/round-two/packed.test.ts` runs it, so the acceptance count of 32 does
include it (28 contract tests + 3 process tests + 1 packed test).

**Historical tests are properly separated.** Round one's 63 tests included 20
that asserted defects. Those files are renamed `*.historical.ts`, remain
typechecked, and are excluded from `bun test test/round-two`. The counts are not
interchangeable and the report says so.

### The harness was checked before its results were believed

The mutation runner's value depends on two guards, and both are real:

- It throws `mutation no longer applies` if a mutant's pattern stops matching,
  so a stale mutant cannot silently become a no-op.
- It requires exit code non-zero **and** a literal `(fail)` marker, so a parse
  or import error is not counted as a kill.

I verified the second by executing it: replacing a mutant's replacement text
with `@@@ ((( unparseable` produces `SURVIVED or invalid mutation`, not
`KILLED`. The counts mean what they say.

The type-control harness is honest in both directions. A vacuous
`@ts-expect-error` would fail the baseline compile (unused directive), and each
marker is removed individually and required to produce a `TS` error.

## 2. Defects found

Found by mutating the implementation and observing that the round-five suite
still passed. All four are fixed in this branch.

### 2.1 A claimed continuation whose holder dies is stranded forever

**This is the finding that changes a conclusion.**

Round five's `ContinuationStore.claim()` moved the record from `waiting` to
`running` and deleted its `waiting/` index entry in the same transaction. A
process that died between `claim()` and `finish()` therefore left a record that
no later process could find or re-claim: `claim` refuses anything not `waiting`,
and the index no longer lists it.

Demonstrated by execution: claim, close the connection, reopen, and the waiting
index is empty while the record sits in `running` and refuses every further
claim.

Round five classified this as a stated scope limit, and the architecture update
adopted that wording: "Recovery from a crash after claiming a continuation is
not implemented." **The shipped framework already provides it.**

- `DeferralStore.releaseClaims(before: Date)` is part of the current store
  contract.
- `sweeper.ts` sets `DEFAULT_EXPIRY_LEASE = "60m"`, documented as "How long a
  delivery claim is honoured before it is released for redelivery ... The lease
  only matters after a crash".
- `types.ts` documents the claim as a second axis over a record that stays
  `waiting`: "a claim whose holder died is released by
  `DeferralStore.releaseClaims` once its lease elapses, so the next sweep
  redelivers".
- The cost is named there as well: "one duplicate escalation after the lease
  elapses, which is the accepted at-least-once trade".

A design that collapses the claim into a state transition cannot express this,
so it is not a deferred feature but a dropped one. By the rule that existing
guarantees cannot be discarded by calling them out of scope, this was a
migration blocker.

**Fixed** by adopting the shipped shape: `claimedAt` as a second axis, the
record staying `waiting` and discoverable, `finish` clearing the index, and
`releaseClaims(before)` on the port. Three mutants guard it: removing claim
exclusivity, ignoring the lease deadline, and reverting to the round-five
state-transition shape all now fail the suite.

### 2.2 Handler survival was never exercised

Every handler and contribution in all 32 tests used `allRuns`. Deleting the
`!h.survival[kind]` guard in `runtime.ts` passed 32/32.

This is not cosmetic. Survival is the mechanism deciding which handlers re-run
on a resumed continuation, and round five's own assumption 8 ("handler policies
on resume are current policy") is a claim about exactly this code path.

Wrapper survival at `runtime.ts:152` is a different path and **was** properly
load-bearing: the four first-party wrappers carry discriminating values, and two
independent mutations of that line were killed. The gap was handlers only.

**Fixed** with a handler declaring `resume: false`, asserted to run on first
delivery and to be absent from the resumed continuation.

### 2.3 Tag selectors were never exercised

The test helper hardcodes `tags: ["protected"]`, so both routes in the selector
test carry the tag. The tag branch could be deleted with the full suite green.
The `routeId` branch was genuinely tested, via the `other` route.

The ledger's "Assertions compare selected and unselected routes" is true for
route id and false for tag.

**Fixed** with a route that does not carry the tag.

### 2.4 The import gate was evadable three ways

Stage 1 of the proposed production sequence is "Enforce allowed imports in CI",
so the gate's own strength is load-bearing for the plan. Round five's version
had three holes, each confirmed by probe:

1. **Unlisted files were unchecked.** The gate iterated its allowlist, not the
   directory. A new `src/v2/sneaky.ts` importing anything passed. Three real
   files (`index.ts`, `demo.ts`, `types.check.ts`) were in fact ungated.
2. **Dynamic imports were invisible.** Only top-level statements were
   inspected, so `await import("./storage.ts")` inside a function body passed.
3. **Computed specifiers were invisible**, which would defeat the gate entirely.

**Fixed.** The allowlist is now closed over the directory in both directions (an
undeclared file and a declared-but-absent file both fail), the walk covers every
node including dynamic `import()`, `require()` and `import type` positions, and
a non-literal specifier is refused. Coverage rose from 7 modules and 12 edges to
10 and 21.

The disclaimer in `ARCHITECTURE.md` stands and is worth keeping: this gate is
evidence for these modules, not proof of a production boundary.

## 3. Stated limits: which are legitimate

Checked against shipped behaviour rather than accepted as written.

| Stated limit | Verdict |
|---|---|
| Recovery after a crash during a claimed resume | **Not legitimate.** Shipped today via claim lease and `releaseClaims`. Fixed above |
| Exactly-once external effects | **Legitimate.** `revive.ts` calls notification "at-least-once by design" |
| Suppressing arbitrary IO that ignores cancellation | **Legitimate.** `timeout-wrapper.ts` states "Side effects of the abandoned run still happen". The spike reproduces shipped behaviour, and `uncooperative.ts` is an honest probe |
| One distributed transaction across the session and deferral stores | **Legitimate.** The framework has none either. `@routecraft/ai` instead makes the agent thread idempotent per sequence number, rewriting losing defer signals so one exchange defers once per sequence number. That replay discipline is a feature-fit item, not a blocker |

## 4. Claims that held under attack

- **The restart is real.** Separate PIDs, `SIGKILL`, physically separate SQLite
  files, an append-only effect log, and `expect(resumed.pid).not.toBe(parked.pid)`.
  The prefix appears once, written by the first process. Completed work is not
  repeated, and the `resume repeats prefix` mutant is killed.
- **Plan mismatch is rejected before claiming**, verified by a separate child
  process run and by the `changed plan accepted` mutant.
- **CAS is genuinely concurrent.** Both children read the version before either
  can pass the barrier, and exactly one wins. The `ready-*` assertion is weak
  (it compares PIDs, not versions) but the setup makes the race real.
- **The crash-between-writes test is a real `SIGKILL`** delivered from inside
  the transaction after the first statement, with the reopened database showing
  neither row.
- **The packed consumer really is public-only.** A real `bun build` plus `tsc`
  declarations, `bun pm pack` into a tarball, and `bun install` from `file:` into
  a fresh temporary directory. No workspace aliases; only `bun-types` and
  `@types/node` are copied, which is type support. The private subpath is refused
  by the exports map, against the installed artifact, with the file confirmed
  present in the tarball first.
- **Application-scoped services hold.** `requireFor` checks the declaration and
  reads the owning host; removing the declaration check is killed. My attempt to
  show a cross-application leak failed because each application owns its own
  `Host` and its own value map, which is the correct shape.

## 5. Hygiene fixed in passing

- `bun run lint` failed at the repository root once the packed validation had
  run, because the generated `validation/round-two/package/` directory is
  gitignored and the flat ESLint config does not read `.gitignore`. The staged
  build now happens outside the repository, so nothing generated is linted.
  Committed hooks did not catch this because they lint staged files, and a
  gitignored artifact is never staged.
- `packed.ts` hardcoded the macOS paths `/private/tmp` and
  `/private/tmp/routecraft-bun-cache`, which on Linux creates `/private/tmp` at
  the filesystem root. Scratch space now stays under the platform temp
  directory.

## 6. Verification after this round

```text
36 pass, 0 fail, 154 expect() calls
27/27 runtime mutations killed by behavioral assertions
BOUNDARIES: 10 modules (all declared), 21 permitted import edges (0 dynamic)
10/10 compiler negative controls detected
PACKED: external branching DSL, open handler, source, facets, replacement, actual resume PASS
PACKED: private package subpath refused PASS
```

Strict typecheck clean, root ESLint and Prettier clean.

## 7. Readiness for the hands-on review

Ready, with the caveat that this is a contract proof and not a migration. The
seams round one omitted are present and defended by executable evidence, and the
one guarantee regression is closed. What a hands-on review should look at first
is the consumer-facing surface: the route builder in `src/v2/dsl.ts`, the four
operation categories and two retry scopes in `src/v2/operations.ts`, and the
route plan that `bun run demo` prints.

`src/v2/dsl.ts` and `src/v2/contracts.ts` carry no behavioral mutants, because
their content is type-level and structural. That is defensible but it means
their guarantees rest on the compiler controls rather than on execution, and the
DSL is precisely the surface a human should inspect.

## 8. Decisions still needed

1. **The claim lease is now a contract, so its policy needs a ruling.** The
   spike uses a caller-supplied instant and an explicit `releaseClaims(before)`;
   production must decide the default lease, who runs the sweep, and whether a
   released record is redelivered or escalated. The shipped defaults (60m lease,
   60s sweep, 72h TTL, 90d retention) are the obvious starting point.
2. **Tie-break identity.** Round five demonstrated that replacement under a new
   plugin ID changes an otherwise unconstrained lexical tie. Either ordering
   between security and resilience contributions becomes an explicit constraint,
   or the tie-break uses a contract-owned contribution identity independent of
   the provider. Round five flagged it and left the choice open.
3. **Named anchors or numeric slots**, still open from round five's assumption 2.
4. **Whether `#542` proceeds in parallel**, untouched by both rounds.

Nothing else here blocks the feature-fit stage.
