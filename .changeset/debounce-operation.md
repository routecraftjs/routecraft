---
"@routecraft/routecraft": minor
---

Add the `debounce` flow-control operation.

`.debounce({ waitMs })` suppresses bursts of exchanges, releasing only the last one in a burst after a quiet period (file-change batching, search-as-you-type). Each arrival resets a `waitMs` quiet timer and supersedes the one being held; an optional `key` selector debounces independently per group, and an optional `maxWaitMs` cap (measured from the burst start, never reset) guarantees eventual release under continuous activity. Emits `route:operation:debounce:held` / `:dropped` / `:released`.

Debounce is the first operation to hold an exchange OUTSIDE the pipeline queue and re-run it later, so it introduces two additive primitives: `StepContext.captureDownstream()` (snapshot the steps after a step and run a held exchange through them as a detached, route-tracked pipeline with its own `exchange:started` / `:completed` lifecycle) and `Route.onDrain()` (a flush hook run at the start of `drain()` / shutdown). Because the released exchange is the route's primary flow, the detached run honors the route-scope `.error()` handler and enforces `.output()` schemas before completing, and a release that cannot clone the held body fails that exchange cleanly instead of crashing the timer. A pending exchange is flushed on drain rather than being lost. Adds `OperationType.DEBOUNCE`. Route scope only (not available inside a fan-out path, and not wrappable by step-scope resilience wrappers).
