---
"@routecraft/routecraft": minor
"@routecraft/testing": minor
"@routecraft/ai": minor
---

Stale option names now fail at build instead of being ignored.

The `Ms` rename and the removals that came with it are only enforced by
TypeScript, and only on an object literal. A plain-JS caller, an `as any`, or an
options object assembled elsewhere and spread in gets no check at all, and the
option is simply dropped: `timer({ intervalMs: 60_000 })` would have silently run
on the 1000ms default. That is a worse failure than a route that refuses to
build, and the spread case is not hypothetical, it is how a renamed option
survived unnoticed across seven call sites in this repo's own test helpers.

Every authored options surface now rejects two kinds of stale name:

- Any key ending in `Ms`. Authored time options take a `Duration` and carry no
  unit suffix, so `Ms` on one can only be a pre-0.7 name. The error names the
  replacement.
- Options removed for their own reasons, listed per surface:
  `timer({ exactTime })`, `timer({ timePattern })`, `timer({ jitter })`,
  `cron({ jitter })` and `retry({ exponential })`, each pointing at what to
  write instead.

The guard is on `timer()`, `cron()`, `http()`, `mail()` (including the nested
`reconnect` options), `.retry()`, `.circuitBreaker()`, `.debounce()`,
`.sample()`, `.batch()`, `defineIndicator()`, `mcpPlugin()`, `testContext()`,
`t.test()`, and the context's own config (`shutdown`, each `servers.<name>`, and
`telemetry.sqlite`). Config is checked in the `CraftContext` constructor rather
than in `defineConfig()`, which is an optional typing helper a config object can
skip entirely.

`jitterMs` is pointed at `maxJitter` rather than at the bare desuffixed
`jitter`, because `retry({ jitter })` is a fraction and sending the reader there
would be worse than saying nothing.
