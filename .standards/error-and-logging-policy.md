# Error and Logging Policy

Authoritative rules for error handling, logging, and eventing in RouteCraft.

---

## 1. Throw specific, log at boundary

- **Throw:** Create a `RouteCraftError` with specific `message` and `suggestion` overrides, or throw a plain `Error` (the framework preserves it). Throwing does not obligate the thrower to log.
- **Boundary:** The catch that **handles** the error (does not re-throw) is the boundary. Only the boundary logs.
- **Never catch-log-throw:** If a catch block re-throws, it must NOT log. Logging and re-throwing creates duplicate log lines.

## 2. Use the error's own message as the pino log string

At a boundary, use `err.meta.message` (`RouteCraftError`) or `err.message` (plain `Error`) as the pino message string. Variable context (route, operation, adapter, tool) goes in the first-arg bindings object. Do not use generic strings like "Step failed" as the log message; the error already says what went wrong.

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

When logging a failure, put the error in bindings (e.g., `{ err, operation, adapter }`). `RouteCraftError` implements `toJSON()` so `rc`, `message`, `suggestion`, `docs`, `causeMessage`, `causeStack` appear in serialized logs.

## 7. Validation and cause serialization

When creating `RouteCraftError` for validation (e.g., RC5002), ensure the **cause** serializes to something useful in logs (e.g., `JSON.stringify(issues)` or a normalized object). Never pass an object that will log as `[object Object]`.

---

## Boundaries

Each boundary handles the error (does not re-throw it to another boundary). Do not add new boundaries without updating this list.

| Boundary | Context | Level | Bindings |
|----------|---------|-------|----------|
| **route.runSteps** | Step/exchange failures | error | `{ err, operation }` |
| **context.start** | Route start and context start failures | fatal | `{ route?, err }` |
| **Timer adapter** | Handler error | error | `{ adapter: "timer", err }` |
| **route.trackTask** | Background task (e.g., tap) rejection | error | `{ err, route }` |
| **AI server tool handler** | Tool call errors | error | `{ tool, err }` |

All boundaries use `err.meta.message` (`RouteCraftError`) or `err.message` (plain `Error`) as the log message, with a fallback string specific to the boundary.

---

## Error Code Philosophy

- **All codes are framework-owned.** Defined in `packages/routecraft/src/error.ts`. The `RCCode` type is a closed union. No external registration, no adapter-defined codes.
- **Codes represent failure patterns**, not step types. Community adapters use framework codes with specific message/suggestion overrides (e.g., `rcError("RC5010", cause, { message: "Redis connection refused on port 6379" })`).
- **A code earns its place** when its docs page can provide specific, actionable troubleshooting steps. Otherwise, use the catch-all (RC5001) and put specifics in the message override.

### Progressive quality ladder for adapter authors

| Level | What to do |
|-------|-----------|
| 0 | Throw plain `Error`. Framework wraps with RC5001, preserves original message and stack. |
| 1 | Throw `rcError(rc, cause)` with the right framework code. Specific docs link, retryable flag. |
| 2 | Throw `rcError(rc, cause, { message, suggestion })`. Specific log message and actionable guidance. |

---

## API

- Use `rcError(rc, cause?, { message?, suggestion?, docs? })` from `packages/routecraft/src/error.ts` for framework and adapter errors.
- Use normal `throw new Error` only when you do not need an RC code or docs link.
- Log with `context.logger` in sources and `exchange.logger` in steps/destinations.
- At boundaries: `logger.error({ err, operation, adapter }, err.meta.message)`.
- Emit and observe context events for lifecycle and errors.

---

## References

- Error source: `packages/routecraft/src/error.ts`
- Logger source: `packages/routecraft/src/logger.ts`
- Context source: `packages/routecraft/src/context.ts`
- Error reference docs: `apps/routecraft.dev/src/app/docs/reference/errors/page.md`
- Monitoring docs: `apps/routecraft.dev/src/app/docs/introduction/monitoring/page.md`
