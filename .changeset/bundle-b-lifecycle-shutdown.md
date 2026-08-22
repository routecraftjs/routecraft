---
"@routecraft/routecraft": minor
---

Lifecycle and shutdown hardening.

**Graceful shutdown drains instead of cancelling (behaviour change).** A
route's single abort controller carried two meanings: "stop the sources" and
"abandon in-flight work". Shutdown's first stage fired both, so one Ctrl-C
killed an agent mid-tool-call while the log promised a drain. Intake and
execution are now separate signals. The first signal closes intake and lets
in-flight exchanges finish; only the forced stage abandons them. A finite
source completing is likewise intake-only, so it no longer cancels exchanges
it already emitted.

**`shutdown: { timeoutMs }` bounds the drain**, defaulting to 30 seconds. Set
it below your platform's kill timer so the process's own policy decides the
outcome rather than a SIGKILL. At the deadline one warn line names the routes
still working and how much each had in flight, in-flight execution is
abandoned, and the process exits non-zero: `craft start --once` reports a
forced shutdown as a failure for the same reason. What a forced stage accepts
losing is stated in the configuration reference: exchanges abandoned mid-step
with no terminal event. Nothing is settled or denied on the way down, so a
parked suspension survives a forced shutdown exactly as it survives a
graceful one.

**API CHANGE: `context.stop()` resolves with `{ forced, pending }`** instead
of `void`. Existing `await context.stop()` call sites are unaffected.

**API CHANGE: `Route.signal` now fires only when in-flight work is abandoned.**
It previously fired at the start of shutdown, and that meaning moved to the new
`Route.intakeSignal`. Code outside this repository that read `route.signal` to
notice a shutdown keeps compiling and silently stops reacting to a graceful
one: read `route.intakeSignal` instead. `Route` also gains `intakeSignal`,
`abortExecution()` and `inFlightCount`, so an out-of-repo implementation of the
interface must add them.

**`shutdown.timeoutMs` is validated at construction** and refuses a
non-positive or non-finite value with `RC5058`, rather than clamping: `0` reads
as "no bound" and would behave as "force immediately".

**`route:started` fires earlier for callable sources (behaviour change).** A
bare `from(async (sub) => ...)` source signalled readiness only on its first
message, so a quiet polling route (an empty mail folder, an idle queue)
delayed plugin start, the suspension sweeper, `whenStarted()` and every
readiness probe by the full 30s backstop on every boot. Readiness now fires
when the route invokes the callable. A source that throws synchronously while
wiring never signals ready.

**API CHANGE: `teardown` takes a second argument, `{ partial, started }`.**
`partial` says the context never finished starting; `started` says whether
this plugin's own `start()` ran. The parameter is additive, so existing
`teardown(ctx)` implementations compile and behave unchanged. The
already-shipped start-failure unwind now reports `partial: true` as well,
which supersedes the `.standards/plugin-lifecycle.md` wording that shipped
days ago: one flag meaning two things depending on which failure you hit is
the ambiguity the argument removes.

**`build()` unwinds the plugins it applied when a later step fails.** A
plugin that threw left every earlier plugin applied and unreachable, because
`build()` returns no context to tear down. Under a supervisor that retries
boot that leaked one resource per attempt, and a held SQLite handle also kept
the file locked, so a transient failure became a permanent one reported as
lock contention. The unwind runs in reverse, tolerates a throwing teardown,
covers `registerRoutes()` as well as `initPlugins()`, and rethrows the
original error unchanged.

**A boot summary line** reports how many routes started of how many, naming
those that failed and those still waiting when the backstop fired. Info when
all started, warn otherwise.

**One SQLite driver resolver and one minimal typing** replace three drifted
copies. The typing now serves suspension, telemetry and the CLI's telemetry
reader; the resolver serves suspension and telemetry, while the CLI keeps its
own Bun-only load because `runtime-gate.ts` refuses to start under Node.
Telemetry resolves through the resolver, so a
Node deployment with `better-sqlite3` installed gets the SQLite sink it
configured instead of silently getting nothing, and its mutable
`static loadDriver` test seam is replaced by an injectable argument.
`loadOptionalPeer` no longer hardcodes "adapter" in its missing-peer message,
since half its callers are not adapters.
