# Round five: rebuilt plugin architecture proof of concept

**Base:** `5dac4d97`. **Measured implementation:** `045c034d1854bda8c0bd6aa7d90c72c4ecf5ef50`.
**Branch:** `spike/astra-round-five`. No production package was changed. No pull request was opened.

The active implementation is `spikes/plugin-architecture/src/v2/index.ts`. The earlier implementation remains historical material. Its eight test files were renamed `*.historical.ts`; they remain typechecked but do not inflate the acceptance count with passing assertions of defects. Both original encoding-E experiments remain available.

## Result

The headline works: **defer, halt, kill the process, start another process, resume a named nested instruction, and execute the suffix without repeating completed prefix work.** The same test crosses physically separate session and deferral SQLite databases and propagates a lent grant to another route, which authorizes at entry.

This is a runnable contract proof, not a production replacement. All section-8 features have an implementation and acceptance coverage within the qualifications below. **The unqualified promise that a timeout prevents arbitrary external side effects does not pass and cannot honestly be implemented by an in-process plugin interface.** Cooperative cancellation and the supported effect fence do pass. Durable recovery after a crash during an already-claimed resume is also not provided; it is different from restarting a durably parked continuation.

## Reproduction and evidence

Environment: Bun 1.4.2, TypeScript 5.9.3. At the root, installation succeeded with:

```sh
BUN_INSTALL_CACHE_DIR=/private/tmp/routecraft-bun-cache TMPDIR=/private/tmp bun install
```

The temporary-directory overrides accommodate this machine's sandbox. No lockfile changed.

Run from `spikes/plugin-architecture`:

```sh
bun run verify
bun run demo
bun run validation/round-two/uncooperative.ts
bun run validation/round-two/tie-replacement.ts
```

`verify` runs strict typechecking, acceptance tests including an independently installed packed artifact, runtime mutations, the import gate, and compiler negative controls. The measured output is checked in at `validation/round-two/verification.txt`, beginning with the measured commit. Demo and limit-probe outputs are beside it.

```text
32 pass
0 fail
137 expect() calls
22/22 runtime mutations killed by behavioral assertions
10/10 compiler negative controls detected; ordinary strict options also pass baseline
BOUNDARIES: 7 modules, 12 permitted import edges, no private/legacy imports
```

The repository commit hooks also passed ESLint/Prettier and all three root TypeScript checks. `git diff --name-only 5dac4d97 HEAD -- . ':(exclude)spikes/**'` returned no paths at the measured commit.

Mutation testing is substantive here. The runner changes a disposable copy and requires an actual test failure; a parse/import error is not counted as a successful kill. Mutations remove the transaction, CAS check, halt, claim-time policy check, source subscription, stream completion wait, cleanup, and observer isolation; repeat the prefix; skip the re-entrant instruction; reset concurrency/breaker state per delivery; accept duplicate providers; discard handler decoration; change ordering to installation order; and accept an incompatible plan. They all fail the behavioral assertions. Compiler controls remove each expected-error annotation independently.

## What was built

- **Execution:** six outcome kinds, pending siblings, isolated nested paths, public declared children, detached downstream capture, an actual error-channel entry, cancellation, guarded commits, streaming completion and drain. `PluginContext.execution` exposes deliver/resume/error-channel operations; a plugin does not need the application's private runtime wiring.
- **Installation:** port-based ordering, explicit replacement declarations, unique token identities, declaration-scoped lookups, duplicate refusals, frozen contribution snapshots, startup rollback and reverse dependency teardown with aggregated failures. Sources can register cleanup before acquisition finishes, so a throwing subscription does not make its acquired resources unreachable.
- **Participation:** open handler points; admission, entry, error and exit; selectors; composing decorations; refusal; contract-owned anchors; required versus optional-presence constraints; inspectable deterministic ordering. Wrapper factories bind once per compiled route.
- **DSL:** encoding E integrated with the actual installed tuple. Generic transforms receive body and typed exchange facets. Immutable chains retain independent plans. Operations demonstrate route-only, dual-mode, step-only and pipeline categories. Dependency validation and method assembly derive from the same installation.
- **Persistence:** a semantic continuation port above an asynchronous-capable atomic record contract. The exercised provider is SQLite. Deferral records and their waiting indexes share one conditional transaction; deletion is SQL deletion, not an undefined-value convention.
- **External consumer:** JavaScript plus declarations are packed into a tarball, installed in a fresh temporary directory, and consumed without workspace source aliases. That consumer implements a branching DSL method, an additional handler point, a wrapper between retry and timeout, a source and a named facet. It parks and resumes real execution using a replacement provider under its own ID. An existing private file inside the tarball is inaccessible through an unexported package subpath.

