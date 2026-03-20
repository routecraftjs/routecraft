---
title: Terminal UI
---

Inspect routes, exchanges, and live events from the terminal. {% .lead %}

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

## Views

### Dashboard (1)

An overview of all routes seen in the database, with aggregated metrics per route:

| Column | Description |
| --- | --- |
| Route ID | The route's `.id()` string |
| Status | Last known status: `registered`, `started`, or `stopped` |
| Total | Total exchanges processed |
| OK | Exchanges that completed successfully |
| Fail | Exchanges that failed |
| Avg Duration | Mean exchange duration in milliseconds |

### Exchanges (2)

A chronological list of individual exchange records. Select a route from the Dashboard and press `Enter` to drill into its exchanges, or press `2` to see all exchanges across all routes.

| Column | Description |
| --- | --- |
| Exchange ID | Unique exchange identifier |
| Status | `started`, `completed`, or `failed` |
| Duration | Processing time in milliseconds |
| Error | Error message if the exchange failed |

### Events (e)

A chronological tail of framework events with human-readable summaries: context lifecycle, route lifecycle, exchange events, and operation events. Useful for debugging unexpected behaviour.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `j` / `↓` | Move selection down |
| `k` / `↑` | Move selection up |
| `Enter` | Drill into the selected route's exchanges |
| `e` | Switch to Events view |
| `Esc` | Go back to the previous view |
| `q` | Quit |

---

## Related

{% quick-links %}

{% quick-link title="Monitoring" icon="presets" href="/docs/introduction/monitoring" description="Logging, events, and the telemetry plugin." /%}
{% quick-link title="CLI reference" icon="installation" href="/docs/reference/cli" description="All craft commands and options." /%}

{% /quick-links %}
