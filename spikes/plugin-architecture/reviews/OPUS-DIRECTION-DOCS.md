# Review: the direction docs, the internals figure, and the direction

Measured on `dd53ef3910eb2b665b9b9a38b28275be3dd550a1` (`validation/round-six`),
confirmed with `git rev-parse HEAD` before anything was read. Every fact below
was produced on that commit. Executable evidence is in
`validation/direction-docs-review/` (ten probes, D1 to D10, all passing, which
means each confirms the behaviour it names). The spike's own `bun run verify`
passes at the same commit: 111 tests, 141/141 mutants killed, boundaries
green, 15/15 compiler negative controls, the diagram check green
(`validation/direction-docs-review/verify.log`).

## Verdict

**The docs explain the architecture well enough for a consumer to follow it
and to challenge it, but not well enough to hold it in their head: they
describe the parts clearly and never show how the parts meet at runtime, and
that gap is where every one of my first-read confusions came from.**

The pages are unusually honest (the Demonstrated / Intended / Migration
decision labels do real work), the prose is tight, and the "What is not
promised" section is the best page in the set. What was missing was the
inside: which column of the kernel does what, where the error ring sits
relative to the wrappers, what the door actually is, who runs the sweep. I
added a figure of that (`figures/inside.tsx`, placed in `02-anatomy.md`) and
the text it implied. Seven statements in the pages and four figures were
wrong against the proof of concept; I corrected them, and they are listed
under "What I changed".

## 1. First read, before the record, the reviews or the code

Written down after reading `docs/direction/` only, in order. Kept as written,
with what the code later said in the right-hand column.

| # | First-read reaction | What the code said |
|---|---|---|
| 1 | Page 01 and its figure say a plugin does "exactly four things" and "there is no fifth socket". Page 02 then lists **five** contracts (point is the fifth). Which is it? | Six. `PluginContext` also hands every plugin `execution` (`deliver`, `resume`, `sweep`, `errorChannel`), `contracts.ts` `PluginContext`. The docs never name it. **Real gap.** |
| 2 | I cannot tell who owns deferral. The kernel computes the site and writes the record (04), the deferral plugin sweeps (04), "the store's default deadline" is set by "a plugin". Kernel, deferral plugin, store plugin and records plugin each own part and no page says which part. | Kernel owns park, resume and the sweep algorithm (`Runtime.park`, `runResume`, `runSweep`). The deferral plugin provides `CONTINUATIONS` over `RECORDS`, owns `.defer()`, the default ttl, the boot report and the timer that calls `ctx.execution.sweep()`. SQLite provides `RECORDS`. **Docs gap**, now drawn. |
| 3 | The door. Page 03 says it is an admission handler; the resume figure puts it in a "runtime" lane; page 04 shows `.resumable()` without saying whose method; page 05 says `auth` contributes it. If the door is admission before the claim and re-admission runs after, does admission run twice on a resume? How does a handler see "the record without its body"? | The door **is** the admission ring, run by the kernel over the ingress with `HandlerInfo.resume` (`ResumeView`, stage `door`) before the claim; re-admission runs only for a park raised at the door (stage `continuation`, `site === null`). A park at a step does not re-run admission. **Docs gap**, now stated in 02. |
| 4 | `requires` is on the descriptor and `c.require()` is in `bind`; resolution happens "before anything binds". The installation figure says `bind` declares points, page 02 says points are static. | `requires` declares, `c.require` fetches and refuses an undeclared port (`UNDECLARED_REQUIRE`). Points are registered in the `Host` constructor. The figure was **wrong**; fixed. |
| 5 | Wrappers: "the order is declared, not positional" versus a step retry that applies "in the order you wrote them". And where is the error ring relative to retry? Does a retry swallow a failure before an error handler can park it? | Two mechanisms share the word "wrapper": route wrappers are contributions; a step-level `.retry()` is `retryStep` decorating one step. The error ring is outside the whole chain (`Runtime.enter` catch). Probe **D3**: a failure the retry absorbs never reaches the error ring. **Unstated**, now stated. |
| 6 | "Exit ring": does it run on a refused, failed or parked run? | Only over completed exchanges. Probe **D4**. **Unstated**, now stated. |
| 7 | Four run kinds on page 03; the figure shows three. Its footer says "nothing in the chain runs on the error channel"; the text says each contribution declares its own survival. | Figure omitted `debounce`. Probe **D8**: a third-party wrapper with `allRuns` runs on the error channel; the footer described our wrappers, not the kernel. **Figure wrong**; fixed. |
| 8 | The failures table lists five decline codes; the figure shows four. | `DEFER_IN_PATH` missing. Fixed. Also: `DEFER_IN_PATH` and `DEFER_IN_FANOUT` are thrown when a **step** returns `defer`, not when an error handler parks; the table presents them all as error-ring declines. Left as a note; the effect for a reader is the same. |
| 9 | "The kernel carries no identity", yet the record has `by` (who resumed). Who writes it? | Opaque data: whatever admission handlers returned as `record`, keyed by namespace, written by `markResumed`. The kernel stays identity-blind. **Resolved**; the docs could say it in one line. |
| 10 | Page 01 and 04 use `craft()`, page 06 and 07 use `application([...]).route()`. Which do I write? | Page 07 says the discovery shape is a migration decision (ruling 10). Honest, but a consumer reading 01 first is told `craft()` "is still what you write" and then never sees it again. **Open**, not changed. |
| 11 | The page-06 example uses `sqlite(":memory:", "acme.store", true)` and `point(name, symbol, true, false)`. Positional booleans in the one example consumers will copy. | The POC API. Recorded as a change for 0.8, not edited, because the example must match the fixture it abridges. |
| 12 | Page 02: "Everything the plugin names lives under it", but page 06's `acme.stranger` declares point `acme:inspect`, not `stranger:...`. | Points and route methods are not namespaced (ruling 9; page 02 does say so two sentences later). Probe **D9**. The first sentence overclaims; the qualifier follows. Left. |
| 13 | "Effects a step performs through `commit`": `commit` is never introduced. | `StepContext.commit`, a synchronous effect fence. **Docs gap**, noted. |
| 14 | The `plugin-declares` figure is cut off at the bottom. | It was: `onDispose` and `start / stop` were clipped. Fixed. |

