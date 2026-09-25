# Routecraft plugin architecture

**Single source of truth.** Rendered artifact: https://claude.ai/artifact/QURVh6GhDVSREgCuzP1spb

Everything else in this folder is either input to
this document or code that tests it. Where a published artifact and this file
disagree, this file wins: the artifact is a rendering of it.

**Status: round 7g complete (the clean-room review of round 7f closed);
production migration not yet approved.** The direction is supported, subject to Jaco's
hands-on review, feature-fit checks and an accepted implementation plan. POC
implementation is not production implementation approval.

**Post-round-five update (2026-09-20).** This update incorporates Jaco's
clarification about plugin-author responsibility and mechanically enforced
internal boundaries. It was made against `ab29c2e86c9f`; the round-five report
records the implementation commit on which its execution evidence was measured.
The four-voice tables below preserve the earlier consolidation; the explicit
post-round-five positions in this file supersede their older status and scope.

Every substantive claim carries four voices, in this order:

| Voice | Who | What it is |
|---|---|---|
| **Assumed** | Claude Opus (this session, with Jaco) | What the original design asserted |
| **Opus** | Clean-room Claude Opus 5 | First independent validation, no session context |
| **Astra** | ChatGPT (Astra) | Second independent validation, no session context, no sight of the first |
| **Now** | Claude Opus, after re-running both | The current position, and what to act on |

**Read "Now" if you read nothing else.** The first three are kept because the
corrections are more instructive than the conclusions, and because a reader who
only sees the answer cannot tell how much to trust it.

## Provenance and honesty note

The original design was written by an LLM working with Jaco. Two independent
agents then checked it against the code. Between them they refuted or corrected
**more than twenty** of its factual claims and **overturned its central
technical conclusion**. Both agents published reproducible commands and
committed code; both were themselves re-checked before anything here was
accepted, and each was wrong about at least one thing.

The thesis survived. The arithmetic and one language claim did not. That
asymmetry is the most useful thing in this document.

- **Opus validation:** `reviews/OPUS-VALIDATION.md`, branch `validation/clean-room`
- **Astra validation:** `reviews/ASTRA-VALIDATION.md`, branch `validation/astra`
- **Round-five implementation and report:** `src/v2/`, `test/round-two/`,
  `validation/round-two/`, and `reviews/ASTRA-ROUND-FIVE.md`, on
  `spike/astra-round-five`. Reported evidence: 32 tests, 22 behavioral mutants
  killed, 10 compiler negative controls, strict typecheck, and a separately
  packed consumer. Round six reproduced all of these and raised the suite to
  36 tests and 27 mutants (`reviews/OPUS-ROUND-SIX.md`). Round seven, a
  clean-room Fable 5.1 review (`reviews/FABLE-REVIEW.md`), reproduced round
  six, then showed its headline correction was a misreading of the shipped
  contract and found eight guarantee regressions. The corrections that
  followed bring the suite to 53 tests and 45 mutants over 11 modules.
  Astra then reviewed those corrections (`reviews/ASTRA-ROUND-SEVEN.md`,
  evidence on `validation/round-six-astra`), reproduced every figure, and
  showed with eighteen probes and seven mutants that three of them were
  incomplete: the authorization gate never consulted the authority it
  required, the tail hash compared the stored step list rather than the live
  one, and the refusal policy for a plugin-declared point existed only in the
  type. Round 7e closes its five exit criteria: 81 tests, 75 mutants, 15
  compiler controls over 12 modules. A clean-room review of that round
  (`reviews/FABLE-ROUND-7E.md`) reproduced it and found the record shape
  under ruling 12 wrong in both directions, the door over-informed, the codec
  seven rules short and the sweep untested as wired; round 7f closes it and
  adds the `#818` door: 99 tests, 121 mutants. A clean-room review of that
  round (`reviews/OPUS-ROUND-7F.md`) found the door admitting a continuation
  that skipped the route's own gate, the error-path park copying `#818`'s
  happy path and none of its refusals, and the elevation held in a plugin
  map; round 7g closes it: 111 tests, 141 mutants. Astra's open-ended
  design review of that head (`reviews/ASTRA-ROUND-7G.md`) keeps the
  architecture and refuses to freeze the continuation contracts: fourteen
  findings, sixteen reproductions, all reproduced here. See post-round-7g,
  the Astra review.
- **Documentation of the direction:** `docs/direction/` is the user-facing
  account, end to end, with figures drawn in the docs site's own figure
  system and every behavioural claim labelled demonstrated, intended or a
  migration decision. It supersedes the earlier `DIAGRAMS.md` and
  `DOCS-ARCHITECTURE-DRAFT.md`. `DIAGRAMS-MECHANISM.md` is one level down, for
  an editor of the proof of concept, and its module graph is checked against
  the source by `bun run verify:diagram`.
- **Historical round-one evidence:** 63 passing tests included defect
  characterizations. Historical test files remain available but are excluded
  from the new default acceptance run. Counts from different rounds are not
  interchangeable.

---

## 1. The plan

Production work starts at step 9, after the plan from step 8 is accepted.
POCs are built earlier. Models are named because they are not
interchangeable here: each round exists to catch what the previous one could
not see.

| # | Round | Who | Output |
|---|---|---|---|
| 1 | Original design and first spike | Claude Opus 5 (this session) | ✅ Done. 31 tests. Wrong in ways rounds 2 and 3 found. |
| 2 | Clean-room validation | Claude Opus 5, fresh session | ✅ Done. 16 figures refuted, 4 POC defects, encoding E. |
| 3 | Clean-room validation | ChatGPT Astra | ✅ Done. 20 POC defects, `StepOutcome` finding, 5 alternatives. |
| 4 | Consolidation | Claude Opus 5 (this session) | ✅ This document. |
| 5 | POC round two | ChatGPT Astra | Built on `spike/astra-round-five`; report and executable evidence checked in. Awaiting independent verification. |
| 6 | Review of round 5 | Claude Opus 5 (this session) | ✅ Done. All round-five numbers reproduced; 4 defects found by mutation. Its headline reclassification of the claim lease was itself wrong, which round 7 found. |
| 7 | Clean-room review of round 6 | Fable 5.1, fresh session | ✅ Done. Everything reproduced; round six's claim-lease correction refuted against `revive.ts`; eight guarantee regressions, thirteen surviving mutants, the encoding measured at 20 and 40 plugins. Verdict: proceed on the kernel half, send the continuation half back. |
| 7c | Corrections | Fable 5.1 (this session, model switched) | ✅ Done. Shipped continuation shape adopted, identity moved out of core, per-step clone dropped, every surviving mutant killed. Commit `2f5812f8`. |
| 7d | Rulings 5, 8, 9, 10, 11 | Jaco, with code shown for each | ✅ Done. Principal out of core confirmed and the fail-open ask closed; facets kept and the standard's amendment drafted; strings owner-qualified; routes-file shape deferred to 7a/7b; refusal policy encoded in the type. Commit `ede7ea66`. |
| 7e | Contract review of 7c and 7d, then the bounded round | ChatGPT Astra (review), Fable 5.1 (this session, corrections) | ✅ Done. Astra reproduced `d6823df6`, then showed the authorization fix still failed open, the tail hash compared the wrong list, and the point policy was type-only, with five exit criteria. All five closed: see post-round-7e. |
| 7e review | Clean-room review of round 7e | Fable 5.1, fresh session | ✅ Done. Reproduced `63cfcda6` to the figure; eighteen probes and sixteen mutants (fifteen surviving) showed ruling 12's record persisted too much and too little, the door saw the parked body, the codec was seven rules short, and the sweep as wired was untested. Seven bounded exit criteria. `reviews/FABLE-ROUND-7E.md`. |
| 7f | The review's seven criteria and the `#818` door | Fable 5.1 (this session) | ✅ Done. Every finding closed or disputed by name; the two-hook door (`authorize`, `elevate`) and the error-path park added, so the step-up flow `#818` describes runs end to end in the spike. See post-round-7f. |
| 7f review | Clean-room review of round 7f | Claude Opus 5.5, fresh session | ✅ Done. Reproduced `814748e4` to the figure; F13 adjudicated for 7f against the shipped comments; fourteen probes and thirty mutants (eleven surviving) showed the continuation never re-asked its gate, the bound came from any refusal, the error-path park had none of `#818`'s refusals, and the elevation was held in a plugin map. Eight bounded exit criteria. `reviews/OPUS-ROUND-7F.md`. |
| 7g | The 7f review's eight criteria | Fable 5.1 (this session) | ✅ Done. Every finding closed by name, two kept as stated differences. See post-round-7g. |
| 7g review | Open-ended design review of round 7g | Astra, fresh session | ✅ Done. Reproduced `85f7506a` to the figure. Verdict: keep the architecture, proceed with feature fit, do not freeze the continuation contracts or migrate this executor. Fourteen findings (R1 to R14), sixteen executable reproductions, every one reproduced here. `reviews/ASTRA-ROUND-7G.md`; evidence `validation/round-seven-g-review/` on `validation/round-7g-astra` at `de98d680`. |
| Docs review | The direction docs read as a consumer, then the direction | Claude Opus 5.5, fresh session | ✅ Done. The docs explain the parts clearly and never showed how they meet at runtime; it drew the internals figure (`figures/inside.tsx`, placed in `02-anatomy.md`) and corrected seven statements and four figures against the proof of concept, with ten probes. Its three first changes, all for 0.8: name `execution` as a sixth socket and make it declared (any plugin can resume a route with no door, probe D5); anchor every first-party handler at a kernel point, starting with the gate (unanchored handlers run in owner-name order, probe D10); define the published surface and test equal reach against it only. `reviews/OPUS-DIRECTION-DOCS.md`. |
| 7a | Feature fit, clean room | Claude Opus 5, fresh session | Walk the real framework feature by feature: what fits the model, what does not. |
| 7b | Feature fit, clean room | ChatGPT Astra | Same brief, independently, from its own round-3 work plus round 6. |
| 8 | Implementation planning | Fable 5.1 | Given everything: decide sequencing, pull-request shape, and whether to fan out to sub-agents. **Fable decides how, not whether.** |
| 9 | Build | Fable 5.1 + sub-agents | Only after 8 produces a plan Jaco accepts. |

**Jaco reviews the POC by hand after 7c**, and his feedback is addressed
before the feature-fit rounds begin. Rounds 7a and 7b keep their numbers; they
follow his review.

**Two rounds are deliberately duplicated** (2 and 3; 7a and 7b) because
independent coverage can expose omissions. Agreement is supporting evidence,
not certification: independently reproduced behavior against the real framework
is stronger evidence than model agreement.

### Post-round-five scope and stopping conditions

**Objective.** Preserve route behavior and the fluent route DSL, enforce internal
module boundaries, and move first-party capabilities behind the same supported
contracts available to external plugins. AI-written changes make locality,
reviewability and executable dependency rules central requirements. Third-party
parity is also a test that the boundaries are real; it is not a requirement to
make arbitrary third-party behavior safe.

Internal modularity alone does not justify a consumer-facing DSL change. Breaking
changes need a specific benefit such as clearer naming, consistent semantics,
better inference or removal of duplication. Default installation may remain
convenient while its components become replaceable. Pure libraries need not
become lifecycle plugins.

The remaining review stages have bounded outputs:

- **Round 6:** independently execute the rebuilt POC, inspect assertions and
  mutation controls, and separate contract defects from stated guarantee limits.
  Fix demonstrated blockers; do not restart a general design exercise.
- **Jaco's review:** inspect representative routes and configuration; resolve
  consumer-facing tradeoffs before feature-fit work.
