# Round 7f clean-room review: evidence

Everything here was measured on `validation/round-six` at
`814748e44824f65e40c58930bfa73781b650180c`, Bun 1.3.11, after a root
`bun install`, from `spikes/plugin-architecture`. Nothing under `src/v2/`,
`test/round-two/` or `validation/round-two/` was changed. The report is
`reviews/OPUS-ROUND-7F.md`.

| File | What it is | How to run |
|---|---|---|
| `harness-controls.sh` | Runs the round-two mutation runner **unchanged** against disposable copies of the spike whose mutant list (and for C1, whose source) is a control. Proves or disproves each claim the runner makes. | `validation/round-seven-f-review/harness-controls.sh` |
| `mutations.ts`, `mutants.ts` | Thirty review mutants, each run against the **whole** suite (packed consumer excluded by name) after the unchanged copy passes the same run. Three-way classification: killed, survived, invalid. The tokenizing `pattern` is the round-two runner's, copied verbatim, and must match exactly once. | `bun run validation/round-seven-f-review/mutations.ts` |
| `probes.test.ts` | Fifteen characterisation probes. Each asserts what the head does, so the file is green on `814748e4` and every assertion is a reproduced fact. The JSDoc on each names the shipped or `#818` reference it departs from. | `bun test validation/round-seven-f-review/probes.test.ts` |

## Harness controls (C1 to C8)

| Control | Runner claim tested | Observed |
|---|---|---|
| C1 source broken in the copy | the unchanged copy passes the whole suite first | refused: `unchanged copy does not pass` |
| C2 pattern matching three sites | a pattern must match exactly once | refused: `mutation pattern is ambiguous (3 sites)` |
| C3 pattern matching nothing | a stale pattern is refused | refused: `mutation no longer applies` |
| C4 secret rule removed | positive control | `KILLED` |
| C5 parse error | a parse error is never a kill | `SURVIVED or invalid` |
| C6 throw at module load | a load error is never a kill | `SURVIVED or invalid` |
| C7 filter matching no test | a kill requires a test to have run | `SURVIVED or invalid` (`matched 0 tests`) |
| C8 synchronous infinite loop | a hang is never a kill | `SURVIVED or invalid` |

## Probes to findings

| Probe | Finding | Reference departed from |
|---|---|---|
| G1 | A refusal park resumed without `elevate` runs the gated route as the refused requester; the route's own gate is never re-asked | `#818` `revive.ts` `rehydrate` (the continuation re-runs `.authorize()`) |
| G2 | The lend bound is any failure's `detail.refused`: a third-party admission handler or a throwing step writes it | `#818` `executor.ts` `parkFromErrorPath` (`insufficientAuthorityOf(originalError)?.scopes`) |
| G3 | A failure without a step site (a route timeout during a tracked stream, an exit handler) parks from the top and the resume re-runs committed effects | `#818` `parkFromErrorPath` refuses this park (`RC5051`) |
| G4 | An error-path park inside a fan-out parks one child, drops the first child's completion from the result and never runs the third | shipped refuses a park inside a split |
| G5 | A `.defer()` inside a fan-out is not refused; children sharing the parent id park once and fail the route with a live record behind it | shipped refuses a park inside a split before writing |
| G6 | The held elevation is keyed by record id in a plugin map: a concurrent loser's lend is applied to the winner's run, and the record names the winner | `#818` `reviveDeferral` holds `elevated` in the call frame |
| G7 | A lend inside the bound that does not satisfy the gate spends the approval, returns `refused`, and tells nobody | `#818` re-runs `.authorize()`, failure reaches the error handler, loop-closing rule |
| G8 | A throwing door hook rejects with its own message; `false` is `refused` | `#818` `runAuthorizer`: one `RC5056` for false, throw and abort |
| G9, G9b | A door hook is unbounded and not owned work; one that settles after `stop()` hits a closed store, or with a store that outlives the app, runs the continuation after `stop()` | `#818` races both hooks against the ingress abort signal |
| G10 | The default ttl misses error-path parks and hand-written defer outcomes | shipped and `#818` `deferExchange`: `request.expiresInMs ?? runtime.defaultTtlMs` |
| G11 | A cancelled run can be parked from the error ring, leaving a live link | `#818` `RC5054` before the write, deny after |
| G12 | A failing `notify` leaves a live, waiting record behind a failed run | `#818` `runNotify` denies the record (`RC5067`) |
| G13 | A resumed body is a null-prototype object (`hasOwnProperty` undefined, `instanceof Object` false) | shipped `serialize.ts` `decode` revives an ordinary prototype through `defineProperty` |
| G14 | The codec keeps `-0` | shipped normalises to `0` |
