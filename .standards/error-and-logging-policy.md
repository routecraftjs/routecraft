# Error and Logging Policy

Authoritative rules for error handling, logging, and eventing in Routecraft.

---

## 1. Throw specific, log at boundary

- **Throw:** Create a `RoutecraftError` with specific `message` and `suggestion` overrides, or throw a plain `Error` (the framework preserves it). Throwing does not obligate the thrower to log.
- **Boundary:** The catch that **handles** the error (does not re-throw) is the boundary. Only the boundary logs.
- **Never catch-log-throw:** If a catch block re-throws, it must NOT log. Logging and re-throwing creates duplicate log lines.

## 2. Use the error's own message as the pino log string

At a boundary, use `err.meta.message` (`RoutecraftError`) or `err.message` (plain `Error`) as the pino message string. Variable context (route, operation, adapter, tool) goes in the first-arg bindings object. Do not use generic strings like "Step failed" as the log message; the error already says what went wrong.

## 3. Stable message for non-error logs; context in bindings

For non-error logs, the **message** is a fixed string. Variable context goes only in the first-arg bindings object or child bindings. This keeps messages searchable and countable in aggregators.

## 4. Level semantics

| Level | Use for |
|-------|---------|
| **fatal** | Context or entire route failed (context start failed, route failed to start) |
| **error** | Operation failed (step failed, adapter threw, invalid plugin, plugin threw during init) |
| **warn** | Unexpected condition but processing continues (e.g., event handler threw) |
| **info** | Notable state (context/route start and stop, server started, shutdown) |
| **debug** | Diagnostic / flow detail (e.g., "Starting all routes", "Processing step", drain) |

Use **info** for context and route lifecycle so start and stop are visible at default level and symmetric.

## 5. Lifecycle and consistency

- **Same level for start and stop:** Log context and route start at the same level as their corresponding stop (e.g., both **info**).
- **Symmetric message wording:** Use matching pairs for lifecycle (e.g., "Starting route" / "Stopping route", "Route stopped", "Routecraft context stopped"). Prefer past tense for completed events and present for in-progress.

## 6. Structured error in bindings

When logging a failure, put the error in bindings (e.g., `{ err, operation, adapter }`). `RoutecraftError` implements `toJSON()` so `rc`, `message`, `suggestion`, `docs`, `causeMessage`, `causeStack` appear in serialized logs.

## 7. Validation and cause serialization

When creating `RoutecraftError` for validation (e.g., RC5002), ensure the **cause** serializes to something useful in logs (e.g., `JSON.stringify(issues)` or a normalized object). Never pass an object that will log as `[object Object]`.

---

## Boundaries

Each boundary handles the error (does not re-throw it to another boundary). Do not add new boundaries without updating this list.

