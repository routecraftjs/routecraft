---
title: Terminal UI
---

Inspect routes, agents, tools, exchanges, and live events from the terminal. {% .lead %}

![Routecraft Terminal UI](/screenshots/tui.webp)

## Prerequisites

The TUI reads from the SQLite database written by the `telemetry()` plugin. Enable it in your context before launching the UI:

```ts
import { CraftContext, telemetry } from '@routecraft/routecraft'

const ctx = new CraftContext({
  plugins: [telemetry()],
})
```

See [Monitoring](/docs/introduction/monitoring#telemetry-plugin) for full plugin options.

## Launching the TUI

Start the TUI in a separate terminal while your context is running (or after it has stopped; the database persists):

```bash
craft tui
```

To read from a non-default database path:

```bash
craft tui --db ./logs/telemetry.db
```

The TUI polls the database every 2 seconds. Because SQLite runs in WAL mode, reads never block the running context.

## Layout

The TUI uses a three-column layout framed by a one-line header and footer:

- **Header** -- Wordmark, version, and a breadcrumb showing where you are in the drill-down (e.g. `Agents › planner › run 789003e7 › web_search`)
- **Left** -- Navigation panel (view switcher + capability / agent / tool list); the Errors item shows a red count when there are failed exchanges
- **Center** -- Main content (exchange lists, agent runs, tool calls, detail views, or event stream)
- **Right** -- Metrics panel with throughput stats, latency percentiles (p90/p95/p99), and a live traffic graph
- **Footer** -- Contextual keyboard hints for the focused view

Navigation is a stack: `Enter` drills into the selected item and `Esc` goes back one level, consistently across every view.

Detail views are live: an open exchange re-reads its related events and an open agent run re-reads its tool-call timeline on every poll, so you can watch a long-running agent invoke tools and receive results in order without leaving the view. New rows append below your cursor; press `f` to pin the cursor to the newest row instead. Opening an exchange or run that is still in flight enables follow automatically.

## Views

### Capabilities (1)

The default view. The left panel lists all routes (capabilities) seen in the database. Select a route to see its summary in the center panel with recent exchanges.

Press `Enter` to drill into a route's exchange list in the center panel. Press `Esc` to return focus to the route list.

### Agents (2)

The left panel lists agents seen in the database: agents registered via `agentPlugin` (shown even before they run) and inline agents discovered when they dispatch (keyed by their route). The status dot is red on errors, green once the agent has run, and yellow for registered-but-not-yet-run.

Press `Enter` to browse the agent's runs. The runs list shows the per-run status, resolved model, total token usage, duration and start time. Press `Enter` on a run to open its detail: the model, input/output token usage, finish reason, and the ordered tool-call timeline. Press `Enter` on a tool call to inspect its input and output (captured only when `captureSnapshots` is enabled).

### Tools (3)

The left panel lists tools: fns registered via `agentPlugin` and any tools observed being called. Press `Enter` to browse a tool's invocation history across all agents and exchanges, then `Enter` on a call to inspect its input/output.

### Exchanges (4)

A chronological list of all exchanges across all routes, ordered most recent first.

| Column | Description |
| --- | --- |
| ID | Unique exchange identifier |
| Status | `started`, `completed`, `failed`, or `dropped` |
| Duration | Processing time |
| Time | Timestamp of the exchange |

Press `Enter` on any exchange to see its detail view with related events grouped by parent/child flow.

### Errors (5)

Same layout as Exchanges but filtered to show only failed exchanges. Useful for quickly spotting and investigating failures.

### Events (6)

A chronological tail of all framework events with human-readable summaries: context lifecycle, route lifecycle, exchange events, and step events. Useful for debugging unexpected behaviour.

| Column | Description |
| --- | --- |
| Timestamp | When the event occurred |
| Event | Full event name (e.g. `route:myRoute:exchange:started`) |
| Details | Formatted summary of the event payload |

## Keyboard shortcuts

### Navigation

| Key | Action |
| --- | --- |
| `j` / `↓` | Move selection down |
| `k` / `↑` | Move selection up |
| `Ctrl+j` / `Ctrl+↓` | Jump 10 rows down |
| `Ctrl+k` / `Ctrl+↑` | Jump 10 rows up |

### Views and drill-down

| Key | Action |
| --- | --- |
| `1` | Switch to Capabilities view |
| `2` | Switch to Agents view |
| `3` | Switch to Tools view |
| `4` | Switch to Exchanges view |
| `5` | Switch to Errors view |
| `6` | Switch to Events view |
| `Enter` | Drill into selected item (e.g. route exchanges, agent runs, tool calls) |
| `Esc` | Go back to the previous panel or view |
| `/` | Filter the browsed list (type to narrow; `Enter` keeps the filter, `Esc` clears it) |
| `f` | Toggle follow mode (keeps tailing new rows; moving the cursor turns it off) |
| `q` | Quit |

---

## Related

{% quick-links %}

{% quick-link title="Monitoring" icon="presets" href="/docs/introduction/monitoring" description="Logging, events, and the telemetry plugin." /%}
{% quick-link title="CLI reference" icon="installation" href="/docs/reference/cli" description="All craft commands and options." /%}

{% /quick-links %}