## Section 8 acceptance ledger

The tests below are in `test/round-two`. “Pass” describes the assertions and scope stated here, not a universal theorem about arbitrary plugins.

| Criterion | Result and concrete evidence |
|---|---|
| Start from `StepOutcome` and `StepContext` | **Pass.** `contracts.ts` defines the protocol; `runtime.ts` executes its six discriminants. Outcomes are additionally body-generic for the fluent helper. |
| Defer → halt → process restart → correct instruction | **Pass.** `process.test.ts` waits for the parked checkpoint, kills the child with SIGKILL, starts another PID and checks the exact durable log. An incompatible plan is rejected before claiming. |
| `resume`, `debounce`, `errorChannel` | **Pass.** Restart exercises resume; captured downstream callbacks exercise detached suffixes; an actual error-channel call delivers an existing failure while the route's circuit is open. |
| Branching/fan-out, including third-party branching | **Pass.** Public child declarations replace the private-symbol dependency. Tests cover fan-out children, consuming pending siblings, isolated failing paths, and a separately compiled external branch. Undeclared dynamic instructions fail by owner/name. |
| Cancellation and late-result suppression | **Pass.** Caller abort rejects before a gated step is released. Releasing it cannot commit a guarded effect or run the suffix. |
| Timeout cannot let side effects land later | **Qualified.** Route and step timeouts suppress results and fence supported effects. **Fails as an unconditional promise about arbitrary IO.** The separate uncooperative probe demonstrates the limit. |
| Error precedence when a handler throws | **Pass.** The primary error remains primary, the handler error is secondary, and later error handlers run. |
| Four handler points | **Pass.** Admission/entry/error/exit execute; an external package also declares and invokes `acme:inspect`. Incompatible duplicate point declarations fail compilation. |
| Refusal and compositional decoration | **Pass.** The next handler receives the preceding decoration; refusal prevents later admission/entry work. |
| Route-ID and tag selectors | **Pass.** Assertions compare selected and unselected routes. |
| Deterministic order, not install order | **Pass.** Reversing installed descriptors preserves the asserted consultation order. Contract constraints and a lexical owner/contribution-ID tie-break are used. See the replacement qualification below. |
| Lent elevation on resumed admission | **Pass for the identity mock.** The restarted process requires the persisted lent grant, and another route authorizes it at entry. A separate revoked-policy test refuses without consuming the durable claim. |
| Depend on ports; own-identity replacement | **Pass.** `acme.disk`, `acme.store`, `acme.number` and `acme.remote` satisfy contracts under their own identities. |
| Two undeclared providers refused by name | **Pass.** The failure names both providers and the port. |
| Explicit replacement declaration | **Pass.** `replaces` names contracts; selected-provider diagnostics record the replacement. Selection concerns a port, not automatic removal of every other contribution from a displaced plugin. |
| External plugin against packed artifact | **Pass.** The separate consumer compiles against emitted declarations and executes against installed JavaScript. Its private-import negative control targets a file that exists in the tarball. |
| Different plugin sets in one process | **Pass.** Two contexts are live simultaneously: one parks/resumes while the other has no deferral facet. |
| All operation categories; retry on step and before `from` | **Pass.** One route uses title, route retry, step retry, delay and transform. Assertions require three executions of the first transform and two of the later transform, demonstrating both retry scopes. |
| Two-argument transform with typed facets | **Pass.** Local and packed consumers access installed facets through the second callback argument while the first argument's body type changes. |
| Declining removes method and facet | **Pass.** Compiler negative controls and the live lean context exercise both absence claims. |
| Typed headers without global augmentation | **Pass with a stated cost.** Headers are supplied through the route's type parameter and exposed as `Partial<H>`; presence is not invented. This is not an input-schema validator. |
| Per-route breaker/concurrency state | **Pass.** Overlapping deliveries share one route's limit while another route proceeds; a tripped breaker stays open and another route stays healthy. Resetting either controller per delivery is mutation-killed. |
| Partial startup acquisition rollback | **Pass.** Both a throwing plugin bind and a throwing source subscription release already-acquired resources. |
| Failure-tolerant, dependency-correct teardown | **Pass.** Multiple cleanup failures aggregate; consumers stop before provider resources close. Concurrent stop waits for startup hooks to settle. |
| Shutdown/drain including streaming | **Pass.** A tracked stream keeps the exchange incomplete and prevents disposal. A step timeout also retains ownership of abandoned work until it settles. |
| Enabled/disabled/circuit-broken status and ownership | **Pass.** A stranger's disabled reason identifies that stranger; breaker state identifies its provider; another route remains enabled. |
| Atomic record/index write with intervening crash | **Pass.** SIGKILL occurs after the first statement inside the transaction. Reopening finds neither record nor index. A subsequent committed transaction preserves both. |
| Delete deletes | **Pass.** Key enumeration and reads confirm absence. |
| Genuine concurrent CAS | **Pass.** Two PIDs read the same version, wait at a barrier, and compete: one wins. Twelve overlapping semantic resumes through an asynchronous adapter also execute the suffix once. |
| Named boot failures/runtime faults | **Pass for the implemented boundaries.** Tests exercise missing ports, cycles, duplicate IDs/providers/instructions, acquisition/start/source/step/handler failures and disabled routes. Cleanup and observer faults retain owners. This is not a claim to enumerate every possible malicious JavaScript throw. |
| Route-plan dump | **Pass.** Reports installation order, providers/replacements, contribution origins/order, unmatched optional constraints, instruction IDs/versions, plan fingerprint and status owner. |
| Principal propagation and entry authorization | **Pass for the identity mock.** Persisted identity survives restart and a dispatch hop; the destination performs its own entry check. |
| Mid-conversation defer across both stores | **Pass for the stated checkpoint.** The session contains the user message and tool request before parking. After restart it contains the approved tool result and assistant completion; neither prefix nor tool request is repeated. |

