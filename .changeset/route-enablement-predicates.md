---
"@routecraft/routecraft": minor
---

Add `.enabled()`: a route can now declare whether it runs at all.

A capability whose credentials are absent had no good state. It either registered and failed at runtime, where the agent calls a tool that cannot work and gets an error it cannot interpret, or it was commented out by hand. Neither is legible, and a route that is missing looked exactly like one that is deliberately off, though only the first is an incident.

```ts
craft()
  .id("mail-inbound")
  .description("Triage inbound mail")
  .enabled(() =>
    env.MAIL_USER && env.MAIL_APP_PASSWORD
      ? true
      : "MAIL_USER and MAIL_APP_PASSWORD are not set",
  )
  .from(mail({ account: "default", folder: "INBOX" }))
  .to(direct("triage"));
```

A route whose predicate is false is **disabled**: registered and known to the context, not started, not intaking, and **not advertised as an agent tool**. The tool list is derived from what the context has enabled, so a disabled capability is simply not offered to the model. That is what makes "the agent must not use this until I supply credentials" true by construction rather than by the model behaving well.

Returning a string disables the route AND is the reason ops reports, so there is no second declaration to go stale. A predicate that throws leaves the route disabled with the error message as its reason and never fails the boot: a missing credential is a configuration state, not a reason to take the process down. Async predicates are awaited before any route starts.

**Refresh is manual by default.** The predicate runs once as the route starts and is not run again until something asks, which keeps the common environment-variable case free of any recurring cost:

```ts
.enabled(predicate)                            // manual (default)
.enabled(predicate, { refresh: "manual" })     // manual, said explicitly
.enabled(predicate, { refresh: "5m" })         // interval
.enabled(predicate, { refresh: "0 * * * *" })  // cron schedule
```

Omitting `refresh` and passing `"manual"` mean the same thing. The sentinel
exists for a computed cadence, where it says what it means instead of assembling
the options object conditionally (`refresh: pollCadence ?? "manual"`), and it
restores the sentinel precedent `suspension` already sets with
`defaultTtl: "never"` and `retention: "never"`.

`refresh` takes `Duration` or a cron expression, told apart by shape. A cron cadence loads `croner` lazily, the same optional peer `cron()` uses, so a context that does not ask for one never pays for it. A malformed cadence is refused while the route is built.

**`drainGrace` sets how long the drain gets, per route.** Taking a route out of service defaults to the context's `shutdown.timeout`, and `.enabled({ drainGrace })` overrides it because the author is the one who knows what that pipeline's in-flight work costs. `drainGrace: "never"` waits indefinitely, which is the only setting under which no in-flight exchange is ever abandoned; under any bounded grace a still-running exchange is abandoned mid-step and emits no terminal event, exactly as in a forced shutdown. `.standards/error-and-logging-policy.md` has been updated to name a forced stop in both its forms rather than only the shutdown one.

**A refresh cadence that cannot be armed fails the boot.** A malformed `Duration` was already refused when the route was built, but a cron cadence only warned when croner armed it, which left one arm of the same option silently degraded. It now throws, matching `cron()` itself, which already rejects its subscribe on a bad expression or an absent `croner`. The expression is checked at startup rather than at build time because `croner` is an optional peer behind an async dynamic import; the framework does not pre-validate cron syntax itself, since a second grammar would disagree with croner at the edges and rejecting a valid expression is worse than checking a moment later.

**Transitions reuse the existing per-route drain.** Enabled to disabled fires the route's intake signal so it stops accepting new work while in-flight exchanges finish, then abandons execution once the `shutdown.timeout` grace deadline passes: exactly what shutdown does, through the same two signals. A flag flip is never a data-loss event and there is no second stop path. Disabled to enabled starts the route normally and returns it to `capabilities()`.

**Ops reports disabled distinctly.** A new `disabled` route lifecycle carries the reason in `details.reason` and maps to `inactive`, so it is listed but excluded from aggregation. It is deliberately not `offline` (which degrades): `failed` is a route that should be running and is not, `offline` is a running deployment losing capability, and `disabled` is capability that was never configured. Overall health is never degraded by a disabled route, because a deliberate configuration state is not an open circuit.

`context.reevaluateEnablement(routeId?)` re-checks on demand and applies any transition, so an operator can set the secret and bring the capability up without a process restart. A genuine transition emits `route:enablement:changed`; a refresh that re-confirms the current verdict is silent.

Two related behaviours changed to make this hold. A context whose routes are all disabled no longer auto-stops, because a disabled route has not completed, it never ran, and stopping would make the re-enable loop unreachable. `@routecraft/testing`'s readiness gate now settles a route that starts **or** is disabled, so a test with a dormant capability no longer waits out its timeout.
