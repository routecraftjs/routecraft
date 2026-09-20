# Adversarial validation: plugin architecture

Validated against `feat/dazzling-fermi-01x3ns` at **86ec81bc6ee8ab41e4068d6a3f86b091d6643502**, using Bun **1.4.2** and TypeScript **5.9.3**. Work is pushed to [**validation/astra**](https://github.com/routecraftjs/routecraft/tree/validation/astra). All authored changes are under `spikes/`; the existing implementation was left intact so the counterexamples remain reproducible.

**Verdict: do not build this proposal as written. The fluent-versus-sound dichotomy is false. The real blockers are execution semantics, contract-based substitution, and resource ownership.** Fix those before moving files or standardising persistence.

In this report, `S/` means `spikes/plugin-architecture/`, `R/` means `packages/routecraft/src/`, and `A/` means `packages/ai/src/`. Commands run from the repository root unless a working directory is stated. These are repository-relative references, not references to an unpublished working tree.

## 1. Claims reproduced, with the commands and their output

### Baseline

Ran:

```sh
git clone https://github.com/routecraftjs/routecraft.git
cd routecraft
git checkout feat/dazzling-fermi-01x3ns
git rev-parse HEAD
BUN_INSTALL_CACHE_DIR=/private/tmp/routecraft-bun-cache TMPDIR=/private/tmp bun install
cd spikes/plugin-architecture
bun test
bun run typecheck
bun run demo
```

Results:

```text
HEAD: 86ec81bc6ee8ab41e4068d6a3f86b091d6643502
install: 1386 packages installed
baseline: 31 pass, 0 fail, 46 expect() calls, 5 files
typecheck: tsc --noEmit, exit 0
install order: routecraft.stores -> acme.audit -> routecraft.deferral -> routecraft.telemetry -> routecraft.operations -> routecraft.resilience
wrapper chain: routecraft.admission -> routecraft.retry -> acme.audit -> routecraft.timeout -> routecraft.concurrency
steps: auditMark, defer, transform, tap, fail
body: hello world
audit: enter greet | exit greet
waiting deferrals: [ "def-1" ]
events seen by telemetry: 6
```

The initial literal `bun install` failed because Bun could not write its temporary/cache files. Redirecting both locations made the root installation succeed. No dependency manifest or lockfile changed.

**CONFIRMED:** the spike executes independently of framework imports. **REFUTED:** the documentation's 26-test count; the supplied branch already has 31.

### Reproducible measurements

I added AST-based counters rather than counting lines containing the word `import`:

```sh
bun spikes/plugin-architecture/validation/counts.ts
bun spikes/plugin-architecture/validation/more-counts.ts
bun spikes/plugin-architecture/validation/graphs.ts
bun spikes/plugin-architecture/validation/test-surface.ts
```

The complete outputs are committed beside these scripts. The scripts distinguish import declarations, dynamic imports, import types, re-exports, named interface members, overload declarations, and method implementations. Raw text references are explicitly labelled as such.

| Claim | Verdict | Command/output or exact inspection |
|---|---|---|
| 28 core candidates | CONFIRMED | `counts.ts`: root `.ts` files excluding `index.ts`, plus `pipeline/`, gives **28**. Only **12** have static imports into the listed plugin territories. |
| Zero core-to-telemetry imports | CONFIRMED | `counts.ts`: **0** for that candidate set. This is not zero textual references. |
| DeferralStore has 15 methods; SessionStore has 6 | CONFIRMED | `counts.ts`: **15**, **6**. Definitions at `R/deferral/types.ts:468`, `A/agent/session/port.ts:44`. |
| Session implementations total 362 lines | CONFIRMED | `wc -l packages/ai/src/agent/session/{sqlite,memory}-store.ts`: **277 + 85 = 362**. |
| Six registered DSL operations | CONFIRMED | `rg -n 'registerDsl\(' packages/{routecraft,ai,os}/src`: actual registrations are **log, debug, map, schema, defer, resume**, all in `R/dsl.ts:125–167`; AI and OS have none. |
| PrimitiveKind has five alternatives | CONFIRMED, with a material qualification below | `R/dsl.ts:42`: **process, transform, tap, filter, validate**. `kind` is not read by registration. |
| Four local logger shapes | CONFIRMED | `TelemetryLogger`, `EventBusLogger`, `MailFetchLogger`, MCP `Logger` at the four cited files/lines. They are different subsets, not four duplicate implementations. |
| Eight logger-child type references; 68 `.logger` files | CONFIRMED for all packages, not core alone | `more-counts.ts`: **8 / 68** across package source; `counts.ts`: **7 / 48** in core package source. The eighth reference includes the testing package cast; calling all eight declarations on the three named public types is imprecise. |
| Pino leaks into the public declarations | CONFIRMED | Built declarations into `S/validation/dist` with `tsup ... --dts-only`; output line **2** is `import * as pino from 'pino'`; line **788** declares the pino logger. This reproduces a source build, not an inspection of an npm tarball. |
| Only two of nine immediate core folders have index.ts | CONFIRMED | `counts.ts`: **deferral, telemetry**, out of **9**. |
| Source is public and implementable | CONFIRMED | `R/index.ts:245–249`, `R/operations/from.ts:112`; `validation/current-source.probe.ts` constructs a `Source<string>` using public exports. I3's withdrawal is correct. |
| Adapter context-store calls | CONFIRMED | `rg -n 'getStore|setStore' packages/routecraft/src/adapters`: **12** call sites. |
| Four web-ingress consumer subsystems | CONFIRMED | `rg -n requireWebIngress packages/{routecraft,ai}/src`: **HTTP, Ops, MCP, ACP**. ACP has more than one call site. |
| Missing default server throws RC5003 | CONFIRMED | `R/plugins/server/registry.ts:574`: resolves `default`, then throws if absent. |
| Config-applier replacement is last-writer-wins | CONFIRMED | `R/config-applier.ts:89`: `getRegistry().set(...)`; its JSDoc explicitly documents replacement. |
| dependsOn is reserved and unenforced today | CONFIRMED | `R/context.ts:104` and surrounding JSDoc; construction applies config appliers before `config.plugins`, without a dependency sort. |
| SQLite file sharing is actively rejected for deferral/sessions in one context | CONFIRMED within that scope | `current-source.probe.ts` calls `claimDatabasePath` twice for one path: second call throws. The participating call sites are deferral config **286** and session config **187**. |
| Closed LLM provider configuration | CONFIRMED | `A/llm/providers/resolve.ts`: **7 switch cases**, six named providers and `custom`. Public custom models remain possible. |
| agent→mcp four imports, reverse zero | CONFIRMED | `counts.ts`: **4 / 0** static relative import declarations. |
| suspension directory is gone | CONFIRMED | Current file inventory has `deferral/`, no `suspension/`. Historical deletions do not imply an unfinished rename. |
| Issue metadata | CONFIRMED | `gh api repos/routecraftjs/routecraft/issues/{542,601}`: both **open**, milestone **0.9.0**, created **2026-08-09** and **2026-08-11**. I read both bodies. |
| PR 818 is a separate open draft | CONFIRMED | `gh api repos/routecraftjs/routecraft/pulls/818`: draft **true**, head **ce0c38ee57f98ab8eae169525c40e8504f2d8fa5**. That is not this validation's checkout. |

Declaration build command:

```sh
node_modules/.bin/tsup packages/routecraft/src/index.ts --dts-only --format esm \
  --out-dir spikes/plugin-architecture/validation/dist --tsconfig tsconfig.json --no-config
```

Output: declaration build succeeded; **764.53 KB**. Generated declarations are ignored by Git.

### Executed framework probes

```sh
node_modules/.bin/tsc -p spikes/plugin-architecture/validation/tsconfig.json --noEmit
bun spikes/plugin-architecture/validation/current-source.probe.ts
```

Typecheck exits **0**. Runtime output:

```text
I1: replacement lookup works by recreating the private Symbol.for name (unsupported protocol, public imports only)
I2/D11: registerDsl accepts a custom early-complete Step despite kind tap; kind does not restrict factory behavior
I8: context starts/stops with no deferral configured
I5: same-context database path conflict rejected
```

The server probe supplies a minimal WebIngress, not a complete production server. It demonstrates that “impossible” is too strong; copying an unpublished symbol name is still an unacceptable supported extension contract.

### Final validation

After adding counterexamples and alternatives (repository commit hooks also passed lint and all three repository typecheck commands):

```text
bun test: 63 pass, 0 fail, 96 expect() calls, 8 files
bun run typecheck: exit 0
bun run demo: unchanged successful output
TypeScript extended diagnostics: 0.67 seconds total on this machine
```

That includes 40 distinct additional method-family plugins plus operations: **41 installed descriptors**, with all 40 additional methods used in one fluent chain. It is a compiler smoke test, not an editor-performance benchmark or a production readiness claim.

## 2. Claims refuted or misleading, with the correction

### Numerical evidence

| Claim | Verdict and measured correction |
|---|---|
| 81 core-to-plugin imports | **REFUTED on this branch.** Static declarations: **75** = operations **52**, deferral **9**, adapters **9**, auth **2**, consumers **2**, plugins **1**, telemetry **0**. Including re-exports, import types and dynamic imports gives **78**, not 81. Command: `counts.ts`. |
| 202 deferral references across 14 files | **REFUTED as a reproducible measurement.** Case-insensitive literal `deferral`: **163 occurrences / 132 matching lines / 12 files**. Matching lines: exchange **30**, error **28**, context **13**, route **7**, executor **5**. Broader `deferr`: **283 occurrences / 225 lines / 13 files**; `defer`: **420 / 307 / 14**. None yields the stated result. State the pattern and counting unit. |
| Telemetry has one core reference | **REFUTED as text counting.** **17 occurrences / 16 matching lines / 8 files**. Several are comments; neither comments nor type imports equal runtime coupling. Zero imports remains true. |
| Deferral implementations total 1,314 lines | **REFUTED.** `wc -l packages/routecraft/src/deferral/{sqlite,memory}-store.ts`: **836 + 453 = 1,289**. |
| 193 deep imports; 90 without shared | **REFUTED under explicit resolved-source counting.** Static imports crossing immediate `src/` folder boundaries and targeting non-index TS files: **318**, including root-file origins; **247** excluding shared. Restrict origins to nested folders: **231**, or **167** excluding shared. `counts.ts` resolves extensionless imports and excludes non-TS targets. The document supplies no script explaining 193. |
| 663 exports, 846-line index | **REFUTED.** **597 named exports**, independently **597 checker-visible export symbols**, **833 newline-terminated lines**. Commands: `counts.ts`, `wc -l packages/routecraft/src/index.ts`. |
| 44 StoreRegistry keys across 20 files | **MISLEADING.** **43 explicitly named keys in 20 files** plus a template-string index signature = **44 interface members**. The index signature permits indefinitely many other keys; it is not one key. The exact “37 must not persist” split has no supplied classification procedure. |
| 24 StepBuilderBase / 48 RouteBuilder methods | **REFUTED.** AST method declarations: **29 / 35**; implementations excluding overload signatures: **23 / 30**. Constructors and fields are not methods. Files: **892 / 1,899 lines**. Neither **64 declarations** nor **53 implementations** means 72 operations. |
| AI imports core 86 times | **REFUTED.** **82 static imports**, all from the public package specifier. The absence of deep imports is confirmed. |
| Shared utility figures: 103 imports; top three 61 | **REFUTED under direct static-import counting.** Cross-folder imports to shared: **71**. Direct imports of duration/abort/stale-options: **37 / 6 / 11 = 54**. Nine immediate utility files exist, plus four SQLite files. “Consumer” must specify file, folder, package, or transitive user. Extensionless compare/schema imports and iterable re-exports make careless grep counts particularly unreliable. |
| Four utilities each have one consumer | **MISLEADING.** `compare` and `standard-schema` serve both deferral and Ops; iterable is re-exported by HTTP's SSE helper. The recommendation to relocate them does not follow from counting direct imports alone. |
| Mail/carddav: 420/126 lines, 11/5 methods, no common names | **PARTLY CONFIRMED, OTHERWISE REFUTED.** File lines **420 / 126** are correct; the named manager classes have **7 / 4 method declarations**, and both have **drain**. Mail's file also contains another class and other functions. `more-counts.ts` prints the names. |
| SDK imported by only three files, all in llm/providers | **REFUTED.** **5**: providers/index, providers/stream-llm, llm/structured-output, agent/run, agent/tool-bridge. `rg -n 'await import\("ai"\)|from "ai"' packages/ai/src`. |
| 12/270 tests reach internals; 96% survives replacement | **REFUTED as source-boundary evidence.** `test-surface.ts`: **266** package/root test files; **156** directly import a source path other than the package's root index. This includes tooling packages. Independently, low private-import counts cannot prove behavioral coverage or refactor survival. |
| RouteDefinition has 21 fields | **REFUTED.** **19**, from the AST. The NonChainField carve-out has **10** entries. |
| Six deferral headers including refusedScopes | **REFUTED for this checkout.** `R/deferral/exchange-state.ts:17` defines **5**: sequence, owner, result, resumedBy, resumedAt. No refusedScopes key exists here. |

### The cycle claims confuse a module graph with a folder graph

Ran `validation/graphs.ts`, which transpiles with `verbatimModuleSyntax`, resolves relative static imports/re-exports, and computes strongly connected components:

```text
routecraft static emitted-JS SCCs [["logger.ts","exchange.ts"]]
ai static emitted-JS SCCs [["surface/registry.ts","surface/cancellation.ts"]]
events outbound []
```

**MISLEADING:** the three cycles in the restricted exchange/route/context source graph do each contain a type-only edge, so those cycles disappear at runtime. But not every edge is type-only: `R/route.ts:4` imports exchange values, and `R/context.ts:10` imports DefaultRoute. There is also a real logger/exchange runtime cycle that the proposed module DAG must address.

**REFUTED:** the cited LLM/agent runtime module cycle. `agent/run → llm/providers → stream-llm → agent/events` ends at a leaf. `agent/events.ts` has no outgoing imports. There is reciprocal folder-level dependency, so extracting a streaming contract can still help; there is no cited circular module execution to fix. The actual AI static runtime cycle is in `surface/`.

### I1–I9, corrected

- **I1 — MISLEADING.** A third party can write a server lifecycle plugin. Supported substitution into the existing server registry lacks a published registration key/port. Public WebIngress and requireWebIngress already exist. My symbol-name probe reaches that registry without importing its private module; it is an unsupported protocol dependency, not a sound public seam.
- **I2 — CONFIRMED narrowly.** No supported arbitrary pre-from wrapper registration exists. **MISLEADING** to say `PrimitiveKind` constrains custom step behavior: `R/dsl.ts:107` reads only label/factory. The public Step protocol already carries complete, branch, fanOut and other outcomes. A branch attempt with OperationType.CHOICE failed at build because the private NESTED_STEPS protocol was missing. That is the real structural gap; it is not a five-kind runtime restriction.
- **I3 — CONFIRMED withdrawal.** Sources are implementable. REGISTER D11 still repeats the withdrawn claim that an outsider cannot define a source. Remove it there too.
- **I4 — MISLEADING as current-tree evidence.** CHAIN_SURVIVAL exists, but `rg POINT_SURVIVAL packages/routecraft/src` returns no matches. The handler-table story belongs to separate PR 818. The inability to invent arbitrary host lifecycle points remains true of both current and proposed closed contracts.
- **I5 — MISLEADING in scope.** The same-context deferral/session SQLite-path refusal is real. It does not prove that arbitrary third-party stores cannot share a server, connection, or database. Telemetry does not participate in claims and does not stamp user_version in its source. Namespacing alone also cannot partition connection-wide PRAGMAs.
- **I6 — MISLEADING inference from a real API.** The deferral port has domain semantics; a backend must implement them today. That does not establish that a generic store is cheaper, or that a Postgres author must write the SQLite implementation's line count. releaseClaims and purgeSettled mutate state: the “six queries” classification is not accurate. Prefer a shared reference implementation over removing useful atomic domain operations prematurely.
- **I7 — CONFIRMED underlying coupling.** Public pino types are real. The aggregate counts need the scope corrections above. Four comments do not prove four independent authors consciously rejected a port; that is narrative, not source evidence.
- **I8 — REFUTED as written.** An ordinary context starts without deferral configured; the probe does so. `R/context.ts:921` requires a runtime only for routes using deferral/resume. The accurate architectural criticism is compile-time/source coupling, not inability to decline the feature at runtime.
- **I9 — CONFIRMED.** Silent global last-writer-wins exists today. The spike repeats it in ServiceRegistry.provide.

D12's “observation and no participation” summary is also **MISLEADING**. Public Step/StepContext already expose scheduling outcomes, nested execution and cancellation. The missing seam concerns particular lifecycle positions and durable continuation machinery, not participation in general.

### Churn is not causal evidence

`more-counts.ts` executes a fixed-window command:

```sh
git log --since=2025-09-19 --until=2026-09-20 --format='COMMIT %H' \
  --no-renames --numstat -- 'packages/*/src/**/*.ts'
```

It counts changed file paths, added+deleted lines, and changes per file. This intentionally states rename policy; the prose's moving “12 months ago” command does not.

| Subsystem | Measured churn | Files | Edits/file |
|---|---:|---:|---:|
| routecraft/pipeline | 3,447 | 4 | 10.3 |
| ai/agent | 22,241 | 36 | 7.6 |
| ai/llm | 5,680 | 16 | 6.1 |
| routecraft/plugins | 12,796 | 42 | 3.8 |
| routecraft/deferral | 6,691 | 19 | 1.3 |
| ai/acp | 2,826 | 10 | 2.3 |
| routecraft/suspension | 13,640 | 20 | 4.8 |
| routecraft/auth | 3,188 | 12 | 5.2 |
| routecraft/operations | 13,041 | 42 | 6.3 |
| ai/mcp | 18,939 | 31 | 8.0 |
| routecraft/adapters | 29,573 | 125 | 4.4 |

Only the ACP row reproduces the register's row. Executor: **1,978 lines changed / 19 edits**, not 2,275/11. Dispatcher: **1,268 / 13**, not 1,050/6. None of the four named Ops files appears in the reproduced top twenty.

**MISLEADING:** “the control group proves the thesis.” This is not a control group. Subsystems differ in age, functionality, review history, renames and file organisation. Repeated edits can be feature growth; many new files can be badly coupled. Use churn to choose investigations, not to certify the diagnosis or impose a CI failure threshold.

Human inputs J1–J19 are attributed requirements/experiences, not independent measurements. Their source-dependent assertions are covered above. J5/J8/J16 are explicitly hypotheses in the register; calling the other preferences “Confirmed” does not turn them into proofs. The historical 3,841-test result and two PR defects were not rerun on ce0c38e in this validation. They must not be presented as measurements of this branch.

Other internal contradictions: DESIGN still calls type flow untouched while README claims it settled; DESIGN has five contribution kinds while the spike has four; DESIGN promises wrapper-cycle rejection at boot while its own test starts successfully and asks for ordering later. The dependency drawing correctly gives stores and servers **four** dependents each, but streaming has **two** (llm and agent), contradicting “everything else has zero or one.” `agent → deferral` is also not the sole cross-package edge: agent→stores and MCP/ACP→servers cross the drawn package boundary too.

## 3. Principles: keep / amend / strike, with reasoning

| Principle | Decision | Amendment and consequence |
|---|---|---|
| P1: equal first-/third-party access | **KEEP; load-bearing** | Require equal access to supported contracts, including execution, resource ownership, diagnostics and replacement. Do not promise arbitrary access to host internals. Test several independently packaged implementations against built public declarations; a colocated audit plugin proves one scenario, not universal parity. |
| P2: core contains no logic | **STRIKE that wording; replace** | Lifecycle, scheduling, cancellation, admission, failure precedence and continuation are logic. Core should own a small, explicit execution protocol and its invariants, with no transport/provider/domain policy. Otherwise important semantics get hidden in undocumented conventions. |
| P3: everything else is a plugin | **AMEND** | Everything with application-owned resources or runtime contributions uses the lifecycle contract. Pure adapters and functions remain libraries. The document's own tier-0 section already contradicts literal P3. A source slot can be a host primitive without making source implementations privileged. |
| P4: one interface | **AMEND heavily** | One installation protocol, several composable typed contribution contracts. Number of interfaces is not number of independently maintained truths. Generate/derive types and runtime metadata from checked definitions. Banning interface composition creates a sprawling optional-member bag. |
| P5: optional, unprivileged reuse | **KEEP, remove the abstract-class prescription** | Factories, functions, default interpreters and contract suites are equally legitimate. No helper may own otherwise unavailable authority. The abstraction should be optional, not inheritance mandatory. |
| P6: dependency, not capability | **AMEND; load-bearing** | Core understands abstract required/provided contracts and resource scopes, not the words store/server. Resolve dependency edges through chosen contract providers. Literal plugin-ID dependencies contradict P7. REGISTER A2 says this correctly; A7 and DESIGN reverse it without resolving the conflict. |
| P7: decline and replace | **KEEP with preconditions** | Replacement must satisfy required contracts, versions and declared execution semantics. A dependent feature cannot run after its indispensable dependency is simply removed. Never require a replacement to impersonate a first-party ID. |
| P8: mechanically enforced boundaries | **KEEP; fix enforcement claim** | Use a resolved-import graph gate, public-entry extraction tests and compiler/lint errors. Project references express build dependencies, not complete visibility. `tsc -b S/validation/boundaries/b` successfully imports A's private source despite A's exports map. CODEOWNERS matters only when repository rules require approval and protect that configuration. |
| P9: exercise public extension points | **KEEP as a proof obligation; merge into P1** | First-party use is necessary coverage, not universal proof. Also test a genuinely foreign requirement and separately installed packages. A novel public extension can be useful before first-party adoption; label its guarantees instead of declaring it unreal. |

P1, amended P2, P6, P7 and P8 bear the architectural load. Literal P3/P4 and the inheritance rule in P5 do not. Removing them loses ideological uniformity, not third-party capability. P9 mostly duplicates P1's testing requirement.

## 4. Proof-of-concept critique, including anything broken

I read every original file under `src/` and all five baseline test files. The baseline establishes registry plumbing, one wrapper ordering, and simple stored-status transitions. It does not establish compatibility with the framework's execution model.

### The plugin the contracts cannot express

`S/validation/unexpressible.ts` attempts a durable admission plugin: participate before parsing, then ask the host to resume an instruction after approval. It also attempts ordinary plugin event publication.

```ts
export const durableAdmission: Plugin = {
  id: "acme.durable-admission",
  apply(ctx) {
    ctx.contribute({
      kind: "handler", id: "admit", point: "beforeParse", handle: () => {},
    });
    ctx.resume({ routeId: "r", instruction: "after-approval", state: {} });
  },
};
```

Command:

```sh
node_modules/.bin/tsc --noEmit --strict --skipLibCheck --allowImportingTsExtensions \
  --moduleResolution bundler --module preserve --target es2022 \
  spikes/plugin-architecture/validation/unexpressible.ts
```

Expected failure, captured in `validation/unexpressible.txt`:

```text
TS2769: Type '"beforeParse"' is not assignable to type 'HandlerPoint'.
TS2339: Property 'resume' does not exist on type 'PluginContext'.
TS2339: Property 'emit' does not exist on type 'PluginContext'.
```

The point is not that these exact spellings must exist. There is no equivalent host port: Source is never subscribed by Runtime; steps receive no continuation or cancellation context; Pipeline returns only Promise<void>; the source subscription's emitter is not exposed to plugin lifecycle hooks. A plugin can build its own scheduler, but then the host no longer owns the execution lifecycle the proposal claims to own.

The stronger runtime counterexample uses the existing deferral plugin: `[defer, effect]` executes `effect` immediately. Calling resume later executes nothing. That is not miniature durable deferral; it removes the property being used as the acceptance criterion.

### Executed counterexamples

`bun test test/adversarial.test.ts` runs **20** passing characterization tests. They intentionally assert defects; green here means the defect was reproduced, not fixed.

| Counterexample | What actually happens | Relevant implementation |
|---|---|---|
| Replacement has ID acme.stores | Missing routecraft.stores dependency, despite supplying the same API | `plugins/deferral.ts:79`, `kernel/host.ts:36` |
| `token<number>("x")` versus `token<string>("x")` | Typed string lookup returns number; toUpperCase throws | `contracts/token.ts:18` |
| Two providers for one token | Second silently replaces first | `registry/index.ts:24` |
| Duplicate plugin IDs | One plugin never applies | `kernel/graph.ts`, Map/state keyed solely by id |
| Duplicate wrapper IDs | One wrapper disappears | Same graph algorithm |
| Apply fails after earlier apply | No automatic unwind; failing plugin's stop is excluded even after explicit stop | `kernel/host.ts:46` |
| One disposer throws | Remaining cleanup and stop hooks never run | `kernel/host.ts:68` |
| Dependency owns an onTeardown cleanup | Dependency closes before dependent stop can use it | Global teardown list runs before all plugin stop hooks |
| Observer throws | Exchange aborts before pipeline execution | `events/index.ts:24`; `runtime/index.ts:101` is outside try |
| Contributed descriptor is mutated after start | Changed wrapper executes despite freeze | `interventions/index.ts` stores live object references |
| Stateful wrapper allocated by wrap | State is recreated for every deliver, defeating route-scoped limits | `runtime/index.ts:96` |
| Defer then effect, then resume | Effect runs before approval; resume only changes status | `plugins/deferral.ts:45`, `runtime/index.ts:79` |
| Typed derived builder contributes build | `b.build().build()` compiles, then throws | `builder/index.ts`, reserved method wins in Proxy |
| C's bodyType() | A value typed string is undefined | `typed/c-merged.ts` |
| Two concurrent resumes | One winner, one loser in the mock | Positive control; the baseline only tested sequential calls |
| Mutate a memory-store read | Stored value changes with unchanged version | `plugins/stores.ts:25` |
| Timeout then release blocked operation | Side effect still happens after reported failure | `plugins/resilience.ts`, no abort protocol |
| Fail between primary record and index write | Persisted waiting record becomes invisible to waiting() | `plugins/deferral.ts:36–41` |
| Resume index deletion | put(undefined) leaves the key permanently present | `plugins/deferral.ts:56`, store put/list |
| First error handler throws | Secondary error replaces original; later handler never executes | `runtime/index.ts:105–109` |

The observer failure is a regression from the actual framework: `R/event-bus.ts` snapshots subscribers, catches synchronous exceptions and handles rejected thenables. The actual StepContext also already carries cancellation and nested execution facilities that the spike discards.

The spike also violates the proposed module direction: `interventions/index.ts` imports `kernel/graph.ts`, while DESIGN places kernel above interventions. Put the shared graph algorithm in an appropriate lower-level module; colocating it with the host is not evidence for the promised build graph.

### Tests that overclaim

- The replacement test's JSDoc says acme.stores; its object at `test/principles.test.ts:65` is actually `id: "routecraft.stores"`. It only checks that a namespace opened. Its fake backend ignores CAS and shares one map across namespaces.
- The CAS test awaits the first resume before starting the second. It does not test a race. I added an actual overlapping call.
- “Composition runs outermost first” checks that retry invokes a flaky step twice. It does not distinguish the ordering of multiple distinct wrappers. The audit test is better evidence for its particular placement.
- The C phantom test casts to Record<string, unknown> before checking absence, bypassing the very typing it claims to test. The separate ghost test genuinely demonstrates the gap.
- D's “cannot be declared without implementation” test checks typeof two functions. It would keep passing if a registry were introduced behind them. It is not a regression test for that property.
- Runtime's JSDoc says it owns a halt contract; its loop has none.
- The tests called P1/P7 do not exercise a published external package, transport admission, defer-site discovery, branch revival, handler budgets or source acknowledgements.
- Encoding A's assertion establishes failure of that conditional-inference encoding, not a theorem about all fluent TypeScript APIs. Its IsUnknown helper would also accept any; use exact type-equality and a separate IsAny exclusion when making such proofs.

## 5. Alternatives to the five awkward things, with code and compilation results

### a. Named exchange properties from installed factories

**Compiles and runs.** `src/typed/facets.ts` derives the extension fields from a factory map, and constructs those same fields at runtime. No ambient augmentation and no core knowledge of deferral is required.

```ts
const ex = withFacets(baseExchange, {
  deferral: exchange => ({
    defer: (reason: string) => `${exchange.id}:${reason}`,
  }),
});
ex.deferral.defer("approval"); // inferred and present

const plain = withFacets(baseExchange, {});
// @ts-expect-error no installed deferral factory
plain.deferral;
```

The essential type is:

```ts
type Facets<F extends Record<string, (ex: Exchange) => unknown>> = {
  readonly [K in keyof F]: string extends keyof F
    ? ReturnType<F[K]> | undefined
    : ReturnType<F[K]>;
};
```

The constructor rejects collisions with body/id/etc. and defines non-writable fields. Dynamic string-keyed maps remain optional, rather than pretending every possible property exists. An application built from a static plugin tuple should carry this facet type into every route callback. A runtime-selected application needs a checked narrowing or a generated static facade.

This is a named API, not a security boundary. Extension-internal mutable state can remain in a private WeakMap; the exposed field can be a read-only affordance.

### b. Encoding E: installed generic method families

**Compiles and executes. The dichotomy is refuted.** Full implementation: `src/typed/e-installed.ts`; positive/negative assertions: `e-installed.check.ts`; scale fixture: `e-scale.check.ts`; runtime tests: `test/e-installed.test.ts`.

The successful route is:

```ts
const route = from({ subject: "hello", size: 5 }, [operations, stranger])
  .transform(mail => mail.subject)
  .filter(subject => subject.length > 0)
  .pair()
  .transform(pair => pair[0].length + pair[1].length);

const result: number = await route.run(); // 10
```

All callback parameters are inferred. `.pair()` belongs to the stranger. It survives later built-in transforms; built-ins survive its retyping. Async transform results are awaited and retyped with Awaited. Declining stranger removes pair from the type. Declaring methods without returning implementations is a compile error.

The key is not inferring a generic function's return. It is applying an explicit type family to the current body and installed tuple, and checking its implementation universally:

```ts
export interface MethodFamily {
  readonly Body: unknown;
  readonly Plugins: readonly Extension[];
  readonly methods: object;
}
export type Apply<F extends MethodFamily, B, P extends readonly Extension[]> =
  (F & { readonly Body: B; readonly Plugins: P })["methods"];

export interface Extension<F extends MethodFamily = MethodFamily> {
  readonly name: string;
  create<B, P extends readonly Extension[]>(host: Cursor<B, P>): Apply<F, B, P>;
}

type Stranger<B, P extends readonly Extension[]> = {
  pair(): Chain<readonly [B, B], P>;
};
export interface StrangerFamily extends MethodFamily {
  readonly methods: Stranger<this["Body"], this["Plugins"]>;
}
export const stranger: Extension<StrangerFamily> = {
  name: "stranger",
  create: <B, P extends readonly Extension[]>(host: Cursor<B, P>): Stranger<B, P> => ({
    pair: () => host.map(body => [body, body] as const),
  }),
};
```

Unlike ambient declarations, this family does not add anything globally. Installing the checked descriptor both installs runtime methods and contributes their types. A ghost family without its implementations fails assignment to Extension<Family>. The signatures and implementation are separate text, but they are compiler-correlated, just like an interface and an implementing object.

The assembly boundary has audited type assertions, as most heterogeneous registries do. Plugin implementations need none. It copies actual methods, including class-prototype methods, checks collisions including reserved host names, and returns a new chain for transformations. Immutable chains prevent retaining an old body type while later mutations replace its shared execution list.

I attacked E too. A naive union-to-intersection advertises methods from merely possible plugins. The committed implementation intersects boxed method sets so uncertainty remains a union; dynamic arrays are rejected; union-plugin and union-tuple negative assertions are checked. I also added tests for async output, class methods and immutable sibling chains.

Limitations: this is an encoding proof, not a replacement implementation of Routecraft. It is not wired into Kernel, does not model all BuilderState fields or durable execution, and does not defeat any/casts/lying declaration files. An application must derive its builder and execution plan from the same installed descriptors. Do not maintain a second independently configured kernel plugin list.

The 40-plugin case compiles and executes. That rebuts the immediate scaling concern at the proposed size; it does not prove unbounded inference performance.

A generated application facade is a fallback for dynamically configured deployments: generate runtime wiring and types together from a manifest, validate a manifest fingerprint at startup, and reject mismatches before routes run. I did not implement that fallback because E already disproves the asserted language limit. A lint rule over global augmentation would be weaker: installation in context A cannot prove availability in context B.

### c. One contribution plan, separate declaration and binding phases

**Compiles and runs.** `src/typed/contribution-plan.ts` stores both steps and wrappers as descriptors. Each has a bind(ctx) function; binding resolves services during apply. Type-bearing names exist before startup, while runtime resources need not.

```ts
const plugin = definePlan("one", {
  steps: {
    mark: {
      bind: () => ({
        kind: "step", name: "mark",
        factory: () => ({ label: "mark", run: () => { trace.push("step"); } }),
      }),
    },
  },
  wrappers: [{
    bind: () => ({
      kind: "wrapper", id: "around",
      wrap: next => async ex => {
        trace.push("before");
        await next(ex);
        trace.push("after");
      },
    }),
  }],
});
```

Test output: `before, step, after`. The adapter verifies that a step's bound name matches its declared key.

Production shape: **declare → validate/resolve → acquire/bind → compile routes → activate → drain → dispose**. Every contribution kind uses that sequence. Resource acquisition is imperative by nature; declarative availability and generic implementations need not be. Atomic commit of the bound contribution set and rollback on failure still need implementation. This helper proves the representation, not those lifecycle guarantees.

The README's generic-union observation is reproducible in `contribution-inference.check.ts`. Its proposed universal lesson is too strong: a separately typed descriptor also preserves the nested callback type without a contribute overload for every kind.

### d. Distinguish optional absence from an invalid ordering reference

**Compiles and runs.** `src/typed/ordering.ts` uses imported anchor objects and an explicit presence policy:

```ts
const authorize = anchor("auth", "authorize"); // exported by its contract module
const edge = { target: authorize, presence: "ifPresent" } as const;

resolveEdges(new Set(), new Set(), [edge]);                 // []
resolveEdges(new Set(["auth"]), new Set(), [edge]);         // throws
resolveEdges(new Set(["auth"]), new Set([authorize]), [edge]); // [authorize]
```

`required` fails if the anchor is absent. `ifPresent` permits the owning contract/provider to be absent, but fails when installed without its promised anchor. Importing a misspelled exported identifier is a compiler error. This is different from treating every unknown handwritten string as optional.

Use contract-owned anchors, not concrete implementation IDs, when replacement must preserve ordering. The sample resolver demonstrates the presence distinction; a full installer must validate anchor ownership and resolve provider aliases. Arbitrarily inventing a new optional handle cannot prove an intended target existed.

Related implemented correction: `src/typed/ports.ts` declares provided/required port identities and computes plugin ordering from their selected providers:

```ts
const store = port<{ open(): void }>("store@1");
orderPlans([
  { id: "deferral", provides: [], requires: [store] },
  { id: "acme.postgres", provides: [store], requires: [] },
]); // acme.postgres, deferral
```

Duplicate providers fail; equal diagnostic names do not alias distinct tokens. Port payloads are invariant. Multiple installed copies of a contract package require an explicit identity/version policy; failing to resolve is preferable to silently treating incompatible types as identical.

### e. A pipe does not require an overload per arity

**Two alternatives compile and run.** E's fluent through method preserves contextual inference at every call, with one signature:

```ts
through<R>(op: (input: Chain<B, P>) => R): R;
```

For the variadic call shape, `src/typed/variadic-pipe.ts` validates tuple adjacency recursively:

```ts
type Fn = (value: never) => unknown;
type Checked<A, F extends readonly Fn[]> =
  F extends readonly [infer H extends Fn, ...infer T extends readonly Fn[]]
    ? H extends (value: A) => infer B ? readonly [H, ...Checked<B, T>] : never
    : readonly [];
type Result<A, F extends readonly Fn[]> =
  F extends readonly [infer H extends Fn, ...infer T extends readonly Fn[]]
    ? H extends (value: A) => infer B ? Result<B, T> : never
    : A;
```

The exported function accepts `...ops: F & Checked<A,F>` and returns `Result<A,F>`.

```ts
const plus = (n: number) => n + 1;
const show = (n: number) => String(n);
const length = (s: string) => s.length;
const result: number = variadicPipe(0, plus, plus, plus, plus, plus, show, length);
// @ts-expect-error wrong adjacent input type
variadicPipe(0, length);
```

There are no arity overloads. The honest tradeoff is contextual inference: this version takes independently typed operators and does not claim to infer every inline generic callback from its left neighbour. `.through()` or E's named methods retain that experience. Recursive types also retain TypeScript's instantiation-depth limits.

## 6. What is missing entirely

### A stable execution protocol and continuation format

The proposed registry changes who supplies code but leaves unspecified what executing that code means. Start from the current StepOutcome/StepContext machinery rather than replacing it with Promise<void>.

Specify continue, complete/drop, fork/join and suspension; instruction identity; nested-path identity; attempt identity; cancellation; error precedence; acknowledgement; and which state survives each boundary. Core can own those mechanics without knowing what an approval or LLM is.

A durable continuation needs an execution-plan version/hash, stable instruction IDs, plugin codec versions, and an explicit migration or rejection path. Array positions plus today's wrapper order are not enough after deployment. Saving old survival policy forever is also unsafe when security requirements change. Define which policy is historical execution state and which must be rechecked at resume.

### Resource scopes and structured lifetime

Separate application, route, exchange and attempt scopes. A route semaphore belongs to a compiled route, not a per-delivery wrapper closure. A transaction belongs to an attempt or exchange according to declared semantics. Subscription ownership, route draining and asynchronous disposal must be host-managed.

Startup must roll back partial acquisition. Teardown must continue after failures, preserve all failures, and dispose consumers before providers. Decide whether failed/start/stopping/stopped hosts can accept work. The current boolean started is not a state machine.

Retries cannot safely overlap abandoned attempts while both mutate one exchange. Cancellation needs explicit propagation and late-outcome suppression; arbitrary side effects cannot be undone by rejecting a promise. Preserve the richer machinery already present in the actual executor.

### Persistence laws, not a smaller method count

Do not commit to generic RecordStore based on this mock. Its interface lacks atomic multi-key writes, deletion, bounded scans, snapshots and close. The proposed primary/index scheme needs atomic conditional transactions; individual CAS writes are insufficient, as the crash test demonstrates.

A backend contract must specify absent versus null/undefined, create-if-absent, version monotonicity/ABA protection, collation and encoding, cursor consistency, transaction limits, namespace isolation, migration locking, durability acknowledgements and clock ownership. Cross-namespace transactions need an explicit same-provider restriction or a different coordination mechanism.

A better initial design preserves DeferralStore as a semantic port and supplies an optional reference implementation over an atomic ordered-record backend. Plugins own state transitions once; specialised SQL implementations may remain where performance warrants. Every implementation runs the same semantic contract suite and crash/concurrency tests. Connection sharing is a separate concern and does not require all consumers to adopt the same query language.

Namespaces do not automatically solve database-wide PRAGMAs, migration leadership, retention interference or one workload exhausting a shared pool. Nor does key ordering make a cursor portable across unrelated snapshots merely because its bytes sort identically.

### Compatibility and installation integrity

Specify contract versions, provider selection, duplicate-instance policy, optional dependencies and replacement declarations. Verify the complete graph before side effects. Freeze normalised descriptors, not just the registry's add method.

A runtime-loaded plugin cannot magically add statically known methods to already compiled route code. Publish separate static and dynamic installation guarantees. Include a route-plan dump showing provider choices, effective wrapper order, origins, option schemas and ignored optional constraints.

### Security and observability contracts

The plugin API is not a sandbox: in-process JavaScript can use filesystem/network and retain references. Declared dependencies improve auditability only if host lookups enforce the declaration. The spike currently permits any require(token).

Do not leave Principal in core merely because a current field mentions it. Define the minimum identity/authentication contract, who may issue it, and what reauthentication means across forwarding, forks and durable revival. Wrapper ordering must preserve declared mandatory admission invariants.

Plugin events need typed emission and observation, failure isolation and an explicit async/backpressure policy. “Observe-only” must actually prevent observers from changing the success/failure of work through exceptions or payload mutation. Redaction and sensitive continuation data need the same attention as ordinary logs.

### A migration that can be stopped safely

The proposal starts with moving types and modules. That can create large churn before proving the hard semantics. Keep the existing executor as a reference implementation; run old and new paths against the same behavioural fixtures. Build an external plugin package against the actual packed artifact, not workspace source aliases. Test two contexts with different plugin sets in one process.

Do not remove published exports merely because internal folders acquire indexes. Track public API compatibility separately. Do not call operations last and least risky: branch typing, nested-path inspection and continuation integration are central risks exposed by the current NESTED_STEPS refusal.

## 7. Ranked verdict: should this be built as proposed, and what should change first?

**No. Build a revised architecture, not this proposal's current contracts.** The source supports the need for better public boundaries, but many measurements are stale and several claims are materially overstated.

Ranked by how much each finding changes the design:

1. **Replace the Promise<void> execution model with explicit host execution/continuation contracts.** Prove actual defer → halt → restart → resume-after-the-correct-instruction, including nested branches, retry, timeout, error handlers and source acknowledgements. This decides whether extraction is possible at all.
2. **Use contract requirements rather than concrete plugin IDs.** Make acme.postgres work under its own identity. Resolve duplicates and versions before apply. Without this, P7 fails at the foundation.
3. **Adopt an installed, compiler-correlated DSL such as E.** The asserted fluency/soundness tradeoff is not real. Carry body and exchange-facet types from the same application definition used to install runtime implementations. Retain an honest dynamic-plugin path.
4. **Design scopes, startup rollback, cancellation and shutdown before expanding plugins.** The current spike loses existing framework protections and cannot safely own resources across failures.
5. **Separate storage connection consolidation from storage-algebra replacement.** Keep semantic ports and provide reusable adapters first. Demand atomicity and crash evidence before moving indexes into plugins.
6. **Unify contribution declaration/binding, use explicit optional anchors, and add named exchange facets.** These are solvable API-design problems; the supplied alternatives compile and execute.
7. **Then enforce and migrate module boundaries incrementally.** Baseline the actual 75 static imports with the committed counting method. Break real cycles, publish contracts, and ratchet imports while preserving behaviour. Do not optimise for a predetermined count of ten modules.

The next acceptance test should combine the hard cases in one independently packaged plugin: a source-delivered exchange, named typed state, a custom typed operation, ordered admission, durable parking, process restart, a replacement store with its own ID, and resumed execution with cancellation/error semantics intact. Test omission and misconfiguration too. A toy audit wrapper plus a boolean resume is not a substitute.

There is no defensible promise of “the last major refactor.” The attainable goal is that a new capability normally adds a plugin, while changes to execution semantics or durable formats are explicit, versioned contract changes. That is the architecture worth stabilising.
