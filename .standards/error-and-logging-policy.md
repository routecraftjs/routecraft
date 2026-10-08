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
| **http dispatch (caller refusal)** | Any `http()` source route, on either response path, whose failure `callerRefusalResponse` maps to a 4xx: the route's own `.input()` or `.authorize()` refused the caller, who gets that status instead of 500. Debug rather than error: `route.runSteps` has already logged the failure, and this line only records the status the door chose | debug | `{ err, routeId, method, path }` |
| **http dispatch (unread body)** | Cancelling the unread body of a run whose responder answered on its own failed (a locked stream rejects). Warn rather than error: the response is already sent and the only cost is a resource held until GC | warn | `{ err, routeId, method, path }` |
| **AI server tool handler** | Tool call errors. A failure `callerRefusalOf` classifies as the caller's own (a refused payload, an `authorize()` refusal of the admitted principal) logs at debug, as the http doors do: the caller gets the refusal and `route.runSteps` has already logged it | error, debug for a caller refusal | `{ tool, err }` |
| **ACP mount handler** | A `session/*` or `initialize` handler failed with anything but a refusal the mount raised itself (a failed turn, a store outage), or a `session/cancel` notification failed. The caller gets `-32603` with at most the RC code, so this log is the only place the message survives. A `SurfaceDisconnected` logs at debug: the caller it would answer is gone | error, debug for a disconnect | `{ err, method, connectionId, session? }` |
| **Agent tool policy predicate** | An `agentPlugin({ toolPolicy })` predicate threw | error | `{ agent, tool, kind, err }` |
| **Route enablement predicate** | A `.enabled()` predicate threw. The route is left disabled with the error message as its reason and the boot is never failed, so this log is the only place the stack survives | error | `{ route, err }` |
| **Deferral denial** | Store failure while denying a deferral that must not stay resumable: one deferred by a cancelled run, or one whose `recovery.defer({ notify })` hook threw or did not settle. Best effort in both cases, because the caller's RC5054 or RC5067 must land whatever the store does | error | `{ deferralId, routeId, reason, expiresAt, err }` |
| **Error-slot hook** | A plugin hook in the chain's `error` slot threw. Handled rather than propagated on purpose: the slot continues to the next hook, and the hook's own throw never replaces the error that reaches the failure path, so this log is the only place it survives | error | `{ operation, err, context: "error-slot hook", hook }` |
| **Exit-slot hook** | A plugin hook in the chain's `exit` slot threw. The work completed before it ran, so no handler ring sees the failure: the exchange fails with the hook's error, announced through the one terminal-failure path, and this log is the only place it survives | error | `{ err, slot: "exit" }` |
| **Resume authorize hook** | A `.resume({ authorize })` hook refused: returned false, threw, or did not settle before the route aborted. All three become one RC5056 with a generic message, so this log is the only place they are distinguishable; a hook whose failures can be told apart from outside is an oracle for what it knows | warn | `{ deferralId, routeId, principal, outcome, err? }` |
| **Agent session follow-up turn** | The boundary turn that consumes a session's inbox, started in process because no continuation was stored, failed on an exchange with no route to track it (a synthetic exchange). With a route, `route.trackTask` is the boundary | error | `{ agent, session, err }` |
| **Agent session continuation** | A session turn ended with work outstanding and its exchange's continuation could not be stored (the store refused the exchange), so completions wait for the next message; or a stored continuation could not be revived (route gone, continuation changed, store failure), so the record stops naming it and queued messages run in process | error | `{ agent, session, deferralId?, routeId?, err }` |
| **Agent session boot drive** | The walk over stored sessions at startup: the whole drive failed (each session is restored by its next message instead), or one continuation a previous process announced and never named could not be released (its reference stays on the record for the next boot to retry) | error for the drive, warn for the release | `{ err }`, `{ err, agent, session, deferralId }` |
| **Agent delta listener** | An `onDelta` listener threw, on a streamed delta (`stream-llm.ts`) or on the final text a run hands it when the accepted attempt streamed none (`run.ts`). The listener is the consumer's; its failure does not fail the turn, and the delta is dropped | warn | `{ err }` |
| **Background tool settlement** | A background tool's route settled but its result could not be written to the session inbox (store failure, lost compare-and-swap). The model is waiting on a result that is now lost, and this log is the only record | error | `{ agent, session, handle, tool, err }` |
| **Surface cleanup after a cancel** | A call a route registered with `surface.onCancel()` failed or timed out when the framework sent it after the turn was cancelled. Nothing awaits these, so this log is the only record; the next registered call is still sent. An editor that has since gone is skipped at debug, since it took the resource with it | warn | `{ session, exchangeId, method, source, err }` |

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