| Boundary | Context | Level | Bindings |
|----------|---------|-------|----------|
| **route.runSteps** | Step/exchange failures | error | `{ err, operation }` |
| **context.start** | Route start and context start failures | fatal | `{ route?, err }` |
| **Timer adapter** | Handler error | error | `{ adapter: "timer", err }` |
| **route.trackTask** | Background task (e.g., tap) rejection | error | `{ err, route }` |
| **http dispatch (respond)** | A route's `respond` responder threw, or returned a descriptor the dispatcher refused (bad status, streaming body). The caller gets 500; the pipeline it already started keeps running | error | `{ err, routeId, method, path }` |
| **http dispatch (unread body)** | Cancelling the unread body of a run whose responder answered on its own failed (a locked stream rejects). Warn rather than error: the response is already sent and the only cost is a resource held until GC | warn | `{ err, routeId, method, path }` |
| **AI server tool handler** | Tool call errors | error | `{ tool, err }` |
| **Agent tool policy predicate** | An `agentPlugin({ toolPolicy })` predicate threw | error | `{ agent, tool, kind, err }` |
| **Route enablement predicate** | A `.enabled()` predicate threw. The route is left disabled with the error message as its reason and the boot is never failed, so this log is the only place the stack survives | error | `{ route, err }` |
| **Suspension deny-on-cancellation** | Store failure while denying a suspension parked by a cancelled run (best effort: the caller's RC5054 must land whatever the store does) | error | `{ suspensionId, routeId, expiresAt, err }` |
| **Resume authorize hook** | A `.resume({ authorize })` hook refused: returned false, threw, or did not settle before the route aborted. All three become one RC5056 with a generic message, so this log is the only place they are distinguishable; a hook whose failures can be told apart from outside is an oracle for what it knows | warn | `{ suspensionId, routeId, principal, outcome, err? }` |
| **Agent session follow-up turn** | The boundary turn that consumes a session's inbox, started in process because no continuation was stored, failed on an exchange with no route to track it (a synthetic exchange). With a route, `route.trackTask` is the boundary | error | `{ agent, session, err }` |
| **Agent session continuation** | A session turn ended with work outstanding and its exchange's continuation could not be stored (the store refused the exchange), so completions wait for the next message; or a stored continuation could not be revived (route gone, continuation changed, store failure), so the record stops naming it and queued messages run in process | error | `{ agent, session, suspensionId?, routeId?, err }` |
| **Agent session boot drive** | The walk over stored sessions at startup: the whole drive failed (each session is restored by its next message instead), or one continuation a previous process announced and never named could not be released (its reference stays on the record for the next boot to retry) | error for the drive, warn for the release | `{ err }`, `{ err, agent, session, suspensionId }` |
| **Background tool settlement** | A background tool's route settled but its result could not be written to the session inbox (store failure, lost compare-and-swap). The model is waiting on a result that is now lost, and this log is the only record | error | `{ agent, session, handle, tool, err }` |

The auth surface adds four more boundaries (source credential verification, route `.authorize()`, userinfo enrichment, HTTP transport), specified in [security.md](./security.md) § Boundaries; they follow the same handle-once rule and their log levels follow security.md's rejection-level policy.

All boundaries use `err.meta.message` (`RoutecraftError`) or `err.message` (plain `Error`) as the log message, with a fallback string specific to the boundary.

A `catch` that classifies malformed caller input and produces no error is not a
boundary and does not belong in this list. Decoding a percent-escaped path
segment is the standing example: `decodeURIComponent` throws `URIError` on input
any client can send, so `path-matcher` turns that into a non-match and the ops
health handler turns it into the same 404 an unknown component gets. There is
nothing to hand on and nothing an operator would act on, and logging it would
hand every caller a log-volume lever.

---

## Error Code Philosophy

- **Core owns the `RC` namespace.** Core codes are defined in `packages/routecraft/src/error.ts`. Ecosystem packages register their own namespaced codes (e.g. `AI1001`) via `ErrorCodeRegistry` declaration merging plus a runtime `registerErrorCodes(namespace, codes, owner)` call; each namespace is claimable by exactly one owner package.
- **Codes represent failure patterns**, not step types. Community adapters use framework codes with specific message/suggestion overrides (e.g., `rcError("RC5010", cause, { message: "Redis connection refused on port 6379" })`).
- **Generic RC codes are ecosystem-throwable.** Adapters and ecosystem packages may throw these core codes directly (with message/suggestion/retryable overrides) instead of minting their own: `RC5001` (step failed, catch-all), `RC5003` (adapter misconfigured), `RC5004` (no handler available), `RC5010` (connection failed), `RC5011` (timeout), `RC5012` (authentication failed), `RC5013` (rate limited), `RC5014` (resource not found), `RC5015` (permission denied), `RC5016` (source payload parse failed), `RC5017` (optional peer missing). The remaining RC codes are engine-internal; do not throw them from ecosystem code.
- **A code earns its place** when its docs page can provide specific, actionable troubleshooting steps. Otherwise, use the catch-all (RC5001) and put specifics in the message override; register a namespaced code only when the failure pattern is genuinely package-specific.

### Progressive quality ladder for adapter authors

| Level | What to do |
|-------|-----------|
| 0 | Throw plain `Error`. Framework wraps with RC5001, preserves original message and stack. |
| 1 | Throw `rcError(rc, cause)` with the right framework code. Specific docs link, retryable flag. |
| 2 | Throw `rcError(rc, cause, { message, suggestion })`. Specific log message and actionable guidance. |

---

## API

- Use `rcError(rc, cause?, { message?, suggestion?, docs?, retryable? })` from `packages/routecraft/src/error.ts` for framework and adapter errors.
- Use normal `throw new Error` only when you do not need an RC code or docs link.
- Log with `context.logger` in sources and `exchange.logger` in steps/destinations.
- At boundaries: `logger.error({ err, operation, adapter }, err.meta.message)`.
- Emit and observe context events for lifecycle and errors.

---

## Exchange Observability

Every operation that alters an exchange's lifecycle must emit an observable event. No silent drops.

The companion document for *where state lives on the exchange* is [`exchange-state-model.md`](./exchange-state-model.md). When you instrument a new operation, that document tells you which fields are stored (`body`, `headers`) versus derived (`id`, `principal`, `logger`); this document tells you which events to emit and what `exchangeId` / `correlationId` resolve to.

The exchange lifecycle event names (`route:exchange:started` / `:completed` / `:failed` / `:dropped` / `:restored`) and their payloads are documented in the events reference (`apps/routecraft.dev/app/content/docs/reference/events/index.mdx`, "Exchange events" section); that page is the source of truth for the names.

**Rules:**

- Every `route:exchange:started` must eventually be followed by exactly one of: `:completed`, `:failed`, `:dropped`, or `:suspended`. The exception is a **forced stop**, in either of its two forms: a forced shutdown (`shutdown.timeout` elapsed) or a route taken out of service by `.enabled()` whose drain outran its grace (`.enabled({ drainGrace })`, defaulting to `shutdown.timeout`). Both abandon in-flight exchanges mid-step through the same `abortExecution` path, and neither emits a terminal event.

  These are one exception, not two: a disable is a per-route shutdown and reuses its machinery deliberately rather than inventing a second stop path. Do not widen it further. An author who cannot afford an abandoned exchange sets `drainGrace: "never"`, under which the route stops intaking but every in-flight exchange still reaches a terminal outcome; that is the only setting where the invariant holds unconditionally.
- Child exchanges (from split) get their own `started`/`completed`/`failed`/`dropped` events.
- The `exchangeId` field must be `exchange.id` (not `correlationId`). Use `correlationId` for grouping related exchanges.
- Operations that drop exchanges (filter, debounce, sample) must emit `route:exchange:dropped` with a `reason` string.
- Operations that restore from cache must emit `route:exchange:restored` with a `source` string.

---

## References

- Error source: `packages/routecraft/src/error.ts`
- Logger source: `packages/routecraft/src/logger.ts`
- Context source: `packages/routecraft/src/context.ts`
- Error reference docs: `apps/routecraft.dev/app/content/docs/reference/errors/index.mdx`
- Monitoring docs: `apps/routecraft.dev/app/content/docs/introduction/monitoring/index.mdx`