- **Rounds 7a/7b:** independently produce a feature migration ledger. For each
  real framework capability, record current behavior, proposed owner, required
  public contracts, a compatibility fixture and unresolved gaps. Reopen the
  architecture only for demonstrated gaps.
- **Round 8:** turn that ledger into mergeable tickets with bounded ownership,
  allowed dependencies, preserved behavior and concrete acceptance checks. No
  production build starts until Jaco accepts this plan.

### Production migration sequence proposed for planning

This supersedes the old sequence in `docs/DESIGN.md`. It is the planning baseline,
not permission to edit production packages during the spike.

| Stage | Mergeable result and gate |
|---|---|
| 1. Boundaries and compatibility | Enforce allowed imports in CI and establish representative existing routes as behavioral and typing fixtures. Guard changes to boundary rules, public contracts and their tests with ownership review. Temporary exceptions must be specific and tracked. |
| 2. Contracts and installation | Introduce ports, provider resolution, resource ownership and named failures alongside the current runtime. Preserve the existing `StepOutcome`/`StepContext` semantics rather than replacing them with the spike's implementation. |
| 3. One production capability | Migrate a bounded first-party capability end to end, including public packaging, replacement and any DSL integration. Select it from the feature ledger; it must exercise real contracts, not merely move files. |
| 4. Execution contributions and deferral | Replace privileged execution connections through proven contracts. Verify branching, resilience ordering, detached execution and durable continuation against existing behavior. This stage needs multiple bounded tickets, not one executor rewrite. |
| 5. Remaining migration and cleanup | Move remaining capabilities through those contracts, preserve convenient defaults, and remove bridges only after their users migrate. |

Enforcement comes before broad file movement. Package exports, project references
and CODEOWNERS alone do not prevent forbidden internal imports. Use resolved
import checks and lint failures, with review protection for the enforcement
configuration itself. The spike's static-import gate is evidence for its tested
modules, not proof of every production dependency boundary.

### Release decision: 0.7 ships without this, 0.8 carries it

**Decided by Jaco, 2026-09-20.** This supersedes the conditional framing that
stood here before.

- **0.7 is cut from current work**, shortly after the pull request that started
  this project merges, plus possibly one or two documentation tickets. It does
  not wait for any part of this redesign, and nothing in this document is a
  reason to delay it.
- **0.8 is the redesign release.** The migration, the contracts and the
  documentation overhaul land there.

This is a better shape than what it replaces. The earlier wording worried about
pre-committing two releases to featureless restructuring; only one is committed,
and 0.7 stops being a hostage to work that has not been planned yet. The
decision gate survives inside 0.8 rather than across the two: the first
production migration still decides whether the remaining capabilities follow the
same contracts or the plan is reassessed.

One risk is worth naming and is small. Naming 0.8 fixes a release boundary
before the feature ledger exists, so if the ledger turns out larger than the
spike suggests, either 0.8 grows or part of the migration slips to 0.9. Under
the v0 policy, where the whole public API is unstable, the cost of that is a
version number rather than a compatibility promise, so the pre-commitment is
cheap. The ledger from rounds 7a and 7b is what turns it into an estimate.

**0.8 needs public extensibility documentation written alongside the code, not
after it.** If third parties can now contribute handlers, wrappers, steps,
facets and providers, the documentation that explains those five concepts is
part of the release rather than a follow-up: an extension point nobody can find
is not an extension point. That work belongs in the round-8 plan with its own
tickets, and the concepts it has to explain are the ones `docs/direction/`
draws and explains, written in the docs site's own vocabulary and figure
system, so the concepts can be judged for explainability before they are
committed to.

Existing guarantees must survive. New guarantees for distributed durability,
exactly-once external effects, arbitrary uncooperative cancellation or sandboxing
are outside this refactor unless separately scoped. A missing existing guarantee
is a migration blocker, not something this paragraph permits dropping.

---

## 2. Principles

### P1. Equal reach for first and third parties

- **Assumed.** Anything a first-party package can do, a third party can do through published API. Test: move a provider to its own package; if it needs one private import, that import is the gap.
- **Opus.** Keep, but the test is too weak: a stranger passes it today by re-deriving a global symbol from its string, and proves nothing.
- **Astra.** Keep, load-bearing. Equal access to *supported contracts* — execution, ownership, diagnostics, replacement — not arbitrary internals. Test multiple independently packaged implementations against built declarations, not one colocated plugin.
- **Now. KEEP, amended.** *Anything a first-party package can do, a third party can do through API that is exported, documented and covered by the version policy.* A capability reachable only through an unexported name is not reachable. The acceptance test builds against the packed artifact, not workspace aliases.

### P2. Core is lifecycle and interfaces; nothing in core is logic

- **Assumed.** Core owns interfaces and lifecycle. It never owns an operation, adapter, transport, provider or store schema.
- **Opus.** Keep as written.
- **Astra.** **Strike that wording.** Lifecycle, scheduling, cancellation, failure precedence and continuation *are* logic. Core should own a small execution protocol and its invariants, without transport, provider or domain policy.
- **Now. AMEND, Astra is right and the two validators disagreed here.** I wrote "nothing in core is logic" and in the same document handed core the exchange lifecycle, ordering, the halt contract and failure precedence. *Core owns a small execution protocol and its invariants. It owns no transport, provider or domain policy.* The unamended version is a slogan that the design's own next paragraph contradicts.

### P3. Everything that is not core is a plugin, including main

- **Assumed.** Main becomes first-party plugins with no privileges.
- **Opus.** **Strike the slogan, keep the operative sentence.** Four exceptions are conceded before anything is built: the kernel, the event bus, `from` as a position, and the exchange and route contracts. A principle with four exceptions is not doing work. Keep *"core defines the kinds; nobody in core defines an instance."*
- **Astra.** Amend. Application-owned resources and runtime contributions use the lifecycle contract; pure functions and adapters stay libraries. Tier 0 already contradicts literal P3.
- **Now. STRIKE the slogan; keep two operative sentences.** *Core defines the kinds; nobody in core defines an instance.* And: *if it needs no context lifecycle, it is a library, not a plugin.* "Everything is a plugin" survives only as the name of the effort.

### P4. One plugin interface, tiered by declaration

- **Assumed.** One contract; two interfaces would recreate the two-halves bug.
- **Opus.** Amend, **because the spike violates it**: `Plugin` and `TypedPlugin` share no members, and the builder ignores `dependsOn`, so it hands you a method for a plugin set the kernel would refuse to start.
- **Astra.** Amend heavily. One *installation protocol*, multiple composable *contribution contracts*. Interface count is not truth count. Otherwise this becomes a sprawling optional-member bag.
- **Now. AMEND, combining both.** *One installation protocol. Contribution contracts may be several, but every one is derived from the same installed value, so the type and the runtime cannot disagree.* Astra's `Apply<F, B, P>` demonstrates this; the round-one spike is the counterexample.

### P5. Reuse is optional and unprivileged

- **Assumed.** Shared convenience lives in an abstract implementation of the same interface, never a contract above it.
- **Opus.** Keep.
- **Astra.** Keep, **drop the inheritance prescription.** Factories, functions, default interpreters and contract suites are equally legitimate. No helper may own authority unavailable through the interface.
- **Now. KEEP, minus the abstract-class wording.** The rule is about authority, not about inheritance: *no reuse mechanism may grant access the bare interface does not.*

### P6. Core knows about dependency, not capability

- **Assumed.** Core provides a dependency graph and never learns the word "store".
- **Opus.** Amend: as written it is contradicted by the design itself, since `InterventionPoint` is a closed set of five capability names.
- **Astra.** Amend, load-bearing, and **note a direct contradiction in our own documents**: the register says depend on contracts, the design says depend on plugin IDs.
- **Now. AMEND, and this is a real design change.** *Core understands abstract required and provided contracts, not plugin identities.* `dependsOn: ["routecraft.stores"]` is wrong and contradicts P7 — a replacement would have to impersonate an ID. Depend on a **port**, resolve to a provider. Astra's `ports.ts` shows it working.

### P7. Every plugin can be declined and replaced

- **Assumed.** A context starts with a first-party plugin off and a stranger's substituted.
- **Opus.** Keep with preconditions: the spike's substitution test installs the stranger *under the first party's ID*, which is absence plus impersonation. With both installed the last `provide` wins silently.
- **Astra.** Keep with preconditions. A replacement satisfies contracts, versions and semantics. **Never require impersonation.**
- **Now. KEEP, amended.** *A replacement declares itself one, under its own identity, satisfying a named contract. Core refuses two undeclared providers of one port, naming both.* This is the same defect as I9, and the round-one spike reproduces it.

### P8. A boundary that is not mechanically enforced does not exist

- **Assumed.** TypeScript project references first, because an agent cannot route around a compile error.
- **Opus.** Keep.
- **Astra.** Keep, **correct the enforcement claim.** Project references are not visibility enforcement. Counterexample committed.
- **Now. KEEP, ranking inverted, and this corrects advice I gave Jaco directly.** I verified Astra's counterexample: `tsc -b` exits 0 while package B imports `../a/private`, despite A exporting only `.`. **Package exports and project references do not block relative filesystem imports.** The working gate is ESLint `no-restricted-imports` with path patterns plus a resolved-import-graph check in CI, which I had ranked third.

### P9. An extension point core does not use to build itself is unproven

- **Assumed.** Whatever core uses to build itself must be what it hands out.
- **Opus.** Keep, the strongest of the nine.
- **Astra.** Keep as a proof obligation, **merge into P1**. First-party use is necessary coverage, not universal proof; a useful new extension point may precede first-party adoption.
- **Now. KEEP as a proof obligation under P1.** Not a separate principle. The obligation is: every published extension point has at least one first-party user *and* one test that exercises it from a separately packaged consumer.


---

## 3. The diagnosis, restated

This is the part that changed most, and it changed because Astra read the
source the original design claimed to have read.

### The original claim (D12)

> Core publishes a seam for observing and none for participating. Telemetry
> only observes and sits at 0 core imports; deferral must intervene and sits
> at 202 references across 14 files. That single absence accounts for the rest.

### What the code actually says

`packages/routecraft/src/types.ts:203`:

```ts
export type StepOutcome =
  | { kind: "continue"; exchange: Exchange; metadata?: StepOutcomeMetadata }
  | { kind: "complete"; exchange: Exchange; metadata?: StepOutcomeMetadata }
  | { kind: "drop"; metadata?: StepOutcomeMetadata }
  | { kind: "branch"; exchange: Exchange; steps: Step<Adapter>[] }
  | { kind: "fanOut"; exchanges: Exchange[] }
  | { kind: "defer"; exchange: Exchange; request: DeferRequest };
```

with `Step.execute(exchange, ctx: StepContext): Promise<StepOutcome>`, and a
`StepContext` carrying `takePending`, `runPaths` for isolated nested parallel
sub-pipelines, and cancellation through `StepSignalContext`.

**Halt, drop, branch, fan-out and defer are already first-class.** Verified
independently.

### Now

**D12 is false as written, and the round-one spike is why I believed it.** That
spike reduced `Step` to `run(): Promise<void>`, and I then diagnosed the
framework for lacking what my own mock had discarded. Both validators found the
consequence; only Astra found the cause.

**The accurate diagnosis is narrower, and Jaco already wrote it** in issue #816
before any of this began:

> Nothing can be registered on the context today to change what a route does.

Core has a rich participation seam for operations **the route author writes**,
and none for behaviour registered **by someone who did not write the route**.
That is a much smaller claim, it is true, and it is the one to build on.

### What survives, and reproduces