## What crosses the wire

A door is anything that runs a route on behalf of a caller outside the process: the `http()` source, the ops dispatch mount, an MCP tool call, the ACP mount. Every door follows the same three rules.

1. **At most the code crosses the wire, never the message.** A route failure is whatever its steps threw, and `rcError` messages routinely interpolate the cause: hostnames, file paths, upstream response text, other routes' ids. The RC code is a bounded vocabulary a client can act on, so a framework door sends it; the `http()` source sends neither, because its 500 is part of the route author's own public API. The message stays in the boundary log and the failure event, which are operator-facing.
2. **A failure is the caller's only when it came from the caller's own request, judged by origin, never by code.** The same code is raised in more than one place: `RC5065` by the dispatched route's `.input()` and by a nested `direct()` call's, `RC5049` by the dispatched ingress route's resume door and by a plugin resuming on its own behalf, `RC5068` by a validate hook on the dispatched route and by one on a nested route, `RC5015` by `authorize()` and by an adapter whose upstream login was refused, `RC5004` by the door's own lookup and by a nested `direct()` to a missing endpoint. Only the first of each pair is the caller's doing. The origin is recorded where the failure is raised (`isAuthorizationRefusal`, the `InputValidationFailure` and `HookRefusal` causes naming their route, the door's own pre-dispatch check) and the door reads that, never the code alone.
3. **A caller-caused answer carries what the caller can act on and nothing the instance owns.** The schema issues for a refused payload, at most 20 of them and each path and message clipped to 256 characters, so a large payload cannot produce a proportional response; one fixed reason per class of refusal, collapsed where the caller's remedy is the same, so a prober cannot tell which check it tripped; the missing scopes, because the caller can request them; a validate hook's kind and reason, because the hook's author wrote them for the refused party, and never the hook's name.

| Door | Caller-caused (by origin) | Anything else |
|------|---------------------------|---------------|
| `http()` source | 400 with the `.input()` issues; 401 for a missing or expired credential where one could change the outcome; 403 `insufficient_permissions` or `insufficient_scope`; a validate hook's `RC5068` with the status its kind maps to (`invalid` 400 to `unavailable` 503) and the hook's reason | 500 `internal server error`, no code |
| ops dispatch | The `http()` mapping, plus 404 for an unknown route id (or an imported route whose remote no longer has it) and 409 for a route with no dispatch door, both decided by the dispatch's own check only | 500 with the RC code |
| MCP tool call | `isError` carrying the `.input()` issues or the refusal class; `AI2002` for a declined call | `isError` naming the tool and the RC code |
| ACP mount | The JSON-RPC taxonomy below: `-32602` for input the turn route's `.input()` or a validate hook refused as `invalid`, `-32001` for every other refusal of the caller's own request (a validate hook's other kinds, `authorize()` on the turn route), each carrying the code, the kind and the reason | `-32603` carrying the RC code |

One instance fault crosses with detail, as a named exception: an MCP tool whose result body breaks the `outputSchema` it advertised answers with the failing fields, because `tools/list` already published that schema and its paths tell the caller nothing new. The output headers schema is never published, so its failures stay generic.

Surfaces that answer outside callers without running a route follow rule 1 on their own terms: an ops contributed resource answers a failure with its code (and a malformed limit or cursor, the caller's, with the mount's fixed text); an MCP Apps view whose `ui.html` loader fails answers `resources/read` with a fixed text naming the tool, since a file loader's error names a host path, and the error is logged with its message also carried by `plugin:mcp:ui:failed`; a proxied MCP tool sends a generic text for a framework failure, passes a guard's own message through because the guard's author wrote it for the caller, and relays the upstream server's result unchanged, since that text is the upstream's, not ours.

A new door reuses the shared classification (`callerRefusalOf`) rather than re-deriving it, so the same refusal cannot be a 403 on one door and a 500 on another. The security side of these rules (why identity refusals map only for the admitted principal) is in [security.md](./security.md) § Doors map refusals by origin.

---

## Error Code Philosophy

- **Core owns the `RC` namespace.** Core codes are defined in `packages/routecraft/src/error.ts`. Ecosystem packages register their own namespaced codes (e.g. `AI1001`) via `ErrorCodeRegistry` declaration merging plus a runtime `registerErrorCodes(namespace, codes, owner)` call; each namespace is claimable by exactly one owner package.
- **Codes represent failure patterns**, not step types. Community adapters use framework codes with specific message/suggestion overrides (e.g., `rcError("RC5010", cause, { message: "Redis connection refused on port 6379" })`).
- **Generic RC codes are ecosystem-throwable.** Adapters and ecosystem packages may throw these core codes directly (with message/suggestion/retryable overrides) instead of minting their own: `RC5001` (step failed, catch-all), `RC5003` (adapter misconfigured), `RC5004` (no handler available), `RC5010` (connection failed), `RC5011` (timeout), `RC5012` (authentication failed), `RC5013` (rate limited), `RC5014` (resource not found), `RC5015` (permission denied), `RC5016` (source payload parse failed), `RC5017` (optional peer missing), and `RC1110` when a plugin's port provider refuses a contribution that arrives after the application froze (the kernel's contract for `PluginContext.frozen`). The remaining RC codes are engine-internal; do not throw them from ecosystem code.
- **A code earns its place** when its docs page can provide specific, actionable troubleshooting steps. Otherwise, use the catch-all (RC5001) and put specifics in the message override; register a namespaced code only when the failure pattern is genuinely package-specific.

