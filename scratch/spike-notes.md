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
- [ ] A1 dedupe isMailParseError
- [ ] A2 stale excludes
- [ ] A3 factory tagging + conformance test
- [ ] B1 EventBus extraction
- [ ] B2 config appliers (DIP)
- [ ] B3 route.ts decomposition
- [ ] C2 namespaced error registry
- [ ] C1 step outcome + takePending (+S2 AggregateResult)
- [ ] C3 subscription object (+S1 Adapter.adapterId)
- [ ] D9 event identity redesign
- [ ] E experiments (pick 2-3)
- [ ] B4 findings doc + final measurements

## Per-change verdicts (fill as they land)

(none yet)