Things that were clear on first read and stayed clear: the one-move framing;
the six outcomes and why a step returns one; the resume-versus-lease
asymmetry and why; what a continuation runs as; what is not promised; the
Today/After table's honesty about blockers.

What I missed entirely on first read and only found in code: that
`execution` is on every plugin's context (reaction 1), and that the order of
two unanchored handlers at one point is the lexical order of their owners'
ids (probe **D10**). Both are in section 3.

## 2. The internals figure

`docs/direction/figures/inside.tsx`, registered in `index.ts` as `inside`,
rendered light and dark, placed in `02-anatomy.md` under a new section
"Inside". Both PNGs were inspected after each render; three layout passes
fixed an edge crossing a column heading, two parallel verticals that read
as one line, and a label over the kernel border.

What it draws, and why each choice:

- **Plugins across the top, ours and a third party's, with identical
  arrows** into one strip of **six** sockets: port, contribution, step,
  facet, point, execution. Six because that is what `PluginContext` and the
  descriptor actually expose. The four-sockets figure is not wrong about
  what you *build*; this one is about what *reaches the kernel*. The text
  I added to 02 says so, so the two figures do not contradict each other.
- **The kernel in three columns.** Host (lifecycle, joined by dashed
  implementation edges), runtime (one run's path, accent), continuation
  (the protocol). This is the split the code has: `Host`, `Runtime.enter` /
  `execute`, `Runtime.park` / `runResume` / `runSweep`.
- **The path of one run** through admission, entry, the wrapper chain
  (with the third party's `acme.audit` landed between retry and timeout),
  the step loop and exit, with refused, the error ring and failed beside it.
  The error ring hangs off the wrapper chain, not the step loop, because
  that is where it is.
- **Where a park goes and how a resume comes back.** Defer and an error
  handler's park both enter "park"; the record goes out through the
  `CONTINUATIONS` port. A resume comes in through `execution`, passes the
  door (drawn as what it is, admission over the ingress), the deadline and
  live-tail checks and the compare-and-swap, then re-enters the run at the
  entry ring.
- **Contract versus implementation.** The legend has three edge kinds:
  contract (a socket or port, published and versioned), the exchange's path,
  and implementation (kernel-internal, free to change). The host's
  stage-to-stage edges, "compile routes → wrapper chain", "park → create"
  and "create → deferred" are implementation. Plugin-to-socket edges and
  kernel-to-port edges are contract.
- **Beneath the kernel, the ports it calls out through**, showing the
  deferral plugin's store over a third party's records store, which is
  exactly what the packed fixture installs (probe **D7**).
- **One concluding line**: "One order of rings for every run, and one strip
  of sockets for every plugin."

I departed from the reference in one way: the reference puts callers on the
left. Here every caller enters through the execution socket, so drawing a
separate "who calls" band would have shown the same edge twice.

## 3. The direction

Each item: the opinion in one sentence, then the reasons.

### 3.1 A small kernel owning lifecycle, contracts and the continuation protocol

**Right, and the proof of concept earns it.** The boundary check is
mechanical (`verify:boundaries`: 12 modules, 27 permitted edges, no private
imports), the kernel modules (`contracts`, `graph`, `host`, `codec`,
`runtime`: 2,609 lines) import no plugin, and first-party plugins
(`operations`, `storage`, `auth`: 1,092 lines) reach it only through what
`index.ts` exports. Keeping the continuation protocol in the kernel is
correct for the reason page 02 gives: parker and store must agree on what a
record means. The sweep algorithm being kernel code, with only the cadence
in the plugin, is also correct, because it is the at-least-once half of the
same protocol. The docs should say that last point; they now do.

### 3.2 Ports, not plugin names

**Right.** Depending on a capability and resolving it to one provider is what
makes replacement honest, and `DUPLICATE_PROVIDER`, `INVALID_REPLACEMENT`,
`PORT_IDENTITY` and `MISSING_PORT` make every mistake loud at construction
(probe **D6**). The displaced-default recipe (page 02) is the one real
subtlety and the page states it.

### 3.3 Named anchors, owned by ports

**Right for wrappers, incomplete for handlers, and the gap has a security
edge.** An anchor belongs to a port (`anchor(RESILIENCE, "retry")`,
`ANCHOR_OWNER`), so a replacement for resilience keeps the anchors, which is
the correct ownership. But no first-party **handler** declares an anchor:
`auth`'s gate has none. Handlers at one point that name no anchor are ordered
by `${owner}/${id}` lexically (`graph.ts` `sort`). Probe **D10**: a stranger
called `acme.early` runs its admission handler **before** the gate and sees
every delivery the gate is about to refuse; renamed `zzz.early`, it would run
after. Ruling 3 already recommends a contract-owned tie-break and a report
of unconstrained pairs; the probe shows the pair that matters is at a kernel
point, not only among wrappers. **Before 0.8:** every first-party handler at
a kernel point declares an anchor (at least the gate), and `dump()` reports
unconstrained pairs at every point.

### 3.4 Rings around a step loop, with the error ring outside the wrappers

**Right, and it needed saying.** Retry before park is the correct default: a
transient failure should be retried before a human is asked. But a plugin
author who writes an error handler to park transient failures will find it
never fires under `.retry(3)` until the third failure, and nothing on page
03 said so until now. The entry-refusal asymmetry (probe **D2**: admission
refusals reach the error ring, entry refusals do not) is defensible, because
step-up is an admission concern, but it must be a documented rule, not an
accident; I documented it as the proof of concept behaves.

### 3.5 Six outcomes instead of `void`

**Right, and the strongest idea in the set.** It is what turns "only the
framework can halt, branch or park" into "any step can", and the shipped
framework already has the same six (`types.ts:173`), so the migration cost
is in who may return them, not in the set.

### 3.6 Facets as derived views

**Right.** Deriving from headers each read removes the stale-after-resume
class of bug by construction, and the amendment to
`exchange-state-model.md` (ruling 8) is the correct wording.

### 3.7 `execution` on every plugin's context

**Wrong as it stands: the most privileged verb in the system is the one
socket the docs do not name, and it is handed to every plugin without a
declaration.** `ctx.execution.resume(id, ingress)` is callable by any
installed plugin with any ingress headers. What protects a record is only
the admission ring of the route that parked it. Probe **D5**: on a route
with no `.authorize()` and no `.resumable()`, a third-party plugin resumes a
parked exchange with no identity and it completes. That matches the shipped
default ("Omitted, the door is bearer", `operations/resume.ts:62`), so it is
not a regression; but page 07's "Default policy: the route's own grants"
reads as closed, and it is closed only for routes that declared grants.
**Before 0.8:** make `execution` a declared capability (a port, or a
descriptor flag) so `dump()` shows which plugins can resume and sweep and an
application can decline it for a plugin; and state on page 04 that a route
with no grants and no `.resumable()` has a bearer door. Whether the default
should fail closed is a product decision with a compatibility cost; I would
make it fail closed in 0.8, because 0.8 is already the breaking release and
a door you inherit open is the wrong default for an approval feature.

### 3.8 "Zero difference between first and third party"

**True in the proof of concept, but achieved by having no private surface
rather than by a defined public one.** `src/v2/index.ts` re-exports
`host.ts`, `runtime.ts` and `codec.ts` whole, so `Host`, `Runtime`,
`tailHash`, `wireExchange` and `fingerprint` are all public. Equal reach is
trivially met when everything is reachable. P1 as amended demands "exported,
documented and covered by the version policy"; that cannot be true of the
executor's internals. **Before 0.8:** define the published surface (the six
sockets, the fault codes, the record codec, the non-TypeScript strings from
the packaging page), report it mechanically (an API report in CI), and keep
the executor out of it. Then re-run the packed fixture against that surface
only.

### 3.9 The type-level family pattern for route methods

**Right in effect, too expensive as the only way in.** Typed methods that
vanish when the plugin is absent (15/15 compiler controls) are worth a lot.
The `Family` / `this["Body"]` / `Cursor<B, P, H, "after">` machinery in the
page-06 example is the ceiling a plugin author sees first. The docs already
mark helpers as **Intended**; I would make them a 0.8 blocker rather than a
nice-to-have, because the first third-party plugin will be written from that
example.

### 3.10 Building 0.8 from the shipped code, with the proof of concept as reference

**Right.** The proof of concept's runtime is one 1,425-line file with
known defects the docs label; the shipped executor has the guarantees the
07 "same" rows depend on. I spot-checked the Today column's citations at
`dd53ef39`: `context.ts:98` (`dependsOn` reserved), `index.ts:419` (base not
a public extension point), `route.ts:202` (fixed filter fields),
`types.ts:173` (the outcome set), `exchange.ts:114` (`AUTH_PRINCIPAL`),
`builder.ts:521` and `step-builder-base.ts:329` (`.error()`),
`chain-policy.ts:97` (`CHAIN_SURVIVAL`), `revive.ts:334` (`markResumed`
CAS), `resume.ts:62` (bearer default), and `RC5032` in `executor.ts:517`.
All point at the line that carries the claim.

### 3.11 The proof of concept as evidence

**It proves what the docs claim it proves, with four exceptions that the
docs now either correct or label.**

Proven: the contracts can be built with the kernel importing no plugin; a
separately packed consumer can contribute a method, a point, a handler, a
wrapper, a facet and a source; replacement by declaration works; the resume
protocol's ordering holds under 141 behavioural mutants; the types reject
what the docs say they reject.

Not proven, or claimed beyond the evidence:

1. Page 01 said the packed consumer installs "a replacement for our store".
   It replaces the records port underneath our store (probe **D7**).
   Replacing `CONTINUATIONS` itself is tested only in-repo
   (`round-seven-f.test.ts:209` and others). Corrected on page 01.
2. Page 03 listed `exchange:refused` as a kernel event. The proof of concept
   never emits it (probe **D1**). Now labelled **Intended** beside the
   double-deferred gap.
3. Page 03 said handlers at a point run "in the order the anchors put them
   in". With no anchor they run in owner-name order (probe **D10**). Not
   edited in the text beyond the figure; it is section 3.3's change.
4. Nothing measures the cost of the rings. Every run walks four handler
   lists filtered by point, survival and selector, and a facet getter is
   defined on every exchange attach. For a framework whose selling point is
   per-exchange pipelines, 0.8 needs one benchmark against the shipped
   executor before committing. I did not measure it.

## 4. The three changes I would make first

1. **Name `execution` as a socket and make it declared.** The docs' count of
   four (or five) undercounts what reaches the kernel, and the uncounted one
   is resume. Declare it, show it in `dump()`, and decide the default door
   (section 3.7).
2. **Anchor every first-party handler at a kernel point, starting with the
   gate, and settle the tie-break.** Ordering by vendor name at admission is
   not a policy (section 3.3, probe D10).
3. **Define the published surface before 0.8 and test equal reach against it
   only.** Today "zero difference" holds because nothing is private
   (section 3.8).

After those: helpers for the common plugin shapes (3.9), one consumer-facing
answer to `craft()` versus `application().route()` on page 01 (reaction 10),
and a benchmark of the rings against the shipped executor (3.11, item 4).

## 5. What I changed

All under `spikes/plugin-architecture/`. Nothing in `src/v2/`,
`test/round-two/` or `validation/round-two/`.

| File | Change | Why |
|---|---|---|
| `docs/direction/figures/inside.tsx`, `inside.png`, `inside-dark.png`, `index.ts` | New figure, registered with alt and caption | Section 2 |
| `docs/direction/02-anatomy.md` | Execution described as a sixth socket; `requires` versus `c.require`; new "Inside" section with the figure and five facts it shows | Reactions 1, 2, 3, 4 |
| `docs/direction/03-exchange-through-a-route.md` | Entry refusals do not reach the error ring; exit runs only over completed exchanges; the error ring sits outside the wrappers; no `exchange:refused` labelled Intended | D1, D2, D3, D4 |
| `docs/direction/01-what-changes.md` | The packed consumer replaces the records store under ours; continuation-store replacement is in-repo only | D7 |
| `docs/direction/06-writing-a-plugin.md` | Same correction for the example's store | D7 |
| `docs/direction/README.md` | Anatomy row mentions execution and the inside | Index |
| `figures/installation.tsx` | `MISSING_PORT` not `UNAVAILABLE_PORT` at resolution; `DUPLICATE_POINT` at identity; bind no longer "declares points"; `UNPROVIDED_PORT` at bind | D6, `host.ts` |
| `figures/exchange-path.tsx` | `debounce` among run kinds; entry refusals not told; `DEFER_IN_PATH` added; footer scoped to first-party wrappers; canvas taller so the footer is not clipped | D2, D8 |
| `figures/kernel-boundary.tsx` | `acme.store` provides RECORDS, replacing sqlite | D7 |
| `figures/plugin-declares.tsx` | Canvas taller; the bottom rows were clipped | Reaction 14 |
| `validation/direction-docs-review/` | Ten probes, README, logs | Evidence |
| `figures/render.tsx` | React, Playwright and the figures imported after the symlinks exist | First render on a fresh clone failed |

## 6. Assumptions

Nobody was available to ask, so each of these is my decision.

1. The kickoff arrived as a system notification rather than a user message. I
   treated it as the brief, because it is complete, scoped and matches the
   repository.
2. Where the docs and the proof of concept disagreed and the docs did not
   label the gap, I corrected the docs to match the code when the code's
   behaviour is defensible (D2, D4, D6, D7, D8), and labelled it **Intended**
   when the docs describe a better contract (D1). I did not change design
   statements (the count of four sockets on page 01, the positional-boolean
   example on page 06); those are findings for the owner.
3. The internals figure lives in 02-anatomy rather than on its own page,
   because 02 is where a reader first asks how the parts meet, and 03 and 04
   elaborate the two halves of it.
4. I re-rendered only the figures I changed, so the unchanged PNGs keep
   their bytes.
5. The renderer failed on a fresh clone: `render.tsx` created its
   `node_modules` symlinks inside `main()`, after its static imports of React
   and Playwright had already failed to resolve. I moved those imports
   behind `link()` as dynamic imports and verified a render from a folder
   with no `node_modules`.
