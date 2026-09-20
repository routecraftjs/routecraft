# Clean-room validation

Independent check of `DESIGN.md`, `REGISTER.md` and the runnable spike, by an
agent with no access to the reasoning that produced them. Every number below
was reproduced from the tree at `86ec81b`. Every code claim is backed by a
file under `spikes/validation/`, which compiles under the same strict
settings as the spike and runs 22 tests.

Reproduction environment: `git fetch --unshallow` is required first. The
clone this validation started from held 51 commits going back to 26 August
2026, so the twelve-month churn table in the register cannot be reproduced
without it. That is worth stating in the register's footer.

```bash
git fetch --unshallow
bun install
cd spikes/validation && bun test && bunx tsc --noEmit    # 22 pass, clean
cd ../plugin-architecture && bun test && bun run typecheck  # 31 pass, clean
```

---

## 1. Claims verified

Listed with the reproduction. Exact means the figure matched to the unit.

### Section 2 (the load-bearing evidence)

| Claim | Verdict | Reproduction |
|---|---|---|
| I1: four consumers of `requireWebIngress` (HTTP, Ops, MCP, ACP) | **CONFIRMED, exact** | `grep -rn requireWebIngress packages/*/src` returns `plugins/ops/plugin.ts`, `plugins/http/plugin.ts`, `ai/src/acp/server.ts`, `ai/src/mcp/server.ts`. Declared at `registry.ts:574`, not `:576`. |
| I2: `registerDsl` builds a step, pushes it, returns `this`, and its own JSDoc calls it sugar | **CONFIRMED** | `dsl.ts:100-119`. The whole body is those three statements. |
| I3 (withdrawn): `Source` is publicly exported and there are no `plugin.ts` files under `adapters/` | **CONFIRMED** | `index.ts:247` (not `:256`); `find adapters -name plugin.ts` returns 0. |
| I5: `shared/sqlite/claims.ts` exists to refuse two subsystems on one file; only two of three consumers claim | **CONFIRMED, exact** | `deferral/config.ts:286` and `ai/agent/session/config.ts:187` call `claimDatabasePath`. Telemetry never does. |
| I6: `DeferralStore` 15 methods, `SessionStore` 6 | **CONFIRMED, exact** | 15: `create get markResumed claimExpiry markExpired markDenied releaseClaims replaceStepState recordContinuation findExpired pending list resumedWithoutContinuation purgeSettled close`. 6: `get create replace keys remove close`. |
| I6: `SessionStore` costs 362 lines (277 sqlite + 85 memory) | **CONFIRMED, exact** | `wc -l packages/ai/src/agent/session/{sqlite,memory}-store.ts` |
| I7: no `Logger` interface; 8 declaration sites of `ReturnType<typeof logger.child>`; 68 files reference `.logger` | **CONFIRMED, exact on all three** | `grep -rn "ReturnType<typeof logger.child>"` returns exactly 8, including `testing/src/test-context.ts:453` as stated. `grep -rn "export interface Logger\b"` returns nothing anywhere. |
| I9: `registerConfigApplier` is a `Map.set`; `dependsOn` is RESERVED and unenforced | **CONFIRMED** | `config-applier.ts:97` (`getRegistry().set(...)`); `context.ts:99-104` carries the RESERVED comment verbatim. |

### Section 3 and the register

| Claim | Verdict | Reproduction |
|---|---|---|
| F1/D12: core-to-plugin imports by target: operations 52, adapters 9, consumers 2, plugins 1, telemetry 0 | **CONFIRMED, exact on five of seven** | Import-statement count over the 24 core root files minus the barrel, plus `pipeline/`. Deferral and auth do not reproduce; see R4. |
| F1: telemetry has one code reference in core | **CONFIRMED** | 17 textual occurrences across 8 files, 16 of them in comments. The one code reference is `context.ts:214` (`rejectStaleOptions(config.telemetry?.sqlite, ...)`), not `:220`. |
| I8: deferral spans exactly 14 core files | **CONFIRMED** | 14 of the 28 core-candidate files contain a case-insensitive `defer`. The count of references does not reproduce; see R10. |
| F2/D9: four hand-rolled logger interfaces, each a different subset, each with a comment saying it matches the pino child shape | **CONFIRMED, exact on every line number and every shape** | `TelemetryLogger` `telemetry/types.ts:111` (warn only), `EventBusLogger` `event-bus.ts:9` (warn+error, unknown bindings), `MailFetchLogger` `adapters/mail/shared.ts:730` (debug+warn as properties), `Logger` `ai/mcp/stdio-client-manager.ts:22` (four levels, unexported). This is the best-evidenced finding in either document. |
| F3/D11: exactly six operations go through `registerDsl` | **CONFIRMED, exact** | `log debug map schema defer resume`, all in `dsl.ts`. |
| F3: 24 declarations on `StepBuilderBase`, file is 892 lines | **CONFIRMED, exact** | AST walk: 29 declarations, 24 distinct names. `wc -l` is 892. |
| D5: `registerDsl` is called by no package but core | **CONFIRMED** | Zero calls in `packages/ai`, `packages/os`, `packages/cli`. |
| D5: `registerDsl` throws on a name already present | **CONFIRMED** | `dsl.ts:101-105`. |
| F4/D6: only `deferral/` and `telemetry/` have an `index.ts`, 2 of 9 | **CONFIRMED, exact** | |
| F4: `@routecraft/ai` imports core 86 times and never deep | **CONFIRMED, exact** | 86 `from "@routecraft/routecraft"`, 0 matching `from "@routecraft/routecraft/`. Worth noting the mechanism: core's `package.json` `exports` map has a single `"."` entry, so the boundary is enforced by resolution, not culture. That supports P8 more strongly than the register claims. |
| D7: `runtime-version`, `standard-schema`, `compare` and `iterable` have one consumer each | **CONFIRMED, exact** | The four that do not belong reproduce precisely. The three that do, do not; see R14. |
| D8: `StoreRegistry` keys declared across 20 files | **CONFIRMED, exact on files** | 20 files, 45 key declarations (claimed 44; the extra is likely the JSDoc example at `context.ts:42`). |
| C1: nine chain positions and a ten-entry carve-out list | **CONFIRMED, exact** | `CHAIN_SURVIVAL` has 9 keys; `NonChainField` has 10 members. |
| Deletion list: the duck-type check at `deferral/ops-resource.ts:172` | **CONFIRMED, exact line** | |
| Register's "two extension points already work this way" | **CONFIRMED, and understated** | `@routecraft/ai` installs six plugins from outside the package through `registerConfigApplier` (`ai/src/config.ts:70-76`), and both `ai` and `os` use `registerErrorCodes` with `ErrorCodeRegistry` augmentation. Plugin *installation* already satisfies P1 today. |
| Churn table file counts | **CONFIRMED** | pipeline 4, plugins 42, auth 12, operations 41, adapters 106, ai/llm 14, ai/acp 10, ai/mcp 26 all match. |
| ai/acp churn 2,826 at 2.3 edits per file | **CONFIRMED, exact** | The only churn row that reproduces. |
| Design section 5: `agent -> deferral` is the only cross-package edge | **CONFIRMED** | `ai/src/agent/session/store.ts:1` imports `DeferralStore` from `@routecraft/routecraft`. |
| Design section 5: `agent -> mcp` is four imports, `mcp -> agent` is none | **CONFIRMED, exact** | |
| Spike: 31 tests, strict typecheck clean, demo runs | **CONFIRMED** | The spike README still says 26. |

