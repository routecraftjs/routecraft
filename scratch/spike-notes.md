# Spike working notes (running log; source for the final findings doc)

Branch: claude/routecraft-architecture-review-7m3c6b. Spike = apply everything, measure, report; not merge-bound.
Plan: /root/.claude/plans/review-the-core-architecture-ticklish-avalanche.md

## Baseline (commit 7ae394b, 2026-06-10)

LOC (src, wc -l): routecraft 25,486 / ai 13,086 / cli 1,420 / testing 1,071
Largest files: route.ts 1870, builder.ts 1140, context.ts 1004, mail/shared.ts 846, exchange.ts 819, types.ts 802, telemetry/plugin.ts 624, error.ts 434
Wall times: typecheck 7.7s, build 2m13s, bun tests 1523/119 files ~10s (+vitest 1 file)
Benchmarks (scratch/bench/, Bun 1.3.11):
- emit (6 subs, 3 matching): 751,355 emits/sec, 1331 ns/emit
- plain route (direct -> 3 transforms -> noop): 31,059 ex/sec, 32.2 us
- wrapped (same + .error() on each transform): 20,355 ex/sec, 49.1 us  <- wrapper relay = +52% latency
- split-agg (split 10 -> transform -> aggregate): 6,402 ex/sec, 156.2 us

## Pre-existing bug fixed at baseline (commit 7ae394b)

mock.module("../src/mcp/dispatch.ts") in tools-selection-mcp.bun.test.ts leaked across bun test files
(module mocks are process-global and not restorable), breaking 3 mcp.bun.test.ts tests in full runs and
dropping the callRemoteTool export. Replaced with recording managers in MCP_STDIO_MANAGERS (framework's
own seam). Learning for findings doc: mock.module is a footgun; prefer store-seam fakes. Check other
mock.module sites (llm providers mocked consistently across agent tests; sdk client mocked in
stdio-client-manager) for the same hazard if provider tests ever need the real module.

## Stage log

- [x] Baseline + bench scripts
- [x] A1 dedupe isMailParseError
- [x] A2 stale excludes (17 dead entries removed from tsconfig+eslint)
- [x] A3 factory tagging + conformance test (also found 2 untagged branches inside html/json factories)
- [x] B1 EventBus extraction (context.ts 1004 -> 816; emit perf unchanged 750k/s)
- [x] B2 config appliers (DIP fix; CraftConfig in core = name/store/on/once/plugins only; initPlugins idempotent + called by start with sync guard -- async guard alone reordered events in 14 tests, worth recording)
- [x] B3 route.ts 1870 -> 846 (synthetic-steps 379, validation 291, executor 491; verbatim moves, deps objects)
- [x] C2 namespaced error registry (AI1001-1003 moved out of core; RC1003 added; collision throws name both packages)
- [x] C1 step outcome + takePending (+S2). 5-variant outcome union (continue/complete/drop/branch/fanOut) --
  choice needed 'branch' (prepends steps), route-cache-hit needed 'complete' (skip remaining, success);
  the originally sketched 3-variant union was insufficient. Wrapper buffer protocol deleted.
- [x] C3 subscription object (+S1) -- 12 core sources + mcp + testing-hooks + pseudo migrated; testSubscription() helper added; dead MCP positional principal arg found+removed
- [x] D9 event identity redesign -- 2x emit, -24% plain, -27% split-agg; EventDetailsMap mergeable; regex-rename corruption incident caught by diff-pairing audit (use a name table in the real PR)
- [x] E1 generator/iterable sources implemented (~120 lines on C3); E2/E3 evaluated-not-built (see findings doc)
- [x] B4 findings doc: docs/architecture/2026-06-spike-findings.md (primary deliverable)

## Per-change verdicts (fill as they land)

- A1: trivial dedupe, done. A2: 17 dead exclude entries deleted, zero fallout.
- A3 verdict: BETTER + caught real bugs. 11 untagged factories fixed; conformance test additionally
  exposed 2 untagged return paths in factories previously believed tagged (html transformer mode,
  json transformer mode), i.e. mockAdapter(html)/mockAdapter(json) silently no-oped for those modes.
  Conformance-test-over-lint-rule was the right call.

- B1 verdict: BETTER. Pure win, no behavior change, eventing now one unit. Cost ~1h.
- B2 verdict: BETTER with one gotcha worth documenting: start() awaiting initPlugins() unconditionally
  added 1 microtask and broke 14 event-interleaving tests; the sync pluginsInitialized guard fixed it.
  Breaking changes as planned (store seeding timing, mail teardown order).
- B3 verdict: BETTER. route.ts 1870 -> 846. Throughput unchanged within noise (plain 32.8us vs 32.2us).
  NOTE: wrapped bench moved 49.1 -> 35.6us across runs on identical wrapper code; bench variance is high,
  use 3-run medians for final numbers.

- C2 verdict: BETTER. Compiler caught every moved-code reference (the closed union earned its keep on the
  way out). Namespacing design held up. Docs table is still hand-written (codegen ticket).
- C1 verdict: BETTER + measured perf win. wrapped 49.1 -> ~30 us/ex (wrapper overhead 53% -> ~0-7%);
  plain + split-agg unchanged within noise. 4 tests needed rewriting (they tested the buffer protocol
  itself). Split wrapper ban KEPT: fanOut recovery would change pipeline cardinality (1 recovered exchange
  replacing N children) -- principled reason, documented in NON_WRAPPABLE comment.
  Discovered en route: .cache() around choice silently discarded branch steps in the old engine; now loud RC5003.
  Split example output byte-identical vs baseline (modulo pid).
  TODO findings doc: .standards/resilience-wrappers.md + adapter-architecture.md + exchange-state-model.md
  still document the old contract; update in docs pass (after D9 so it's one rewrite).
  NOTE: root 'bun run craft' shortcut uses node but CLI dist rejects node ("requires Bun") -- contradicts
  CLAUDE.md note; pre-existing on baseline; flag to user.
