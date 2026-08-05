---
"@routecraft/routecraft": minor
---

Propagate an `AbortSignal` from `.timeout()` into the wrapped step.

Promises cannot be cancelled, so an expired deadline used to leave the abandoned work running to completion in the background. The step now receives a signal through its step context that fires on expiry (abort reason: the `RC5011` error), at both step scope and route scope; nested timeouts link their signals so the earliest deadline wins. Function-form steps get it as a trailing argument (`.process((ex, { signal }) => fetch(url, { signal }))`, also on `.transform()`, `.to()`, and `.enrich()`), adapter authors read `ctx.signal` in `Step.execute`, and the built-in `http()` destination forwards it into its fetch automatically. `.tap()` deliberately receives no signal: taps run detached, so an abandoned attempt must not cancel an observation in flight. The `.timeout(ms)` surface is unchanged.