---

## 2. Claims refuted or misleading

Ranked by how much they change the design, not by confidence.

### R1. "Three cycles block this today, every one is `import type`, so there is no runtime cycle"

**REFUTED, and this one is load-bearing.**

```bash
bunx madge --circular --extensions ts packages/routecraft/src     # 71
```

Seventy-one circular dependencies, not three. Eighteen of them are direct
two-node cycles. The named triangle is not among them in the shape stated:
`route.ts` does not import `exchange.ts`, it reaches it through
`adapters/direct/shared.ts -> adapters/direct/types.ts`, and `context.ts`
reaches `route.ts` through `capabilities.ts`.

Worse, there is a **value cycle**, and the design says there is none:

```js
// madge with detectiveOptions: { ts: { skipTypeImports: true } }
// RUNTIME (value-only) circular deps in core: 1
//   exchange.ts > logger.ts
```

`logger.ts:8` imports `getExchangeContext` and `HeadersKeys` as values from
`exchange.ts`; `exchange.ts:9` imports `logger` and `childBindings` as values
from `logger.ts`.

This breaks the proposed core graph at its first line. Section 4 states
`logger -> (nothing)`. Today `logger` has a runtime dependency on `exchange`,
which is four rows below it. The `contracts` module does not fix a value
cycle: `getExchangeContext` is a function, not a type. Breaking it needs a
real decision (move correlation-binding extraction out of the logger, or
invert it behind a registered resolver), and that decision is not in the
design.

The cycles also thread through `deferral/`, `operations/`, `plugins/ops`,
`plugins/http` and `adapters/`, that is, through plugin territory, which the
ten-module core plan assumes sits above core. `deferral/config.ts ->
deferral/ops-resource.ts -> plugins/ops/store.ts -> plugins/ops/indicator.ts`
is not fixed by an interface layer under core.

**Consequence for the plan.** "Breaking the cycle and building the interface
layer are the same job" is false. Step 1 of the sequence is larger and less
certain than stated, and it is the step everything else waits on.

### R2. "Only 12 of 270 test files reach into internals, so about 96% of the suite asserts behaviour"

**REFUTED.** 155 of 266 test files (58.3%) import a non-`index.ts` path under
`src/`. Restricted to `packages/routecraft` alone it is 62 of 139 (45%).

```
ai: 75/91   routecraft: 62/139   cli: 7/15   eslint-plugin: 6/6   os: 2/5
```

This is the number that prices the migration. Section 10 offers it as
evidence that the suite survives "wholesale internal replacement". Under
these figures, roughly half the suite is coupled to the internal module
layout that steps 2 to 7 exist to change. The refactor should be budgeted
with test migration as a first-class cost, not a rounding error.

### R3. I1: "A third party cannot write a server plugin"

**REFUTED as stated.** They can, today, using only the published entry point
and no private import. Proof compiles: `spikes/validation/i1/stranger.ts`.

The reasoning is that `WEB_INGRESSES` is private. It is unexported, but it is
`Symbol.for("routecraft.plugin.server.web-ingresses")` (`plugins/server/registry.ts:29`),
a process-global string-keyed registry, and `getStore`/`setStore` are public
methods on the exported `CraftContext`. Every one of the 45 store keys in the
codebase uses `Symbol.for`; zero use a non-global `Symbol()`. So a stranger
re-derives the key from its string, augments `StoreRegistry`, and publishes
the same map the first party publishes:

```ts
import type { CraftContext, WebIngress } from "@routecraft/routecraft";
const WEB_INGRESSES: unique symbol = Symbol.for(
  "routecraft.plugin.server.web-ingresses",
) as typeof WEB_INGRESSES;
declare module "@routecraft/routecraft" {
  interface StoreRegistry { [WEB_INGRESSES]: ReadonlyMap<string, WebIngress>; }
}
export function acmeServers(ingresses: ReadonlyMap<string, WebIngress>) {
  return { name: "acme.servers", apply: (ctx: CraftContext) => ctx.setStore(WEB_INGRESSES, ingresses) };
}
```

`tsc` reports zero errors in that file.

The accurate claim is narrower and still worth making: **the contract exists
but is unnamed, undocumented and unversioned**, so writing against it is
writing against a private detail that can be renamed without a major version.
That matters, because it changes the remedy. Exporting the keys is a one-line
change per key; it is not a reason to rebuild the plugin system. The plugin
system may still be worth rebuilding, but I1 is not the argument for it.

The same correction applies to J3 ("no to all four") and to A2's "that single
fact is why a third party cannot replace the server plugin".

### R4. "81 core-to-plugin imports across 28 files", the proposed CI ratchet

**MISLEADING on both halves.**

*The count* is an inconsistent mix of two methods. Counting import
statements: operations 52, deferral 9, adapters 9, consumers 2, auth 2,
plugins 1, telemetry 0 = **75**. Counting imported symbols: operations 122,
adapters 15, deferral 13, auth 3, consumers 2, plugins 1 = **156**. The
published figures take operations and adapters from the first method and
deferral and auth from the second. No single method yields 81.

*The file count* reads as 28 offenders. It is the population: 24 core root
files minus the barrel, plus 4 in `pipeline/`. The number of files that
actually import into plugin territory is **12**:

```
builder.ts  client.ts  context.ts  dsl.ts  enablement.ts  exchange.ts
route.ts  step-builder-base.ts  testing-hooks.ts  types.ts
pipeline/executor.ts  pipeline/synthetic-steps.ts
```

Section 10 proposes this number as a CI ratchet that "only goes down". A
ratchet on a figure that cannot be reproduced by two people running the same
command will produce a gate nobody trusts. Pick one method, write the script,
check the script in, and quote the script's output rather than a prose number.

The direction is confirmed and, on the symbol count, understated: operations
is 122 symbols, six times the next-largest, and it is the real coupling.

### R5. "The AI package has a live runtime cycle that must be broken"

**MISLEADING.** There is no runtime cycle. `packages/ai/src/agent/events.ts`
has **zero imports of any kind**, so `agent/run.ts -> llm/providers/index.ts
-> stream-llm.ts -> agent/events.ts` terminates. Madge finds no cycle here at
either setting.

What is real is a **folder-level** cycle: `agent -> llm` is 19 imports,
`llm -> agent` is 3 (two type-only, one value: `normalizeStreamDelta`). That
does block module separation, and the proposed fix (move the streaming-delta
concern to a `streaming` module) is correct and cheap. It should be described
as what it is.

The value cycle that does exist in `packages/ai` is
`surface/cancellation.ts <-> surface/registry.ts`, which neither document
mentions. There are also 13 type-inclusive cycles, 7 of them inside `agent/`.

