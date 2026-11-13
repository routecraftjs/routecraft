---
"@routecraft/ai": minor
---

`plugin:mcp:tool:called` carries the call's arguments as `_snapshot: { args }` instead of `args`, so the telemetry store keeps them only when `captureSnapshots` is on. They were written to the events table on every call, whatever that setting said. The debug log line that printed the same arguments is removed.

Breaking: a subscriber that read `details.args` reads `details._snapshot.args`.