The restart test's effect log is exactly:

```text
# Before killing the parked process:
prefix
tool-request

# After a fresh process resumes:
prefix
tool-request
tool-result
suffix
principal:alice:approve
```

The deferred instruction is nested and re-entrant. Re-entering that instruction is intentional; its already-persisted conversation state decides what remains. Removing re-entry or replaying the route prefix fails the test.

## Awkward shapes and what I would change

**A durable plan cannot contain arbitrary closures as its continuation format.** The runtime persists instruction IDs, a plan fingerprint and a codec version, and rebuilds executable instructions on startup. Branches declare their children publicly. Unknown children fail. This is the cost of making a third-party branch discoverable and resumable. A real compiler should produce a normalized instruction graph and explicit deployment version rather than asking every operation author to manage this manually.

**The fingerprint is not a hash of arbitrary behavior.** It covers declared instruction identities/versions, relevant chain data and options. Changing captured closure values without changing the declared version cannot be detected reliably. The current path rejects a changed plan; it does not migrate one. Automatically generated transform IDs include their position, so deployment compatibility still relies on the declared plan version. Do not market this as arbitrary hot-upgrade compatibility.

**Typed convenience and the low-level execution protocol have different trust boundaries.** The installed-family construction checks methods and carries body/facet types. The low-level heterogeneous instruction registry still executes plugin code over erased payloads. It does not prove arbitrary adapters, raw branch children, external schemas or declaration files honest. A plugin compiler should keep typed construction separate from this deliberate erasure boundary.

**Operation phase restrictions use receiver types.** Route-only and pipeline methods reject the wrong `this` phase without plugin-side return casts. They can still appear in completion lists in an invalid phase. Separate checked before/after method factories could improve discovery; the generic encoding does not require that ergonomic compromise forever.

**Shutdown ownership outlives a timeout.** Reporting timeout and disposing a resource still used by abandoned work are separate decisions. The runtime suppresses the result but retains ownership until settlement. A plugin that ignores cancellation forever can therefore prevent graceful shutdown forever. Solving forced termination requires a worker/process boundary or an explicit forced-shutdown policy; it cannot be repaired by another `Promise.race`.

**Service binding is application-scoped, including inside steps and lazy facets.** A shared plugin descriptor cannot store the most recently bound service in a closure and remain correct across contexts. Steps now have declaration-scoped service lookup, and facet factories receive a scoped lookup for their own application. One descriptor is tested against two simultaneously live providers; each step and facet observes the right value, and undeclared access is refused.

**Storage stays semantic above atomicity.** Deferral owns waiting/running/completed transitions and index maintenance once. The generic backend supports asynchronous implementations; it is not accidentally limited to SQLite's synchronous API. The spike intentionally does not specify a production scan/cursor/migration algebra.

## Outstanding rulings: assumptions actually made