### R6. "193 cross-folder deep imports", "discounting `shared/`, the real figure is 90, a finite worklist"

**MISLEADING, and the reassurance is wrong.** Counting every relative import
inside `packages/routecraft/src` that resolves into a different top-level
folder at a path other than that folder's `index.ts`:

| Scope | Count |
|---|---|
| All files | **431** |
| Excluding `index.ts` (the barrel, which must reach at files) | **312** |
| Excluding the barrel and `shared/` targets | **239** |
| Core root files only, barrel included | 197 |
| Core root files only, barrel excluded | 78 |

193 is close to the 197 figure, which is the least meaningful cut: 119 of
those 197 are the package barrel doing its job. The figure that measures the
pathology is 312, and the worklist after discounting `shared/` is 239, not
90. Under any method the number of distinct target files reached is 125.

### R7. F6: "the adapters row is the control group, and it proves the thesis"

**NOT REPRODUCIBLE, and it inverts.** Running the register's own footer
command over a full clone:

| Subsystem | Churn | Files | Edits/file |
|---|---|---|---|
| routecraft/pipeline | 3,447 | 4 | 10.2 |
| ai/mcp | 18,155 | 26 | 9.4 |
| ai/agent | 18,457 | 30 | 8.9 |
| ai/llm | 4,920 | 14 | 6.7 |
| routecraft/operations | 12,839 | 41 | 6.4 |
| routecraft/auth | 3,188 | 12 | 5.1 |
| **routecraft/adapters** | **27,875** | **106** | **5.0** |
| routecraft/plugins | 12,796 | 42 | 3.8 |
| ai/acp | 2,826 | 10 | 2.3 |
| **routecraft/deferral** | 6,691 | 19 | **1.2** |

Adapters does have the highest raw churn, as claimed. It does not have the
lowest rework rate: it is mid-table at 5.0. The lowest is `deferral/` at 1.2,
which is the subsystem the entire design says is the most tangled in the
codebase.

The reason is the failure mode the register itself withdrew as O3. `deferral/`
was created by the rename from `suspension/` about a month before the
measurement, so its files have had almost no time to accumulate edits. The
register caught that a completed rename distorts churn, then left the
distortion in the row it calls its control group, and still lists
`routecraft/suspension` as a live subsystem with 19 files when the directory
does not exist and 19 is now deferral's file count.

**Consequence.** F6 is the only evidence offered that "a real interface
prevents rework". It does not survive its own command. The thesis may still
be true; this table is not the reason to believe it. Either re-derive it with
rename following (`--follow`) and a stated commit window, or drop it and rest
the case on section 2, which does survive.

### R8. "663 exports across an 846-line `index.ts`"

**REFUTED.** 833 lines, **598** distinct exported names, no `export *`, no
inline declarations. `packages/routecraft/package.json` has a single `"."`
export, so there is no second entry point contributing names.

### R9. "24 declarations on `StepBuilderBase` and 48 on `RouteBuilder`", roughly seventy

**REFUTED on the second half.** AST walk over `builder.ts`: `RouteBuilder`
has 35 member declarations and **30 distinct names**, not 48. `RouteBuilder
extends StepBuilderBase`, so the user-visible surface is 24 + 30 = **54**
distinct methods, or 64 declarations counting overloads. The gap is real and
large; "roughly seventy" overstates it by about a third.

### R10. "202 references across 14 core files: exchange.ts 36, error.ts 32, context.ts 29, route.ts 18, executor.ts 15"

**NOT REPRODUCIBLE; the direction is understated.** The file count is exactly
right at 14. The reference count is not: a raw case-insensitive count of
`defer` over those files gives **420**; stripping comments gives **218**. The
per-file ranking is different under both methods, and `error.ts` dominates
either way (83 raw), not `exchange.ts`.

If the intent was to contrast with telemetry, the contrast stands and is
sharper than published: telemetry is at 1 code reference, deferral at 218 to
420. State the method and the figure will hold.

### R11. I4's `POINT_SURVIVAL` does not exist in the tree

`grep -rn POINT_SURVIVAL packages/` returns nothing. It lives only in PR #818,
which is halted in draft. I4 is presented in section 2, whose stated standard
is "binary claims, each checkable against a named file", and the register's
own closing standard is "every entry has to be confirmed against the current
tree before it earns a place here". This one cannot be.

The structural half is confirmed: `chain-policy.ts:43` is
`type ChainField = Exclude<keyof RouteDefinition, NonChainField>`. Say that a
parallel table was *required by* the halted work and cite the PR, rather than
citing a file that does not carry it.

### R12. C1: "`RouteDefinition` carries 21 fields... fifteen cross-cutting... five deferral resolver outputs"

**REFUTED.** `route.ts:168` declares **19** fields. The split is 6 identity
and wiring (`id sources steps consumer discovery enablement`), 9 chain
positions, 3 deferral resolver outputs (`deferSteps reentrantDeferSteps
usesResume`), 1 principal flag. Thirteen cross-cutting, not fifteen; three
deferral outputs, not five.

### R13. I6: "1,314 lines to implement `DeferralStore` twice versus 362 for `SessionStore`"

**MISLEADING, and the comparison is not like for like.** The deferral figure
is 1,289 (`sqlite-store.ts` 836 + `memory-store.ts` 453), not 1,314.

More importantly, the 362 omits `packages/ai/src/agent/session/store.ts`, 242
lines, which is *the typed semantics layer over the two stores a session
touches*. That layer is exactly what D10 proposes deferral acquire when the
15 methods "move from the store contract into the plugin, written once
instead of once per backend". The comparable total for sessions is 604, not
362.

So the honest saving is roughly 1,289 collapsing to a generic `RecordStore`
adapter pair plus a deferral semantics layer, call it 850 to 1,050, with the
real win arriving at the *third* backend rather than the first. That is still
a good argument. Stated as 1,314 versus 362 it implies a 3.6x reduction that
D10's own text contradicts two paragraphs later.

### R14. D7: `shared/` consumer counts

**Half refuted.** The four files that do not belong reproduce exactly at one
consumer each. The three "genuinely shared" do not:

| File | Register | Actual (distinct consumers) |
|---|---|---|
| `duration` | 11 | **35** |
| `stale-options` | 6 | **11** |
| `abort` | 6 | 6 |
| total imports | 103 | **130** |

The proposed rule (a utility earns `shared/` at its third consumer) is
unaffected and is a good rule.

### R15. `CHAIN_SURVIVAL`'s nine keys are not nine chain positions

Three of the nine are **buckets**: `preParseFilters`, `postParseFilters`,
`postFromFilters`. The pre-from chain standard names eleven positions
(`error authorize parse input throttle circuitBreaker retry timeout
concurrency cacheCheck cacheStore`), and the bucket entries justify a
whole-bucket policy by citing one member each, verbatim: `preParseFilters`
says `"authorize (#2)"`, `postParseFilters` says `"cacheCheck (#9)"`.

**Consequence for the design.** "With survival declared on the contribution,
there is one table and it is derived" understates the work. Moving to
per-contribution survival forces a decision for every position currently
hidden inside a bucket, and nobody has made those decisions. Section 11's
open question about ordering expressiveness should be widened to cover
survival, which is the harder half.

