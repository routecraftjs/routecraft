# Performance tests

End-to-end performance scenarios driven by [k6](https://k6.io) against a
running Routecraft capability. These measure what a consumer sees
(throughput, latency percentiles, error rate) rather than in-process
engine micro-costs, which makes them the right tool for before/after
comparisons between branches.

## Requirements

- Bun (serves the capability)
- k6 >= 0.57 (`brew install k6` or see the [install docs](https://grafana.com/docs/k6/latest/set-up/install-k6/)); 0.57+ runs the TypeScript scenario natively

## Running

Terminal 1, start the capability under test:

```bash
bun run perf:serve          # listens on http://127.0.0.1:4180
```

Terminal 2, run the scenario:

```bash
bun run perf:k6
```

Tunables via environment variables:

| Variable | Default | Applies to |
| --- | --- | --- |
| `PORT` | `4180` | serve.ts |
| `BASE_URL` | `http://127.0.0.1:4180` | k6 scenario |
| `VUS` | `50` | k6 scenario |
| `DURATION` | `30s` | k6 scenario |

## Comparing branches

Run the identical scenario against each branch and compare the k6
summaries (`http_reqs` rate, `http_req_duration` p95/p99):

```bash
git checkout main && bun install && bun run build
bun run perf:serve   # terminal 1
bun run perf:k6      # terminal 2, save the summary

git checkout <branch> && bun install && bun run build
bun run perf:serve
bun run perf:k6      # compare
```

The thresholds in the scenario (error rate < 1%, p95 < 50ms) are sanity
gates for local runs, not CI gates; k6 exits non-zero when they fail.

## Scenarios

| File | Capability | What it measures |
| --- | --- | --- |
| `http-route.k6.ts` | `serve.ts`: `http()` source -> 3 transforms -> `noop()` | Request/response route throughput and latency under constant load |
