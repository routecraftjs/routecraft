---
title: debounce
titleBadges:
  - text: planned
    color: purple
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
debounce(options: { quietMs: number }): RouteBuilder<Current>
```

Only pass exchanges after a specified quiet period with no new exchanges. Useful for handling bursts of similar events.

```ts
// Wait for 1 second of quiet before processing
.debounce({ quietMs: 1000 })

// Typical use: Batch file system changes
.id('file-watcher')
.from(file({ path: './config', watch: true }))
.debounce({ quietMs: 500 }) // Wait for editing to finish
.process(reloadConfig)
```