### R16. Minor line-number drift

`registry.ts:576` is 574. `index.ts:256` is 247. `deferral/types.ts:523` is
468. `context.ts:105` is 104. `config-applier.ts:89` is 97. `context.ts:220`
is 214. `dsl.ts:41` is 42. `builder.ts` is 1,899 lines, not 1,892. None of
these change a conclusion; together they suggest the documents were written
against a slightly earlier tree and should be re-pinned to a commit.

---

## 3. Principles: keep, amend, strike

### Keep as written

**P2 (core is lifecycle and interfaces), P5 (reuse is optional and
unprivileged), P8 (a boundary that is not mechanically enforced does not
exist), P9 (an extension point core does not use to build itself is
unproven).**

P9 is the strongest of the nine and does the most work. P8 is well evidenced
by the one boundary that already holds: `@routecraft/ai` never deep-imports
core, and the reason is the single-entry `exports` map, not discipline.

### Amend

**P1. Zero difference between inside and outside.** The executable test as
written ("if it compiles and its tests pass, the interface is real; if it
needs one private import, that import is the gap") is too weak, and R3 shows
why: a third party can already write a server plugin with no private import,
by re-deriving a global symbol from its string. That passes the test and
proves nothing, because the thing it depends on is not a contract.

> **Amended P1.** Anything a first-party package can do, a third party can do
> through API that is exported, documented and covered by the version policy.
> A capability reachable only through a name that is not exported is not
> reachable, whatever the module system permits.

This also sharpens the acceptance test in section 10: extraction must depend
only on exported symbols, and the ratchet should count *undocumented
contract surfaces* alongside private imports.

**P4. One plugin interface, tiered by declaration.** The principle is right
and the spike already violates it. There are two interfaces in the spike:
`Plugin` (used by the kernel) and `TypedPlugin` (used by `derivedBuilder`).
They share no members, nothing correlates them, and `derivedBuilder` ignores
`dependsOn` entirely, so it will hand you a `defer` method for a plugin set
the kernel would refuse to start (`spikes/validation/test/spike-defects.test.ts`).
That is the two-halves bug this work exists to remove, reintroduced by the
fix for it.

> **Amended P4.** One plugin interface, and the type-level declaration of what
> a plugin contributes is *derived from the same value* that is installed.
> Two shapes that must agree is the bug, whether they are two interfaces or an
> interface and a `declare module`.

Section 5 of this report shows this is achievable.

**P6. Core knows about dependency, not about capability.** As written it is
contradicted by the design itself. `InterventionPoint` is a closed set of five
names, and `"wrapper"`, `"step"`, `"handler"`, `"exchange"` and `"source"` are
capabilities. Core does learn them; it just does not learn `"store"`.

> **Amended P6.** Core knows the shape of a run and the dependencies between
> plugins. It knows nothing about the meaning of anything that occupies a
> position in that run.

That is defensible and is what the design actually builds. The unamended
version invites the objection that five closed points are a tier system with
better marketing.

**P7. Every plugin can be declined and replaced.** The decline half is proven,
in the spike and in the current codebase (config-applier). The replace half is
not built and not tested. The spike's "a stranger's plugin substitutes for a
first-party one" test installs the stranger *instead of* the first party, with
the same id and the same `Symbol.for` name. That is absence plus
impersonation. With both installed, the last `provide` wins with no
diagnostic, which is exactly I9's defect that the design says must be fixed
(proven in `spike-defects.test.ts`).

> **Amended P7.** A replacement declares itself one. Core refuses two
> undeclared providers of the same token, naming both, and accepts a declared
> replacement with a recorded diagnostic.

### Strike the slogan, keep the operative version

**P3. Everything that is not core is a plugin, including main.** The headline
has four conceded exceptions in its own document before anything is built: the
kernel (cannot be a plugin by construction), the event bus (stays in core
against the rule), `from` (a core position), and the exchange and route
contracts. A principle with four exceptions written next to it is not doing
work.

The operative sentence two lines below it is the real principle and is
checkable: **"Core defines the kinds; nobody in core defines an instance."**
Keep that, delete "everything is a plugin" as a statement of principle, and
keep it only as the name of the effort.

### Tensions between principles

1. **P4 versus S2.** Declarative steps and imperative wrappers split the one
   interface. The design flags this and offers only convenience. Section 5(c)
   resolves it.
2. **P6 versus the five closed points.** Addressed in the amendment above.
3. **P8 versus the `token<T>()` decision.** The design replaces declaration
   merging because "there is no shared interface for two packages to collide
   in". There is: `token(name)` is `Symbol.for(name)`, a process-global
   string-keyed registry. Two packages choosing `"acme.cache"` collide, and
   the collision is now **silent at runtime** where declaration merging gave a
   **compile error**. Proven:
   ```ts
   const mine = token<{a: string}>("acme.thing");
   const theirs = token<{b: number}>("acme.thing");
   expect(mine.key).toBe(theirs.key);   // passes
   ```
   P8 says a boundary that is not mechanically enforced does not exist. By
   P8's own standard, tokens are a weaker boundary than what they replace.
   The token design is still right for other reasons (no load-order
   dependency, type travels with the import), but it needs a collision
   mechanism: core should refuse a second `provide` of a token whose declared
   provider differs, and the token name should be namespaced to the package.
4. **P5 versus P1.** Not a real tension, but worth stating: the abstract base
   test ("lose nothing but convenience") is unfalsifiable until there is an
   abstract base. Add it to the acceptance tests in section 10.

---

## 4. Proof-of-concept critique

The spike is well built for its size, it executes, and its four
infrastructure findings (F4 to F7) are real. The problems are in what it
claims to have shown.

Everything below is backed by a passing test in
`spikes/validation/test/spike-defects.test.ts` and
`spikes/validation/test/break-it.test.ts` (15 tests).

### 4.1 The stranger is not a stranger

`src/plugins/audit.ts` does `import { STORE_API } from "./stores.ts"`, a
relative path inside the spike's own source tree. There is no package
boundary, no `exports` map, and no published entry point, so "written against
the published contracts only" is not checked by anything. The spike's own
governing test, P1's ("move one first-party provider into its own workspace
package depending only on the published entry point"), is not what the spike
runs. Making `audit` a second workspace package with its own `package.json`
is an hour of work and would turn the claim into a check.

### 4.2 The deferral plugin is deferral in name only

- Its admission wrapper is `wrap: (next) => next`. It does nothing.
- Its `defer` step writes a store row and lets the pipeline continue.
- So does its error handler.

Real deferral stops an exchange at step N, persists a continuation, and
resumes at step N+1 without repeating the work before it. That is the whole
reason deferral is at 202 references across 14 core files. Section 9 step 5
calls rebuilding deferral "the acceptance test: if this works, the
architecture is real". The spike has not tested it.

### 4.3 The contracts cannot express deferral, and this is the headline finding

Four tests in `break-it.test.ts`, all passing, all demonstrating a failure:

1. **A contributed step cannot halt the pipeline.** `Step.run` returns
   `Promise<void> | void`. There is no outcome value, no exchange flag the
   executor reads, and no handler point between steps. The only signal a step
   can send is a throw, which is a failure, not a halt.
2. **A wrapper can skip everything or nothing, never a suffix.** A wrapper
   receives `(next: Pipeline, route: RouteView)`. `next` is the whole composed
   pipeline; `RouteView` exposes `stepLabels: readonly string[]` and nothing
   executable. There is no way to stop at step 2 of 3.
3. **Resuming re-runs the work already done.** `Runtime.assemble` builds a
   closure that loops the whole step list from index 0. No contribution kind
   supplies an entry offset, and there is no API meaning "continue this
   exchange at step 2".
4. **The `source` intervention point does not exist.** The design names five
   points "closed on purpose". The spike's `InterventionPoint` is
   `"wrapper" | "step" | "handler" | "exchange"`. `RouteSpec.source` is
   declared and **never subscribed** by the runtime; the test proves
   `subscribe` is never called.

So the two things section 11 names as the risks that could kill the design,
halt/continue and `from`, are both absent from the spike, and the second is
absent while `docs/DESIGN.md` section 7 says F8 moved it out of the
not-answered list. F8 answers *type flow* in four isolated files under
`src/typed/` that the kernel never touches. It does not answer how a source
becomes a contribution.

**What this needs before step 4 is designed.** A `Step` outcome
(`continue | halt(continuation)`), a continuation value carrying the entry
index and each participant's serialized state, and an executor entry point
that takes one. That is C2's "one continuation value computed once at park
time" from the register, and it is a *sixth* thing core must own that the
five closed intervention points do not cover. It should be in section 6, not
discovered in step 5.

### 4.4 Tests that do not test what their JSDoc claims

**"resume is compare-and-swap"** (`principles.test.ts`). The two resumes are
sequential and awaited. `Deferrals.resume` reads the row, returns false when
`status !== "waiting"`, and only then reaches `put(..., { ifVersion })`. The
second call short-circuits on the status guard and never reaches the CAS.
Proof: the same three assertions pass verbatim against a store whose `put`
ignores `ifVersion` entirely
(`spike-defects.test.ts`, "the spike's CAS test passes against a store with no CAS").

To its credit the property does hold: raced with `Promise.all` against the
real store, exactly one caller wins. The defect is in the test, not the code,
and the spike never checks the concurrent case.

**"declared constraints reproduce the fixed chain"** (`chain.test.ts`). The
JSDoc says it reproduces the documented pre-from order, which the README
gives as `error -> retry -> timeout -> concurrency`. The assertion is
`[retry, timeout, concurrency]`. `resilience` declares
`retry.after = ["routecraft.error"]` and nothing contributes
`routecraft.error`, so the constraint evaporates under F4 and the test
asserts the evaporation as success. The spike's own demo chain carries **two**
unmatched constraints it never reports (`routecraft.error` and
`routecraft.authorize`); see section 5(e), where a 60-line change surfaces
both.

**"a stranger's plugin substitutes for a first-party one"**. Covered in P7
above. It tests absence, not substitution.

**"a declared-but-unregistered step still compiles and is absent"**
(`typeflow.test.ts`). The body reads the property through
`as unknown as Record<string, unknown>`, so it never demonstrates that
`flow.phantom()` typechecks. The equivalent test in `builder.test.ts` does it
properly with an uncast `builder.ghost()`. Delete the weaker one.

### 4.5 Defects the spike has and does not test

All proven in `spike-defects.test.ts`:

1. **A duplicate plugin id is silently dropped.** `topoSort` keys `state` by
   id, so the second plugin with the same id is marked done and never pushed,
   while `byId = new Map(...)` keeps the *last*. Installation uses the first
   and dependency resolution uses the last. A step-name clash throws; a
   plugin-id clash is silent.
2. **Two providers of one token resolve by install order, silently.** No
   `replaces` field exists. This is I9's defect, unfixed.
3. **An exchange-extension token collision is silent** while a step-name
   collision throws. Two of the four points guard their namespace; two do not.
4. **The wrapper chain is re-sorted and re-composed for every exchange.**
   `deliver -> assemble -> compose -> orderedWrappers` runs a topological sort
   per exchange. Section 11 assumes "the chain is built once per route" and
   expects the cost to be nil. The spike does not do that, so the open
   question has not been narrowed at all.
5. **The derived builder cannot branch.** The proxy returns itself and mutates
   one captured array, so `b.transform(f)` and `b.transform(g)` share every
   step and `left.build() === right.build()`. `choice`, `multicast` and
   `split` all need branching.
6. **The derived builder's duplicate handling contradicts the kernel's.**
   `StepsOf` intersects step maps, so two plugins declaring `transform`
   produce an overload at the type level while the runtime `Map.set` keeps the
   last. The kernel throws `DuplicateStepError` for the same pair.
7. **The derived builder ignores `dependsOn`.** See P4 above.
8. **`token()` collides globally by string** with no compile-time check. See
   P8 above.

### 4.6 Smaller things

- `stop()` runs `onTeardown` callbacks *before* `plugin.stop()`. A plugin's
  `stop` hook therefore runs after the resources its `apply` registered for
  teardown have been disposed. Reverse it, or document why not.
- `EventBus.emit` iterates a `Set` that a handler can mutate by disposing
  itself mid-emit.
- Exchange extension factories run for every installed plugin on every
  exchange, eagerly. Today's `ex.deferral` is not paid for by routes that
  never defer. Make them lazy on first `use`.
- Handlers have no ordering mechanism at all. Wrappers get declared
  constraints; handlers get install order. Error-handler order decides which
  plugin classifies a failure first, so this needs the same treatment.
- `registerFluent("upper", ...)` runs at module import time in
  `builder/index.ts`, reproducing today's import-order side effect in the file
  whose purpose is to critique it.
- Two of the five wrappers in the headline demo line (`admission`,
  `concurrency`) are `(next) => next`.
- The spike README says 26 tests; there are 31.

### 4.7 What the spike genuinely establishes

Worth saying plainly, because the criticism above is dense:

- One topological sort really does serve both graphs (F7). That is a good
  finding and the code is clean.
- Freezing contributions at start (F6) is correct and the error is legible.
- The missing-dependency error naming both sides works and is better than
  `undefined is not a function`.
- Teardown of only-applied plugins is correct and tested.
- The observe-only plugin genuinely needs nothing but the bus, which is F1's
  thesis demonstrated rather than asserted.
- F2 (a union erases its own generic, fixed with an overload) is a real
  TypeScript finding that will recur, and catching it early is worth the spike
  on its own.

---

## 5. Alternatives to the five awkward things

All five have better answers than the ones recorded. Code for each is in
`spikes/validation/src/`, compiles under the spike's strict settings, and is
covered by 22 passing tests.

### (b) The DSL trade in F8. The dichotomy is false.

**F8 claims:** in TypeScript today a DSL can be fluent AND body-typed AND
plugin-extensible, or it can be sound, but not both.

**This is refuted.** `spikes/validation/src/e-hkt.ts` is all four, and
`e-hkt.check.ts` proves each one with a compile-time assertion or a
`@ts-expect-error` that `tsc` verifies fires.

The mistake in encoding A is real but avoidable. `infer` against a *generic
function* instantiates its type parameters at their constraints, which erases
the body relationship. The fix is to stop asking TypeScript to recover a
type-level relationship from a value-level generic, and to have the plugin
state it directly as a defunctionalised type-level function. The plugin
declares two computed members on an interface that reads the incoming body
through `this`:

```ts
export interface StepSig {
  readonly Body: unknown;                   // supplied by the builder
  readonly Args: readonly unknown[];        // supplied by the builder
  readonly params: readonly unknown[];      // computed, may depend on this["Body"]
  readonly out: unknown;                    // computed, may depend on this["Args"]
}

type ParamsOf<S extends StepSig, Body> = (S & { readonly Body: Body })["params"];
type OutOf<S extends StepSig, Body, A extends readonly unknown[]> =
  (S & { readonly Body: Body; readonly Args: A })["out"];

export type Builder<Steps, Body> = {
  [K in keyof Steps]: <const A extends ParamsOf<SigOf<Steps[K]>, Body>>(
    ...args: A
  ) => Builder<Steps, OutOf<SigOf<Steps[K]>, Body, A>>;
} & { build(): readonly Step[]; bodyType(): Body };
```

A plugin then ships one value carrying both halves:

```ts
interface TransformSig extends StepSig {
  readonly params: [fn: (body: this["Body"]) => unknown];
  readonly out: this["Args"] extends readonly [(body: never) => infer R] ? R : never;
}

export const operations = {
  id: "routecraft.operations",
  steps: {
    transform: { make: /* ... */ } as StepDef<TransformSig>,
    filter:    { make: /* ... */ } as StepDef<FilterSig>,
    header:    { make: /* ... */ } as StepDef<HeaderSig>,
  },
} as const satisfies TypedPlugin;
```

What `tsc` confirms, with negative controls (flipping one expectation to the
wrong type produces `TS2344`; removing one `@ts-expect-error` produces
`TS2578` or the underlying error):

- **Fluent.** One method chain. No pipe, no free functions, no arity limit.
- **Body flows.** `{subject, size} -> string -> string -> string -> number`
  across `transform`, `filter`, `header`, `transform`, `defer`, with every
  lambda parameter inferred and never annotated.
- **Plugin-extensible.** A stranger's `acme.redact` declares
  `params: [fields: readonly (keyof this["Body"])[]]`, so its argument is
  type-checked against *the body at that point in the chain*. Passing
  `["size"]` after a `transform` that made the body a `string` is a compile
  error. No core change, no `declare module`.
- **Sound, three ways.** A declined plugin's step is absent from the type
  (`@ts-expect-error` on `withoutDeferral.defer`). There is no way to declare
  a step without implementing it, because `steps` is a value and its keys are
  the runtime registry's keys. And there is no global namespace to collide in,
  because `Steps` is a type parameter rather than a merged interface.

**On the scale worry.** The design says the derived builder is "untested at
forty operations, and that is where it may fall over". It does not.
`spikes/validation/src/scale.check.ts` generates 40 step definitions and a
40-deep chain; the body type threads correctly all the way down (field access
four levels into the result type checks) and `tsc --noEmit` over the whole
validation package takes **1.3 seconds**.

**What F8's table conflates.** There are two distinct soundness gaps and the
table treats them as one:

| Gap | Symptom | Fixed by |
|---|---|---|
| G1 | A method declared in a merged interface and never registered compiles and throws | Deriving the declaration from the registered value |
| G2 | A method exists on the type whether or not the plugin is installed in *this* context | Parameterising the builder over the plugin set |

Encoding C has both. Encoding B (`derivedBuilder`) fixes G2 and does not
attempt the body type. Encoding E fixes both and carries the body type. The
conclusion "every framework with this shape has made the same trade" is not
a reason; it is an observation about frameworks that predate `const` type
parameters (TS 5.0) and interface-`this` defunctionalisation.

**Costs, stated honestly.** The plugin author writes a `StepSig` interface
alongside the factory, and the factory needs a cast to `StepDef<Sig>["make"]`
because the runtime signature is erased. That is more ceremony than
`declare module`, and it is unfamiliar. A `defineStep` helper can hide most
of it. The runtime is still a `Proxy`, with the branching defect noted in 4.5
to fix (return a new proxy over an immutable step list rather than mutating a
captured array). And error messages when a signature does not match get
long, which is the standard cost of type-level programming.

**Recommendation.** Do not accept F8's conclusion. Re-run the `from` spike in
section 9 step 1 against encoding E rather than against A to D. If encoding E
survives `from`, P3's biggest stated risk is gone.

### (a) `ex.deferral` becoming `ex.use(DEFERRAL_EXT)`

**The premise is false and the answer is free.** "Core cannot type a property
whose name it does not know" is true only if the exchange type is fixed. It
is not: a route author touches the exchange through the builder, and the
builder already carries a type parameter derived from the plugin set. Add a
second one for extensions and `ex.deferral` comes back as a real, checked
property.

`spikes/validation/src/a-exchange.ts` and `.check.ts`. A plugin declares its
extension as an ordinary named member of a value:

```ts
export const deferralPlugin = {
  id: "routecraft.deferral",
  extensions: {
    deferral: (exchange: Exchange<unknown>): DeferralAffordance => ({ /* ... */ }),
  },
} as const satisfies ExchangePlugin;
```

and the exchange a step sees is `Enriched<Body, ExtOf<Installed>>`. `tsc`
confirms:

```ts
ex.deferral.defer("needs approval");   // typed, by name
ex.trace.spanId;                       // a stranger's extension, same treatment
// @ts-expect-error  defer takes a string
ex.deferral.defer(42);
// @ts-expect-error  nothing contributes `cache`
ex.cache.get("k");
// @ts-expect-error  deferral declined, so the property is gone
lean.deferral.defer("nope");
```

This is **strictly better than today**, not merely equal. Today `ex.deferral`
is on the type whether or not deferral is installed, because it is a fixed
member of a core interface. Here, declining the plugin removes it. So S4 is
not a taste judgement against a soundness cost; it is a regression that does
not need to be paid, and the alternative fixes an existing unsoundness on the
way past.

The one thing it costs: the extension type must be threaded to wherever a
step body is written, which means step lambdas receive an exchange type
parameterised by the plugin set. That is the same plumbing (b) already needs.
Do (b) and (a) together or neither.

### (c) Declarative steps versus imperative wrappers

**The split is not steps versus wrappers.** It is "value known at module
load" versus "value known after dependency resolution". A step factory closes
over nothing, so it can be a literal. A wrapper closes over the API the
plugin built from `ctx.require(...)`, so it cannot be a literal *at module
load*. A thunk over the resolved dependencies erases the distinction.

`spikes/validation/src/c-unified.ts` and `.check.ts`:

```ts
export const deferral = definePlugin({
  id: "routecraft.deferral",
  needs: { store: STORE_API },
  provides: DEFERRAL_API,

  setup: ({ store }) => ({ defer: async (reason: string) => { /* ... */ } }),

  steps:    (api) => ({ defer: (reason: string): Step => ({ /* uses api */ }) }),
  wrappers: (api) => ({ "routecraft.admission": { after: ["routecraft.authorize"],
                                                  before: ["routecraft.retry"],
                                                  wrap: (next) => /* uses api */ } }),
  handlers: (api) => ({ "routecraft.deferral.recovery": { point: "error", handle: /* uses api */ } }),
  exchange: (api) => ({ deferral: () => ({ defer: api.defer }) }),
  health:   (api) => ({ up: api !== undefined }),
});
```

`tsc` confirms three things:

- `setup`'s return type flows into every thunk with no annotation anywhere.
- Every one of the five points is declarative data on one object. `apply` and
  `ctx.contribute` disappear from the common case entirely.
- The builder still derives through the thunk:
  `UnifiedBuilder<StepsOfUnified<[typeof deferral]>>` has `defer`, rejects
  `defer(42)`, and rejects `transform` because no installed plugin declares it.

That is the principled unification, and it is stronger than the current
design in a second way: `needs` makes the dependency a *token* rather than a
plugin id, which is A2's "naming a contract permits replacement, naming a
plugin forbids it". The design's `dependsOn: ["routecraft.stores"]` names a
plugin, which A2 explicitly says not to build on, and then section 6 builds
on it. That contradiction should be resolved before step 3.

### (d) `pipe` needing an overload per arity

Three answers, in order of usefulness.

**1. The question is moot under (b).** A method chain has no arity. Encoding E
takes 40 chained calls with one type and zero overloads.

**2. A single variadic signature type-checks but cannot contextually type.**
`spikes/validation/src/d-variadic.ts` implements
`chainBroken<In, const Fns>(start, ...fns: Fns & Threaded<Fns, In>)`. It
compiles and validates when every lambda is annotated. It cannot contextually
type an unannotated parameter, because `Fns` and `Threaded<Fns, In>` are
mutually dependent so `Fns` infers as the empty tuple. This is recorded as a
**checked negative**: the `@ts-expect-error` on the implicit-`any` fires
today, and if a future TypeScript fixes inference the directive becomes
unused and the build breaks, which is the point.

**3. The curried form is unbounded, single-signature and fully inferred.**

```ts
export interface Curried<Body> {
  <Out>(fn: (body: Body) => Out): Curried<Out>;
  done(): Flow<Body>;
}
```

`d-variadic.check.ts` chains eight operators with every parameter inferred and
asserts the final body type. One signature, any arity. The cost is `.done()`
and a call per operator instead of a comma.

**And the meta-point.** Even if none of these worked, an overload set is not
a design defect. `Promise.all`, rxjs `pipe` and lodash `flow` all ship
generated overloads, and generating twenty of them is a twenty-line script.
Listing it as one of five things the design is stuck on overstates it.

### (e) Ordering constraints naming an absent plugin

**The binary is false.** Fatal and inert are not the only options, and the
third costs one array and one accessor: **stay inert and record**.

`spikes/validation/src/e-constraints.ts`, four tests:

```ts
export function unmatchedConstraints(nodes): readonly UnmatchedConstraint[]
export function report(unmatched): string
```

Ordering behaviour is unchanged. What changes is that the silence becomes a
value: readable at boot, printable in the startup report, exposed on the ops
surface, and assertable in a test (`expect(ctx.unmatchedConstraints()).toEqual([])`).
A nearest-neighbour suggestion closes the last gap, because the failure that
matters is not "id I invented" but "id I misspelled" and "id that was renamed
under me":

```
"acme.audit" declares after "routecraft.retrry", which no installed plugin
provides. Did you mean "routecraft.retry"?
```

The rename case is the one neither document raises and it is the worse of the
two. `acme.audit` pins itself with
`after: ["routecraft.retry"], before: ["routecraft.timeout"]`, two string
literals with no type safety and no stability contract. Renaming
`routecraft.timeout` silently relocates every third-party wrapper that
targeted it, in a release that is not breaking by any current policy. The
third test demonstrates exactly that and shows the report surfacing it.

**Proof that this is not theoretical:** run it over the spike's own demo
chain and it finds two unmatched constraints the spike never reports,
`routecraft.error` (declared by the framework's own `resilience` plugin) and
`routecraft.authorize`. The first is in the order the README says the test
reproduces.

**Two further pieces this needs and the design does not have:** constraint
ids must be part of the version policy (renaming one is a breaking change),
and each plugin should declare the ids it *provides*, so core can distinguish
"an id nobody provides" from "an id provided by a plugin you declined".

---

## 6. What is missing entirely

Ordered by when it will hurt.

**1. Versioning of the plugin contract.** Nothing in either document says
what happens when `PluginContext` gains a member, what a plugin declares it
was built against, or how a plugin compiled against 1.0 behaves under 1.2.
For a design whose entire purpose is third parties, this is the largest
omission. It also silently expands the public surface: today it is 598
exported names; after this design it is 598 names *plus* every token name,
every wrapper id, every step name and every handler id, all of them strings,
none of them currently covered by any policy.

**2. Isolation, which A2 promises and the design does not build.** A2 says
"isolation then falls out for free: you cannot read what you did not
declare". In the spike, any plugin can `require` any token it can name and
`provide` over any token at all, including one a first-party plugin already
published (proven in `spike-defects.test.ts`). If isolation is a goal,
`provide`/`require` must be scoped by declaration, and that is a different
registry from the one the spike built. If it is not a goal, remove the claim
from A2, because it will be quoted later as a security property.

**3. Halt, continue and the continuation value.** Covered in 4.3. This is a
sixth thing core must own, and the five closed intervention points do not
cover it. C2 in the register already describes it correctly ("one continuation
value computed once at park time"); the design does not carry it forward.

**4. Handler ordering.** Wrappers get declared constraints; handlers get
install order. Error classification order decides behaviour.

**5. Route-scoped versus context-scoped wrapper state.** Circuit breaker and
concurrency are per-route today. In the spike, one `WrapperContribution`
instance serves every route and `RouteView.optionsFor` returns `unknown`. How
a wrapper keeps per-route state, and who owns its lifetime, is undesigned.
This is the concrete form of section 11's cost question.

**6. Observability of the graph.** No surface lists the installed plugins,
the resolved order, the wrapper chain, the token providers or the unmatched
constraints. Every one of those is a support question, and the ops plugin
already exists to answer that shape of question.

**7. Error taxonomy for boot failures.** Cycle, missing dependency, duplicate
id, duplicate token provider, duplicate step name, contribution after freeze,
unmatched constraint. Seven conditions with no RC codes and no message
policy, in a codebase whose error policy is a standards document.

**8. Streaming and backpressure.** `Pipeline` is `(ex) => Promise<void>`. C1
names SSE streaming on the HTTP source as one of the changes that drove
`executor.ts` to 11 commits and 2,275 lines. If a wrapper has to survive a
streaming body, `Promise<void>` is the wrong shape, and finding that out in
step 4 repeats the mistake the sequence was designed to avoid.

**9. A testing story for plugin authors.** `@routecraft/testing` exists and
the design says nothing about what a third party uses to test a plugin.

**10. Migration.** Steps 2 to 7 change internal module layout that roughly
half the test suite imports directly (R2). There is no codemod, no
deprecation window, no dual-running period, and step 7 ("move ~70 operations
through the step door") is described as "the largest and the least risky"
with no evidence for the second half. Given R9, it is ~54 methods, and given
R2 it touches the most tests.

**11. What breaks in year two.** Two things. First, `InterventionPoint` is
closed at five and a sixth is "a core change by definition"; the first
capability that wants a per-step interceptor, a serializer point, or a
per-exchange resource scope forces one, and there is no process for it.
Second, relative ordering constraints are a global coordination problem that
gets worse with population: with five wrappers the graph is obvious, with
thirty (the realistic number once third parties exist) a partial order leaves
most pairs undetermined, and `topoSort` resolves undetermined pairs by *input
order*, which is plugin install order. That is the same non-determinism I9
complains about, relocated. Core should detect and report an under-constrained
chain, or define a deterministic tiebreak that is not install order.

**12. A problem the proposed architecture creates that the current one does
not.** Today a wrapper's position is wrong only if someone edits
`executor.ts`, which is one reviewed file. After this change, a wrapper's
position is a function of every installed plugin's constraints, so a user
installing an unrelated third-party plugin can silently reorder their
resilience chain. The observability in (6) and the under-constrained
detection in (11) are what make that tolerable, and both are currently absent.

---

## 7. Verdict

**Build it. Do not build it as sequenced, and do not rest the case on section
2 as written.**

Ranked by how much each conclusion should change the plan.

### Rank 1: the two things that must change before any code

**1a. Re-spike `from` against encoding E, not against A to D.** F8's
dichotomy is false and `spikes/validation/src/e-hkt.ts` demonstrates the
contradiction. The design's single largest stated risk, that `from` and type
flow make P3 unreachable, was assessed against an encoding set that excluded
the one that works. Section 9 step 1 is still the right first step; it is
aimed at the wrong target.

**1b. Model halt, continue and the continuation before designing the
intervention registry.** The spike's contracts cannot express deferral
(4.3, four passing tests). Deferral is the acceptance test for the whole
design. Discovering the missing sixth concept at step 5 is precisely the
failure the sequence was ordered to avoid, and the sequence currently walks
into it.

### Rank 2: evidence that must be repaired before it is used to decide

**2a. Section 2 has one refuted claim (I1), one unverifiable claim (I4), and
one claim whose supporting figure is an inconsistent mix of two methods
(I8/D12).** Section 0 says section 2 is the load-bearing evidence and each
item is binary. Two of nine are not. The case still stands on I2, I5, I6, I7
and I9, which all reproduce, but the document should say so rather than
claim nine.

**2b. Fix or drop F6.** The control group inverts under the register's own
command (R7), and the reason is the rename failure mode the register itself
identified and withdrew as O3.

**2c. Re-measure the cycle claim (R1).** It is three orders of magnitude
different from reality in count, and it contains a value cycle the design
says does not exist, in the module the design places at the root.

**2d. Re-measure the test-coupling claim (R2).** It is the migration budget.

### Rank 3: design changes with a proven alternative

Each of the five awkward things has a better answer, with compiling code:

| | Recorded position | Better answer | Proven in |
|---|---|---|---|
| (a) | `ex.deferral` regresses to `ex.use(TOKEN)` | Named extensions derived from the plugin set. Strictly better than today, because declining removes the property. | `a-exchange.check.ts` |
| (b) | Fluent, typed, extensible, sound: pick three | All four, at 40 steps in 1.3s | `e-hkt.check.ts`, `scale.check.ts` |
| (c) | Steps declarative, wrappers imperative, reason is convenience | One declarative shape for all five points, via a thunk over resolved dependencies | `c-unified.check.ts` |
| (d) | One `pipe` overload per arity | Moot under (b); curried form otherwise; checked negative for the variadic form | `d-variadic.check.ts` |
| (e) | Fatal or inert, neither is free | Inert and recorded, with a nearest-neighbour suggestion. Finds two real unmatched constraints in the spike's own demo. | `e-constraints.test.ts` |

Also at this rank: amend P1, P4, P6 and P7 as in section 3, strike the P3
slogan and keep its operative sentence, and resolve the `dependsOn`
contradiction (A2 says do not name plugins, section 6 names plugins).

### Rank 4: the things the design is right about, which is most of it

D12 is correct: core publishes a seam for observing and none for
participating, and that single absence accounts for the rest. The evidence
that survives is enough to carry it. D9 is airtight and should be built
first, on its own, as issue #542, because it is A1 and A3 in miniature and it
is the cheapest possible proof that the team can execute this pattern. A7's
"a foundational plugin is one with a high in-degree" is right and the spike
demonstrates it. A5's layering is right. The packaging tiers in section 5 are
right, and Tier 0 ("if it needs no context lifecycle, it should not be a
plugin") is the single most valuable sentence in the design, because it keeps
most of the codebase out of the plugin system entirely.

### What I would do differently from first principles

Three changes to the shape, not to the intent.

**Make the plugin a value, not a protocol.** The design's `Plugin` is an
object with lifecycle methods and an imperative `apply` that reaches a
privileged context. `definePlugin` in section 5(c) is a plain data structure
with one thunk per point. Everything core needs to know about a plugin,
including what it contributes, what it needs, what it provides and what
methods it adds to the builder, is then readable from the value *and from its
type*, without running anything. That is what makes the builder derivable, the
graph inspectable, and the two halves impossible to desynchronise. It is also
what makes a static check possible: a lint rule can read a plugin's manifest
where it cannot read what `apply` did.

**Make the continuation a first-class core concept, alongside the exchange.**
The register already found this (C2: six carriers of "where is this exchange
and what re-runs"). The design drops it and then proposes deferral as the
acceptance test. Core owns the exchange lifecycle; a suspended exchange is
part of that lifecycle, not a plugin's private business. One continuation
value, computed at park time, carrying the entry index and each participant's
serialized state, is a core contract. Deferral is then a plugin that produces
and consumes it, and so is debounce, and so is the error channel, which is
what C2 found empirically.

**Name the contract surface and version it before opening the door.** The
whole exercise is about third parties. The thing third parties will actually
depend on after this change is not the 598 exported names, it is a set of
strings: token names, wrapper ids, step names, handler ids, constraint ids.
Today that surface is zero and the coupling hides in private symbols. After
this change it is a few hundred strings with no policy. Decide now whether a
wrapper id is public API (it is), put the ids in exported constants so a
rename is a compile error rather than a silent relocation, and put them under
the version policy in `.standards/api-stability.md`. The alternative is
discovering in year two that the ordering graph is unversioned public API,
which is the same category of mistake as the pino type in the public surface
that D9 is about.

---

*Reproductions, counter-examples and 22 passing tests: `spikes/validation/`.
Nothing outside `spikes/` was modified.*
