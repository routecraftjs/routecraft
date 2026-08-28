---
"@routecraft/routecraft": minor
"@routecraft/ai": minor
---

Every authored time option now takes `Duration` (`number | "5m"`), and the `Ms` suffix is gone from all of them.

The framework had two conventions and they had drifted into a contradiction: `.cache({ ttl })` took raw milliseconds while `.suspend({ ttl })` took `Duration`, so the same property name meant two different types on two operations. One option used `Duration` and roughly two dozen used raw milliseconds.

The rule is now one line: **input options a user writes take `Duration`; values the framework reports stay millisecond numbers.** `Duration` is a superset of `number`, so widening breaks nothing on its own; the break is the rename, because a name ending in `Ms` that accepts `"5m"` lies.

Reported values are deliberately unchanged: `durationMs` on events, `ageMs` on ops responses, `backoffMs` on `route:retry:attempt`, and every other emitted millisecond stays exactly as it was. Those are machine-readable data, not authored configuration. Internal resolved shapes (`ResolvedTimeoutOptions.timeoutMs`, `refillPerMs`, `SuspensionRuntime.defaultTtlMs`) are computed values and stay too.

## Migration

| Surface | Old | New |
| --- | --- | --- |
| `timer()` | `intervalMs` | `interval` |
| `timer()` | `delayMs` | `delay` |
| `timer()` | `jitterMs` | `maxJitter` |
| `cron()` | `jitterMs` | `maxJitter` |
| `http()` | `timeoutMs` | `timeout` |
| `mail()` | `pollIntervalMs` | `pollInterval` |
| `mail({ reconnect })` | `baseDelayMs` | `baseDelay` |
| `mail({ reconnect })` | `maxDelayMs` | `maxDelay` |
| `.timeout()` | `.timeout(timeoutMs: number)` | `.timeout(duration: Duration)` |
| `.delay()` | `.delay(delayMs: number)` | `.delay(duration: Duration)` |
| `.retry()` | `backoffMs` | `backoff` |
| `.retry()` | `maxBackoffMs` | `maxBackoff` |
| `.circuitBreaker()` | `windowMs` | `window` |
| `.circuitBreaker()` | `cooldownMs` | `cooldown` |
| `.debounce()` | `waitMs` | `wait` |
| `.debounce()` | `maxWaitMs` | `maxWait` |
| `.batch()` | `flushIntervalMs` | `flushInterval` |
| `.sample()` | `intervalMs` | `interval` |
| `.cache()` | `ttl: number` | `ttl: Duration` (name unchanged) |
| `.dedupe()` | `ttl: number` | `ttl: Duration` (name unchanged) |
| `defineConfig` | `shutdown.timeoutMs` | `shutdown.timeout` |
| `defineConfig` | `servers.<name>.shutdownGraceMs` | `servers.<name>.shutdownGrace` |
| `defineConfig` | `telemetry.sqlite.eventFlushIntervalMs` | `telemetry.sqlite.eventFlushInterval` |
| `defineIndicator` | `maxAgeMs` | `maxAge` |
| `mcpPlugin` | `restartDelayMs` | `restartDelay` |
| `mcpPlugin` | `toolRefreshIntervalMs` | `toolRefreshInterval` |
| `@routecraft/testing` | `routesReadyTimeoutMs` | `routesReadyTimeout` |
| `@routecraft/testing` | `delayBeforeDrainMs` | `delayBeforeDrain` |
| `.throttle()` | `per: ThrottleTimeUnit` | `per: ThrottleTimeUnit \| Duration` (widened, unit words unchanged) |

Existing numeric values keep working under every new name, so the migration is a rename and nothing else:

```ts
// before
.from(timer({ intervalMs: 60_000 }))
.retry({ maxAttempts: 3, backoffMs: 1000, maxBackoffMs: 10_000 })

// after, unchanged behaviour
.from(timer({ interval: 60_000 }))
.retry({ maxAttempts: 3, backoff: 1000, maxBackoff: 10_000 })

// or, now that the unit can be said out loud
.from(timer({ interval: '1m' }))
.retry({ maxAttempts: 3, backoff: '1s', maxBackoff: '10s' })
```

`jitter` becomes `maxJitter` on `timer()` and `cron()` rather than the bare `jitter` a straight desuffixing would give. Two reasons. It is genuinely a maximum: each delay is drawn uniformly from `[0, maxJitter)`, matching the `maxBackoff` / `maxWait` / `maxDelay` prefix already in the DSL. And `.retry({ jitter })` is a *fraction* in `[0, 1]`, not a duration, so a bare `jitter` would have meant two different types on two operations, which is exactly the `ttl` defect this change exists to close. `.retry({ jitter })` is deliberately untouched: a fraction is the right model where the backoff it perturbs varies per attempt.

`.throttle({ per })` now also accepts a `Duration`, so a window no unit word names (`per: "90s"`) is expressible. The unit words keep their exact meaning. **A bare number is milliseconds**, as everywhere else a `Duration` is accepted: `per: 60` is a 60ms window, not a minute. Write `per: "60s"` or `per: "minute"`.

Two supporting changes come with it. `assertDurationMs` is folded into `parseDuration`, which grows an optional `min` floor (`0` for waits, `1` for deadlines), so one guard now owns the whole grammar instead of two that could drift. `Duration` and `parseDuration` move from `suspension/` to `shared/` internally; both are still exported from the package root, so nothing changes for consumers.

The `craft start --timeout` flag now also accepts a duration string (`--timeout 30s`); a bare number is still milliseconds.
