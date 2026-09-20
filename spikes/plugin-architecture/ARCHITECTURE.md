# Routecraft plugin architecture

**Single source of truth.** Rendered artifact: https://claude.ai/artifact/QURVh6GhDVSREgCuzP1spb

Everything else in this folder is either input to
this document or code that tests it. Where a published artifact and this file
disagree, this file wins: the artifact is a rendering of it.

**Status: design, not approved. No implementation has started and none should.**

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
- **All code:** `src/`, `test/`, `validation/` in this folder. 63 tests, strict typecheck clean.

---

## 1. The plan

Nothing is built until step 8. Models are named because they are not
interchangeable here: each round exists to catch what the previous one could
not see.

| # | Round | Who | Output |
|---|---|---|---|
| 1 | Original design and first spike | Claude Opus 5 (this session) | ✅ Done. 31 tests. Wrong in ways rounds 2 and 3 found. |
| 2 | Clean-room validation | Claude Opus 5, fresh session | ✅ Done. 16 figures refuted, 4 POC defects, encoding E. |
| 3 | Clean-room validation | ChatGPT Astra | ✅ Done. 20 POC defects, `StepOutcome` finding, 5 alternatives. |
| 4 | Consolidation | Claude Opus 5 (this session) | ✅ This document. |
| 5 | POC round two | ChatGPT Astra | Rebuild the POC against the corrected design and the new acceptance list. |
| 6 | Review of round 5 | Claude Opus 5 (this session) | Verify by execution, not by reading. |
| 7a | Feature fit, clean room | Claude Opus 5, fresh session | Walk the real framework feature by feature: what fits the model, what does not. |
| 7b | Feature fit, clean room | ChatGPT Astra | Same brief, independently, from its own round-3 work plus round 6. |
| 8 | Implementation planning | Fable 5.1 | Given everything: decide sequencing, pull-request shape, and whether to fan out to sub-agents. **Fable decides how, not whether.** |
| 9 | Build | Fable 5.1 + sub-agents | Only after 8 produces a plan Jaco accepts. |

**Jaco reviews the POC by hand between 6 and 7**, and his feedback is addressed
before the feature-fit rounds begin.

**Two rounds are deliberately duplicated** (2 and 3; 7a and 7b) because
agreement between two models with no shared context is the strongest evidence
this process can produce, and duplication is what makes agreement mean
something.

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
- [ ] A lent elevation survives admission on a resumed continuation

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

### Diagnostics

- [ ] Every boot failure and runtime fault **names the plugin responsible**
- [ ] A route-plan dump: resolved order, selected providers, contribution origins, unmatched constraints
- [ ] Principal propagation across hops with `authorize()` at entry

### Durable agents

- [ ] Defer mid-conversation and resume, crossing the agent session store and the deferral store


---

## 9. Open rulings Jaco owes before round five

1. **Closed or open intervention points.** #816's acceptance says `HandlerPoint` is declaration-merged and extensible by a package outside core, with a duplicate name a compile error. This design says the five points are closed and a sixth is a core change by definition. **These cannot both be true.** My reading: #816 is right, boundedness is unenforceable once strangers contribute, and `DetachedKind` growing three to four during this project is the evidence.
2. **Ordering: named anchors or numeric slots.** Jaco proposed Spring-style numeric order. My recommendation is named contract-owned anchors with numeric slots underneath, where the names are the API and the numbers are not, because a third party hardcoding `150` breaks silently when core renumbers.
3. **Tie-break rule** inside a gap. Not install order. Proposed: plugin id, lexicographic — arbitrary, deterministic, stable, inspectable.
4. **Is isolation a goal.** If yes, `provide`/`require` must be scoped by declaration and that is a different registry. If no, delete the claim from A2.
5. **Where `Principal` lives.** A security boundary, not a layering preference. Do not decide it from one existing field.
6. **Scope of the not-doing list.** O1, O2, O4, O5, the AI package, the agent loop, and the thirteen omissions. Some must be explicitly deferred before Fable begins, or scope drifts.
7. **Whether #542 runs in parallel now.** Both validators rate it independent and airtight. It is the cheapest available proof that this team can execute this pattern in this codebase.

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

**And the rule that generates the rest: a green suite is not evidence.** 63
tests pass here; 20 of them assert defects.

---

## Appendix: files

| Path | What |
|---|---|
| `ARCHITECTURE.md` | This file. Source of truth |
| `README.md` | Round-one spike's own findings, superseded where they conflict |
| `reviews/OPUS-VALIDATION.md` | First clean-room validation |
| `reviews/ASTRA-VALIDATION.md` | Second clean-room validation |
| `src/` | Round-one spike plus both validators' alternatives |
| `test/` | 63 tests, of which ~20 are characterisation tests asserting defects |
| `validation/` | Astra's measurement scripts and committed outputs |
| `docs/` | Superseded originals, kept for the audit trail |

```bash
cd spikes/plugin-architecture
bun test          # 63 pass
bun run typecheck # clean
bun run demo
```
