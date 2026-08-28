---
"@routecraft/routecraft": minor
---

Remove two `timer()` options that never worked: `exactTime` and `timePattern`.

`timePattern` was declared on `TimerOptions` and documented in the adapter
reference, and was **never read** by the source. It has done nothing since it was
introduced.

`exactTime` was worse than inert, because it looked like it worked. It anchored
only the FIRST fire: without `fixedRate` every subsequent fire used `interval`, so
`timer({ exactTime: "09:00:00" })` fired at 09:00 and then every 1000ms forever.
With `fixedRate: true` it hardcoded 24 hours and ignored `interval`. `delay` was
silently ignored whenever it was set. It validated nothing, so `"9am"` produced
`setTimeout(NaN)` and a hot loop, and `"25:00:00"` silently rolled into the next
day at 01:00. It had no timezone support and no test coverage.

**Replacement: `cron()`.**

```ts
// before, which did not do this
timer({ exactTime: "09:00:00" })

// after
cron("0 9 * * *", { timezone: "Europe/Amsterdam" })
```

`cron()` gets the timezone handling `exactTime` never had. Note that it pulls the
`croner` optional peer, which `timer()` does not require; that is a real
consequence of the move even though nothing could have been relying on `exactTime`
behaving correctly.

The `exactTime` branches come out of `TimerSourceAdapter.subscribe()` with the
option, so the adapter is simpler rather than carrying dead scheduling paths.