| Finding | Status |
|---|---|
| 12 core files import plugin territory, in 75 static import statements | ✅ Both validators, and me |
| `operations` alone pushes 122–152 symbols into core, six times the next folder | ✅ The real coupling, and understated originally |
| 2 of 9 core folders have an `index.ts` | ✅ |
| `dependsOn` exists, marked RESERVED, unenforced | ✅ |
| `registerConfigApplier` is last-writer-wins, silently | ✅ |
| Pino is in the published type surface; no `Logger` interface exists | ✅ |
| `logger.ts ↔ exchange.ts` is a **runtime value cycle** | ✅ Both validators independently |
| A third party cannot *supportedly* substitute a server plugin | ✅ (but see I1 below: they can unsupportedly) |

### What died

| Claim | Why |
|---|---|
| "Core has no participation seam" | `StepOutcome` exists with six arms |
| "A third party cannot write a server plugin" (I1) | All 78 store keys are `Symbol.for`; a stranger re-derives the key. Contract is *unnamed and unversioned*, not absent |
| "A third party cannot define a source" (I3) | `Source` is exported and implementable |
| "Deferral cannot be declined" (I8) | A context starts and stops fine without it. The coupling is in the source, not the runtime |
| "`PrimitiveKind` restricts custom steps" (I2, partly) | `registerDsl` destructures `{ label, factory }` and never reads `kind` |
| "Fluent, typed, extensible, sound: pick three" (F8) | Two independent working encodings |
| The churn control group | Does not survive its own command |
| 81 / 202 / 193 / 663 / 1,314 / 21 fields / 24+48 | None reproduces |

---

## 4. Evidence

Every figure the original design leaned on, with both validations and the
current position. **No figure here is pinned to a commit**, which was the root
cause of four errors; the remedy is a checked-in script per claim whose output
is quoted, and that is now an acceptance criterion rather than a suggestion.

| Claim | Assumed | Opus | Astra | Now |
|---|---|---|---|---|
| Core→plugin imports | 81 across 28 files | 75 statements, 12 files | 75 statements, 78 incl. re-exports/dynamic, 12 files | **75 statements from 12 files.** The original mixed statement and symbol counts inside one figure |
| Deferral coupling | 202 refs / 14 files | 420 occurrences / 14 files | `defer` 420/307/14; literal `deferral` 163/132/12 | **14 files is exact. The count depends entirely on the term and the unit; state both or state neither** |
| Telemetry coupling | 0 | 0 imports, 1 reference | 0 imports, 17 textual occurrences | **0 imports. Not zero references** |
| Deep cross-folder imports | 193, "90 after `shared/`" | 312, 239 after `shared/` | 318 / 247, or 231 / 167 by origin | **Three methods, three answers, all far above 193. The reassurance was backwards** |
| `index.ts` surface | 663 exports / 846 lines | 598 / 833 | 597 named, 597 checker-visible / 833 | **~597 exports, 833 lines** |
| `DeferralStore` vs `SessionStore` | 15 vs 6 methods | ✅ | ✅ | **Confirmed by all three** |
| Store implementation cost | 1,314 vs 362 | 1,289 vs 604 (incl. a 242-line semantics layer omitted originally) | 1,289 vs 362 | **1,289 vs 604.** The omitted layer is exactly what the design proposes deferral acquire |
| Builder surface | 24 + 48 ≈ 70 | 23–25 + 25–30 ≈ 54 | 29/35 declarations, 23/30 implementations | **~53 distinct methods.** "About seventy" overstated by a third |
| `RouteDefinition` | 21 fields | 19 | 19 | **19.** The 21 was measured on an unmerged branch |
| `StoreRegistry` keys | 44 | 44 | 43 named + one template index signature | **43 named keys plus an open index signature, which is not one key** |
| Test coupling | 12 of 270 internal | 129–194 of 265 | 156 of 266 | **Roughly half the suite imports internal paths. This is the migration budget** |
| Import cycles in core | 3, all type-only | 71, one a value cycle | SCC analysis: one runtime cycle, `logger ↔ exchange` | **One runtime value cycle; many type-inclusive. It breaks the proposed core graph at its first line** |
| `llm ↔ agent` runtime cycle | Yes | Not a cycle | Not a cycle; `agent/events.ts` has zero imports. Real AI cycle is `surface/registry ↔ surface/cancellation` | **No llm/agent runtime cycle. Folder-level reciprocity is real; the fix still helps** |
| `shared/` consumers | duration 11, abort 6, stale 6, total 103 | 35 / 6 / 11, total 139 | 37 / 6 / 11, total 71 cross-folder | **Direction confirmed, magnitude was understated. The four singletons reproduce; the rule stands** |
| Churn control group | adapters highest churn, lowest rework | Does not reproduce; deferral lowest at 0.1 | Does not reproduce; method differences dominate | **Withdrawn. Churn selects investigations; it does not certify a diagnosis or gate CI** |

### Where the two validators disagree with each other

| Topic | Opus | Astra | Now |
|---|---|---|---|
| P2 "no logic in core" | Keep | Strike | **Astra.** The design contradicts it one paragraph later |
| I8 declinability | Confirmed | Refuted | **Astra.** The original conflated source coupling with runtime declinability |
| Enforcement ranking | Project references first | References do not enforce visibility; counterexample committed | **Astra, verified myself.** Lint plus an import-graph gate is the real boundary |
| POC defect count | 4 | 20 | **Astra went deeper.** Several of its findings are regressions from the real framework |
| Verdict | Build it, not as sequenced | Do not build these contracts | **Astra is better calibrated**, given what `StepOutcome` turns out to be |


---

## 5. The proof of concept: keep, fix, discard

63 tests pass and the typecheck is clean, and that fact is close to
meaningless: 20 of those tests are characterisation tests that assert defects.
**Green means reproduced, not fixed.**

### What is genuinely good and should survive into round two

| | Why it earns its place |
|---|---|
| **Dependency sort with named failures** | `MissingNodeError` names both sides; `CycleError` carries the path. Boot failures are legible, which is the whole obligation the framework owes a plugin ecosystem |
| **One topological sort for two graphs** | Plugins by dependency and wrappers by ordering are the same problem. Evidence for P6 |
| **Wrapper ordering by declared constraints** | A stranger lands mid-chain between two first-party wrappers with no core change. This is P1 demonstrated, and it is the single most convincing thing in the spike |
| **Freeze after apply** | A contribution from `start()` would silently miss an already-composed chain |
| **Step-name collision refused at apply, naming both plugins** | Matches `registerDsl`'s existing behaviour |
| **Telemetry as observe-only** | Needs nothing but the event bus, confirming the observation seam is already right |
| **Encoding E (both variants)** | The most valuable output of the whole exercise. See §6 |

### What is wrong and must not be carried forward

The headline: **the spike discarded `StepOutcome` and `StepContext` and replaced
them with `Promise<void>`.** Everything below follows from that or from
shortcuts taken around it.

| Defect | Where | Consequence |
|---|---|---|
| `Step.run(): Promise<void>` | `contracts/route.ts` | Cannot halt, branch, fan out or defer. Discards a protocol the framework already has |
| `RouteSpec.source` declared, never subscribed | `runtime/index.ts` | Sources were never demonstrated at all |
| Resume changes status, executes nothing | `plugins/deferral.ts` | The acceptance test does not test the acceptance criterion |
| Effect runs before approval | `plugins/deferral.ts` | Not durable deferral in miniature; the opposite |
| Two plugin interfaces, builder ignores `dependsOn` | `contracts/plugin.ts`, `builder/` | Violates P4; offers methods for a plugin set the kernel would refuse |
| Tokens collide silently | `contracts/token.ts` | `Symbol.for` is a global string registry. Weaker than the declaration merging it replaced |
| Duplicate token providers replace silently | `registry/index.ts` | Reproduces I9, the defect the design says must be fixed |
| `require` unrestricted by declaration | `registry/index.ts` | A2's "you cannot read what you did not declare" is claimed and not built |
| Observer exception aborts the exchange | `events/index.ts` | **A regression from the real `event-bus.ts`,** which snapshots subscribers and catches |
| Disposer throws, remaining cleanup skipped | `kernel/host.ts` | Teardown must continue and aggregate failures |
| Dependency disposed before dependent's `stop` | `kernel/host.ts` | Global disposers run before all stop hooks |
| Wrapper state allocated in `wrap` | `runtime/index.ts` | Resets per delivery. Circuit breaker and concurrency are per-route in reality |
| Descriptor mutated after start still executes | `interventions/` | Freeze guards the method, not the objects |
| Index write not atomic with record write | `plugins/deferral.ts` | A crash between them makes a persisted record invisible |
| `put(key, undefined)` does not delete | `plugins/stores.ts` | Orphan index keys forever |
| First error handler throws, original error replaced | `runtime/index.ts` | Loses the real failure |
| `interventions` imports `kernel/graph` | module layout | Violates the document's own dependency direction |

### Tests that overclaim

Recorded because the lesson is about method, not about these files.

- The substitution test installs the stranger **under the first party's ID**, so it tests absence plus impersonation, not replacement.
- The CAS test awaits the first resume before starting the second. It is not a race.
- The encoding-C phantom test casts to `Record<string, unknown>` before asserting absence, bypassing the typing it claims to check.
- `Runtime`'s JSDoc says it owns a halt contract. Its loop has none.
- Encoding A proves one conditional-inference encoding fails. It was written up as a property of TypeScript.

---

## 6. Proven alternatives

Each compiles and runs. Where both validators produced one, both are kept:
two independent solutions to the same problem is stronger than either.

### The DSL. F8's dichotomy is false

**Assumed:** fluent, body-typed, plugin-extensible, sound — pick three.

**Opus:** encoding E by defunctionalisation. Plugin states the body
relationship as computed interface members reading `this`. 40 steps, 1.29s,
mutation-verified.

**Astra:** installed method families. `Apply<F, B, P>` applies an explicit
type family to the current body and installed tuple. Additionally handles
async via `Awaited`, inherited prototype methods, immutable sibling chains,
and rejects union-plugin ambiguity rather than advertising possible methods.
41 descriptors compile and execute.

**Now.** The dichotomy is dead. **Astra's is the better starting point** because
it addresses assembly-boundary honesty and dynamic-plugin cases the other does
not. Both share the essential move: *stop asking TypeScript to infer a
type-level relationship out of a value-level generic function.*

Neither is production-ready. Neither is integrated with the kernel. Both
require the application's builder and execution plan to derive from the same
installed descriptors — two independently configured lists reopen the gap.

### Named exchange properties

**Assumed:** `ex.deferral` regresses to `ex.use(TOKEN)`; a real cost.

**Both validators:** the premise is false. The exchange type is not fixed; the
builder already carries a plugin-derived parameter. Astra's `facets.ts` derives
fields from a factory map and constructs the same fields at runtime, rejects
collisions with `body`/`id`, and defines non-writable properties.

**Now.** **Strictly better than today**, because declining the plugin removes
the property, where today `ex.deferral` is on the type regardless. Requires the
same plumbing as the DSL: do both or neither. It is a named API, not a security
boundary — private state stays in a `WeakMap`.

**Round seven.** This reverses a written standard and nobody had said so.
`.standards/exchange-state-model.md`, Non-rules: "Plugins do not extend
`DefaultExchange`'s prototype. Adding a getter for plugin-defined concerns would
lead to arms races and conflicts. Plugins export external helpers." Typed facets
are exactly plugin-defined getters on the exchange. **Decided, ruling 8:** keep
facets, one per plugin named by its namespace, and amend the standard with the
reason recorded there.