### JSON-RPC refusals on the ACP mount

The ACP mount answers a refused request with a JSON-RPC error, and a client branches on the code rather than the message. The taxonomy is decided once for the mount, not per method, and it is the contract `craft acp` is written against:

| Code | Name | The mount uses it for | What a client may infer |
|------|------|-----------------------|-------------------------|
| `-32002` | Resource not found | A session the caller cannot see: missing, owned by somebody else, or belonging to an agent this harness does not serve. One code and one message for all three, so the answer is not an oracle for which ids exist | The conversation is gone from this view. A bridge drops it from its tracking and tells the person to start a new one |
| `-32602` | Invalid params | Input the mount cannot act on: a content block it does not accept, a prompt with no text, a configuration option it does not offer, an agent name the instance does not hold; and, through `callerRefusalOf`, a turn-route `.input()` refusal or a validate hook refusing as `invalid`, with `{ code, kind, issues \| reason }` in `data` | The request was wrong, not the conversation. Nothing is dropped; the same request will be refused again until it changes |
| `-32001` | Refused | A refusal of the caller's own request on the turn route that is not a parameter fault: a validate hook's `forbidden`, `not_found`, `conflict`, `gone`, `rate_limited` or `unavailable` (`unauthenticated` downgrades to `forbidden`, since the mount reads no credential per request), or the route's own `authorize()`. `data` carries `{ code, kind, reason? }`, the message is the hook's reason | The conversation exists and the request was understood; what a client does next follows the kind, exactly as an http caller reads the status the same kind maps to |
| `-32603` | Internal error | Any handler failure that is not a refusal the mount raised itself: a failed turn, a store outage, a fault in the mount. `data` carries at most the RC code, never the message | The instance is unwell. The conversation may well still exist; keep it and retry later |
| `-32000` | Connection lost | Minted by `craft acp`, never by the mount: the relay's own answer to an editor request the dead transport never answered | The instance is being reconnected to; the request was not delivered |

A refusal of one kind must never be reported under another code: the bridge's drop-on-not-found rule is only safe while not-found means exactly that. A new refusal the mount grows picks its code from this table, or adds a row and says what a client may infer from it.

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

- Every `route:exchange:started` must eventually be followed by exactly one of: `:completed`, `:failed`, `:dropped`, or `:deferred`. The exception is a **forced stop**, in either of its two forms: a forced shutdown (`shutdown.timeout` elapsed) or a route taken out of service by `.enabled()` whose drain outran its grace (`.enabled({ drainGrace })`, defaulting to `shutdown.timeout`). Both abandon in-flight exchanges mid-step through the same `abortExecution` path, and neither emits a terminal event.

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