1. **Open handler points.** Followed the user's instruction. External declaration merging works, and the declaring package must supply the invocation site. A name alone does not create a new lifecycle phase. Point conflicts are checked when incompatible point identities are declared; identical repeated TypeScript declarations are not inherently distinguishable owners.
2. **Ordering API.** Used imported, contract-owned anchors with `required`/`ifPresent`. No numeric-slot API was introduced.
3. **Ties.** Used lexical plugin ID, then contribution ID. This is provisional and has an observable replacement consequence, demonstrated below.
4. **Isolation.** Enforced declarations on `PluginContext.require/provide`. This is supported-API discipline, not a sandbox. Application-owned objects and arbitrary in-process JavaScript are not capability-secure.
5. **Principal.** Used a minimal core envelope for propagation, with authorization policy supplied by a plugin. The fixture is trusted structural data, not authentication, signed delegation, expiry validation or revocation infrastructure.
6. **Scope.** Built section 8's contract proofs. Did not migrate the real framework, implement providers/transports, run a real LLM, design distributed transactions, or implement every production persistence law from section 7.
7. **#542.** Left it untouched, as required by the spike-only constraint. This branch makes no decision about running that work in parallel.

Additional explicit assumption: handler policies on resume are current policy, not a frozen authorization decision from the parked process. Refusal occurs before the durable claim. Historical identity/state survives; authorization may still reject it.

## What ARCHITECTURE.md should now change

### 1. Narrow the timeout acceptance sentence

`validation/round-two/uncooperative.ts` executes a callback that ignores both the signal and the effect fence. After timeout is reported, releasing its gate prints:

```text
UNGUARDED_EFFECT_AFTER_TIMEOUT=true
```

A framework can reject a late outcome, fence a supported commit operation and cancel cooperative IO. It cannot retract an arbitrary write made by an in-process plugin that ignores those mechanisms. Specify that boundary, or require process isolation. The current unqualified acceptance criterion is false.

### 2. “The DSL question is settled” only settles the existence result

Three integration defects were caught and fixed during this build:

- Projecting facets through the broad array index of the HKT's constrained plugin tuple advertised a string index. One compiler option masked that problem. The packed consumer using ordinary strict settings exposed it. Projection now uses literal tuple keys.
- The fluent step helper accepted an untyped outcome while preserving the old body type. A number-returning step followed by a string-only callback compiled. `StepOutcome<B>` and the helper's checked callback now reject that program.
- Retry methods initially lived on the operations descriptor while the route wrappers lived on resilience. Declining resilience could therefore leave an executable-looking route retry with no wrapper. Retry/timeout methods now belong to the same resilience descriptor as their runtime contributions. The compiler rejects retry when resilience is declined, and a context containing resilience without operations executes retry correctly.

These do not revive the fluent-versus-sound dichotomy. They refute the stronger interpretation that choosing encoding E proves an integrated compiler sound. P4's wording should distinguish checked installation/method availability from arbitrary behavioral agreement between types and runtime.

### 3. Contract-owned anchors preserve explicit constraints, not every relative position

`validation/round-two/tie-replacement.ts` installs the same policy contribution under a default ID and then a replacement's own ID. It prints:

```text
DEFAULT [ "policy", "audit" ]
REPLACEMENT [ "audit", "policy" ]
```

The lexical tie-break is deterministic, but provider replacement changes the tie. No explicit ordering constraint was violated. Thus “a replacement preserves ordering” needs qualification. Security/resilience relationships must be explicit constraints, or the tie-break must use a stable contract-contribution identity independent of the provider's identity. Choosing that identity belongs in the pending ruling, not in an unnoticed implementation detail.

### 4. State the durability guarantee before calling this durable execution

The spike proves restart from a committed parked checkpoint and at-most-one successful claim. It does **not** prove exactly-once external effects or automatic recovery after a process crashes between claim and completion. A claimed record can remain running. Nor are the session and deferral databases in one distributed transaction: a crash between those separate writes needs an explicit recovery protocol in a production agent.

Before production, choose leases/fencing and replay/idempotency rules, plus an outbox or reconciliation protocol between those stores. The existing acceptance test does not decide that policy. Calling it complete durable execution would repeat round one's mistake at a subtler boundary.

## Verdict for round six

Review this implementation by executing `bun run verify`, then attack the continuation format, raw instruction type boundary, scope ownership and replay policy. The spike now provides the execution and public participation seams that round one omitted; another round of token registries and counting imports would not test its important claims.

Do not promote this directly into production. The next decisions should be the precise durability/replay guarantee, stable contract-owned ordering identities, principal validation and compatibility policy. Those are the contracts that determine whether future capabilities can remain plugins instead of forcing another structural rewrite.