### Declarative versus imperative contributions

**Astra:** the split is not steps versus wrappers, it is *value known at module
load* versus *value known after dependency resolution*. A thunk over resolved
dependencies erases it. Sequence: declare → validate/resolve → acquire/bind →
compile routes → activate → drain → dispose.

**Now.** Adopt the phase sequence. Atomic publication and rollback are not yet
implemented and are required.

### Ordering constraints against absent plugins

**Astra:** distinguish *optional absence* from *invalid reference*. Anchors are
imported objects, not handwritten strings, so a typo is a compile error.
`required` fails when absent; `ifPresent` tolerates an absent owner but fails
when the owner is installed without its promised anchor.

**Now.** Adopt, with two additions of Jaco's: anchors are **contract-owned, not
implementation-owned**, so a replacement preserves ordering; and ties inside a
gap break by a **stated deterministic rule that is not install order**.

### `pipe` arity

**Now.** Moot under the DSL work. Astra also demonstrated a recursive
tuple-adjacency encoding with no arity overloads, at the cost of contextual
inference for inline generic callbacks.

---

## 7. Missing entirely

Ordered by when it hurts. Nothing here was in the original design.

1. **A stable execution protocol and continuation format.** Start from the existing `StepOutcome`/`StepContext`, not from `Promise<void>`. Specify continuation identity, instruction and nested-path IDs, attempt identity, cancellation and late-result handling, error precedence, source acknowledgement, and what survives each boundary. A durable continuation needs a plan version or hash, stable instruction IDs, codec versions and an explicit migration-or-reject path. **Array positions are not stable across a deployment.**
2. **Policy versus state on resume.** Saving survival policy forever is unsafe when security requirements change. Historical execution state and policy that must be rechecked on resume are different things.
3. **Resource scopes and structured lifetime.** Application, route, exchange and attempt scopes. A semaphore belongs to a compiled route, not a per-delivery closure. Startup must roll back partial acquisition; teardown must continue after failures and dispose consumers before providers. `started: boolean` is not a lifecycle state machine.
4. **Versioning of the plugin contract.** After this change the public surface is ~597 names **plus** every token name, wrapper id, step name, handler id and anchor — all strings, none under `.standards/api-stability.md`. Largest omission for a design whose purpose is third parties.
5. **Persistence laws, not a smaller method count.** Atomic multi-key writes, deletion, bounded scans, snapshots, close; absent versus null; create-if-absent; ABA protection; collation and key encoding; cursor consistency; transaction limits; migration locking; durability acknowledgement; clock ownership. **Keep `DeferralStore` as a semantic port** with an optional reference implementation over an atomic ordered-record backend, and run every implementation against one contract suite including crash and concurrency cases.
6. **Connection sharing is not query abstraction.** Namespaces do not partition connection-wide PRAGMAs, migration leadership, retention interference or pool exhaustion.
7. **Isolation.** A2 claims "you cannot read what you did not declare"; nothing builds it. Either scope `provide`/`require` by declaration or delete the claim before it is quoted as a security property. The plugin API is not a sandbox and should not be described as one.
8. **Handler ordering and composition.** #816 already rules: registration order is consultation order, refusals short-circuit, decorations compose. **But "registration order" is install order**, which is the non-determinism this design elsewhere rejects.
9. **Observability of the graph.** Nothing lists installed plugins, resolved order, wrapper chain, token providers, ignored optional constraints or contribution origins. Every one is a support question, and the ops plugin already answers that shape.
10. **Error taxonomy for boot failures.** Cycle, missing dependency, duplicate id, duplicate provider, duplicate step name, contribution after freeze, unmatched constraint. Seven conditions, no RC codes, in a codebase whose error policy is a standards document.
11. **Streaming and backpressure.** `Pipeline` is `(ex) => Promise<void>`; the dispatcher states a streaming response is in-flight work for as long as it runs. Completion is not when the pipeline returns.
12. **Migration.** Roughly half the suite imports internal paths. Keep the existing executor as a reference and run both paths against the same behavioural fixtures. Build an external plugin against the packed artifact, not workspace aliases. Two contexts with different plugin sets in one process.
13. **Year two.** `InterventionPoint` closed at five, with no process for a sixth — and the analogous `DetachedKind` grew from three to four *during this project*. Relative ordering with thirty wrappers leaves most pairs undetermined. And installing an unrelated third-party plugin can silently reorder a resilience chain, which today requires editing one reviewed file.

---

### Post-round-five: ordering responsibility and guarantee boundaries

**Ordering is powerful and plugin authors own correct use.** Jaco explicitly
accepts that a plugin can construct a semantically bad chain. The framework must
reject mechanically invalid configurations (cycles, missing required contracts,
undeclared duplicate providers and invalid required anchors) and expose the
resolved chain, selected providers and contribution origins. It need not prove
that every valid chain makes business sense.

Document the tie-break rule and declare explicit constraints for first-party
chains whose order matters. The POC demonstrates that replacement under a new
plugin ID can change otherwise unconstrained lexical ties. That is a documented
composition consequence, not by itself an architecture blocker. Stable
contribution identities are an option if needed; they are not a prerequisite for
continuing. This clarification does not choose numeric slots over named anchors.

Name the executing plugin and relevant chain when reporting failures. That is
attribution of execution context, not a guarantee of identifying the root cause
of every interaction. Diagnostics, testable contracts and plugin-author tests
are the desired safeguards; semantic misuse cannot always be detected.

**Evidence limits from round five, pending independent review:**

- A committed deferred checkpoint survives a real process kill and resumes at
  the correct instruction, including a conversation spanning two stores. A
  process that dies mid-continuation leaves a record that is reported at boot
  and never re-run, which is the shipped guarantee (see post-round-seven). The
  two stores do not have a distributed transaction, and external effects do not
  acquire exactly-once semantics.
- Cancellation suppresses late outcomes and effects submitted through the
  guarded API. Arbitrary plugin IO that ignores cancellation can still occur;
  drain is bounded, as `shutdown.timeout` bounds it, and abandons what is still
  running after the deadline, naming it.
- Encoding E remains a demonstrated solution for fluent extensibility, not a
  blanket soundness guarantee. Round five found and fixed integration defects
  in facet typing, body-preserving outcomes and the correspondence between
  installed resilience methods and runtime wrappers. Real DSL compatibility
  still requires the feature-fit fixtures.
- Continuation compatibility relies on declared identities and versions. The
  POC rejects mismatched plans; it does not migrate saved plans or discover
  changes hidden inside captured closures.

The acceptance bullets below are retained as the round-five review checklist.
The report records each result and qualification; unmarked boxes are not a new
claim that nothing was implemented. In particular, the timeout bullet cannot
honestly promise suppression of arbitrary unguarded external IO.

---

### Post-round-six: independent execution review

Measured on `3b69bfda` (round five) and `HEAD` (this round). Every round-five
number reproduced exactly: 32 tests, 22 mutants killed, 10 compiler negative
controls, strict typecheck, the import gate, and the packed consumer. The
mutation harness was itself checked before its results were accepted: a
deliberately unparseable mutant is reported as `SURVIVED or invalid`, never as
a kill, so its counts mean what they say.

Four defects were found by mutation and fixed here. Three were untested
mechanisms; one is a contract gap against a guarantee the shipped framework
already makes.

| Defect | Evidence it was real | Status |
|---|---|---|
| **A claimed continuation whose holder dies is stranded forever.** `claim()` moved the record out of `waiting` and deleted its waiting index | A probe that claims, closes and reopens finds an unclaimable record | **This finding was wrong, and its fix was reverted in round 7c.** The shipped resume IS a transition out of waiting, and a half-run continuation is meant to be reported, not re-run. What round five actually lacked was the duplicate reply, the expiry claim and expiry itself. See post-round-seven |
| **Handler survival was never exercised.** Every contribution in all 32 tests used `allRuns`, so `!h.survival[kind]` could be deleted with the full suite still green | Deleting the check passed 32/32 | **Fixed.** A handler declining `resume` is now asserted absent from the resumed continuation. Wrapper survival was already load-bearing; two mutants confirmed it |
| **Tag selectors were never exercised.** The test helper hardcoded `tags: ["protected"]`, so every route carried the tag and the branch could be deleted | Deleting the check passed 32/32 | **Fixed.** A route without the tag is now asserted unselected |
| **The import gate was evadable three ways**: a new file in `src/v2` was simply not in the allowlist, a dynamic `import()` inside a function body was never inspected, and a non-literal specifier was invisible | Each probe passed the round-five gate unchanged | **Fixed.** The allowlist is closed over the directory, the walk covers every node, and a computed specifier is refused. Coverage went from 7 modules and 12 edges to 10 and 21 |

**The paragraph that stood here claimed the stranded-claim defect changed a
conclusion. It did, in the wrong direction.** Round six read `releaseClaims`,
the sixty-minute lease and the "second axis" JSDoc as the resume path. They are
the expiry-NOTIFICATION path. `revive.ts:335` takes `markResumed`, a
compare-and-swap out of waiting, before `runContinuation` at `:412`; `types.ts`
says of a record left resumed without a continuation that "this residue is a
half-run CONTINUATION and is only ever reported", and that "the asymmetry with
the delivery claim is deliberate". The quote round six leaned on, "one
duplicate escalation after the lease elapses", is about re-sending a nag. The
round-six fix therefore made the spike re-run a half-run continuation, which
the shipped design explicitly refused to build. The method failure was
quoting JSDoc without following the call it describes; rule 9 below.

The other three stated limits hold, checked the same way:

- **Exactly-once external effects.** The framework explicitly does not promise
  it. `revive.ts` calls notification "at-least-once by design". Legitimate limit.
- **Suppressing uncooperative IO on timeout.** `timeout-wrapper.ts` states that
  "side effects of the abandoned run still happen". The spike reproduces shipped
  behaviour, and the uncooperative probe is an honest demonstration rather than
  a gap. Legitimate limit.
- **One distributed transaction across the session and deferral stores.** The
  framework does not have one either; `@routecraft/ai` instead makes the agent
  thread idempotent per sequence number. Legitimate limit, but that replay
  discipline is a feature-fit item, not something the current spike models.

**What round six did not reopen.** The execution protocol, installation model,
ordering, encoding E, and the DSL are unchanged. The restart proof is genuine:
separate PIDs, `SIGKILL`, physically separate databases, an append-only effect
log, and a prefix written only by the first process. The packed consumer is
genuine: a real tarball installed from `file:` into a fresh directory, with only
type support copied and the private subpath refused by the exports map.

---

### Post-round-seven: the review that corrected round six, and what followed

A clean-room Fable 5.1 reviewed `e5d16035` (`reviews/FABLE-REVIEW.md`).
Everything round six reported reproduced. It then added sixteen mutants, of
which thirteen survived, ran ten guarantee probes against the shipped
framework, of which eight showed regressions, and measured the shipping DSL
encoding at 20 and 40 plugins. Its verdict was to proceed on the installation
half and send the continuation, exchange and principal half back for one
bounded round. That round is commit `2f5812f8`. Its content, by what changed:

| Finding | Shipped behaviour it was checked against | Status at `2f5812f8` |
|---|---|---|
| Round six's lease fix re-runs a half-run continuation | `markResumed` before `runContinuation`; `resumedWithoutContinuation` reports and never re-runs; the lease heals `claimExpiry` only | **Reverted and rebuilt.** `markResumed` CAS; second resume answered `duplicate` from the cached outcome; failed resume recorded; `claimExpiry`, `releaseClaims`, `findExpired`, `markExpired`, `sweep`, ttl |
| `.defer("approval")` parks one exchange per route | ids are `{exchangeId}#{sequence}`, predictable before the defer | **Fixed.** Minted per exchange; `ex.deferral.id` predicts the next one; two defer points in one exchange park `#1` then `#2` |
| Plan hash too wide (every plugin, every option) and too shallow (no callable) | `hash.ts` hashes the tail only and folds in callable source verbatim | **Fixed.** `Step.source` carries the callables; the hash covers the tail's definitions and nothing else; an edited suffix refuses, an unrelated plugin or option does not |
| `Principal` a forgeable core field, restored and trusted after restart | `security.md` §3: restored is never authentic; `authentic.ts` brands by `WeakSet` | **Fixed.** Core carries headers; `auth` plugin owns the key, the brand and the `authorize` handler; a step-written or stored principal is refused; a resume is authorised by its ingress |
| `structuredClone` per step rejects functions, streams, class instances | plain JSON only at the defer boundary (`RC5042`) | **Fixed.** No clone in flight; `NOT_SERIALIZABLE` (renamed `NOT_PERSISTABLE` in 7e, when the codec became the shipped one) names the step at the defer boundary |
| Unbounded drain | `shutdown.timeout` then `forceStageTwo` | **Fixed.** `stop(timeout)` abandons and reports after the deadline |
| Contributions re-sorted per handler point per exchange | drawn as once at freeze | **Fixed.** Ordered once |
| Contribution ids one flat namespace; facet names, option keys, point names unversioned | `api-stability.md` covers TypeScript symbols only | **Fixed per ruling 9** (`ede7ea66`): namespaces, per-owner ids, facet named by namespace, namespaced option keys. Version policy extension is 0.8 work |
| Displaced provider still binds, acquires and contributes | none | **Documented.** P7 amended below; "ours steps aside" qualified in the docs draft |
| Refusal honoured at `admission` and `entry`, ignored at `error`, discarded at `exit` | none | **Fixed per ruling 11.** Encoded in `HandlerPoints`; compile error where not honoured, `REFUSE_UNSUPPORTED` at runtime |
| CLI `routes/` and `plugins/` layout does not fit a DSL that starts from an `Application` value | `packages/cli/src/project.ts:194`, `start.ts:324` | **Open ruling 10.** A design question for 7a/7b, not a migration cost |
| `keepsAlive`, auto-stop, `TeardownInfo`, `whenStarted()` absent | `context.ts` | **Ledger items.** Shipped guarantees the feature-fit rounds must carry |
| An authorization ask was a bare option that failed open without the auth plugin (found while answering Jaco's question on ruling 5) | `.authorize()` is a core builder method, so the ask and the check are one | **Fixed.** `.authorize()` contributed by the auth plugin; `RouteSpec.requires` enforced by the kernel |

**Round seven's positions on the principles**, adopted here unless marked:
P1 keep, and extend the version policy to the string surface. P2 keep, and say
plainly that the kernel owns the resume protocol, the claim, the plan hash and
the continuation format (it imports `CONTINUATIONS` by name at four sites).
P4 keep; the code demonstrates it. P5 keep. **P6 amended:** core knows about
dependency, not capability, *except the one continuation port the kernel owns
under P2*; as written it was a slogan the runtime contradicted at its first
line. **P7 amended:** *a provider can be replaced; a plugin can be declined
when nothing requires its ports*; a displaced provider still binds. **P8
amended:** keep the rule, drop "does not exist"; a boundary is graded and the
slogan would be quoted against a partial ratchet that is progress. P3 and P9
as already struck and merged.

**Scale.** The shipping encoding checks in 3.4 s at 20 plugins and 40 steps
(233k instantiations, 226 MB) and 10.9 s at 40 and 80. Facets cost nothing
measurable. Editor latency is unmeasured.

**Two method lessons, recorded as rules 9 and 10 in section 10.** Round six
quoted contract JSDoc without following the call it described. Round seven's
mutation harness reported 16/16 kills on its first run because a path error
failed every mutant; the runner discipline caught it, the reviewer said so,
and the real count was 3/16.

### Post-round-7e: Astra's contract review, and the bounded round it asked for

Astra reviewed `d6823df6` (`reviews/ASTRA-ROUND-SEVEN.md`; its probes and
mutants are on `validation/round-six-astra` at `763d26aa`, and every one of
its eighteen probes now lives in `test/round-two/round-seven-e.test.ts`
asserting the corrected behaviour). Its reproduction matched to the figure.
Its verdict, one more bounded round before implementation planning, was
right, and the reason is worth keeping: **a port can be selected without
governing the behaviour it advertises, and a hash can accurately compare the
wrong list.** Both were true of the round 7c and 7d corrections. What
changed, by finding:

| Astra finding | What was wrong | Status after round 7e |
|---|---|---|
| **D1** Authority substitution changed provider selection, not authorization | The gate and the facet called a module-local `principalOf`; a replacement provider was selected and never consulted; a provider under the `auth` namespace satisfied `requires` and the protected body ran | **Fixed.** Identity is two plugins: `principals` provides `AUTHORITY` (header, brand); `auth` requires it, provides `ENFORCEMENT` and contributes the gate. Both gate and facet consume the selected authority, and `.authorize()` requires `ENFORCEMENT`, the gate's own port. An independently branded vendor authority is accepted and the default mint refused under it; a provider without the gate fails `ROUTE_REQUIRES` |
| **D1** Authorization ran at entry, after the CAS, so a refused resumer spent the approval | `markResumed` preceded the gate | **Fixed.** The gate runs at admission. A resume's admission is over the ingress and runs before the record's state is disclosed; a refusal leaves the record waiting and unclaimed, and learns nothing, not even that the record was already resumed. Duplicates pass the door too |
| **D2** The store could not express denial, keyset paging, retention, step state, settlement time | `ContinuationStore` had `denied` in the record and no transition to it | **Fixed.** `markDenied`, `settledAt` and `reason`, `findExpired(now, limit, after)` over `(expiresAt, id)` returning unclaimed entries with their route, `purgeSettled`, `pending`, `replaceStepState` by fingerprint, `Continuation.stepState` handed back as `StepContext.stepState` to the parking step alone. A plan mismatch now claims, re-asks through the error channel and denies, as `refuseContinuation` does |
| **D2** `resume(id, headers)` had no payload, no acknowledgment | `RunResult` could not carry the cached failure | **Fixed.** `resume(id, { payload, headers, signal })`; the payload reaches the continuation as `routecraft.deferral.result`; a duplicate carries `outcome` (completed, failed, deferred, and what was omitted) |
| **D3** The tail hash was recomputed from the stored step ids, so an appended step was skipped | `tailHash(route.steps, saved.pending)` | **Fixed.** A continuation stores `frames`: suffixes of declared lists anchored at the defer site even when nothing follows it. The resume rebuilds the path from the route as compiled today and hashes that. An appended step, an appended step after a trailing defer, and an edited child of a branching step are all refused |
| **D3** A callback nested in an option object vanished through `JSON.stringify` | Top-level functions only | **Fixed.** `Step.source` is projected recursively with the shipped rules (functions by verbatim text at any depth, `Date`, `URL`, `RegExp`, `Map`, `Set`, opaque instances, a depth bound) and rendered canonically |
| **D4** Refusal policy erased at runtime for plugin-declared points; broad `Handler` lost the correlation | `runtime.handlers` hardcoded `error` and `exit` | **Fixed.** `point(name, owner, refuse)` is the runtime half of a point, typed against the merged declaration so the two cannot disagree; a plugin installs its points, the host refuses an unknown or re-owned name, and the runtime reads the policy from the descriptor. `Handler` is distributed over the points, so `{ point: "exit", handle: () => refuse }` fails to compile whichever type it is assigned to |
| **P1** Claim did not exclude resume; no deadline check on resume; expiry on a protected route refused before the error handler; claimed records and orphans in the scan | Six lifecycle holes | **Fixed.** `markResumed` wins only against an unclaimed record; an overdue resume expires the record itself (claim, nag, settle) and reports `EXPIRED`; the gate declares `errorChannel: false`; the waiting index carries the claim so the scan never returns a claimed record; an orphan is counted, left unclaimed, and the cursor moves past it |
| **P2** `structuredClone` was the codec; a non-cloneable terminal body threw outside the recording catch | A `Map` resumed as `{}`, a `Date` as a string; a completed payment reported as a failed resume | **Fixed.** `codec.ts` is the shipped rule set: plain JSON data, `Date` in a tagged envelope, everything else refused by path (`NOT_PERSISTABLE`). The terminal body is cached best-effort: a completion whose output is not JSON data records `completed` with `omitted` |
| **P3** `resumedWithoutOutcome` never called; `sweep` never healed; no sweeper | Methods that existed and nothing wired | **Fixed.** `deferralPlugin({ lease, interval, retention })` owns the policy: its start hook heals, purges, retires what came due while the process was down, reports stranded residue as `deferral:boot`, and arms the timer; `sweep` returns a report (`released`, `purged`, `visited`, `retired`, `orphans`). `PluginContext.emit` was added so a plugin can report under its namespace |
| Exit decoration reached the next handler and not the caller | | **Fixed.** The decorated exchange is what the caller gets |
| Public claims overpromised (six named) | | **Corrected** in `DOCS-ARCHITECTURE-DRAFT.md` and `DIAGRAMS-MECHANISM.md`, each by the wording Astra objected to |
| Authority transfer on resume: the spike overlaid the ingress headers, so the approver's authority flowed into the continuation | A policy the round-seven corrections never decided | **Ruling 12**, below |

**Astra's mutants**, folded into `validation/round-two/mutants.ts`: nested
children omitted from the hash, the minted grant array unfrozen, the scan
ignoring the deadline, `markExpired` on an unclaimed record, the duplicate
dropping its exchanges, the stored headers overriding the ingress (which no
longer applies, since nothing is overlaid: replaced by "ingress merged into
the continuation"), and the authority's answer ignored. All killed, with the
tests they needed added. Nineteen more from this round guard the corrections
above.

**What this round did not do.** Signed resume tokens and payload validation
against a declared schema remain ledger items, as Astra classed them. The
management listing (`list`) and the action fingerprint are not in the port;
the ledger decides whether they are companion ports. The spike's sweeper is
one timer per application, and its stop is disposal, not the shipped
`context:stopping` gate. The chain-order claim in the docs draft is now
scoped to route-level layers; a compatibility fixture for the shipped filter
chain is still 7a and 7b work.

### Post-round-7f: the review of 7e, and the door as `#818` shipped it

A clean-room Fable 5.1 reviewed `63cfcda6` (`reviews/FABLE-ROUND-7E.md`;
its evidence is `validation/round-seven-e-review/` on
`validation/round-7e-fable` at `41af1af7`). Every figure reproduced. Its
verdict was one more bounded round before 7a and 7b treat the continuation
contract as settled, and Jaco ruled that his own review waits until that
round is done. This is that round, with one addition: the resume door as
pull request `#818` shipped it, which Jaco confirmed as the plan and which
the review's F15 had found missing.

| Finding | Status after round 7f |
|---|---|
| **F1** `.authorize()` with no grants admitted anyone | **Fixed.** The ask demands an authentic principal whatever its grants |
| **F2, F3** ruling 12's record persisted the whole ingress header set (a bearer beside the principal reached the cached outcome) and lost the resumer on a failed continuation | **Fixed.** The door records a reference chosen by the selected authority (`Authority.refOf`), the kernel writes what the door recorded into `markResumed` itself, keyed by plugin namespace, and nothing else from the ingress reaches the continuation. The codec refuses a value marked secret |
| **F4, F5** the door was handed the parked body; the route was resolved before the door | **Fixed.** Admission at a resume gets a `ResumeView` (id, route, site, parked and due times, the recorded refusal, the parked headers, the payload) and never the body; the route is looked up after the door, so a refused caller does not learn whether it exists |
| **F6** no deadline check after the swap | **Fixed.** Re-checked after `markResumed`; a resume that crossed the deadline at the door records a failed outcome, tells the route once, and does not run |
| **F7** a defer inside `runPath` was swallowed | **Fixed.** Refused as `DEFER_IN_PATH` before anything is written, as shipped refuses a park inside a split |
| **F8** a branch returning children out of order could not park | **Fixed.** A frame is the longest run the path takes from one list: a suffix when it reaches the end (an appended step joins it), a bounded slice when a branch chose part of its children (an appended sibling does not). Any declared subset in any order parks and resumes |
| **F9, F10** the codec was seven rules short of shipped; a corrupt envelope revived as data | **Fixed.** Secret brand, null-prototype accumulation both ways, symbol-keyed and non-enumerable properties, named array properties, `Date` subclasses and `Date` with properties, the reserved envelope, and a corrupt envelope refused on decode, one test and one mutant each |
| **F11** the boot report read the plugin's own store, not the selected one | **Fixed.** The deferral plugin requires the port it provides and reports from the selected store |
| **F12** a sweep in flight when `stop()` began was abandoned after its claim | **Fixed.** The sweep is owned work: it ends between records when a stop begins, and the record it claimed may still reach the error channel during the drain |
| **F13** the boot scan runs after sources subscribe, "opposite of the shipped guarantee" | **Disputed.** The reviewer read the comment in `config.ts`; the call says shipped starts plugins after routes signal readiness (`context.ts`), so a shipped source is live before `scanOnStart` too. What shipped guarantees is that the context is not started until the scan completes, and a `whenStarted` equivalent is already a ledger item. The mechanism diagram's box order was wrong and is corrected. Rule 9 |
| **F14** no default deadline | **Fixed.** `deferralPlugin({ ttl })` defaults to 72 hours and applies it wherever `.defer()` or the facet names none; `ttl: null` opts out |
| **F15** the door applied the requester's grants to the resumer and nothing recorded that as a choice | **Fixed as ruling 13**, and completed by the `#818` door: `.resumable({ authorize, elevate })` |
| **F16** a codec mismatch was denied and nagged | **Fixed.** Refused non-destructively as `CODEC_MISMATCH` |
| **F17** paging past the first page was untested | **Tested** at the sweep, with orphans ahead of live work, purge and lease healing; and the runtime now refuses a page that does not advance (`SCAN_STALLED`) |
| **F18** a duplicate during the first run carries no outcome | **Documented** in the draft |
| Harness: two ambiguous patterns; a kill needs a test to have run; no unchanged-copy control | **Fixed.** A pattern must match exactly once, a kill requires at least one test to have run, and the unchanged copy passes the whole suite (the packed consumer excluded by name) before any mutant runs. Every survivor is reported |
| Sixteen review mutants, fifteen surviving | **All in `mutants.ts` with the tests they needed, plus thirty of this round's** |

**The door, as `#818` shipped it.** `authorize` decides who may resume, over
the live ingress principal and the restored parked one, with the record view
beside them; declared, it is the whole policy, and undeclared the gate asks
the route's own grants of the resumer (ruling 13). `elevate` decides what
authority the continuation carries: it returns headers holding a live re-mint
of the parked identity, lent at most the grants the park recorded as refused;
a changed subject or grant set, a lend outside the bound, or a principal that
is not live is refused before the approval is spent. The answer is held at the
door and applied at entry of the run the claim let through, where the route's
own gate is asked again and the lend has to satisfy it. Without `elevate` the
continuation runs as the restored parked principal and any downstream gate
refuses it. **Parking from the error path** is what raises such a park: an
`error` handler that declares `mayDefer` may answer a failure with a defer
request; a refusal at admission parks the whole route with the refused grants
recorded as the bound, a failure inside a step parks at that step and
re-enters it, and `notify` is told the id once the record is durable and
before the deferred event fires. The step-up flow in `#818`'s description
(refused, parked, lent, run as the requester, resumer recorded) runs end to
end in `test/round-two/round-seven-f.test.ts`.

**What this round did not do.** Signed resume tokens and payload validation
against a declared schema stay ledger items. `list` and the action
fingerprint are companion ports over the existing record. A `whenStarted`
equivalent, and the shipped `context:stopping` gate for plugins, are ledger
items; the sweep's own stop is now correct without them. The subject-ring
versus actor-ring distinction `#818` counts lends against is not in the
spike's principal, which has one grant ring and one lent ring.

### Post-round-7g: the review of 7f, closed

A clean-room Claude Opus 5.5 reviewed `814748e4` (`reviews/OPUS-ROUND-7F.md`;
its evidence is `validation/round-seven-f-review/` on
`validation/round-7f-opus` at `52a62a49`). Every figure reproduced, its
fourteen probes and thirty mutants included. It adjudicated F13 for round
7f, by the call in `context.ts`, and named two shipped comments that
overpromise against it; those belong in an issue against the main
repository. Its verdict, ready for Jaco's review and one bounded round
before the door and the error-path park are treated as settled contracts, is
this round. What changed, by finding:

| Finding | Status after round 7g |
|---|---|
| **G1, G7** the continuation never re-asked the route's own gate, so a step-up park resumed without a lend ran as the refused requester, and an insufficient lend spent the approval silently | **Fixed.** A park raised at the door is re-admitted on resume: the gate is asked again of what the continuation carries. Without a lend the restored principal is refused, the failure reaches the error ring, the record ends failed; a second park for a refusal the same plugin already raised is declined as `DEFER_REPEATED`, which is `#818`'s loop-closing rule |
| **G2** the bound was any failure's `detail`: a rate limiter or a throwing step authored what the door could lend | **Fixed.** A refusal is recorded keyed by the refusing plugin's namespace, and the gate reads only its own entry; a step failure records no bound at all |
| **G3, G4, G5, G11** the error-path park copied `#818`'s happy path and none of its refusals | **Fixed.** Refused before any write, each by name beside the failure: a failure outside any step (`DEFER_UNSITED`), a defer or a failure inside a fan-out (`DEFER_IN_FANOUT`, unsited), a run its caller cancelled (`DEFER_CANCELLED`) |
| **G6** the held elevation lived in a plugin map keyed by record id | **Fixed.** The door's allow decision carries the elevation (`carry`), the kernel applies it after the claim to that resume call alone, and nothing is held anywhere |
| **G8, G9, G9b** hooks were unbounded and their failures distinguishable; a door that settled after `stop()` ran the continuation | **Fixed.** False, a throw and an abort under the ingress signal are one refusal; the resume is owned work from its first await and re-checks that the runtime accepts after the door |
| **G10** the default deadline missed error-path parks and hand-written defers | **Fixed.** The deadline travels with the store (`ContinuationStore.defaults.ttl`) and the kernel applies it to every park |
| **G12** a failing `notify` left a live link behind a failed run | **Fixed.** The record is claimed and denied before the caller is told `NOTIFY` |
| **G13, G14** the codec revived null-prototype objects and kept `-0` | **Fixed.** An ordinary prototype on the way back with `__proto__` defined as an own key, as shipped; `-0` normalised |
| The view lacked `meta` and the step-state descriptor; it hands every admission handler the parked headers | **Partly.** `meta` travels from the defer request to the view. The headers stay: the kernel is identity-blind, so a view that carried only the principal would have to know which header that is; every admission handler already sees the headers of every first delivery, and the body is what the door must not see. The step-state descriptor is not in the view |
| Ten surviving mutants: the sweep's stop between records and pages, the grant ring, re-lending, step-state scoping, the notify failure, a nested site, the entry re-ask | **All killed**, with a test each, and twenty more of this round's |
| "97 tests" in three places | **Corrected**, and now 111 |

**What this round did not do.** The door stays on the deferred route; more
than one door per route, signed tokens with call binding, payload validation
and per-ring lend counting are in the 7a and 7b ledger as migration blockers,
not options. The reference store still reads every waiting index entry per
page; the bound is in the port. The two shipped comments the review named
(`config.ts:354`, `sweeper.ts:268`) need an issue against the main
repository, which is Jaco's to file or approve.

### Post-round-7g: the Astra review, reproduced

Astra reviewed `85f7506a` with an open brief: the whole design, any method.
Its verdict: keep the architecture (kernel boundary, one installation
protocol with several contribution contracts, contract-owned anchors,
one facet per namespace, the resume and notification asymmetry) and do not
freeze the continuation contracts or treat this executor as the migration
target. All sixteen probes and the strict-compiler fixture reproduce here on
the same head. Positions per finding, to be confirmed by Jaco:

| Finding | Astra's priority | Position |
|---|---|---|
| **R1** a cancellation during the store write leaves a live park; the ordinary case still notifies | P1 | **Accepted.** Shipped and `#818` check after `create` and deny claim-first; the spike checks only before. Pass the run's signal into `park` and settle after the write |
| **R2** notification is not bounded by the ingress signal | P1 | **Accepted.** `#818`'s `runNotify` races the signal and denies on abort; the spike closes only the synchronous throw |
| **R3** the identity rule compares grant arrays by joined text, so `["admin,read"]` equals `["admin","read"]` and a lend-free elevation widens the permanent grants | P1 | **Accepted.** Compare structurally |
| **R4** a retried step's failed first attempt stays tracked, so a successful retry is reported as a failure | P1 | **Accepted.** Owned work (drained at stop) and outcome-bearing work (streams) are one set; they must be two |
| **R5** step state replaced while the door waits is stored but the winning resume runs the earlier snapshot | P1 | **Accepted as a contract gap.** The claim must return the record it claimed, or the resume must re-read after winning. Shipped `revive.ts` shares the pre-claim read; not a migration regression |
| **R6** `dispatch` keeps the source run's resumption, so a same-named step on another route receives its step state | P1 | **Accepted.** Clear resumption when a dispatch starts a new route |
| **R7** a store swap released after `stop()` timed out starts the continuation on disposed resources | P1 | **Accepted.** Re-check acceptance after `markResumed` and record the failure without running the route |
| **R8** `deferralPlugin` holds its sweep timer in the descriptor closure, so two contexts from one exported value share it | P1 | **Accepted.** Per-installation state belongs in `bind`; a descriptor must be reusable |
| **R9** a refusal after a decorating admission handler parks the undecorated exchange | P2 | **Disputed as a defect, accepted as a documentation gap.** A park raised at admission is re-admitted on resume, so the whole ring re-runs on the parked exchange; persisting the decorated one would decorate twice. The document must say the park stores what admission was given |
| **R10** an open point may declare `defer` and its handler may return a park, but `invoke` erases it | P1 | **Accepted.** Only the kernel's error point has a site to park at; restrict `defer` to it in the type and add a compiler control |
| **R11** sparse arrays and numeric-looking non-index properties differ from the shipped codec | P2 | **Accepted.** The migration keeps `serialize.ts`; the spike codec is a stand-in and the `$date` tag a format decision to record |
| **R12** a deployment without the deferred route answers `UNKNOWN_ROUTE` before the door, disclosing the route and dropping its policy | P1 | **Accepted.** Fail closed now (an unknown route is refused, not disclosed); the door independent of the deferred route stays a ledger blocker |
| **R13** an ordinary park emits `exchange:deferred` twice, once per id meaning | P2 | **Accepted.** One owner of terminal events |
| **R14** a decode failure after the claim leaves the record resumed without an outcome, as if the process had crashed | P2 | **Accepted.** Every post-claim step belongs inside the scope that records a failed outcome |

**The design recommendation that matters.** Astra reads the spike's runtime
as a second continuation subsystem, and reads the pattern of the last three
rounds (each closes one path and a fresh reviewer finds the neighbouring
one open) as evidence that translating shipped behaviour into this loop
does not converge. Its instruction: extract the participation contracts
around the shipped executor, keep the shipped execution machinery, and use
the failures above as fixtures for the feature-fit ledger. This matches
what the record already says at stage 4 ("multiple bounded tickets, not one
executor rewrite") and in the round-six ruling on migration ("keep the
existing executor as a reference"); what it adds is that the spike's
executor is not the migration target and the record should stop reading as
if a green round made it one. **Adopted:** the spike is a reference for the
contracts, and the ledger measures the shipped code against them.

Its other asks, carried into the ledger brief: a state-transition ledger
for every awaited boundary (which snapshot is authoritative, which signal
applies, what is recorded); the consumer assembly story (a project-typed
route factory over a side-effect-free definition) fixed before the DSL is
documented as final; plugin-author effort made visible with helpers over
the low-level protocol; the non-TypeScript contract (point names, anchors,
namespaces, option keys, event names and payloads, error codes, codec,
hash projection) versioned; fixtures derived by crossing mechanisms rather
than by adding single-path mutants; and one short current-contract section
in this record so a reader does not reconstruct the API from superseding
rounds. Its thirteen documentation corrections are the input to the
documentation round.

### Brief for rounds 7a and 7b: the feature-fit migration ledger

Two independent walks of the real framework, `7a` by a fresh Claude Opus 5 and
`7b` by Astra from its own round-three and round-five work. Same brief, no sight
of each other. Agreement is supporting evidence; a capability only one of them
noticed is the reason for running two.

**Deliverable: one row per existing capability**, covering `packages/routecraft`
(builder, DSL, context, adapters, consumers, operations, pipeline, deferral,
auth, telemetry), `packages/ai`, `packages/os` and `packages/cli`.

| Column | What it must contain |
|---|---|
| Capability | The unit as a consumer meets it, not the file |
| Current behavior | What it does today, cited to source, including its error and edge semantics |
| **Guarantee at risk** | The crash, ordering, concurrency or security guarantee it makes today that a naive port would silently drop |
| Proposed owner | Core, a first-party plugin, a library, or unchanged |
| Required public contract | The port or contribution type it needs, and whether that contract exists in the spike |
| Compatibility fixture | The executable check that proves behavior is preserved, and the mutation that proves the fixture is load-bearing |
| Unresolved gap | What neither the spike nor the ledger can currently answer |

**The "guarantee at risk" column is not optional, and it is the one round six
added.** Round five ported deferral without the claim lease and classified the
loss as a scope limit; the guarantee was documented in the shipped store
contract the whole time. Assume more of these exist. The reliable way to find
one is to read the JSDoc on the current contract and ask what it promises after
a crash, under concurrency, or across a restart, rather than reading the happy
path.

**Every fixture needs a mutation.** Round five's suite was green while handler
survival and tag selection were both deletable. A compatibility fixture that
passes against unchanged behavior proves nothing until the corresponding
behavior change has been shown to fail it.

**Order the ledger by guarantee risk, not by package.** The migration sequence
should be driven by which capabilities carry guarantees that are hard to
re-establish once a contract is published, not by which directories are
convenient to move.

### Challenges to the proposed production sequence

The five stages are sound and the order is broadly right. Three changes are
warranted by round-six evidence.

1. **The continuation contract belongs in stage 2, not stage 4, and the
   contract to settle is the shipped one.** The sequence introduces ports in
   stage 2 and revisits deferral in stage 4. Rounds six and seven together show
   the port's shape decides what can be expressed at all: per-exchange ids,
   a tail-only hash over step definitions including callable source,
   `markResumed` plus a cached outcome for duplicates, and `claimExpiry` with
   its lease for notifications. Round six's version of this challenge would
   have settled the wrong shape early, which is worse than settling it late.
   Publishing `ContinuationStore` in stage 2 as round five or round six had it
   publishes a contract that has to break.

2. **Stage 1 must gate mechanisms, not just imports.** The import gate was
   evadable three ways, and the repository's own precedent is instructive: the
   flat ESLint config carries a comment explaining that it does not read
   `.gitignore`, and the packed artifact still slipped past the commit hooks
   because hooks lint staged files. Enforcement configuration needs its own
   tests, and the gate must be closed over the directory rather than over a
   list someone must remember to update.

3. **Stage 3's bounded capability should be chosen for guarantee density, not
   for size.** A capability that only moves files proves the boundary compiles.
   The stage is worth a release cycle only if the chosen capability carries at
   least one crash or concurrency guarantee that the new contracts must
   re-establish, which is the risk the whole migration is actually exposed to.

On the release decision, see section 1: 0.7 ships from current work and 0.8
carries this. Round seven's eight regressions are evidence for keeping the
first production migration as the gate inside 0.8: round five nearly lost one
guarantee to a scope note, round six inverted another while restoring it, and
the feature ledger is the instrument for finding the rest before a release
shape is committed to.

## 8. Acceptance criteria for the round-two POC

Nothing below is optional. The round-one POC fails most of them, which is why
there is a round two. **Judge the contracts, not the implementations** —
mocked bodies are fine, a `Step` that cannot halt is not.

### Execution semantics

- [ ] Start from `StepOutcome` and `StepContext`, not `Promise<void>`
- [ ] **Defer → halt → restart the process → resume at the correct instruction**, with completed work not re-run
- [ ] All three detached kinds: `resume`, `debounce`, `errorChannel`
- [ ] Branching and fan-out, including a third-party branching step (today blocked by the private `NESTED_STEPS` symbol)
- [ ] Cancellation, late-result suppression, and a timeout that does not let a released step's side effect land after the reported failure
- [ ] Error precedence with a handler that itself throws

### Handlers (#816)

- [ ] Four points: `admission`, `entry`, `error`, `exit`
- [ ] Refusal short-circuits; decoration composes and feeds the next handler
- [ ] Selectors by route id and tag
- [ ] Deterministic order that is **not** install order
- [x] A resume is admitted on its ingress identity, never on the stored one, before the approval is spent; the continuation then runs as the stored identity restored, with the resumer recorded as data; a step-written principal is refused (inverted in round 7c, completed in round 7e; the original criterion asserted the laundering `security.md` forbids)

### Contracts and substitution

- [ ] Depend on **ports**, not plugin IDs. A replacement works under its own identity
- [ ] Two undeclared providers of one port are refused, naming both
- [ ] A replacement declares itself one
- [ ] An external plugin built against the **packed artifact**, not workspace aliases
- [ ] Two contexts with different plugin sets in one process

### Operations and the DSL

- [ ] All four operation categories: route-only, dual-mode, step-only, pipeline. **Retry on a step and retry on the `from` in one route**
- [ ] `.transform((body, ex) => ...)` — two arguments, with `ex` carrying typed plugin facets
- [ ] Declining a plugin removes its method **and** its exchange facet from the type
- [ ] Headers typed without global augmentation, or the cost stated

### Resources and lifecycle

- [ ] Per-route wrapper state: circuit breaker and concurrency across two routes
- [ ] Rollback of partial acquisition on startup failure
- [ ] Teardown continues after a failure, aggregates failures, disposes consumers before providers
- [ ] Shutdown and drain with in-flight work, including a streaming response
- [ ] Route status: enabled, disabled with reason, circuit-broken — and who owns it when a stranger's plugin sets it

### Persistence

- [ ] Atomic multi-key write: record plus index, with a crash between them proven safe
- [ ] Delete actually deletes
- [ ] CAS under genuine concurrency, not sequential awaits
- [x] One route parks any number of exchanges; ids minted per exchange and predictable before the defer
- [x] The plan hash covers the tail's step definitions including callable source and nothing else
- [x] A second resume is answered `duplicate` from the cached outcome; a failed resume is recorded
- [x] A record left resumed without an outcome is reported, never re-run
- [x] An expiry claim whose holder dies is released by the lease and the nag delivered once after it

### Diagnostics

- [ ] Every boot failure and runtime fault **names the plugin responsible**
- [ ] A route-plan dump: resolved order, selected providers, contribution origins, unmatched constraints
- [x] Principal propagation across hops with `authorize()` at admission, from a header an auth plugin owns
- [x] An authorization ask cannot fail open: `.authorize()` is absent from the type without the auth plugin, and a route requiring `ENFORCEMENT`, the gate's own port, refuses to compile without a provider
- [x] Strings are owner-qualified: one namespace per plugin, contribution ids per owner, one facet per namespace, `namespace.key` option keys
- [x] A refusal at a point that does not honour it is a compile error and a named runtime fault

### Durable agents

- [ ] Defer mid-conversation and resume, crossing the agent session store and the deferral store


---

## 9. Rulings and outstanding decisions after round five

**Updates.** Jaco instructed round five to use open handler points. His later
clarification accepts plugin-author responsibility for semantically bad ordering,
with visibility and mechanical validation rather than universal prevention.
Numeric versus named ordering and the exact tie-break policy remain distinct
choices; the POC uses named anchors and lexical ties provisionally. Remaining
items below record the earlier questions, not an assertion that no ruling has
been given. The scope and release baseline is now stated in section 1.

1. **Closed or open intervention points — open for the POC.** #816's acceptance says `HandlerPoint` is declaration-merged and extensible by a package outside core, with a duplicate name a compile error. This design says the five points are closed and a sixth is a core change by definition. **These cannot both be true.** My reading: #816 is right, boundedness is unenforceable once strangers contribute, and `DetachedKind` growing three to four during this project is the evidence.
2. **Ordering: named anchors or numeric slots.** Jaco proposed Spring-style numeric order. My recommendation is named contract-owned anchors with numeric slots underneath, where the names are the API and the numbers are not, because a third party hardcoding `150` breaks silently when core renumbers.
3. **Tie-break rule** inside a gap. Not install order. Round four proposed plugin id, lexicographic. **Round seven disagrees:** `tie-replacement.ts` shows a replacement flipping an unconstrained pair, and the pair that matters is an authorisation gate against a retry. Its recommendation: tie-break on a contract-owned contribution identity (port name plus contribution id), fall back to owner only when identities are equal, and report every unconstrained pair of wrappers that share a surviving run kind in `dump()`. Determinism is necessary and not sufficient.
4. **Is isolation a goal.** Round seven: no. Delete the claim from A2, keep declaration-scoped `require` as API discipline. The step-path wiring is now mutation-covered.
5. **Where `Principal` lives. Confirmed by Jaco, 2026-09-21: not in core.** Core carries headers; the auth plugin owns the key, the `WeakSet` brand, the `.authorize()` route method and the entry handler; a continuation never resurrects authenticity. The cost was stated before he confirmed: the brand is as strong as shipped, core is identity-blind, and the ask had been a bare option that **failed open** when the plugin was absent (probed: `completed "leaked"`). That gap is closed in the same commit: `.authorize()` is a method the auth plugin contributes, so a route cannot express the ask without it (compiler control), and it declares a route requirement the kernel refuses to compile unprovided (`ROUTE_REQUIRES`, mutation-covered). **Round 7e corrected what that requirement names.** Requiring the authority port was the wrong contract: a provider of authority can be present with no gate, and the route ran unprotected (Astra D1). Identity is now two plugins, `principals` (the header and the brand, replaceable under a vendor's own brand) and `auth` (the gate, the facet and `.authorize()`), and the ask requires `ENFORCEMENT`, the gate's own port. The gate runs at admission, so a refused resume spends nothing.
6. **Scope of the not-doing list.** Round seven's version, to be confirmed before 7a and 7b. Explicitly out: exactly-once external effects, one transaction across the session and deferral stores, sandboxing, automatic migration of a changed plan, retracting uncooperative IO. Explicitly NOT out, because shipped: per-exchange deferral ids, tail-only hash with callable source, duplicate-resume idempotency, TTL expiry with lease-healed escalation, restored-principal refusal, bounded shutdown (all five now in the spike); `keepsAlive` and auto-stop, `TeardownInfo`, resume payload validation and the signed token (ledger items).
7. **Whether #542 runs in parallel now.** Both validators rate it independent and airtight. Round seven did not read it. It is the cheapest available proof that this team can execute this pattern in this codebase.
8. **Facets against `exchange-state-model.md`. Decided by Jaco, 2026-09-21: keep facets, amend the standard.** Facets are typed per installation (`TypedExchange<B, P, H> = Exchange<B, Partial<H>> & Facets<P>`; `ex.auth.principal` is `PrincipalView | undefined` when auth is installed and a compile error when it is not, `types.check.ts`), and a collision is refused at construction. The standard's non-rule was written when a plugin getter could only be typed globally. The amendment to apply in 0.8, since `.standards/` is outside this spike:

   > Plugins do not patch `DefaultExchange`'s prototype. An installed plugin may declare one top-level facet named by its namespace through the plugin protocol. Installation contributes that facet to this application's exchange type. Duplicate namespaces and collisions with reserved core fields are rejected before execution. A facet is a view or affordance derived from exchange state and runtime services, not another persistence slot. Persistent exchange state remains in `body` and `headers`; step-owned continuation state follows its separate lifecycle contract. Facet factories must be reconstructible after rewrapping and resume. Other accessors may remain exported helpers.

   This is Astra's wording from round 7e, adopted over the earlier draft because it keeps the state-versus-derivation distinction the standard exists for: a facet must not become a mutable bag that vanishes at the next envelope. `ex.auth.resumedBy` is the test case: derived from a recorded header, never stored on its own.
9. **The string surface. Decided by Jaco, 2026-09-21: owner-qualify everything.** Implemented: every plugin has a namespace (declared, or the last segment of its id), unique per application (`DUPLICATE_NAMESPACE`); contribution ids are checked per owner, as ordering already keyed them, so two plugins may both name a wrapper `audit` and one plugin may not name two; a plugin's facet must be its namespace (`FACET_NAMESPACE`); route option keys must be `namespace.key` for an installed plugin or `route` (`OPTION_NAMESPACE`), so `resilience.retry`, `operations.title`, `auth.authorize`. Handler point names stay global by declaration merging and carry an owner identity that makes two declarations of one name with different identities fail to compile. Remaining for 0.8: extend `api-stability.md` so these strings are covered by the version policy alongside TypeScript symbols.
10. **How a `routes/` file gets its application. Deferred by Jaco to rounds 7a and 7b, 2026-09-21.** The CLI recognises a plugin by a callable `apply` (`project.ts:194`) and loads routes from separate files built with a free `craft()`. Under the spike, a typed chain comes from `app.route()` on an `Application<P>` value. The three shapes to weigh with the CLI, TUI and testing package in view: a project-level `app.ts` that routes import; a `defineRoutes(app => [...])` callback the CLI invokes; or a free `craft()` over a global registry, which is what exists and what encoding E was built to leave.
11. **Which handler points honour a refusal. Decided by Jaco, 2026-09-21: encode it in the type.** Each `HandlerPoints` entry now carries `refuse: true | false` beside its owner identity; `HandlerDecision<K>` offers `refuse` only where the point honours it, so a refusal at `exit` is a compile error (control in `types.check.ts`). For a caller the compiler did not see, the runtime raises `REFUSE_UNSUPPORTED` naming the handler: a fault at `exit`, a secondary on the primary error at `error`. Nothing is silently ignored any more. **Round 7e completed it:** the runtime had hardcoded the two kernel points, so a plugin-declared point had no policy at all, and the broad `Handler` type had lost the correlation between point and decision. A point is now declared twice, once by merging and once by `point(name, owner, refuse)`, typed so the two halves cannot disagree; the host registers a plugin's points before anything binds, and `Handler` is a distributed union.
12. **Whose authority a resumed continuation runs under. Confirmed by Jaco, 2026-09-22, as the `#818` door.** The shipped framework keeps the deferred principal restored on the continuation and records the resumer separately (`revive.ts` `rehydrate`, `resumedBy`; `security.md` §3). The round 7c spike overlaid the ingress headers onto the continuation instead, so the approver's live authority flowed into every downstream hop; round 7e replaced that with the shipped default but recorded the whole ingress header set, which the 7e review showed persisted a bearer and lost the resumer on failure. Round 7f settles it as `#818` has it: the continuation runs as the exchange that parked; the door records a reference to the resumer (`Authority.refOf`) and the swap writes it into the record; a downstream `.authorize()` refuses the restored principal; and the door's `elevate` hook, not a step, is where live authority after the wait comes from, bounded by the refusal the gate itself recorded and never changing identity. **Round 7g completed it, from the 7f review:** a park raised at the door is re-admitted when it resumes, so the gate that refused is asked again of what the continuation carries; the elevation is carried by the kernel to the resume call that made it; the hooks are bounded by the ingress signal and fail as one refusal. Recorded in post-round-7f and post-round-7g and enforced by the step-up tests and mutants.
13. **The door's default policy. Decided in round 7f, from the 7e review's F15.** When a route declares no `.resumable({ authorize })`, the gate asks the route's own grants of the resumer: an approver must hold what the requester needed. Declared, the hook is the whole policy and sees both principals and the record view. Shipped separates the two by putting the hook on the ingress route; the spike has no ingress route, so the deferred route carries the door, and the default is stated rather than implied.

---

## 10. Standing method rules

Earned the hard way. Twenty-plus corrections trace to eight habits, and one
habit produced four of them.

1. **Name the commit.** Four wrong figures came from measuring on an unmerged branch and writing the result as a fact about main.
2. **Enumerate, do not grep for what you suspect.** Three cycles reported; a tool finds one runtime cycle and many more type-inclusive.
3. **One method per figure.** The 81 mixed statement and symbol counts; the 202 mixed lines and occurrences.
4. **Use an AST for code shapes.** A regex counted overload signatures as methods and inflated the builder surface by a third.
5. **Test language claims, do not reason about them.** F8 was argued and is false.
6. **Wire what you declare.** A declared, never-subscribed source demonstrated nothing.
7. **Do not omit the file that weakens your case.** A 242-line semantics layer made a 3.6x saving look real.
8. **A passing test proves what it asserts, not what its name says.** Check the assertion, then mutate it.

9. **Follow the call, not the comment.** Round six quoted `releaseClaims` JSDoc and inverted a shipped guarantee. `revive.ts` had the answer three calls away.
10. **A harness that reports every mutant killed is a harness to distrust first.** Round seven's first run said 16/16; a path error had failed every mutant. The real count was 3/16.
11. **A selected port proves nothing until its provider is mutated.** Round 7d required the authority port and called it fail-closed; the gate never read the provider. Astra's "authority answers nothing" mutant survived, and that one surviving mutant was the whole finding. For every port a plugin requires, mutate the provider and watch the consumer fail.
12. **Hash the thing you will run, not the thing you saved.** The tail hash was correct over the wrong input for two rounds: it compared the stored step list against itself and skipped whatever had been appended. A compatibility check must derive its input from the live graph and compare that against the record.
13. **A survivor under a filter is a survivor; a kill under a full run is not a kill until the unchanged copy passed the same run.** The 7e review manufactured sixteen kills from one script its copy lacked. The harness now runs the unchanged copy first.
14. **A mutant that only touches an import or a type is a no-op under Bun.** The transpiler elides it. Mutate a value the code reads.
15. **A pattern must match once.** Two mutants were at the right site by file order. The harness asserts the count.
16. **A record carries a reference, never the thing it refers to.** The resumer on the record is a subject, not the credential or its grants; a codec with no secret rule persists whatever a header carried.

**And the rule that generates the rest: a green suite is not evidence.** 63
tests passed in round one; 20 of them asserted defects. 32 passed in round
five with two mechanisms deletable. 36 passed in round six with a fix that
re-ran half-run continuations.

---

## Appendix: files

| Path | What |
|---|---|
| `ARCHITECTURE.md` | This file. Source of truth |
| `README.md` | Round-one spike's own findings, superseded where they conflict |
| `reviews/OPUS-VALIDATION.md` | First clean-room validation (round 2) |
| `reviews/ASTRA-VALIDATION.md` | Second clean-room validation (round 3) |
| `reviews/ASTRA-ROUND-FIVE.md` | The rebuild report (round 5) |
| `reviews/OPUS-ROUND-SIX.md` | Execution review of round 5; its headline finding was wrong, see its banner |
| `reviews/FABLE-REVIEW.md` | Clean-room review of round 6 that found the misreading (round 7) |
| `reviews/ASTRA-ROUND-SEVEN.md` | Astra's contract review of rounds 7c and 7d; its probes and mutants are in `validation/contract-review/` (from `validation/round-six-astra` at `763d26aa`, folded into this branch) |
| `reviews/FABLE-ROUND-7E.md` | Clean-room review of round 7e; its probes and mutants are in `validation/round-seven-e-review/` (from `validation/round-7e-fable` at `41af1af7`, folded into this branch) |
| `reviews/OPUS-ROUND-7F.md` | Clean-room review of round 7f by Claude Opus 5.5; its probes, controls and mutants are in `validation/round-seven-f-review/` (from `validation/round-7f-opus` at `52a62a49`, folded into this branch) |
| `reviews/ASTRA-ROUND-7G.md` | Astra's open-ended design review of round 7g; its sixteen probes and compiler fixture are in `validation/round-seven-g-review/` (on `validation/round-7g-astra` at `de98d680`, folded into this branch) |
| `reviews/OPUS-DIRECTION-DOCS.md` | Claude Opus 5.5 review of `docs/direction/` as a consumer reads it, then of the direction; its ten probes are in `validation/direction-docs-review/` |
| `docs/direction/` | The user-facing documentation of the direction: seven pages and nine figures in one visual identity (the outward harness, the internals, and seven mechanism figures), with the differences from the shipped framework cited by file |
| `DIAGRAMS-MECHANISM.md` | The mechanism for an editor of the proof of concept; its module graph is code-derived and checked |
| `src/v2/` | The proof of concept: 12 modules, `auth.ts` added in 7c, `codec.ts` in 7e |
| `test/round-two/` | 111 acceptance tests; `corrections.test.ts` holds rounds 6 and 7, `round-seven-e.test.ts` Astra's eighteen probes as corrected behaviour, `round-seven-f.test.ts` the 7e review's findings inverted and the `#818` door, `round-seven-g.test.ts` the 7f review's findings inverted |
| `validation/round-two/` | Mutation harness (141, listed in `mutants.ts`), import gate, packed consumer, type controls (15), diagram check, process-kill harness |
| `validation/round-seven/` | Round seven's probes, kept as evidence of the pre-correction API |
| `src/`, `test/*.historical.ts`, `docs/`, `README.md` | Round one and its validators, superseded |

```bash
cd spikes/plugin-architecture
bun run verify         # typecheck, 111 tests, 141 mutants, gate, type controls, diagram
bun run verify:packed  # external consumer against a real tarball
bun run demo
```
