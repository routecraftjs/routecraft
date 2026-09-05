# @routecraft/routecraft

## 0.7.0

### Minor Changes

- [#718](https://github.com/routecraftjs/routecraft/pull/718) [`b7255b0`](https://github.com/routecraftjs/routecraft/commit/b7255b0d69a0dcd1b4b33965a9391d287f847bca) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Named agent sessions with a durable transcript, an inbox, and interrupt ([#716](https://github.com/routecraftjs/routecraft/issues/716)).

  **`agent(name, { session })`**, and `session` on the inline form, make an agent remember: every message for one session id continues one transcript, kept under `(agent, session)` and loaded, appended and stored back per turn. Absent `session`, nothing changes. The model is told its own session id in a `## Session` system block.

  **Where sessions live.** Records go to their own store, chosen by a new `sessions: { store }` key on `defineConfig` (or `sessionsPlugin()`): SQLite at `.routecraft/sessions.db` by default, created by the first session written rather than at boot, `"memory"` by opt-in, or a `SessionStore` of your own, a four-operation contract (`get`, `create`, `replace` under a version compare-and-swap, `keys`) that both shipped backends, `SqliteSessionStore` and `MemorySessionStore`, pass the same contract suite against. `ROUTECRAFT_SESSION_STORE` names it from the environment. An explicitly configured path that cannot be opened fails at startup, and a value naming neither a location nor a backend is refused with `RC5003`; a store failure is the new `AI1012`. The continuation a turn stores between turns stays in the suspension store, because it is a parked exchange, so `session` still needs a `suspension` block. Core exports its SQLite seam so the session store opens on the same runtime split as the suspension store and shares its path resolution, busy classification and transactional migration runner (`resolveSqliteDriver`, `resolveDatabasePath`, `isSqliteBusy`, `migrateSqlite`).

  **One turn at a time per session.** A message that arrives while a turn is running goes to the session's durable inbox; its caller is acknowledged with `AgentResult.session.status === "queued"` and the queued messages become the next turn's first user message, in order, as one message with the parts in order. That turn starts on its own at the boundary, and runs on the route: a turn that ends with work outstanding stores its exchange's continuation at the agent step (body and headers, as a `.suspend()` park stores them), and the boundary turn is that continuation revived in process, so the route's steps after the agent run on the boundary turn's reply. **`interrupt: true`**, on either form, cancels the running turn through the existing cancellation path, keeps its partial transcript (including the tool call that was in flight), and starts a turn with what queued plus the interrupting message. A turn a restart cut short is treated the same way at the next turn. The stored record carries a shape version, so a record another release wrote fails as `AI1010` naming the store rather than as a provider refusal one turn later.

  **`AgentResult.session`** carries `{ agent, id, status, queued }`. **`FnHandlerContext.session`** hands a tool the session it runs in. A turn runs under the principal of the exchange it runs on; every inbox item records its poster's subject and the delivered message renders it per part as quoted data, and the record keeps the subject that started the session (`startedBy` on the management API). Who may post is the route's `.authorize()`.

  **Contributed management resources.** Core's ops plugin gains `registerOpsResource(ctx, { name, description, list, describe })`: a read-only resource another package contributes, served under the introspection tier at `GET /ops/{name}` and `GET /ops/{name}/{segment...}`, with `parsePageQuery`, `takePage` and `decodeCursor` exported so a contributor pages on the route listing's cursor contract; a throw from a contributor is a 500 carrying its code, and `RC5059` a 400. `@routecraft/ai` registers **`agent-sessions`**, which lists every session with its turn state, inbox depth and background calls in flight, filtered by `agent` and paged by `limit` and `after`.

  New events: `route:agent:session:queued`, `:interrupted`, `:restored`, `:parked`, `:revived`. New error codes `AI1010` and `AI1012`. Core exports `parkAside` and `reviveSuspension` as internals for a tier that stores a continuation beside a completing run and revives it itself. The internal one-run module of the agent tier is renamed from `session.ts` to `run.ts` (`AgentCancellationCause` stays exported).

- [#681](https://github.com/routecraftjs/routecraft/pull/681) [`044917c`](https://github.com/routecraftjs/routecraft/commit/044917c02f7a51027fc0133135d15ece310a44b1) Thanks [@ex0b1t](https://github.com/ex0b1t)! - `authorize()` gains `anyScope` and `effective` ([#680](https://github.com/routecraftjs/routecraft/issues/680)).

  Two gaps that both forced routes down to `predicate`, where a refusal costs the recoverable error shape: a failing predicate throws `RC5015`, which carries no `missing.scopes`, so exactly the routes that most need to name what would have worked lose the ability to.

  **`anyScope` is the OR.** `scopes` requires every entry; `anyScope` admits a principal holding any ONE of them, for a scope family whose variants are interchangeable at the door (`leave:read`, `leave:read:self`, `leave:read:base`) and narrow further down the pipeline. A refusal throws `RC5038` naming the whole accepted set rather than one entry, because any of them would have opened the door and a consent flow should be able to offer the caller the choice. Given both, `scopes` and `anyScope` compose as an AND of the two conditions. An empty array is refused with `RC2001` when the validator is built: unlike `scopes: []`, which is a requirement of nothing and vacuously satisfied, an accepted set naming nobody admits nobody, and one computed empty (a tenant lookup that missed, an unset environment variable) would otherwise remove a route's only scope gate in silence.

  The cause carries `missing.mode` alongside `missing.scopes`: `"all"` when every listed scope was required and absent, `"any"` when the list is the whole accepted set and one entry suffices. Without it a consent flow acting on the documented contract would request every member of an interchangeable family and grant a wider ring than the route ever asked for. The field is optional on `InsufficientAuthority`, so an application that throws that shape itself keeps compiling.

  **`effective` reads the actor's scopes too.** `effective: true` satisfies `scopes` and `anyScope` from the subject's ring plus the OUTERMOST actor's, which is how an agent exercises its own standing authority on a caller's behalf: an agent legitimately holds scopes nobody who asks it for something holds, and without this it can never act on anyone's behalf under its own grant.

  Three bounds on that flag, each deliberate:

  - **The outermost actor only, never the chain.** Prior actors stay audit data (RFC 8693 section 4.1), the rule `actor` already follows. Walking the chain would undo the intersection `delegate()` applies at every hop and let authority accumulate with delegation depth, and accumulating authority fails open where missing authority fails closed. A route raising `maxDelegationDepth` gets deeper delegation but no deeper scope reading.
  - **Never applies to `roles`.** A role is what the principal IS; scopes are what a keyring CARRIES, and only keyrings are inheritable.
  - **A documented no-op under the default `actor: 'none'`**, which admits no actor for the flag to read. It reads `actor.scopes`, so the actor has to carry some: an actor minted by `delegate()` does, one parsed from a token's RFC 8693 `act` claim does not, since that claim has no scope member. Map your IdP's own shape with `ClaimMappers.actor` for token-borne delegation.

  Widening a check this way ADDS the agent's standing scopes to the subject's rather than capping the caller by them: the check reads the union, and `delegate()` does not intersect delegated scopes with the actor's own either. What an agent's grant bounds is the additional authority a caller gains by going through it, which is the control this moves and why the flag is opt-in per route rather than a context-wide default.

  Existing routes are unaffected: `effective` defaults to `false`, `anyScope` defaults to absent, and the shared `missingScopes` helper the scope-gated ops tiers depend on keeps its AND semantics over the subject's own ring.

- [#638](https://github.com/routecraftjs/routecraft/pull/638) [`8aa360e`](https://github.com/routecraftjs/routecraft/commit/8aa360e34a67a0affb90bf6283405eb65fc5d51f) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Lifecycle and shutdown hardening.

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

  **API CHANGE: `context:stopped` carries `{ forced, pending }`** instead of an
  empty payload, so a forced shutdown is visible to a subscriber rather than
  only to whoever holds the return value or reads the exit code. The shape does
  not vary: a clean stop carries `forced: false` and an empty `pending`. A
  handler typed against the old empty payload keeps compiling.

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

- [#645](https://github.com/routecraftjs/routecraft/pull/645) [`602787a`](https://github.com/routecraftjs/routecraft/commit/602787a60494f73cdd6d9d550c293ea0e6fd3dfa) Thanks [@ex0b1t](https://github.com/ex0b1t)! - The management API on the ops server, plus `craft exec` and `craft ops` ([#209](https://github.com/routecraftjs/routecraft/issues/209), [#194](https://github.com/routecraftjs/routecraft/issues/194), [#644](https://github.com/routecraftjs/routecraft/issues/644)).

  A running instance can now be driven over HTTP, locally or remotely, and two CLI command families are clients of that one surface.

  ## The API

  Three resources on the ops mount, under `/ops`. Dispatching creates an exchange, so the exchange is a sub-resource of the route it runs on rather than a verb of its own.

  | Method and path                   | Tier          | What                                 |
  | --------------------------------- | ------------- | ------------------------------------ |
  | `GET /ops/routes`                 | introspection | List routes, filtered and paginated  |
  | `GET /ops/routes/{id}`            | introspection | Describe one route                   |
  | `POST /ops/routes/{id}/exchanges` | dispatch      | Dispatch work and return the outcome |

  The handlers are transport-agnostic and the mount is a thin door over them, so the console's control API can grow over the same handlers later without protocol rework.

  **Secure by default, and loudly so.** Every tier is disabled unless named, and a disabled tier answers **404 rather than 403**: an unconfigured instance discloses neither its route inventory nor that a management surface exists. Each tier takes `false` (the default), `true` (open), or a scope string the caller's principal must carry. `ops:introspection` and `ops:dispatch` are the documented names, `ops:operations` is reserved, and dispatch is always its own scope so a dashboard token that reads the inventory cannot also run work.

  Authentication is ordinary mount auth: the ops mount's own `auth`, else the named server's, per the existing inheritance rules. Nothing bespoke. A tier naming a scope with no validator in scope fails the boot rather than guessing, since admitting everyone and refusing everyone are opposites and neither is what was written.

  **No bypass and no synthetic operator principal.** A dispatch runs the full pre-from chain and `.authorize()` sees exactly the principal the validator minted, so an operator dispatch is indistinguishable from any other authenticated caller.

  **Collections page for real.** Every collection response is `{ items, nextCursor }`, never a bare array, with keyset cursors matching the suspension store's idiom. A cursor is valid only for the filter that produced it, and a malformed `limit` is refused rather than clamped: a caller silently handed a bounded page cannot tell a truncated answer from a complete one.

  **A park is an outcome.** A dispatch against a suspendable route answers 202 with the standard `Suspended` acknowledgment. A drop is reported separately from a failure, because a filter saying no and a step breaking need different answers.

  ## The clients

  `craft exec <route> [--field=value ...]` dispatches and prints the result; input can also arrive as JSON on stdin. `craft ops health | ready | routes [id] | indicators [name]` reads the instance's own state.

  Both resolve one **personal settings file** (`.routecraft/settings.yaml`, project-local then global), overridden by `CRAFT_URL` / `CRAFT_TOKEN` / `CRAFT_FORMAT` and then by flags. It is the person's file, never app configuration. A connection failure names both the address used and which source supplied it. Output is `pretty` by default, with `json` and `raw`.

  The CLI groups by operator task rather than by URL prefix: `craft ops health` reads `/health/**`, which is deliberately not under `/ops`, and both are stated once in the docs so nobody "fixes" the apparent inconsistency in either direction. Health never walls but returns more when authenticated, so the clients present a credential whenever the settings provide one and say which view is being shown rather than rendering a status with no reason.

  ## Breaking notes

  **`ops.auth: false` is no longer refused.** It previously threw as a no-op; it now carries the server plugin's meaning unchanged, so no validator is effective for the mount. Consequences: the `health.details` gate closes, and a scope-gated tier has nothing to check against and fails the boot. Nothing that worked before stops working; what changes is that a spelling which used to be an error is now meaningful.

  **`apiKey()` gains `scopes`**, applied to the principal minted by the static `keys` allowlist, so a deployment without an identity provider can satisfy a scope check. It is refused alongside `verify`, where the returned principal already says what it carries.

  New error codes: `RC5059` (a refused paging argument) and `RC5060` (a dispatch against a route with no `direct()` door).

  `missingCredentialResponse` moved into the shared HTTP response module, and the `~standard.jsonSchema` reader was extracted out of the suspension descriptor so both callers share one implementation. The JSON Schema dialect is passed explicitly at each call site, so a display choice in the management API can never move a stored continuation hash.

- [#592](https://github.com/routecraftjs/routecraft/pull/592) [`489fb85`](https://github.com/routecraftjs/routecraft/commit/489fb85ea8479a36a4a43ec19288884e42c81c5c) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Resumed continuations honour the filter chain, and the detached definition is derived per position ([#580](https://github.com/routecraftjs/routecraft/issues/580)).

  A resumed exchange's continuation ran under a `RouteDefinition` assembled as an object literal with empty filter arrays, inherited from the `.debounce()` release path. The pre-from filter chain therefore did not apply to execution two at all, and the one position that did (`error`) applied because it had been copied by hand rather than chosen.

  **`.concurrency()` now bounds resumed continuations.** This is the user-visible fix. A route declaring `.concurrency({ max: 5 })` because a downstream tolerates five calls at a time was getting five ingress executions **plus unbounded resumes** against that same downstream, so a batch of approvals landing together could overrun the limit the bulkhead exists to enforce. Ingress executions and resumed continuations now compete for the same limiter.

  **`.retry()` and `.timeout()` now apply to execution two.** Both are safe against the store transition: attempts and deadlines run before any terminal outcome is recorded, so a retried continuation never spends the approval it was answering.

  **Upgrade note.** A route that already declares route-scope `.retry()` alongside a `.suspend()` gains at-least-once execution of the steps after the suspend point, where the chain previously did not reach them. That is the same guarantee those retries already gave the steps before the suspend, but it is new for the continuation and needs no opt-in, so make continuation steps idempotent or move side effects a downstream cannot absorb twice behind a step-scope wrapper you control. This is why the bump is `minor` rather than `patch`: previously documented "does not run" behaviour becomes "runs".

  **Which positions apply is now declared, not inherited.** `pipeline/chain-policy.ts` keys a survival record by `Exclude<keyof RouteDefinition, NonChainField>`, so every chain position states an answer for each of the three runs that re-enter a route partway down (a resume, a `.debounce()` release, and an error-channel re-entry), each with its own reason. Adding any field to `RouteDefinition` fails the build until it is classified, and adding a fourth kind of detached run fails every position until each says what it means, which is what stops a future chain position from silently not applying to continuations.

  Positions that stay off on a resume, with the reasoning now in code and on the [filter chain page](https://routecraft.dev/docs/advanced/filter-chain): `authorize` (a restored principal fails `RC5043` by design, so copying it would refuse every resume), `parse` (the stored body is already parsed), `input` (it validates the shape arriving at the route, and execution two starts mid-pipeline with a transformed body), `throttle` (it admits new work, and the exchange was admitted on execution one), `circuitBreaker` (a continuation runs after the resume has claimed the suspension, so fast-failing there would spend the approval; its home is the resume ingress route's own chain), and `cache` (already refused at build alongside a reachable suspend).

  `.debounce()` release behaviour is unchanged, now because its own policy says so rather than by sharing one.

- [#586](https://github.com/routecraftjs/routecraft/pull/586) [`a9b355c`](https://github.com/routecraftjs/routecraft/commit/a9b355c66ebf7572e46705626bf2909664b7da50) Thanks [@ex0b1t](https://github.com/ex0b1t)! - `craft start`, the convention-based project runtime ([#131](https://github.com/routecraftjs/routecraft/issues/131)), and drop-in compatibility for Claude Code agent files ([#340](https://github.com/routecraftjs/routecraft/issues/340)).

  **`craft start [dir]`** boots a whole project from its folder layout instead of a hand-written barrel: `craft.config.ts`, then `plugins/`, then any folder an ecosystem package has claimed, then `capabilities/`. Both the root-level and `src/`-nested layouts work, and a folder that is absent is skipped. A directory holding `route.ts` is one capability and is not descended into, so colocated tests, fixtures and private helpers are never imported. A `plugins/` module that default-exports a factory is an error naming the file, because a factory needs arguments the runtime cannot invent.

  **`registerProjectDiscoverer`** lets a package claim a convention folder and turn it into a config fragment, which is how `agents/` and `skills/` get their meaning without the CLI ever depending on `@routecraft/ai`. A discoverer receives a context object (the folder, the content root, the project root, and the configuration accumulated so far) and declares its ordering as `after: ["skills"]` rather than a magic number. Cycles are an error; a dependency on a folder nobody registered is satisfied. A claimed folder present with no discoverer registered fails loudly, naming the erased type-import case, since that is the one the author will be staring at.

  Skills compose house folder, then frontmatter `skills:` refs in declared order, then the bundle's own folder, most specific winning and every source named in the startup log. Refs are local paths or `npm:` package refs resolved against installed packages only. Precedence is code wins, convention fills the gaps, applied per field: an agent declared in `craft.config.ts` keeps every field it set and discovery contributes only the skill set it left unset.

  `--once` shuts down after the first exchange reaches a terminal outcome, and pairs with `--timeout <ms>` so a project that produces nothing reports instead of hanging.

  **Claude Code agent files** load without edits: unknown frontmatter is ignored with a warning, `tools` and `disallowedTools` accept Claude's comma-separated string, `model` accepts the `opus` / `sonnet` / `haiku` aliases and `inherit`, and a reference to a Claude built-in this runtime does not provide is dropped with a warning rather than failing the load. `disallowedTools` without `tools` is rejected at load: a per-agent list replaces the context default rather than narrowing it, so a deny list alone cannot be honoured and silently inheriting the denied tools would be the worst reading of the file.

  New error code `AI1004` for a `skills:` ref that does not resolve.

- [#667](https://github.com/routecraftjs/routecraft/pull/667) [`67189a4`](https://github.com/routecraftjs/routecraft/commit/67189a4036ec9462110b138996c517d89eb80262) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Every authored time option now takes `Duration` (`number | "5m"`), and the `Ms` suffix is gone from all of them.

  The framework had two conventions and they had drifted into a contradiction: `.cache({ ttl })` took raw milliseconds while `.suspend({ ttl })` took `Duration`, so the same property name meant two different types on two operations. One option used `Duration` and roughly two dozen used raw milliseconds.

  The rule is now one line: **input options a user writes take `Duration`; values the framework reports stay millisecond numbers.** `Duration` is a superset of `number`, so widening breaks nothing on its own; the break is the rename, because a name ending in `Ms` that accepts `"5m"` lies.

  Reported values are deliberately unchanged: `durationMs` on events, `ageMs` on ops responses, `backoffMs` on `route:retry:attempt`, and every other emitted millisecond stays exactly as it was. Those are machine-readable data, not authored configuration. Internal resolved shapes (`ResolvedTimeoutOptions.timeoutMs`, `refillPerMs`, `SuspensionRuntime.defaultTtlMs`) are computed values and stay too.

  ## Migration

  | Surface               | Old                                     | New                                                                 |
  | --------------------- | --------------------------------------- | ------------------------------------------------------------------- |
  | `timer()`             | `intervalMs`                            | `interval`                                                          |
  | `timer()`             | `delayMs`                               | `delay`                                                             |
  | `timer()`             | `jitterMs`                              | `maxJitter`                                                         |
  | `cron()`              | `jitterMs`                              | `maxJitter`                                                         |
  | `http()`              | `timeoutMs`                             | `timeout`                                                           |
  | `mail()`              | `pollIntervalMs`                        | `pollInterval`                                                      |
  | `mail({ reconnect })` | `baseDelayMs`                           | `baseDelay`                                                         |
  | `mail({ reconnect })` | `maxDelayMs`                            | `maxDelay`                                                          |
  | `.timeout()`          | `.timeout(timeoutMs: number)`           | `.timeout(duration: Duration)`                                      |
  | `.delay()`            | `.delay(delayMs: number)`               | `.delay(duration: Duration)`                                        |
  | `.retry()`            | `backoffMs`                             | `backoff`                                                           |
  | `.retry()`            | `maxBackoffMs`                          | `maxBackoff`                                                        |
  | `.circuitBreaker()`   | `windowMs`                              | `window`                                                            |
  | `.circuitBreaker()`   | `cooldownMs`                            | `cooldown`                                                          |
  | `.debounce()`         | `waitMs`                                | `wait`                                                              |
  | `.debounce()`         | `maxWaitMs`                             | `maxWait`                                                           |
  | `.batch()`            | `flushIntervalMs`                       | `flushInterval`                                                     |
  | `.sample()`           | `intervalMs`                            | `interval`                                                          |
  | `.cache()`            | `ttl: number`                           | `ttl: Duration` (name unchanged)                                    |
  | `.dedupe()`           | `ttl: number`                           | `ttl: Duration` (name unchanged)                                    |
  | `defineConfig`        | `shutdown.timeoutMs`                    | `shutdown.timeout`                                                  |
  | `defineConfig`        | `servers.<name>.shutdownGraceMs`        | `servers.<name>.shutdownGrace`                                      |
  | `defineConfig`        | `telemetry.sqlite.eventFlushIntervalMs` | `telemetry.sqlite.eventFlushInterval`                               |
  | `defineIndicator`     | `maxAgeMs`                              | `maxAge`                                                            |
  | `mcpPlugin`           | `restartDelayMs`                        | `restartDelay`                                                      |
  | `mcpPlugin`           | `toolRefreshIntervalMs`                 | `toolRefreshInterval`                                               |
  | `@routecraft/testing` | `routesReadyTimeoutMs`                  | `routesReadyTimeout`                                                |
  | `@routecraft/testing` | `delayBeforeDrainMs`                    | `delayBeforeDrain`                                                  |
  | `.throttle()`         | `per: ThrottleTimeUnit`                 | `per: ThrottleTimeUnit \| Duration` (widened, unit words unchanged) |

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

  `jitter` becomes `maxJitter` on `timer()` and `cron()` rather than the bare `jitter` a straight desuffixing would give. Two reasons. It is genuinely a maximum: each delay is drawn uniformly from `[0, maxJitter)`, matching the `maxBackoff` / `maxWait` / `maxDelay` prefix already in the DSL. And `.retry({ jitter })` is a _fraction_ in `[0, 1]`, not a duration, so a bare `jitter` would have meant two different types on two operations, which is exactly the `ttl` defect this change exists to close. `.retry({ jitter })` is deliberately untouched: a fraction is the right model where the backoff it perturbs varies per attempt.

  `.throttle({ per })` now also accepts a `Duration`, so a window no unit word names (`per: "90s"`) is expressible. The unit words keep their exact meaning. **A bare number is milliseconds**, as everywhere else a `Duration` is accepted: `per: 60` is a 60ms window, not a minute. Write `per: "60s"` or `per: "minute"`.

  Two supporting changes come with it. `assertDurationMs` is folded into `parseDuration`, which grows an optional `min` floor (`0` for waits, `1` for deadlines), so one guard now owns the whole grammar instead of two that could drift. `Duration` and `parseDuration` move from `suspension/` to `shared/` internally; both are still exported from the package root, so nothing changes for consumers.

  The `craft start --timeout` flag now also accepts a duration string (`--timeout 30s`); a bare number is still milliseconds.

- [#676](https://github.com/routecraftjs/routecraft/pull/676) [`567c922`](https://github.com/routecraftjs/routecraft/commit/567c9221fc3ea6fd4eb334836c2d1cd600daa0fa) Thanks [@ex0b1t](https://github.com/ex0b1t)! - `timingSafeStringEqual` is now exported from the package root.

  A custom `validator` is the supported way to admit a request on a shared secret, and it works on every surface that takes one, the MCP server included. Until now nobody outside the package could write that comparison safely: `===` on a secret returns as soon as two bytes differ, and the time it took is a measurement an attacker can repeat to recover the secret a byte at a time. The framework had the constant-time comparison already and kept it to itself.

  The documented custom-validator example on `ValidatorAuthOptions` now uses it, so the pattern a reader copies is the safe one.

- [#573](https://github.com/routecraftjs/routecraft/pull/573) [`8f01cf8`](https://github.com/routecraftjs/routecraft/commit/8f01cf8802e17217eb045116ed248fc22a3d09e5) Thanks [@ex0b1t](https://github.com/ex0b1t)! - `forward()` now carries the caller's identity and trace ([#567](https://github.com/routecraftjs/routecraft/issues/567)).

  `Route.buildForward()` built the forwarded exchange with no headers, so a forwarded call arrived anonymous and separately traced. A target declaring `.authorize()` refused it with `RC5012`; a target without one ran with no authority at all. The forwarded call also got a fresh correlation id, breaking the audit chain at the forward boundary.

  This affected every caller of `forward()`: route-scope and step-scope `.error()` handlers, `circuitBreaker` fallbacks, and `BlockClient.forward` in `@routecraft/ai`, which is the documented way to back an agent block with a route. A memory or knowledge block resolved that way was either refused by its target or served identically to every caller regardless of who asked.

  A `direct()` destination never had the bug because it hands the target its live exchange, headers and all. Forward builds a fresh envelope, so it has to pass the caller's headers explicitly. It now does, which brings the two in-process paths to parity.

  Headers travel by reference rather than as a copy. Both authenticity brands (`markAuthentic`, `markRestored`) are identity-keyed `WeakSet` membership, so any copy silently drops them: a copied restored principal would fail `authorize()` with `RC5023` ("self-asserted") instead of the correct `RC5043` ("restored, not verified live"), and re-branding one to compensate would launder an unverified identity into a trusted one. Propagation is unconditional and cannot escalate: it is the same frozen authority the calling route was already running under.

  `Route.getForward()` now takes the calling exchange as a required argument. It is `@internal`, and required rather than optional so a new call site cannot silently reintroduce the anonymous forward.

  **Engine-owned headers are re-established at every route ingress.** `buildExchange` is the single ingress constructor, so it now mints a fresh `routecraft.id` rather than letting one be inherited. An inherited exchange id collides in every store keyed by it: telemetry spans (`${exchangeId}:${contextId}`), the `exchanges` and `exchange_snapshots` tables, and suspension ids (`${exchangeId}~${sequence}`). The correlation id, not the exchange id, is what links a hop. This corrects the pre-existing `direct()` behaviour too, where the target route previously ran under the caller's exchange id.

  **Split hierarchy no longer crosses a route boundary.** `buildExchange` now drops `routecraft.split_hierarchy` at route ingress. A split group can only join within the executor run that created it, so a hierarchy arriving from another route was unjoinable by construction, and actively harmful: `.aggregate()` looks the trailing group id up in the context-wide split-parent store, so it would find the _caller's_ parent exchange and delete that entry on completion, corrupting an aggregation still in flight on the calling route. This also closes the same latent hazard on the pre-existing `direct()` path.

  Two consequences worth knowing. A target route with a strict `.input({ headers })` schema now sees the caller's headers and may reject a forward that previously passed. And forwarding a principal whose `expiresAt` has passed now surfaces the expiry error rather than `RC5012`, which is the correct failure but a different one.

- [#721](https://github.com/routecraftjs/routecraft/pull/721) [`07e9b4c`](https://github.com/routecraftjs/routecraft/commit/07e9b4c118ad509d13b3e07dccdca488481f9788) Thanks [@ex0b1t](https://github.com/ex0b1t)! - `html()` text extraction changes what it returns: escaped markup is no longer deleted, and whitespace inside the match is no longer collapsed ([#719](https://github.com/routecraftjs/routecraft/issues/719)).

  `extract: "text"`, `"innerText"` and `"textContent"` ran a tag-stripping regex over text cheerio had already decoded. At that point there is no markup left to strip, so the regex could only match content the page had escaped on purpose: `<pre>type X = Array&lt;string&gt;;</pre>` came back as `type X = Array;`, with no signal to the caller that anything had been dropped. Removing it changes two things, on all three roles that extract (transformer, source, enricher).

  **Whitespace inside the match now survives.** This is the half that reaches the most routes. The stripping step also collapsed every run of whitespace to a single space, so any page with ordinary indentation was being flattened:

  ```
  <div class="card">
    <h2>Getting started</h2>
    <p>Install the   package
       and run it.</p>
  </div>

  before: "Getting started Install the package and run it."
  after:  "Getting started\n  Install the   package\n     and run it."
  ```

  Only the ends are trimmed, per matched element in the array case. A `<pre>` therefore keeps its newlines and indentation too, which is the code-sample case that motivated the fix.

  **Escaped markup now survives.** `Array&lt;string&gt;` extracts as `Array<string>` rather than `Array`. The value is decoded and unsanitised: a page that escaped a payload gets it back as live markup, so escape it at the sink before writing extracted text into HTML or into any line-structured format.

  **You are affected if** a route compares extracted text to a literal, keys or hashes on it, validates it against a schema, or writes it to a line-oriented sink. There is no compile error and no new option to notice. Collapse it in the route where you want the old shape:

  ```ts
  .transform(html<unknown, string>({ selector: '.card', extract: 'text' }))
  .transform((text) => text.replace(/\s+/g, ' '))
  ```

  `<style>` and `<script>` subtrees are still removed from text extraction, which is the part that genuinely needed handling. `extract: "html"`, `"outerHtml"` and `"attr"` are unchanged.

- [#655](https://github.com/routecraftjs/routecraft/pull/655) [`72073ae`](https://github.com/routecraftjs/routecraft/commit/72073ae5cebb5d3d01c5bd6a9cf760c298469835) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Two options on the `http()` client: `maxBodySize` and `redirect`.

  **`maxBodySize` caps the response body, defaulting to 10 MB.** This is a behaviour change for any route already moving larger payloads through `http()`: raise the option on that call to keep working. The name and the number are the http plugin's inbound `maxBodySize`, deliberately, so one concept means one thing on both sides of the framework.

  The cap is enforced at the two moments the size can be known. A declared `Content-Length` above the cap is refused before the body is read; otherwise the body streams and the running count is checked as it arrives, so the response is abandoned the moment the ceiling is crossed. The second arm is what bounds memory rather than only bounding what the route receives, and it is the only one available for a chunked response that declares nothing.

  Exceeding the cap fails the exchange with the new `RC5061`, naming the option, the limit, and the size that was declared or counted. The body is never truncated to fit: half a JSON document parses as though it were whole, and a route acting on it would be quietly wrong instead of loudly failed. The cap applies to error responses too, and the size error names the status so the HTTP failure stays legible.

  **`redirect: "follow" | "manual" | "error"` mirrors the platform, and the default stays `"follow"`.** Nothing changes for a route that does not set it.

  `"manual"` returns the 3xx itself with `Location` readable, so a route that validated a URL can re-run its own rule on each hop instead of having the adapter walk somewhere the route never approved. A 3xx under `"manual"` does not trip `throwOnHttpError`, because it is the outcome the route asked for; every other non-2xx still does.

  ```ts
  .enrich(http({ url: (ex) => ex.body.url, maxBodySize: 2_000_000, redirect: 'manual' }))
  .choice(when(isRedirect, revalidateAndFollow))
  ```

  `isRedirect` and `HTTP_REDIRECT_STATUSES` are exported alongside the option, because the adapter already owns that rule and the obvious hand-rolled version (`status >= 300 && status < 400`) includes `304`, which is a cache answer rather than a hop. What to do on a hop stays the route's own business.

  `maxBodySize` accepts `Infinity` as the named opt-out; zero and negatives are refused rather than read as "no limit".

  The option reports what happened and hands control back. It carries no allowlist, no address classification and no cross-host rules: whether a URL is acceptable is the route's decision, where a reader can see the rule and change it. `.standards/package-boundaries.md` section 6.1 records that as a general rule for framework additions.

- [#713](https://github.com/routecraftjs/routecraft/pull/713) [`3cd2c9f`](https://github.com/routecraftjs/routecraft/commit/3cd2c9f19b0d6d6f22763461662c1eab1991d8d5) Thanks [@claude](https://github.com/apps/claude)! - `http({ responseBody: "bytes" })` stops the client corrupting binary responses ([#712](https://github.com/routecraftjs/routecraft/issues/712)).

  The `http()` client read every response through a `TextDecoder` and handed the route a string. There was no binary arm, so any body that is not valid UTF-8 was silently destroyed: each invalid sequence became U+FFFD and re-encoded as three bytes, and the original could not be recovered.

  The corruption was asymmetric, which is why it survived. Measured on a real fetch:

  ```
  jpeg:     8 bytes in, 16 out, identical=false
  ogg/opus: 8 bytes in,  8 out, identical=true
  ```

  An Ogg page header is the ASCII `OggS`, so a voice note passed through intact, while a JPEG's leading `ff d8 ff e0` did not. A route fetching both saw one work and the other fail, which reads as a problem with the file rather than with the transport. Until now such a route had to call `fetch` directly and reimplement the size cap and the timeout.

  ```ts
  .enrich(http({ url: (ex) => ex.body.mediaUrl, responseBody: 'bytes' }))
  ```

  `responseBody: "text"` is the default and is exactly today's behaviour. `"bytes"` hands the route a `Uint8Array` of what arrived, with no decoding and no JSON parsing. Name the result type yourself (`http<In, Uint8Array>({ ... })`): the option deliberately does not change it, since an option value selecting an adapter's type is what the Option Laws forbid. `maxBodySize` and `timeout` apply unchanged, counting bytes as they arrive. With `throwOnHttpError`, a failing binary response reports its size and content type instead of quoting a decoded body, since decoding it for the message would reintroduce the corruption on the error path.

  The mode is explicit rather than sniffed from the content type: sniffing would silently change the body type of an existing route that receives `application/octet-stream` today and reads it as a string.

  **The `body` option's type is narrowed, though in practice only `bigint` and `symbol` bodies stop compiling.** It was `unknown | ((exchange) => unknown)`, and a union containing `unknown` collapses to `unknown`, so the callback form had no contextual parameter type and every call site annotated its own exchange by hand. The value arm is now a named `HttpRequestPayload` (string, number, boolean, null, object, `Uint8Array`, `ArrayBuffer`, `URLSearchParams`, `FormData`). `object` is a member and absorbs almost everything, so the union is broad in practice: a route passing a value outside it will no longer compile, but that is only `bigint` and `symbol`. A callback's return type is still unchecked for the same reason. In exchange, `body: (ex) => ...` now gets `ex` typed as the route's exchange with no annotation.

  Also fixed: the client set `Content-Type: application/json` when it found no header spelled exactly `Content-Type`, so a route that set `content-type` in lowercase got the header twice, arriving as `application/json, application/json`. The lookup is case-insensitive now.

  Not included, by design: streaming the response body to the route. The body is buffered under the cap in both modes; a route that needs a stream is a different option.

- [#711](https://github.com/routecraftjs/routecraft/pull/711) [`261d9a4`](https://github.com/routecraftjs/routecraft/commit/261d9a45659ae32ff8e06f5ed2d523983e48dac2) Thanks [@claude](https://github.com/apps/claude)! - `http({ respond })` decides when the caller is answered, so a webhook can acknowledge before the pipeline runs ([#710](https://github.com/routecraftjs/routecraft/issues/710)).

  An `http()` source answered the caller with the pipeline's result, which is right for an API and wrong for a webhook whose work outlasts the sender's patience. Bird treats anything past a few seconds as a failed delivery and redelivers under the same `webhook-id` for about 27 hours, Stripe and Svix behave the same way, and the Standard Webhooks specification says to acknowledge before processing. Route authors worked around this with two routes and a `direct()` hand-off, a split that existed only because the framework had no way to answer early.

  `respond` is a function called once per request, after every gate has passed and after the pipeline has been started. The response is sent when it returns, so the function decides whether the caller waits:

  ```ts
  // Acknowledge, then process: `finished` is never touched.
  .from(http({ path: '/hooks/bird', method: 'POST', respond: () => ({ status: 202 }) }))

  // Answer with the result, which is what omitting the option does.
  respond: async ({ finished }) => ({ status: 200, body: (await finished).body })
  ```

  It receives `{ request, finished }` and returns `{ status, headers?, body? }`, which the dispatcher serialises by the same rules as a pipeline result. Returning `undefined` defers to the pipeline and answers with its result, so one responder can decide per request. `status` is required and validated, since an omitted one would otherwise be a silent 200 that a webhook sender reads as an acknowledgement, and a status that forbids a body drops it so Bun and Node answer alike. `request` is the parsed request the route sees, never the `Request`, whose body has already been read to parse it and verify its signature. Omitting `respond` entirely keeps the previous behaviour exactly, including streaming and the suspension acknowledgement, which a responder does not carry.

  Every gate runs before the responder: a bad signature is still a 401 and the responder never runs.

  **Failures move to the error channel.** Once a responder has answered, the response is gone, so a pipeline failure reaches the route's `.error()` handler and the ordinary error events (`route:error`, `context:error`, `route:exchange:failed`) and nowhere else. Give such a route an `.error()` handler.

  **Shutdown still waits.** A detached run is the route's in-flight work from the moment it starts, and the context drains that work before any listener closes. The pipeline is started before the responder is called, which is what puts it inside that drain.

  **Two refusals, both deliberately wider than they look.** Nothing can tell before calling a responder whether it will await the pipeline, since that is decided inside the function, so both guards cover every responder including one that would have been safe. A responder on a route that also uses `.batch()` is refused (`RC5003`) at subscribe, because a batched message waits in the buffer instead of counting as in-flight work and would be discarded at shutdown after the answer had gone. And once shutdown has begun a responder is not called at all: the request answers `503` with `retry-after` so the sender redelivers to the next instance.

  **Bound admission, not execution.** Answering early removes the backpressure the caller's wait provided. `.throttle()` and `.concurrency()` before `.from()` still apply, but their defaults (`mode: "queue"` with no `maxQueue`, `mode: "delay"`) cap how many run at once while letting the wait line grow without limit, which a redelivery burst turns into unbounded heap. Give `.concurrency()` a `maxQueue`, or `mode: "reject"`, on any route that answers early. Note also that a refusal only reaches the sender when it happens before the answer: `.authorize()` runs inside the pipeline, so a denial stops the work without the caller being able to tell it from acceptance.

  **OpenAPI.** A route with a responder advertises no success code, because the document cannot know what a function returns; its rejection codes stay, since every gate still runs ahead of it. A route that wants documented success codes omits the option.

  Not included, by design: no retry, replay, or persistence of a detached delivery. One lost to a crash is the sender's redelivery to make, which is what deduplicating on `webhook-id` in the route is for.

- [#670](https://github.com/routecraftjs/routecraft/pull/670) [`d738d05`](https://github.com/routecraftjs/routecraft/commit/d738d05b946292bb4ebb78984507877f8ed3d259) Thanks [@(ex)](<https://github.com/(ex)>)! - Server-Sent Events and streaming responses on the http source ([#388](https://github.com/routecraftjs/routecraft/issues/388)).

  A route can now answer with a stream. The dispatcher rejected one with `RC5018` and the comment "SSE deferred"; that gate is gone and the two body shapes it refused have become two rows in the response-convention table.

  ## Framing

  An `AsyncIterable` body answers `text/event-stream; charset=utf-8` with `Cache-Control: no-cache`, one SSE frame per yielded value. An object carrying a `data` property is an event descriptor, so `event`, `id` and `retry` are read from it; any other value becomes `data: <JSON>`. Strings and `Uint8Array`s pass through as raw bytes, which is the escape hatch for a hand-built frame, an SSE comment, or a different line format entirely.

  A `ReadableStream` body passes through unframed as `application/octet-stream`, with the caller owning every header. Framing follows the body type rather than the content type, so a route that overrides the content type to `application/x-ndjson` yields strings and writes its own newlines.

  ```ts
  craft()
    .id("order-events")
    .from(http({ path: "/orders/:id/events", method: "GET" }))
    .transform(async function* (_, ex) {
      for await (const update of watchOrder(
        ex.headers["routecraft.http.params"].id,
      )) {
        yield { event: "update", id: update.sequence, data: update };
      }
    })
    .to(noop());
  ```

  There is no `sse()` adapter, and there will not be one. SSE is an HTTP response, not a protocol: no upgrade, the same request/response shape, one exchange per request with the pre-from chain applying once at entry. WebSocket is genuinely different and gets its own adapter.

  ## Lifecycle

  A client that disconnects cancels the route's iterator, visible as a `return()` into a generator's `finally` or a `for await` exiting. `plugin:http:request:completed` is held back until the stream closes, so `durationMs` spans request receipt to stream end. Open streams end when the context begins stopping rather than being waited out by the listener's grace window, and a streaming request claims a per-request idle-timeout exemption so a quiet stream is not reaped.

  **Resilience operations apply up to the first byte, and no further.** Once the status line is sent the response cannot be replayed: `retry()` cannot re-run a half-delivered stream, and `timeout()` bounds time to first byte rather than the life of the stream.

  Every event stream opens with a `: open` comment. Neither runtime puts the status line on the wire before the body's first chunk, so without it a stream that starts quiet leaves the client's `fetch` unresolved and an `EventSource` without its `open`.

  `Last-Event-ID` arrives on the exchange like any other request header. Replay is the route's own business, since only the route knows what its ids mean.

  ## Streaming an agent

  `agent({ stream: true })` produces the token deltas instead of the consolidated `AgentResult`, so a route serving a model's reply over SSE is one declarative step:

  ```ts
  craft()
    .id("chat-stream")
    .input({ body: ChatInput })
    .from(http({ path: "/chat/stream", method: "POST" }))
    .to(
      agent({
        system: aria,
   => (ex.body as z.infer<typeof ChatInput>).message,
        stream: true,
      }),
    );
  ```

  The queue and the abort that closes it live inside the adapter beside `onDelta`, and abandoning the stream aborts the run, so a client that disconnects mid-answer stops the model. Only the `stream: true` call site widens its declared output; every other agent route still says `AgentResult`. Setting `stream` alongside `onDelta` is refused at construction, since they are the pull and push spellings of one thing.

  ## The ops event tail

  `GET /ops/events` tails the context event bus as SSE, gated by a new `events` tier (`ops:events` is the documented scope name). Its own tier rather than a corner of introspection: a route listing describes an app's shape, while the tail carries what it is doing right now. A bounded buffer keeps a slow reader from growing memory without bound, and a dropped-count frame says so rather than leaving a silent gap.

  ## Bounds on a streaming listener

  A streaming response is exempt from the idle reaper, which was the only limit
  on how long a connection could stay open, so two options on a server
  definition put a ceiling back. `idleTimeout` (a `Duration`, default `"255s"`)
  sets the reap window for ordinary connections and is refused above Bun's 255s
  ceiling rather than clamped, because a config honoured on Node and capped on
  Bun means two different things depending on where it runs.
  `maxStreamingRequests` (default `500`) caps the streams one listener carries
  and answers `503` with `Retry-After` past it. A backstop below the
  file-descriptor cliff, the same kind of number as `maxBodySize`'s 10 MB, and
  a complement to `.concurrency({ max, mode: "reject" })` rather than a
  replacement: the route operation shapes one endpoint, the listener cap catches
  the routes that never thought about it. It counts requests that claim a slot,
  so a surface declaring itself long-lived for every request (today, the MCP
  mount) is not counted and the cap is not a total.

  A stream admitted on an expiring credential now closes at expiry, through the
  same `isPrincipalExpired` boundary the rest of the framework checks. No 401 is
  attempted, because one cannot follow a `200` already on the wire; an
  `EventSource` reconnects by specification and meets ordinary admission. A
  browser client authenticates through `apiKey({ in: "query" })`, documented
  with the caveat that query strings reach access logs and browser history.

  ## Notes

  `RC5018` keeps its meaning for request-side refusals (413 and 400); only the streaming-response arm is gone. `HttpMountContext` gains `claimStreamingSlot()`, which exempts a request from the reaper and counts it against the cap in one decision, returning a release or refusing. `plugin:http:request:completed` gains an optional `error`, so a stream that breaks after its status line is sent stops being counted as a `200`. The cycle-safe JSON the telemetry sink kept private moved to a shared module and now identifies framework objects by their brand rather than by key names, matching how `logger.ts` already discriminates them. `anySignal` is exported for composing cancellation scopes, replacing six hand-rolled variants that had drifted on the empty case.

- [#700](https://github.com/routecraftjs/routecraft/pull/700) [`a97f6b2`](https://github.com/routecraftjs/routecraft/commit/a97f6b260f6143c2139b15a596c2074920403a14) Thanks [@ex0b1t](https://github.com/ex0b1t)! - `http({ signature })` verifies the Standard Webhooks scheme ([#698](https://github.com/routecraftjs/routecraft/issues/698)).

  Deliveries signed per [the specification](https://www.standardwebhooks.com/), which Resend, Bird and Svix among others send, now verify declaratively instead of forcing `rawBody: true` and a hand-rolled HMAC in a route step.

  ```ts
  .from(http({
    path: '/hooks/bird',
    method: 'POST',
    signature: {
      scheme: 'standard-webhooks',
      secret: process.env.BIRD_WEBHOOK_SECRET!,
    },
  }))
  ```

  The scheme reads the three headers the specification fixes (`webhook-id`, `webhook-timestamp`, `webhook-signature`), signs `<id>.<timestamp>.<raw body>` with the base64-decoded secret, and admits when any space-separated `v1,` entry matches under the existing constant-time comparison, which is what key rotation looks like on the wire. `toleranceSec` bounds replay exactly as it does for Stripe, defaulting to 300 seconds. Verification is checked against the published vector from the specification's own reference implementation, not one this repo invented.

  **This scheme takes no `header`.** The specification fixes all three names it reads, so there is nothing to configure but the secret, and renaming only the signature header would have built a route that constructs cleanly and then rejects every delivery. `header` stays required for the other three schemes, and the options type is now a discriminated union on `scheme`, so passing a header here, or omitting one there, is a compile error as well as a construction-time `RC5003`.

  **A malformed secret fails at the `http({...})` call site**, not on the first delivery, where it would have looked like the sender's fault. The `whsec_` prefix and base64 padding are both optional, matching the reference implementation. The refusal names the field and the expected shape, never the value, since error causes reach logs.

  This covers the symmetric half of the specification. Asymmetric signatures (`v1a`, ed25519) are not verified, and such an entry is skipped like any other unsupported version. Svix's own default headers are `svix-` prefixed rather than `webhook-`, so a delivery from a sender that has not white-labelled them needs the manual escape hatch; the reference page says so.

  Redeliveries inside the freshness window are the route's to deduplicate, through the specification's `webhook-id`; the gate does not track delivery ids. A passing signature authenticates the sending system and mints no principal. Both are now written down in `.standards/security.md` beside the defaults themselves.

  The three shipped schemes behave exactly as before. Internally, `verifyWebhookSignature` takes the request's header set rather than one pre-read value and dispatches on the scheme before reading anything, because a scheme decides for itself which headers it needs; the replay bound is shared with `"stripe-timestamped"` rather than copied.

- [#679](https://github.com/routecraftjs/routecraft/pull/679) [`3b48ba5`](https://github.com/routecraftjs/routecraft/commit/3b48ba52bfe8bc91cf77de8023e080e534b5eca2) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Http surfaces become discoverable protected resources, and the CLI reads the challenge ([#669](https://github.com/routecraftjs/routecraft/issues/669)).

  Routecraft verifies; issuers issue. This release makes a refused caller able to find out who issues, on every http surface rather than only MCP.

  ## Server
  - The RFC 9728 protected-resource metadata builder and the CORS policy engine move from `@routecraft/ai` into core (`buildProtectedResourceMetadata`, `HttpCorsOptions`, exported from the package root). MCP consumes the shared implementation with unchanged behaviour on its own claimed paths; `McpCorsOptions` and `McpCorsOriginResolver` remain as aliases.
  - Every http server serves `/.well-known/oauth-protected-resource`, with RFC 9728 path-suffixed documents mirroring any path no mount claims exactly. Documents are sourced from the owning mount's effective validator (issuer from `jwt()` / `jwks()`) and declared scopes; the ops mount declares its scope-gated tier values as `scopes_supported`. A bare `{ validator }` with no issuer yields an honest minimal document.
  - Every bearer 401 (shared middleware, the synthesized missing-credential response on http and ops) carries a `resource_metadata` hint in its `WWW-Authenticate` challenge; the ops `insufficient_scope` 403 carries it alongside the `scope` it already named.

  ## CLI
  - `craft exec` and `craft ops` parse `WWW-Authenticate` on a refusal, follow the `resource_metadata` hint (best effort, 5s timeout), and extend the refusal with which scope is required, who issues acceptable tokens, and how to supply a credential (`--token`, `CRAFT_TOKEN`, settings file).
  - `.routecraft/settings.yml` is accepted beside `settings.yaml`, resolved independently per location; a location carrying both spellings refuses with both paths named.

  ## Docs

  The credential ladder as recipes on securing-capabilities and the ops reference: no auth, a static key compared with `timingSafeStringEqual`, a self-signed JWT via `jwt({ secret })`, and a real IdP via `jwks()`. The static-key recipe is compiled and run verbatim by the test suite.

- [#679](https://github.com/routecraftjs/routecraft/pull/679) [`3b48ba5`](https://github.com/routecraftjs/routecraft/commit/3b48ba52bfe8bc91cf77de8023e080e534b5eca2) Thanks [@ex0b1t](https://github.com/ex0b1t)! - `direct({ internal: true })`: a trusting subroutine can close its external doors ([#677](https://github.com/routecraftjs/routecraft/issues/677)).

  An internal direct source keeps its in-process endpoint, so `direct("id")` enrichers and `forward()` compose against it unchanged, and skips the capability registry: the route is not dispatchable through the ops management API (the listing shows `dispatchable: false`) and not resolvable as an agent `directTool`.

  Both external doors refuse by name. Ops dispatch keeps `RC5060` but says the route is declared internal instead of advising a direct source the route already has, and a `directTool` naming an internal route fails `context.start()` with the boundary-route guidance: expose a route carrying `.input()`, `.description()` and `.authorize()`, and point the tool at that.

  The default is unchanged: `direct()` routes stay dispatchable, and the option is additive.

- [#576](https://github.com/routecraftjs/routecraft/pull/576) [`fbf9bfc`](https://github.com/routecraftjs/routecraft/commit/fbf9bfc56507eb492ce4ebf5aaac3ac5715b8c02) Thanks [@ex0b1t](https://github.com/ex0b1t)! - **Behaviour change.** An MCP tool whose route drops the exchange now returns an error result instead of the caller's own request ([#214](https://github.com/routecraftjs/routecraft/issues/214)).

  A dropped exchange (a `.filter()` rejecting, a `.choice()` matching no branch, an error handler returning `recovery.drop()`) resolves with the body it came in with. The MCP server was publishing that as the tool's result, `structuredContent` included, so a client received its own arguments back and could not tell them from an answer the tool had computed. `CraftClient.sendDirect` and the route-scope `forward` have always raised `RC5031` for exactly this case; MCP was the one request/reply surface still echoing.

  Such a call now comes back as `isError: true` with a message saying the tool declined the request, under the new error code `AI2002`, and never carries the request body back. This applies to every MCP tool, whether or not its route declares `.output()`, because an echoed request is not a result under any schema.

  A decline is not counted as a failure. It emits the new `plugin:mcp:tool:declined` event and logs at warn, leaving `plugin:mcp:tool:failed` and error-level logs to mean what they did before. A tool whose route filters declines as a matter of course, and an error-rate alert should not fire on ordinary traffic.

  If a route reaches a drop on a path where the caller should receive a value, give it a branch that produces one (an empty list, an explicit not-found shape) or recover with a body in `.error()`. A drop that is genuinely the right answer now says so honestly instead of fabricating a result.

  Core exports `isDropped(exchange)` so request/reply source adapters outside core can tell "the route declined" apart from "the route produced this", which is not otherwise reachable: the flag lives on the exchange's internals.

- [#576](https://github.com/routecraftjs/routecraft/pull/576) [`fbf9bfc`](https://github.com/routecraftjs/routecraft/commit/fbf9bfc56507eb492ce4ebf5aaac3ac5715b8c02) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Enforce the `outputSchema` an MCP tool advertises ([#214](https://github.com/routecraftjs/routecraft/issues/214)).

  A route exposed with `.from(mcp())` that declares `.output({ body })` has that schema advertised as the tool's `outputSchema` in `tools/list`, and spec-compliant clients parse the result's `structuredContent` against it. The MCP server now checks the body it is about to publish and refuses one the schema rejects: the call returns `isError: true` carrying the failing fields (new error code `AI2001`) instead of a result that contradicts what the server promised.

  The route pipeline already validated the exchanges it completes, and keeps reporting those violations as `RC5002`. What this adds is a check at the surface that made the promise, for results that reached it without passing through that validation: a tool registered directly in `MCP_LOCAL_TOOL_REGISTRY` today, and a suspension once [#550](https://github.com/routecraftjs/routecraft/issues/550) lands.

  A body the route already validated is deliberately not re-checked. Output validation replaces the body with the schema's output value, so re-running the schema would reject what it had just produced: a route declaring `.output({ at: z.string().transform((s) => new Date(s)) })` would fail every call with "expected string, received Date". Core records which schema accepted the body and exposes it as `wasOutputValidated(exchange, schema)`, beside `isDropped`, compared by identity so an exchange validated against one contract does not count as validated against another. Any request/reply adapter enforcing the same schema at its own boundary can avoid the same trap.

  Tools whose route declares no `.output()` advertise no schema and are unchanged.

  The advertised contract now has one owner: `advertisedOutputArms(entry)` is what `tools/list` publishes and what enforcement accepts, so the two cannot drift.

  A run that parks at a `.suspend()` answers with the framework's `Suspended` acknowledgment rather than the route's declared output, and the pipeline skips output validation for it. Enforcement accepts it (via `isSuspended`), so a suspending MCP tool answers with its acknowledgment instead of a validation error. Advertising that second arm as `oneOf: [Output, Suspended]` in `tools/list` is still open: it needs a schema for the acknowledgment and a signal that a route can park, neither of which core exposes yet. Until then a strict client that validates `structuredContent` against the advertised schema will reject a suspension response, exactly as it did before this change.

  Core also exports `validateAgainst(schema, value)`, the Standard Schema helper the pipeline validates with, typed to the schema's output and returning the raw `issues` alongside the formatted message, for adapter authors who need a validation failure as data to hand back over the wire rather than as a thrown error.

- [#631](https://github.com/routecraftjs/routecraft/pull/631) [`443b160`](https://github.com/routecraftjs/routecraft/commit/443b160380cabbea7d880fb3899c8265e5a43bb5) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Unify mount auth across http, mcp and ops, and make the listener a mount property ([#628](https://github.com/routecraftjs/routecraft/issues/628)).

  One vocabulary on every mount:

  - `auth` unset inherits the server validator as a wall when one exists.
  - `auth: <config>` is the mount's own wall, replacing the server's validator.
  - `auth: false` removes the wall and keeps the inherited validator reachable, so a route's `.authorize()` still pulls identity through it. On mcp this replaces "credentials are never inspected": a valid token now attaches a principal to tool calls and an invalid one is treated as absent.

  The registry resolves the rule once into per-mount facts (`HttpMountAuth` on the mount context: `configured` / `own` / `optedOut` / `walled`); `serverAuthConfigured` is removed from `WebIngress` and `HttpMountContext`.

  The ops surface gains `auth`, feeding its `health.details` gate through the mount's effective validator without ever walling the probes. The gate now fails closed with no validator in scope: an explicit `when-authenticated` refuses the boot, and the unwritten default withholds details with a startup warning instead of serving them to every caller.

  `server` becomes a mount property on http: each entry under `mounts` names its own listener (default `"default"`), the plugin's top-level `server` remains only as the single-mount shorthand and is refused alongside `mounts`, and the built-ins describe only routes on their own listener.

  ```ts
  defineConfig({
    servers: { default: { port: 8080 }, internal: { port: 9090 } },
    ops: { auth: { kind: "apiKey", name: "x-ops-key", keys: [opsKey] } },
    mcp: { auth: jwks({ issuer }) },
    http: {
      mounts: {
        api: { path: "/api", auth: { kind: "apiKey", keys: [apiKey] } },
        webhooks: { path: "/webhooks", auth: false },
        admin: { path: "/admin", server: "internal" },
      },
    },
  });
  ```

- [#620](https://github.com/routecraftjs/routecraft/pull/620) [`a18bee7`](https://github.com/routecraftjs/routecraft/commit/a18bee75b821c63bd53041d0e353b59bc476ad29) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Add named HTTP servers and bind-time mount claims so HTTP routes, MCP, health endpoints, and custom plugins can share one listener on distinct paths while retaining isolated-server topology.

  This removes the listener-owned `http.port`, `http.host`, `mcp.port`, and `mcp.host` options. Define the listener once and select it by name:

  ```ts
  // Before
  defineConfig({
    http: { host: "0.0.0.0", port: 8080 },
    plugins: [mcpPlugin({ transport: "http", host: "0.0.0.0", port: 8081 })],
  });

  // After: shared listener, distinct paths
  defineConfig({
    servers: { public: { host: "0.0.0.0", port: 8080 } },
    http: { server: "public" },
    plugins: [mcpPlugin({ transport: "http", server: "public", path: "/mcp" })],
  });
  ```

  Use a separate server name to give any surface a dedicated port. Further
  user-visible changes:

  - Listener lifecycle events move from `plugin:http:server:listening` /
    `plugin:http:server:closed` to `server:listening`, `server:failed`, and
    `server:closed`, each carrying the server name.
  - Bearer `auth:rejected` reasons are now the bounded underscore vocabulary
    shared with MCP (`invalid_token`, `unsupported_scheme`, `infrastructure`,
    `expired`, `insufficient_scope` where applicable), rather than the previous
    HTTP free-text literals.
  - A bearer verification that fails on the server side (JWKS unreachable,
    network error) now answers `500` on the HTTP surface instead of
    `401 invalid token`, so clients keep their cached token during an IdP blip.
  - `mcpPlugin({ transport: "http" })` now requires an explicit HTTPS
    `resource.url` unless `NODE_ENV` is exactly `development` or `test`
    (an unset `NODE_ENV` counts as production and fails closed). Previously an
    omitted `resource.url` silently advertised the bound address.
  - Servers optionally take a server-level `auth` validator inherited by every
    mounted surface (opt out per mount with `auth: false`) and a
    `shutdownGraceMs` bound on graceful drain.
  - The http plugin gains named path-scoped mounts, and the mount now decides
    authentication. `http: { mounts: { api: { path: "/api" }, default: { path:
"/", auth: false } } }` walls `/api` (inheriting the server validator) while
    the catch-all stays public; routes pick a surface with `http({ mount:
"api", path: "/orders" })` (paths are relative to the mount prefix). The
    per-route `http({ auth: "required" | "optional" | "skip" })` option is
    REMOVED: a public route is public because of where it lives, a route that
    needs identity on a public mount declares `.authorize()` (which forces
    verification through the server validator), and there is no route-level way
    to weaken a mount's wall. The former `"optional"` personalisation mode has
    no equivalent.
  - The bearer middleware now enforces principal expiry itself (floored,
    inclusive, fail-closed on non-finite values), so a custom validator that
    returns an already-elapsed `expiresAt` is rejected with `expired` on HTTP
    routes too, not only on MCP.
  - `plugin:mcp:server:listening` is removed. Subscribe to `server:listening`
    on the MCP transport's named server instead; the MCP path is config
    (`mcpPlugin({ path })`).
  - `auth:rejected` / `auth:success` carry a consistent `source` per surface:
    `http` for the default HTTP mount, `http:<name>` for named mounts, `mcp`
    for the MCP transport, on every rejection path including missing
    credentials and webhook signatures.
  - The HTTP bearer missing-credential reason is now `missing_header` (event
    and 401 body), matching MCP and the documented bounded vocabulary;
    api-key keeps `missing api key`.
  - Mount paths are validated as static canonical pathname prefixes: no `?`,
    `#`, `:param` segments, empty segments, backslashes, or percent-encoding,
    and the path must survive URL parsing unchanged (no `.` or `..` segments,
    no spaces or characters the parser rewrites). `mcpPlugin({ path })` is held
    to the same contract and additionally rejects `"/"` (previously a root
    path was silently remapped to `/mcp`); the shared validator is exported as
    `normalizeStaticPathPrefix`.
  - `mcpPlugin`'s HTTP transport no longer waits for its named server to bind
    during the plugin `start()` hook, so plugin registration order relative to
    the servers plugin cannot deadlock startup. A missing or undeclared server
    still fails fast at apply time.
  - Listeners reap idle connections after 255s, and mounts that hold quiet
    long-lived streams (the MCP transport; custom mounts via
    `longLived: true`) exempt their requests per request, so silent streams
    are never cut while parked sockets still get reaped.

- [#623](https://github.com/routecraftjs/routecraft/pull/623) [`cf46f07`](https://github.com/routecraftjs/routecraft/commit/cf46f0707913ff4902ea45e71066ce5500f65939) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Add the ops plugin: an operational surface mounted on a named server, with health as its first capability.

  Enable it with `defineConfig({ ops: {} })`. It needs no application code: route lifecycle, circuit-breaker position and the context's own serving state are all derived from events the framework already emits.

  ```ts
  defineConfig({
    servers: { ops: { port: 9090 } },
    ops: { server: "ops" },
  });
  ```

  Five paths, three signals, separated by what acting on the answer does:

  - `GET /health`: operational health, every component. What an uptime monitor pages on.
  - `GET /health/live`: liveness. 200 while the process is up, and nothing else ever, so a third party going down cannot restart every replica.
  - `GET /health/ready`: readiness. Instance-domain components only, because derotating a replica helps only when the peers are in a better position.
  - `GET /health/routes/<id>` and `GET /health/indicators/<name>`: one component with its own status code.

  Further user-visible details:

  - The report carries `view` and `status`; there is no separate `ready` flag, because it would be exactly `status !== "down"` and a derivable field of that name on the operational aggregate invites routing traffic on the deployment-wide signal.
  - Statuses are `up`, `degraded`, `down`, `inactive`. An exchange error is a route issue, not a health issue: only a dead source (`down`), an open breaker or a deliberate offline (`degraded`) move a route's status. A finished one-shot route reports `inactive` and is excluded from aggregation.
  - `defineIndicator({ name })` declares a dependency the framework cannot see, and the handle it returns is the push surface (`up()`, `down()`, `inactive()`). Register handles through `ops.indicators`. Give an indicator a `route` to bind it to a probe route's exchange outcomes and the route needs no health code at all; give it `maxAgeMs` to make silence go stale.
  - Per-component `details` maps default to `when-authenticated`, collapsing to `always` on a server with no validator configured (the same collapse the http plugin applies to `/ready`). `always` and `never` are the other settings. Statuses themselves are always served, so a probe with no credential always works.
  - The mount claims `/health` and `/ops` exhaustively, so a collision with another surface fails at bind time rather than being decided by dispatch order. `/ops/*` answers 404 until the action surface ships.
  - The http plugin now declares its `/health`, `/ready` and `/openapi.json` built-ins as mount claims, so another surface can no longer shadow them silently on dispatch score. The ops surface is the one deliberate exception: with both plugins on one server the http `/health` built-in stands down and ops answers that path, since the report is a strict superset of the constant. `WebIngress` gains `hasMount(id)` so a surface can make that decision from inside its `claims()` thunk.
  - `defineIndicator` refuses a name that is not usable as a single URL path segment, since the name is the last segment of `/health/indicators/<name>`.
  - A handle declared with `defineIndicator` but never listed in `ops.indicators` is reported at context start. Pushing through an unregistered handle is inert by design, so without the report the surface would look instrumented while watching nothing.
  - A server carrying `health.details: "when-authenticated"` with no validator configured warns at start, because the configured value reads back as a gate while behaving as `always`.
  - `plugin:ops:health:changed` fires on every component transition, carrying `component`, `name`, `from` and `to`.
  - The ledger is published on the store under `OPS_HEALTH_STATE` so other surfaces can read health without going through HTTP.

- [#630](https://github.com/routecraftjs/routecraft/pull/630) [`2432c0e`](https://github.com/routecraftjs/routecraft/commit/2432c0e5bccf1bdb73399439f2229beea910ee22) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Re-entrant suspend sites: a step can park the exchange it is executing, own the closure state that revives it, and be denied cleanly when its run is cancelled ([#268](https://github.com/routecraftjs/routecraft/issues/268), [#269](https://github.com/routecraftjs/routecraft/issues/269), [#552](https://github.com/routecraftjs/routecraft/issues/552), [#581](https://github.com/routecraftjs/routecraft/issues/581) groundwork).

  The core seam the agent tier plugs into, kept agent-ignorant:

  - **`markSuspendCapable(adapter)`** brands a `.to()` / `.enrich()` adapter as able to raise a durable suspension from inside its own execution. The suspend-site walk assigns such steps a re-entrant `SuspendSite` whose continuation includes the step itself, so a resume re-runs the step to finish the work it parked in the middle of. The step's own definition is therefore covered by the continuation hash: editing it invalidates its parked exchanges through the `RC5048` re-ask path. The `.split()` / `.multicast()` / `.dispatch()` refusals a static `.suspend()` gets at build time apply as recorded refusals that fire on the first actual suspension (`RC5051`), because whether a capable step ever parks is dynamic.
  - **`SuspendSignal`** is the throwable a branded adapter raises: `{ schema?, ttl?, meta?, callBinding?, stepState? }`. It converts into the ordinary `suspend` StepOutcome inside the hosting step, before any step-scope wrapper can observe the throw (a retry wrapper seeing the raw signal would re-run the park and charge the work twice).
  - **`stepState`** rides `SuspendRequest` into the record's existing opaque slot, under the same plain-JSON rule as the exchange (`RC5042`), and comes back through exchange internals (`peekResumeStepState`): the step reads without consuming, the executor clears when the step settles, and a retried attempt still resumes, while a later suspend-capable step in the same continuation starts clean. Nothing agent-shaped enters the core record.
  - **Validation narrows for re-entrant sites only**: no live `schema` can be read back off the route (it was raised inside the step's own code), so `RC5049` never fires there and the raw payload is delivered to the re-entering step as its suspended call's result. A resume-token holder can therefore hand such a step arbitrary JSON; the step is the validator. Static `.suspend()` sites keep full validation.
  - **New `suspendedSchema` / `SUSPENDED_JSON_SCHEMA` exports** give transports a Standard Schema for the acknowledgment, which is what lets the MCP server advertise `oneOf: [Output, Suspended]`. The acknowledgment stays `{ status, suspensionId, token, schema?, expiresAt? }`: it crosses the wire, so it carries the contract and nothing policy-shaped.
  - **New `RC5054`**: a run cancelled around its own park (an elapsed route-scope `.timeout()`) refuses to park before the store write, or immediately denies the just-written suspension after it, so no live resume link survives a run whose caller was told it failed. A token presented later reads `RC5050`. `context.stop()` is not cancellation: parked exchanges survive it, which is the store's entire purpose.

- [#667](https://github.com/routecraftjs/routecraft/pull/667) [`67189a4`](https://github.com/routecraftjs/routecraft/commit/67189a4036ec9462110b138996c517d89eb80262) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Stale option names now fail at build instead of being ignored.

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

- [#667](https://github.com/routecraftjs/routecraft/pull/667) [`67189a4`](https://github.com/routecraftjs/routecraft/commit/67189a4036ec9462110b138996c517d89eb80262) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Remove two `timer()` options that never worked: `exactTime` and `timePattern`.

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
  timer({ exactTime: "09:00:00" });

  // after
  cron("0 9 * * *", { timezone: "Europe/Amsterdam" });
  ```

  `cron()` gets the timezone handling `exactTime` never had. Note that it pulls the
  `croner` optional peer, which `timer()` does not require; that is a real
  consequence of the move even though nothing could have been relying on `exactTime`
  behaving correctly.

  The `exactTime` branches come out of `TimerSourceAdapter.subscribe()` with the
  option, so the adapter is simpler rather than carrying dead scheduling paths.

- [#667](https://github.com/routecraftjs/routecraft/pull/667) [`67189a4`](https://github.com/routecraftjs/routecraft/commit/67189a4036ec9462110b138996c517d89eb80262) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Add `.enabled()`: a route can now declare whether it runs at all.

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

- [#699](https://github.com/routecraftjs/routecraft/pull/699) [`3f64e8c`](https://github.com/routecraftjs/routecraft/commit/3f64e8c71452b0b4357a920ab2f4073d15e1f9f0) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Scaffolding from a repository keeps the files it copies, and parked agent threads can be rewritten in place.

  **The scaffolder no longer loses files ([#653](https://github.com/routecraftjs/routecraft/issues/653)).** A built-in example copied with `force: false` and no `errorOnExist`, so an example file landing where the base template already wrote one vanished with nothing in the output to say so. The collisions are now walked before the copy and named afterwards.

  **A URL example's `package.json` is merged, not overwritten.** It used to replace the base manifest outright, which threw away the project name the user had just typed and the package manager they picked, and meant `mergeExampleDeps` never ran on that path at all. The template still wins on everything it declares; `name` and `packageManager` stay with the scaffold, and the three dependency maps plus `scripts` merge key by key.

  **A `/tree/<branch>` URL no longer needs a subpath.** The pattern demanded one, so a whole repository at a named branch was unexpressible and a template repository could not scaffold from the branch under test in its own CI. The parser is now `parseGitHubExampleUrl`, exported and tested on its own. A branch is still one path segment: `feature/my-branch` parses as branch `feature` with subpath `my-branch`, because nothing in the URL says which slash is the boundary, and the JSDoc now says so instead of claiming multi-segment support the pattern never had.

  **The copy filter matches path segments.** It matched substrings, so `.gitignore` and every file under `.github/` were dropped along with the `.git` directory they were never aimed at, and a capability folder named `pnpm-lock.yaml-parser` went with the lockfile. `bun.lock` and `bun.lockb` join the lockfiles that are deliberately excluded.

  **Breaking (0.x, so `minor`): `SuspensionStore` gains a required `replaceStepState` member.** A custom store implementation has to add it; the two shipped backends already have it, so a deployment that uses `memory` or `sqlite` is unaffected.

  **`SuspensionStore.replaceStepState`** compare-and-swaps the opaque `stepState` slot of a record that is still `suspended`, leaving every other field alone. It is the one write that edits a parked record in place rather than settling it, and it exists for compaction: a thread that has outgrown the model's context window can only be shrunk while the exchange stays parked. The compare is a `stepStateFingerprint` of the state the caller read, so two rewrites of the same read produce one winner, and the swap only matches a still-parked row, so a resume that got there first wins outright. Both shipped backends implement it, and the cross-runtime suite proves they agree.

  **`replaceParkedThread` and `assertResumableThread`** (`@routecraft/ai`) put an agent's thread through that swap safely. A rewrite that breaks tool-call / tool-result pairing, duplicates a call id, empties the thread, or drops the suspended call the approver's answer lands on is refused with **`AI1008`** before the store is touched, so a failed compaction costs nothing and the run resumes uncompacted.

  **`AI1009`** separates "the prompt does not fit the model's context window" from every other dispatch failure. The two need opposite reactions and no shared status code distinguishes them; the classifier reads OpenAI's `context_length_exceeded` where there is one and matches the phrasings Anthropic, Google and the local runtimes actually emit otherwise. Every other failure is rethrown untouched, with its retryability intact.

- [#649](https://github.com/routecraftjs/routecraft/pull/649) [`0f2879a`](https://github.com/routecraftjs/routecraft/commit/0f2879a3264bd05d406c3c89de57c8ee0bc0fb48) Thanks [@ex0b1t](https://github.com/ex0b1t)! - `shell()`, isolated by default, and the framework half of the `Bash` agent tool ([#181](https://github.com/routecraftjs/routecraft/issues/181), [#343](https://github.com/routecraftjs/routecraft/issues/343)).

  **`shell(command, args?, options?)` in `@routecraft/os`** runs a command and produces `{ stdout, stderr, exitCode, signal?, truncated }`. It is fetch-shaped, like `agentBrowser()` beside it: `.enrich()` merges the result, `.to()` replaces the body with it, `.tap()` discards it.

  **It never invokes a shell.** The program is spawned directly with an argument vector, so no `bash` or `sh -c` interprets a command line and an argument can never become a command. That is the security boundary, and it is stronger than escaping. Ask for shell interpretation visibly with `shell("bash", ["-c", script])`.

  **Mark what came from outside with `untrusted()`.** Direct spawning stops an argument becoming a command; it does not stop one posing as an _option_ to the program you invoked, which is how `--upload-pack=evil` reaches `git clone`. Marked values get flag-injection protection, every argument gets control-character hygiene. Protection is per value because blanket protection strips the leading dashes off the author's own flags. The new `require-untrusted-shell-args` lint rule catches a value you forgot to mark. It ships in both presets as a warning rather than an error while its analysis is young, so a misfire is a nuisance in an editor instead of a failed build; raise it to `error` once you trust it on your own code.

  **A tier refuses an option it cannot satisfy, and never ignores one.** `network` defaults to denied, so `isolation: "none"` was handing back full egress under a default that said otherwise. That combination is now refused with `OS1004`, naming `network: true` as the way to accept egress out loud. Running uncontained costs two visible words rather than one silent default, and denied egress is the guarantee worth protecting: the `unshare` tier deliberately does not contain filesystem reads, so no-network is what stands between a command reading a credential and sending it somewhere.

  **The environment baseline carries fixed values, not inherited ones.** Granting the names while inheriting the values reopened what the grant model exists to close: `HOME` pointed at the caller's real home, so every command found `~/.aws/credentials` and `~/.ssh/config` unasked, and `PATH` was the caller's, so one writable entry on it chose the program. `PATH`, `HOME`, `LANG` and `TZ` now have documented fixed values, and `passEnv` is how a command asks for the caller's own.

  **Isolation tiers, named for their mechanism so the name is the promise.** `unshare` (Linux kernel namespaces) is the default; `none` is an explicit opt-out. The `unshare` tier guarantees no network egress unless the call sets `network: true`, no visible host processes, no host privileges, contained mounts, invisible host SysV IPC objects, and a hostname of its own. It does **not** contain filesystem reads: the command can still read every file the caller can, `~/.ssh` and `.env` included. That non-promise is documented on the adapter page rather than left implied.

  A tier that cannot be established fails with `OS1001` naming the cause and the ways out. `shell()` never degrades to a weaker tier.

  **The environment is granted, not inherited.** A command gets `PATH`, `HOME`, `LANG`, `TZ` and nothing else; further variables are declared per call with `env` (values) or `passEnv` (forwarded by name). Per-call options beat the `ROUTECRAFT_SHELL_ISOLATION` operator override, which beats `shellPlugin()` context defaults.

  **A lazily-resolved tool is no longer a lesser tool.** `directTool(routeId)` returns a thunk, because `craft.config.ts` is evaluated before any route is registered and the tool needs the route's `.description()` and `.input()`. Paths that read the registry entry before that resolution saw a thunk carrying nothing and reported the absence as a property of the tool. After context start a route-backed tool now answers every question an eagerly authored one does: the `tools()` catalogue reports its description and tags, so a builder filtering on either still selects it.

  That is what `Bash: directTool("bash-runner")` with `tools: Bash` in an agent file needs to work end-to-end, and the `Bash` tool itself is assembly rather than framework: a route running `shell()` on an isolation tier, shipped by the scaffolder's template.

  **Two `tools()` entries for one tool compose their guards instead of replacing.** Naming a tool twice, most realistically as a broad `MCP(server)` grant plus a narrower entry restricting one of its tools, kept whichever entry came last and silently dropped the guard the other carried. Both guards now run, and an entry carrying no guard can no longer strip one an earlier entry attached.

  **Agent-file loader.** `disallowedTools` matches the reference it names and nothing else, so a deny for one `Direct(...)` route cannot remove another. The deny-only error explains that honouring a deny list against inherited defaults was declined rather than citing a ticket that has since been closed.

  **Guard refusals are countable.** A call-time guard rejection emits `route:agent:tool:refused`, carrying the tool and the error code and nothing else. It is separate from `route:agent:tool:denied`, which fires when a policy withholds a tool at selection time so the model never sees it: counting them together would mix "this agent may not have that tool" with "this agent asked for something its guard rejected", and the second is what tells an operator an agent is probing the edges of what it was given. The refused input is deliberately absent even under snapshot capture, because a refused tool input is the input least worth trusting and can carry a token someone passed as an argument.

- [#661](https://github.com/routecraftjs/routecraft/pull/661) [`1ed5edf`](https://github.com/routecraftjs/routecraft/commit/1ed5edfd7c6023c58d5c87829b362744d65e3c32) Thanks [@ex0b1t](https://github.com/ex0b1t)! - One shared guard for "is this a Standard Schema", and one `isThenable` ([#545](https://github.com/routecraftjs/routecraft/issues/545), [#575](https://github.com/routecraftjs/routecraft/issues/575)).

  Mostly consolidation. The thenable defect itself was fixed in [#660](https://github.com/routecraftjs/routecraft/issues/660); this is the follow-up that stops the duplication growing back. Three behaviour changes come with it, each described below: callable schemas such as ArkType are now accepted where they were refused, an ArkType suspension digest changes (denying and re-asking any such exchange parked across the upgrade), and an event handler returning a bare thenable is no longer misreported as having thrown.

  **`isStandardSchema(value)` is new public API**, exported from `@routecraft/routecraft` beside `formatSchemaIssues` and `validateAgainst`. It answers one question: does this value carry a callable `~standard.validate`, and so can it be handed to `validateAgainst`, which dereferences that property unguarded. Seven boundaries hand-rolled the same index cast and predicate before it existed. Each of them keeps its own throw, its own error code and its own message, because those differ per boundary on purpose: a plugin option validator throws a plain `Error`, the fn registry throws `RC5003` naming the fn, and the structured-text fallback declines with `undefined` rather than throwing at all. Only the cast and the test moved. It is built on the existing `standardExtensionOf` rather than re-deriving the null-and-object-and-bag extraction, which would have added another spelling of the thing this change removes.

  `isThenable` is now one implementation in core, covering the three core sites that had their own. It stays core-internal, so it is not part of this or any public surface, and `@routecraft/ai` keeps its own copy across the package boundary.

  **A callable schema now reads as a schema.** `standardExtensionOf` admitted only `typeof "object"`, so an ArkType schema, which is a function object carrying `~standard`, read as carrying no bag at all. `validateAgainst` validates one happily, so the test was narrower than the validation it feeds. Two consequences, both improvements, one with a migration note:

  - ArkType schemas are accepted wherever the new guard runs, rather than being refused by boundaries that previously indexed `~standard` directly.
  - A suspension parked under an ArkType schema now hashes its rendered JSON Schema rather than falling back to vendor and version. That fallback is identical for every schema a vendor produces, so the changed-schema half of the resume compatibility check could not fire for ArkType at all: schema edits under a parked ArkType exchange went uncaught. They are caught now. **The digest changes for ArkType schemas only** (Zod and the other object-shaped libraries are byte-identical). Know what that costs on the upgrade: an ArkType suspension parked before this release resumes into a hash mismatch, and a mismatch is not a soft check failure. It reaches `refuseContinuation`, which **denies the record** (RC5048, reason `continuation changed`) and **re-asks the approver**, so the parked exchange does not resume and a human is asked again. Settle or drain ArkType-schema suspensions before upgrading if a re-ask is disruptive.

  **One behaviour fix comes with it.** An event handler that returned a thenable rather than a `Promise` was logged as having thrown when it had returned normally: the bus followed its duck-type with `result.catch(...)`, which a thenable does not carry, so the call threw from inside the surrounding `try`. The thenable is adapted before `catch` is reached, and a rejecting one is still caught and logged as a rejection.

  A repo-internal ESLint rule now bans `instanceof Promise` in `packages/*/src`, so a sixth hand-rolled site is caught at review rather than found by its symptoms. It is not in `@routecraft/eslint-plugin-routecraft`, which `eslint.config.mjs` scopes to `examples/**` and which therefore could not guard framework source at all.

  `agent()`'s two output guards collapsed into one because both already produced the same message. `validateFnOptions` adopts partially: it keeps a first guard that rejects a value that is not schema-shaped at all, separately from the shared predicate rejecting a schema-shaped value with no validator, because the two messages diagnose different mistakes.

- [#578](https://github.com/routecraftjs/routecraft/pull/578) [`8a45022`](https://github.com/routecraftjs/routecraft/commit/8a4502283a6b6c5a377205cd4a0ddbf27acecd83) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Executor integration and the `.suspend()` / `.resume()` operations ([#550](https://github.com/routecraftjs/routecraft/issues/550), slice 2 of [#417](https://github.com/routecraftjs/routecraft/issues/417)).

  The user-visible half of durable suspend and resume, built on slice 1's store, records and signed tokens. A capability can now pause mid-pipeline, wait for an answer that arrives out of band, and continue from the same position without re-running earlier steps.

  **`.suspend({ expect, ttl })`** produces the `suspend` outcome [#437](https://github.com/routecraftjs/routecraft/issues/437) reserved. The executor serializes the exchange, computes the continuation hash, writes the suspension, emits `route:exchange:suspended`, and schedules nothing: no worker parks, and the route stays live for every other exchange. `expect` types `ex.suspension.result` for the rest of the branch the way `.input()` types the body.

  **Execution one always answers.** A durable suspend cannot hold a caller across the days an approval takes, so the run terminates at the suspend and returns a `Suspended` value: `202` plus `Retry-After` on `http()` (the status carries the discrimination, so the declared 200 body stays the route's own output), the value itself on `direct()` (narrow it with `isSuspended`), an ack rather than a nack on queue-shaped sources, and a log line on `cron()` / `simple()` / file sources. The route's real output flows to its destinations on execution two.

  **`.resume(map?)`** addresses an exchange by signed token, never a route by name, so a mail-born exchange can be continued by an HTTP-born answer with the original source taking no part in execution two. It verifies the token, checks the continuation still matches, validates the answer against the suspending step's live `expect`, wins the `markResumed` compare-and-swap, and re-enters at position N+1 with `ex.suspension.result` / `resumedBy` / `resumedAt` populated. A duplicate answer returns the first one's cached terminal outcome without re-running anything. The mapping function owns shape; revival owns validation.

  **`ex.suspension`** is readable before the suspend runs, so a notification step can send a working resume link. A `.tap()` snapshot follows its owner rather than its own fresh id, since "notify, then park" is exactly a tap.

  **Refusals, at the earliest point each is knowable.** Suspend inside `.split()`, a `.multicast()` path or a `.dispatch()` target is refused at build time with the new `RC5051`; under a step-scope wrapper or alongside route-scope `.cache()` with `RC5003`; a context with a suspendable route and no `suspension` config refuses to start with the new `RC5052`; an exchange that cannot be persisted fails at park time with `RC5042`, not at resume.

  **Revival failures are catchable, not dead ends.** Unknown (`RC5046`), expired (`RC5047`), changed continuation (`RC5048`), rejected answer (`RC5049`) and denied (`RC5050`) all throw in the resume ingress route. The three that leave an approver stranded (`RC5047`, `RC5048`, `RC5050`) additionally re-enter the suspended route's error channel, so a route-scope `.error()` there can notify and re-ask. `RC5049` stays in the ingress: a malformed answer is a per-request input error, the suspension stays resumable, and routing it through the suspended route would let any token holder drive that route's re-ask path with junk.

  New events `route:exchange:suspended` / `:resumed` / `:expired` on the fixed registry. New optional `suspension` field on the builder state bag, which threads the `expect` type through the chain: a hand-written state bag such as `RouteBuilder<{ body: X }>` now describes a chain only if it carries that field too.

  `SerializedOutcome` gains a `suspended` status, for the two-stage-approval case where the continuation reaches another `.suspend()`: recording that as `completed` would publish a false receipt and hand the first approver the second one's resume token.

  MCP carriage (`structuredContent` plus the derived `oneOf` output schema) is gated on [#214](https://github.com/routecraftjs/routecraft/issues/214) and is not in this slice.

- [#602](https://github.com/routecraftjs/routecraft/pull/602) [`bb48cce`](https://github.com/routecraftjs/routecraft/commit/bb48cceb13dddfd1a8fdf2528ee8e4e6ba332b68) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Suspensions expire, heal their own delivery, and get retired on a schedule; plugins get a `start()` phase; contexts are single-use ([#551](https://github.com/routecraftjs/routecraft/issues/551)).

  A `ttl` used to be enforced only when a late answer arrived. Nobody presents a token for a suspension that timed out, so an unanswered one sat in the store past its deadline and its route was never told: the "nobody approved in 72 hours, escalate" flow the deadline exists for did not run. A sweeper now retires overdue suspensions on a schedule, emitting `route:exchange:expired` and re-entering the route's error channel with `RC5047`, and scans at startup before the context reports ready so an outage's backlog reaches its routes ahead of new traffic.

  **Suspensions now expire by default.** Omitting `ttl` previously meant no expiry at all; it now means the context's `defaultTtl`, which is `72h`. A deployment relying on parks that live indefinitely must set `suspension: { defaultTtl: 'never' }`.

  **Expiry delivery is crash-safe, and at-least-once.** Retiring is claim (`suspended` -> the new `expiring` status) -> notify -> finalize (`expired` / `denied`). A process that dies mid-delivery leaves a claim the sweeper releases after `expiryLease` (default `60m`) and redelivers, so the approver hears about the expiry despite the crash; a crash after notifying but before finalizing redelivers one duplicate escalation. A token presented while a record is `expiring` reads as expired (`RC5047`), and a released record is past its deadline, so a late answer is refused either way.

  **Settled records are now purged.** `retention` (default `90d`, `"never"` to keep everything) drives `purgeSettled` once at boot and hourly after. Previously nothing ever removed a settled record, so a long-running process accumulated every exchange that ever suspended.

  **The sweep pages on a keyset cursor** ordered `(expiresAt, id)`, advancing past every visited record, so records a context cannot retire (a renamed route's parked suspensions, a shared store) can never starve the work behind them, whatever their number.

  **Breaking for out-of-tree stores.** `SuspensionStore` changes shape: `findExpired(now, limit, after?)` takes a required limit and an optional keyset cursor and must order by `(expiresAt, id)`; new required members `claimExpiry(id, at)` and `releaseExpiring(before)`; `markExpired` / `markDenied` now finalize from `expiring` rather than transitioning from `suspended`; `resumedWithoutTerminal(limit?)` is required and diagnostic-only; `SuspensionStatus` gains `"expiring"` and records gain `claimedAt`. The shipped sqlite backend migrates its schema automatically on open (version 2: `claimed_at` column, `(status, expires_at, id)` sweep index).

  **Breaking: `plugin:started` changes meaning.** The `apply()` phase events are renamed `plugin:applying` / `plugin:applied`, and the new `start()` lifecycle phase takes the plain names `plugin:starting` / `plugin:started`, so the event vocabulary matches the lifecycle (applying, starting, stopping). `plugin:started` does not disappear: an existing subscriber keeps compiling and keeps firing, but it now marks start-done instead of apply-done and fires later than it did, after every route is up.

  **Breaking: a context is single-use.** `context.start()` after `context.stop()` now refuses with `RC1004` instead of resolving readiness over routes whose controllers are gone. Build a fresh context from your config; the process is the real restart unit, and `craft run` already behaves this way. Two concurrent `start()` calls now collapse into one boot instead of running every plugin `start()` hook twice.

  **New: `CraftPlugin.start?(ctx)`**, a third lifecycle phase between `apply` and `teardown`, running after every route has signalled readiness (bounded by a 30s backstop for sources that never signal). Hooks run in registration order, each awaited; a throwing hook fails `context.start()` with the original error after tearing the context down. `CraftContext.whenStarted()` resolves once no route is still coming up and every hook has finished, which is what `startAndWaitReady()` in `@routecraft/testing` awaits. A single route failing to come up is deliberately not observable there; watch `route:started` for per-route readiness.

  Also fixed: a transient store error while caching a completed continuation's outcome no longer reports the finished work as failed to the caller, and `defaultTtl` was ignored on the sqlite backend, which is the production default.

- [#630](https://github.com/routecraftjs/routecraft/pull/630) [`2432c0e`](https://github.com/routecraftjs/routecraft/commit/2432c0e5bccf1bdb73399439f2229beea910ee22) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Suspension: securing resume is now possible, and still yours to define ([#632](https://github.com/routecraftjs/routecraft/issues/632)).

  **The framework ships a policy point, not a policy language.** How approvals work is the application's design: Routecraft has no notion of an approver, a role, a four-eyes rule, or an escalation, and shipping one would get it wrong for somebody. What it now guarantees is the part you cannot build from outside.

  **`.resume({ authorize })`.** One hook on the resuming route, receiving `{ principal, parked, payload, record }`: the live principal (whatever the route's `.authenticate()` resolved), the parked principal restored from storage, the submission exactly as it arrived, and the record's context view (`id`, `meta`, `routeId`, `suspendedAt`, `expiresAt`). Never the parked body: the hook runs before the principal is authorized, so a body-reading hook would put the parked payload in front of exactly the party the check exists to reject. `payload` is RAW, because `schema` validation runs only once the hook has passed: a submission the hook refuses never reaches the validator and never spends the link. Return false or throw to refuse.

  **`.suspend({ meta })`, identical on both surfaces.** Plain JSON under the exchange's own rules (`RC5042`), persisted verbatim, never interpreted, never surfaced on the acknowledgment, and handed to the hook at revive. `ctx.suspend()` takes exactly what `.suspend()` takes, so an agent-raised park and a route-raised one are one mechanism with one resuming path. Because `meta` lives only on the record, a parker that snapshots its policy there gets policy-travels-with-the-park by construction rather than by a tamper check.

  **The refusal contract.** Every refusal happens before the store's compare-and-swap, so saying no never spends the rightful principal's single-use link, and before the record's lifecycle is disclosed, so a refused caller cannot learn whether the park is still open. `false`, a throw, and a hook that never settles are one `RC5056` with one message, distinguished only in the boundary log, because a hook whose failures can be told apart from outside is an oracle for what it knows; a thrown cause never reaches the wire. An async hook is bounded by the route's own lifecycle rather than a framework knob (the route's stop signal, widened by an enclosing `.timeout()`), and the suspension's deadline is re-checked once it resolves so an overrun reports `RC5047`.

  **With no hook the door is bearer**, exactly as before. Resume is securable, not secured; the docs say so in the reference rather than warning about it at startup.

  **Per-call resume credentials** (`RC5055`). A parallel agent tool batch produces one park while each handler mints its own credential through `ex.suspension.tokenFor(call)`. A recipient sent a link by a handler that then lost the park is refused instead of resuming the winner's park, record-only and before anything else. `tokenFor` refuses a missing binding at the mint site rather than silently handing back an unbound credential.

  **The pre-claim window is ordered, and the ordering is the security property.** The deadline arm and the continuation arm each settle a record and drive the suspended route's error channel, so the credential binding and the hook run above both, and above the settled-state disclosure. The hash is compared non-destructively for the same reason. Previously either transition was reachable by a party the checks exist to reject, who could deny the record, burn the rightful principal's claim, and drive an approver notification with it.

  **Docs.** A "Securing resume" section on the resume reference carries six patterns as real running code, each proven on its accept and refuse path in `packages/routecraft/test/securing-resume.bun.test.ts`: four eyes, scope gate, channel segmentation, policy travels with the park, same-user continuation, and threshold by scope over a narrowed payload.

  **Breaking.** `.suspend({ expect })` is now `.suspend({ schema })` and the option is OPTIONAL: a site that declares none parks with no contract, validates nothing at the ingress, and types `ex.suspension.result` as `unknown`. The rename carries through `ctx.suspend()`, `SuspendError`, `testFn`'s structural suspend, the `Suspended` acknowledgment's wire field (both the advertised JSON Schema and the structural validator), the stored record, and `describeExpect` to `describeSchema`. The sqlite store migrates itself. `SuspensionExpect` is now `SuspensionSchema` and carries an `absent` sentinel distinct from the degraded fallback, so a site edited between "declared but unrenderable" and "no schema at all" moves the digest instead of quietly accepting anything.

  **Breaking.** `Suspended` no longer carries `question` or `reason`, and neither suspend surface accepts them. The acknowledgment is `{ status, suspensionId, token, schema?, expiresAt? }`: it crosses the wire to whoever called the route, so it carries the CONTRACT and nothing else, while everything policy-shaped lives on the record where only the hook and an operator can read it. `SuspendError`, `ctx.suspend()`, `SuspendSignal`, both stores, and the advertised MCP schema drop the fields together. Put what you were carrying there into `meta`, or send it through the notification step that already runs before the park.

- [#563](https://github.com/routecraftjs/routecraft/pull/563) [`b97f82c`](https://github.com/routecraftjs/routecraft/commit/b97f82c3cabe900a8fee2bc13544b20fdbc2dfdd) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Suspension store, records, and signed resume tokens ([#549](https://github.com/routecraftjs/routecraft/issues/549), slice 1 of [#417](https://github.com/routecraftjs/routecraft/issues/417)).

  The persistence and identity layer for parked exchanges. No DSL and no executor changes yet: `.suspend()` and `.resume()` arrive in [#550](https://github.com/routecraftjs/routecraft/issues/550), and TTL plus the expiry sweeper in [#551](https://github.com/routecraftjs/routecraft/issues/551). This slice ships the foundation those build on, in core rather than in `@routecraft/ai`, because the store is shared by plain capabilities, human approvals, and the agent tier alike.

  **The record and the contract.** `Suspension` is a parked exchange plus everything needed to revive it: route, position, continuation hash, serialized exchange, expected-result schema, action fingerprint, status, and the resume receipt. `stepState` is one opaque slot the store never interprets, which is what lets the agent tier share this store instead of growing a second one. `SuspensionStore` is async throughout and its state transitions are compare-and-swap rather than read-then-write, so a resume racing the sweeper has exactly one winner and multi-node coordination stays addable later.

  **Two backends, one contract suite.** `MemorySuspensionStore` for tests and ephemeral use; `SqliteSuspensionStore` as the durable default. The sqlite backend runs on a per-runtime driver split: `bun:sqlite` under Bun, `better-sqlite3` as a new optional peer under Node via `loadOptionalPeer` (`RC5017` with an install hint). `node:sqlite` is deferred; the version matrix behind that call and its graduation condition are recorded in the driver's JSDoc. Both backends pass the same contract suite, and the sqlite one passes it under Bun and Node.

  **Signed resume tokens.** HMAC-SHA256, base64url, mintable before the suspending step runs so a notification step can send a working resume link. The signing secret is required configuration, read from `ROUTECRAFT_SUSPENSION_SECRET` or `suspension: { secret }`, and its absence is a build-time `RC5040` rather than a surprise on the first suspend. At least 32 bytes are required, because a token holder can guess the secret offline without limit. It is never generated into the store. `testContext()`, `NODE_ENV=development` and `NODE_ENV=test` mint an ephemeral in-memory key.

  **Continuation hashing.** `continuationHash` covers steps `N+1` to the end plus the `expect` schema, not the whole pipeline, so a deploy that touches code before the suspend point does not invalidate approvals in flight while a change to what the approval authorizes still does. A step contributes its inline lambdas, its adapter's options, and the arguments its factory was called with, so repointing a destination after the suspend point (`file({ path: a })` to `b`, or a dynamic path callback) invalidates a parked approval rather than resuming it into a write somewhere else. It covers step definitions only, never the behaviour of what the tail calls. `actionFingerprint` binds an approval to the exact operation it authorized.

  **Serialization is a security boundary.** `serializeExchange` refuses anything but plain JSON data with `RC5042`, naming the path that failed, which is what keeps live resolvers out of the store; `Date` round-trips faithfully through a reserved envelope that body data cannot forge. Symbol-keyed properties are refused rather than silently dropped, and `__proto__` is written without going through the inherited setter, so a field named that survives the round trip instead of vanishing. Values carrying the reserved `Secret` brand are refused ahead of [#526](https://github.com/routecraftjs/routecraft/issues/526). A rehydrated principal is marked restored rather than authentic ([#355](https://github.com/routecraftjs/routecraft/issues/355)), so `authorize()` rejects it with the new `RC5043` instead of trusting a shape read off disk.

  New config key `suspension`, new store key `SUSPENSION_RUNTIME`, new error codes `RC5040` to `RC5045`, and new exports `markRestored` / `isRestored`. `SuspensionStore` carries a `purgeSettled(before)` retention method so a long-running process does not accumulate every exchange that ever suspended; the sweeper wires it up in the lifecycle slice.

- [#660](https://github.com/routecraftjs/routecraft/pull/660) [`cc652b9`](https://github.com/routecraftjs/routecraft/commit/cc652b909f208baad8fec1f5740a8cbed5ce9208) Thanks [@ex0b1t](https://github.com/ex0b1t)! - A schema whose `validate()` returns a thenable now validates instead of passing ([#545](https://github.com/routecraftjs/routecraft/issues/545), [#575](https://github.com/routecraftjs/routecraft/issues/575)).

  Standard Schema allows `validate()` to return a result or a promise of one, and "promise" there is the thenable contract, not the `Promise` class. Every validation boundary in the framework tested for the class, so a schema returning a plain thenable was missed. The miss did not skip validation: the thenable object itself became the result record, its absent `issues` read as success, and the caller's original unvalidated input came back marked ok.

  That reached route `.input()`, route `.output()` (which then stamped the exchange as output-validated), suspension resume payloads, MCP advertised-output enforcement, `schema()`, `testFn`, and the MCP options validator. `.input()` is a boundary control, so a caller who asked for validation silently got none.

  **What changes.** Such a schema now decides the outcome it always meant to. A route that used to accept a body its schema rejects now fails it with `RC5002`. Real `Promise`-returning schemas are unaffected.

  **The one thing to know.** Awaiting an arbitrary thenable runs schema-author `then` code on the validation path, so a schema that never settles now hangs the validation where it used to silently pass. That is the safer of the two failures, but it is a new one.

  **The one thing to know, part two.** Nothing bounds that wait. `.input()` is position [#4](https://github.com/routecraftjs/routecraft/issues/4) of the pre-from filter chain and `.timeout()` is [#8](https://github.com/routecraftjs/routecraft/issues/8), so a route timeout sits below validation and cannot reclaim a hung one.

  The AI SDK bridge (`jsonSchema({ validate })`) is a synchronous seam and refuses asynchrony rather than awaiting it. It now refuses a thenable too, where it used to return `{ success: true, value: undefined }`, passing and corrupting at once. It also fails on `issues: []`, which its length check used to let through the same way: present `issues` mean failure whether or not the schema said why, which is the rule `validateAgainst` already applied.

  **A schema returning a non-record now fails with a message instead of crashing, synchronous schemas included.** A `validate()` that produced `undefined`, `null` or a primitive rather than a result record killed `validateAgainst` with a raw `TypeError` out of framework internals, in two places: `undefined` and `null` on the `issues` read, a primitive on the `value` check. An array was worse than a crash: it is a non-null `object`, so it cleared both and reached the fallback that returns the caller's input, reporting success on unvalidated data. All of them now come back as an ordinary failure naming what the schema returned. This was never thenable-specific; the guard sits after the await, so the synchronous path is covered by the same line.

  `validateWithSchema` for MCP plugin options changes on its success path as well: a schema that passes without returning a `value` now yields the caller's own options rather than throwing, and the remaining "produced undefined options" refusal fires only on an explicit `{ value: undefined }`.

  `@routecraft/testing` gains `thenableSchema(outcome)`, a Standard Schema whose `validate()` returns a non-`Promise` thenable, for holding your own validation boundaries to the contract rather than the class.

### Patch Changes

- [#626](https://github.com/routecraftjs/routecraft/pull/626) [`dbf4610`](https://github.com/routecraftjs/routecraft/commit/dbf46104fe102e6d0a3f91d3dddc82193df45310) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Name the mount topology when a declared server has nothing mounted on it.

  `servers.mcp: server has no mounts.` said nothing about what did mount, which
  is the fact a reader needs: an empty server usually means the surface meant
  for it never mounted, not that the config naming it is wrong. The refusal now
  lists every mount and the server it landed on, and reports all empty servers
  together rather than one boot at a time:

  ```text
  servers.mcp: server has no mounts. Mounted surfaces: http -> servers.public.
  Either remove the unused server, or bind a surface to it. A surface that names
  the server in config but did not mount is usually a plugin that failed to
  apply, a misspelt server name, or a plugin version that predates named servers.
  ```

  The check moved from `HttpMountRegistry.validate()` up to the servers plugin,
  which is the only place that can see across servers. A registry validated
  directly no longer refuses itself for being empty.

- [#626](https://github.com/routecraftjs/routecraft/pull/626) [`dbf4610`](https://github.com/routecraftjs/routecraft/commit/dbf46104fe102e6d0a3f91d3dddc82193df45310) Thanks [@ex0b1t](https://github.com/ex0b1t)! - An IMAP pool drained mid-connect no longer throws during teardown.

  The pool reserves a slot before its connect resolves, since the reservation is
  what bounds the pool size. `drain()` dereferenced every slot's client
  unconditionally, so a shutdown that began while a connection was still being
  established threw `null is not an object`. That is the ordinary shape of a
  shutdown during startup, and the thrown teardown masked whatever had actually
  failed the boot.

  Drain now skips a slot that holds no client yet, and an acquire whose connect
  lands after the drain logs its own connection out rather than leaving a socket
  open with nothing referencing it.

- [#642](https://github.com/routecraftjs/routecraft/pull/642) [`50ef8c3`](https://github.com/routecraftjs/routecraft/commit/50ef8c337f98a642641b2a6c3d83fb17c1e1741b) Thanks [@ex0b1t](https://github.com/ex0b1t)! - A `stop()` racing boot no longer tears a plugin down while its own lifecycle
  hook is still running.

  A stop that arrived while a plugin's `apply()` or `start()` was awaiting
  produced the order enter, teardown, resolve: the plugin was torn down (the
  teardown walk keys off the applied set, so it was never skipped), but
  anything the hook acquired after its last await point was acquired after the
  release meant to cover it, and nothing released it afterwards. A process that
  exits hides this because the OS reclaims; an embedder or a test suite
  building successive contexts in one process keeps the interval or socket.

  Shutdown now waits for the in-flight hook before teardown, on a promise
  scoped to the plugin lifecycle hooks alone. It deliberately does not cover
  `run()`, which for an indefinite route resolves only once the context stops.
  The wait is unbounded, matching plugin teardown: a hook that never settles is
  a defective plugin rather than a shutdown-policy question, and interrupting
  instead would require every plugin author to write `start()` so it tolerates
  teardown-before-completion.

  Both lifecycle walks also re-check for a stop before each plugin, so a stop
  mid-boot no longer applies or starts plugins that teardown has already
  walked past.

  **One constraint comes with the wait, documented rather than enforced.** A
  lifecycle hook must not `await` its own `ctx.stop()`: it would wait for a
  shutdown that is waiting for the hook. Both intents keep a working spelling,
  and they differ by a keyword. Use `throw` to abort the boot with a reason,
  which unwinds through the teardown walk and surfaces the error, or call
  `ctx.stop()` without awaiting it to stand the context down without failing
  the boot. Nothing detects the awaited form, so it hangs at boot on the first
  run; the unawaited form is pinned by a test.

- [#676](https://github.com/routecraftjs/routecraft/pull/676) [`567c922`](https://github.com/routecraftjs/routecraft/commit/567c9221fc3ea6fd4eb334836c2d1cd600daa0fa) Thanks [@ex0b1t](https://github.com/ex0b1t)! - The stream expiry check now applies the clock tolerance that admitted the credential.

  `isPrincipalExpired` documents itself as the single source of the expiry boundary, and the checkpoint that closes a stream when its credential lapses called it without the tolerance the admitting verification had applied. So a client inside the tolerance window looped: admission admitted it, the stream armed, found the credential expired by its own stricter boundary, and closed, and the client reconnected into the same pair of answers.

  The resolved tolerance now rides on the admit verdict, beside the principal and the credential it already carried, so anything re-checking that credential inherits the boundary by construction rather than by remembering to pass an argument. Resolving it a second time from config at each consumer would reproduce the same class of bug the moment the two resolutions drifted.

  The timer sleeps to the deadline the tolerance moves rather than to `exp`, since waking inside the window would find the credential good and re-arm on the fifty-millisecond floor for the rest of it.

  Revoking the stream also no longer depends on the notification succeeding. The signal called `onExpired` and then aborted, so a notifier that threw took the abort with it: on the synchronous arm the throw escaped and the caller got no signal, and on the timer path it was an uncaught exception with the abort never running, leaving the expired credential's stream open. The abort now runs first and a throw from the callback is swallowed.

- [#637](https://github.com/routecraftjs/routecraft/pull/637) [`5a9758c`](https://github.com/routecraftjs/routecraft/commit/5a9758cadb2c0539f167d6fbee6f3f963f84fee8) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Retention counts from settlement, not from the park ([#634](https://github.com/routecraftjs/routecraft/issues/634)).

  `purgeSettled` used to measure the retention window from `suspendedAt` because the store carried no settlement timestamp, so a record that parked for 89 days and resolved on day 89 was purged one day after settling. Records now carry `settledAt`, stamped on every terminal transition (resumed, expired, denied), and retention measures from it: a settled record gets the full configured window from the moment it settled, however long it was parked before that.

  **The SQLite store migrates itself to schema v4.** Resumed rows backfill exactly from `resumed_at`. Expired and denied rows carry no trustworthy settlement evidence (a due time is not a settlement time, and a long outage can put the two far apart), so they are stamped with the migration moment and keep one full retention window from the upgrade: they may live longer than they would have under the old clock, and are never purged earlier than the new contract promises.

  `parseDuration(value, field)` is now exported from `@routecraft/routecraft`, so code that computes a ttl can validate it under exactly the rules the suspend surfaces apply. `ctx.suspend({ ttl })` (and its `testFn` twin) now validate the ttl at the call site with `RC5003`, matching `.suspend()`, instead of surfacing a malformed duration after the handler has unwound.

- [#637](https://github.com/routecraftjs/routecraft/pull/637) [`5a9758c`](https://github.com/routecraftjs/routecraft/commit/5a9758cadb2c0539f167d6fbee6f3f963f84fee8) Thanks [@ex0b1t](https://github.com/ex0b1t)! - The suspension park counter refuses corruption instead of resetting ([#635](https://github.com/routecraftjs/routecraft/issues/635)).

  The framework-owned `routecraft.suspension.sequence` header used to tolerate any malformed value by resetting the counter to 0, silently re-deriving a suspension id an earlier park of the same exchange already used. Resume tokens sign the id, so a reused id would let an old unspent link verify against a new park. A malformed or exhausted counter value now refuses with the new `RC5057`, with the two cases distinguishable in the message; a missing header still reads as zero, since an exchange that has never parked legitimately carries none. The refusal surfaces only on suspension surfaces (`ex.suspension`, or the park itself), so routes that never touch suspension are unaffected by a mangled header.

## 0.6.0

### Minor Changes

- [#538](https://github.com/routecraftjs/routecraft/pull/538) [`53ee88c`](https://github.com/routecraftjs/routecraft/commit/53ee88c9ae3f3eb89d2d673db8ac039de9b062ec) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Adapter role model: `Source` / `Destination` / `Enricher`, and the DSL option laws ([#532](https://github.com/routecraftjs/routecraft/issues/532)).

  Mid-route reads were modeled as "a Destination whose `send` returns the content", which overloaded one slot with two contracts (push-out void vs pull-in value) and forced adapter factories to infer their category from option VALUES (`mode: 'read'`, path-string sniffing, category-by-absence). That inference is structurally unsound through overloads, so the slot is split instead: `Destination.send` is now strictly void (push OUT; the body flows through unchanged) and the new `Enricher.fetch` pulls a value IN. The operation keyword selects the role: `.from()` subscribes, `.to()`/`.tap()` prefer `send` and fall back to `fetch` (a fetch result replaces the body in `.to()`; `.tap()` always discards), `.enrich()` fetches.

  Breaking changes:

  - `.enrich(x)` with the aggregator omitted now REPLACES the body with the fetched value (it previously spread-merged). `only()` and `none()` remain for merging; the `replace()` helper is deleted (it is the default now). Custom aggregator functions are unchanged, but the aggregator type is renamed `DestinationAggregator` to `EnrichAggregator`. A fetch resolving `undefined` means "no value" and leaves the body unchanged; the bare-enrich / fetch-only-`.to()` overloads reflect this via the new `FetchedBody` helper type (a result type including `undefined` infers the union of the previous body and the defined results).
  - File-family adapters (`file`, `csv`, `json`, `jsonl`, `xml`, `html`) drop the `mode` option. Position selects the role; send behavior uses `append: true` / `delete: true` (mutually exclusive, RC5003 at construction). `jsonl`'s send now overwrites by default (`append: true` restores the old default; audit every `.to(jsonl(...))` event log). Note the same silent flip for `.tap()`: a migrated `.tap(json({ path }))` resolves to `send` and writes, where the old `mode: 'read'` tap read and discarded; use `.enrich()` to read. The per-mode aliases (`FileReadAdapter`, `CsvReadAdapter`, `JsonReadAdapter`, `JsonlReadAdapter`, `XmlReadAdapter`, `HtmlReadAdapter`) are deleted.
  - `json()`'s transformer extraction option is renamed `path` to `pointer`; `path` now always means a file path and its presence alone selects the file roles (no more slash-sniffing).
  - Sends that produce receipts surface them via headers instead of body replacement: `.to(mail())` sets `routecraft.mail.sentMessageId` / `.accepted` / `.rejected` / `.response` (the `MailSendResult` type is deleted; the inbound `routecraft.mail.messageId` set by the source is left untouched so mail-to-mail routes keep their correlation id); carddav writes/deletes set the `routecraft.carddav.url` / `.uid` / `.etag` keys the read side already uses, plus `.created` for insert-vs-update (`CarddavWriteResult` / `CarddavDeleteResult` are deleted). Adapters set receipts through the new `SendContext.setHeader` sink on `send`; observability hooks split per slot (`getMetadata(result)` for fetch, `getSendMetadata(receipts)` for send).
  - Pull-in adapters are now typed `Enricher` and their classes renamed accordingly: `HttpEnricherAdapter`, `MailEnricherAdapter`, `DirectEnricherAdapter`, `LlmEnricherAdapter`, `AgentEnricherAdapter`, `EmbeddingEnricherAdapter`, `McpEnricherAdapter`, `AgentBrowserEnricherAdapter`. Route-level behavior of `.to(http({ url }))`, `.to(direct("x"))`, `.to(llm(...))` is unchanged.
  - `chunked: true` requires the literal `true` (a widened boolean is a compile error), and the chunked variant keeps the send/fetch roles.
  - `ToResultBody` is deleted; `CallableDestination<T>` is void-only; `CallableEnricher<T, R>`, `Enricher<T, R>`, `SendContext`, and `ToTarget` are new exports.
  - `@routecraft/testing`: `spy()` grows a `fetch` face (records into `calls.enrich` and returns the current body); a `mockAdapter` `send` handler's return value now follows the step's slot resolution (used by fetch-resolved steps, discarded by send-resolved `.to()`).
  - `@routecraft/ai`, `@routecraft/os` and `@routecraft/testing` raise their `@routecraft/routecraft` peer range to `>=0.6.0`: their declarations reference the new role-model types, so pairing them with a 0.5.x core no longer type-checks.

  Also in this release:

  - `json()` and `html()` reject `path: ""` (RC5003) instead of silently falling through to the transformer role, and `getMetadata` / `getSendMetadata` now receive the exchange as a second argument so adapters can derive per-call metadata without instance state (the `direct` adapter reported a concurrent exchange's endpoint before).
  - `.to()` receipt headers are subject to the same framework-owned key rule as `.header()`: an adapter setting `routecraft.id` / `.operation` / `.route` / `.split_hierarchy` through `SendContext.setHeader` is warned about and ignored rather than corrupting engine state.
  - CSV appends terminate their chunk with a newline (repeated `.to(csv({ append: true }))` writes previously spliced records together, e.g. `a,b` + `c,d` = `a,bc,d`) and are serialised per path, so concurrent appends can no longer both write the header.
  - CardDAV deletes surface the resolved `routecraft.carddav.etag` alongside `.url` / `.uid`, and the role facades keep their adapter constructor so class-based `mockAdapter(CarddavAdapter, ...)` still intercepts.
  - Mail IMAP operations (`move` / `copy` / `delete` / `flag` / `unflag` / `append`) report their metadata again: the adapter's hook was renamed to `getSendMetadata` to match the slot the step resolves.

- [#536](https://github.com/routecraftjs/routecraft/pull/536) [`0cfd01c`](https://github.com/routecraftjs/routecraft/commit/0cfd01c5bacca05405bd093a3f1183a9249adff6) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Agent tool policy, plus one tool-name contract on `__`

  **Breaking: synthetic tool names normalise on `__`.** `direct_<routeId>` becomes `direct__<routeId>` and `_block_load_<name>` becomes `_block__load__<name>`. Fn ids and the `mcp__<server>__<tool>` form are unchanged. `__` is now the only structural separator, so a single underscore is never a boundary and a route named `fetch_order` stays unambiguous against its prefix. The authoring grammar (`Direct(...)`, `MCP(...)`) does not change, and markdown frontmatter carrying raw `mcp__server__tool` still resolves. Update anything pinning a generated name: guards keyed on tool name, assertions on `toolCalls[].toolName` or `blocksLoaded[].toolName`, recorded transcripts, evals.

  **Breaking: `ResolvedTool` gains a required `source` field**, a discriminated union of `fn` / `direct` / `mcp` / `block` set by the resolver. Only affects code that hand-constructs a `ResolvedTool`, such as test fixtures or a custom bridge.

  **Breaking: `Direct(<routeId>)` and fn ids are validated against the provider tool-name charset.** A route id or fn id that cannot survive as a provider-facing name (`/^[A-Za-z0-9_-]{1,64}$/`) now raises `RC5003` naming the offending character or length, instead of reaching the provider and being rejected there. Expose an unsafe route id under a tool-safe alias with `directTool(routeId)`. An MCP client tool whose remote name cannot form a valid wire name is dropped from the agent's tool list with a warning rather than failing the dispatch.

  **New: `agentPlugin({ toolPolicy })`**, repository-wide admission control for the agent tool surface, keyed by tool kind (`fn` / `direct` / `mcp`), each `true`, `false`, or a predicate over a read-only tool descriptor. Omitting `toolPolicy` admits everything, so existing contexts are unaffected. Supplying it makes the surface an allowlist and every kind must be decided explicitly. Enforced at the single point every agent form converges on, so no agent can opt out, and multiple installs compose with AND. A denied tool is dropped, logged, and emitted as `route:agent:tool:denied`.

  **New event: `route:agent:tool:denied`**, emitted once per tool refused admission by a policy, carrying `agentName`, `toolName`, `toolKind`, and a `reason` of `rule`, `rule-error`, or `unknown-provenance`.

- [#419](https://github.com/routecraftjs/routecraft/pull/419) [`9d9d7f0`](https://github.com/routecraftjs/routecraft/commit/9d9d7f0e4d61717d12760c0aff50ae4341ac5ab0) Thanks [@ex0b1t](https://github.com/ex0b1t)! - 0.6.0: prettier plugin for compact DSL chains, changesets-based release engineering (fixed core train, per-push canaries of the packages each merge changed, tokenless npm trusted publishing with provenance), and normalized workspace dependency ranges.

- [#468](https://github.com/routecraftjs/routecraft/pull/468) [`6722d4a`](https://github.com/routecraftjs/routecraft/commit/6722d4a75de6c7d08ec438d97c1bc07ce780df98) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Add the `concurrency` (bulkhead) wrapper operation.

  `.concurrency({ max })` bounds how many exchanges run an operation at once, the sibling of `.throttle()` (which bounds a rate). Dual-mode like the other resilience wrappers: step scope wraps the next step, route scope (before `.from()`) bounds the whole pipeline at the innermost resilience position (inside `.retry()` / `.timeout()`, so a slot is held per attempt and freed between retry backoffs). The default `queue` mode applies backpressure (bounded by `maxQueue`); `mode: "reject"` fails fast with the new `RC5026` (retryable). A `key` selector partitions the pool per user / tenant / pool (bounded by `maxKeys`). Emits `route:concurrency:queued` / `:acquired` / `:released` / `:rejected`.

- [#478](https://github.com/routecraftjs/routecraft/pull/478) [`faa5331`](https://github.com/routecraftjs/routecraft/commit/faa5331f3aae3da6ed980c85fa35d2beb147ee72) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Add the `debounce` flow-control operation.

  `.debounce({ waitMs })` suppresses bursts of exchanges, releasing only the last one in a burst after a quiet period (file-change batching, search-as-you-type). Each arrival resets a `waitMs` quiet timer and supersedes the one being held; an optional `key` selector debounces independently per group, and an optional `maxWaitMs` cap (measured from the burst start, never reset) guarantees eventual release under continuous activity. Emits `route:operation:debounce:held` / `:dropped` / `:released`.

  Debounce is the first operation to hold an exchange OUTSIDE the pipeline queue and re-run it later, so it introduces two additive primitives: `StepContext.captureDownstream()` (snapshot the steps after a step and run a held exchange through them as a detached, route-tracked pipeline with its own `exchange:started` / `:completed` lifecycle) and `Route.onDrain()` (a flush hook run at the start of `drain()` / shutdown). Because the released exchange is the route's primary flow, the detached run honors the route-scope `.error()` handler and enforces `.output()` schemas before completing, and a release that cannot clone the held body fails that exchange cleanly instead of crashing the timer. A pending exchange is flushed on drain rather than being lost. Adds `OperationType.DEBOUNCE`. Route scope only (not available inside a fan-out path, and not wrappable by step-scope resilience wrappers).

- [#513](https://github.com/routecraftjs/routecraft/pull/513) [`db38127`](https://github.com/routecraftjs/routecraft/commit/db3812755bdf36bc15ef284a479b8288deaababd) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Delegation-aware `Principal` and `authorize()`: distinguish a user acting directly, an agent (or any party) acting on a user's behalf, and an agent acting under its own authority.

  `Principal` gains `actor` (RFC 8693 `act`, nested, outermost-only policy input), `subjectProfile` (`user` / `service` / `ai_agent`), `mayAct` (RFC 8693 `may_act`, enforced in-process), and `grantId`. A new `delegate()` helper and `.delegate()` operation mint delegated principals: subject and roles pass through, scopes become `intersect(subject, consent ceiling)`, chains nest, expiry takes the minimum, and authenticity covers the whole chain. `authorize()` gains `subject`, `actor`, and `maxDelegationDepth` matchers; `jwt()`/`jwks()` parse `act` / `may_act` / `sub_profile` and gain a `ClaimMappers.roles` mapper, failing closed on unparseable delegation claims. New error codes RC5034-RC5038.

  BREAKING: `authorize()` defaults to `actor: 'none'`, so principals carrying an actor (minted by `delegate()` or parsed from a token's `act` claim, including Clerk impersonation sessions) are rejected until a route declares its permitted actors. `.delegate()` fails closed when the resolver returns `undefined`: the subject's direct principal is stripped by default (the exchange continues anonymous) instead of passing through with full authority; pass `{ otherwise: 'keep' }` for continuations that serve the caller directly. The strip skips anonymous exchanges, delegated principals, and `ai_agent` subjects. A missing scope now raises RC5038 (recoverable, with `missing.scopes` on the cause) instead of RC5015; role and predicate failures keep RC5015. See the 0.5-to-0.6 migration guide.

- [#479](https://github.com/routecraftjs/routecraft/pull/479) [`23257a0`](https://github.com/routecraftjs/routecraft/commit/23257a04d3086eb9fdcdc651764948c224f855ae) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Add the `directory` source adapter for scanning a directory.

  `directory({ path })` scans a directory and lists its entries, each a `DirectoryEntry` carrying the entry's `path`, `name`, `ext`, `relativePath`, `size`, `modifiedAt`, `createdAt`, and `isDirectory`. By default it emits a single exchange with the full `DirectoryEntry[]` listing; pass `chunked: true` to emit one exchange per entry, matching the non-chunked/chunked convention of the `csv` and `jsonl` adapters. Supports `recursive` and `includeDirs`, lists files only by default, and orders entries deterministically by relative path. Filtering is left to the normal operations (`.filter()` per entry in chunked mode, or `.transform()` / `.split()` on the array) so you can narrow by metadata or name, then read content with the `file` adapter (`.enrich(file({ path: (ex) => ex.body.path, mode: 'read' }), ...)`). Entries that vanish mid-scan or broken symlinks are skipped with a debug log, other unreadable entries are skipped with a warning, and a missing or unreadable directory throws a clear `directory adapter:` error.

- [#478](https://github.com/routecraftjs/routecraft/pull/478) [`faa5331`](https://github.com/routecraftjs/routecraft/commit/faa5331f3aae3da6ed980c85fa35d2beb147ee72) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Add the `dispatch` flow-control operation.

  `.dispatch(strategy, ...targets)` runs exactly one of several targets, chosen by a load-balancing strategy, the sibling of `multicast` (all targets) and `choice` (one by predicate). The required leading strategy is `"failover"` (try targets in order until one succeeds; pairs with per-target `.retry()` / `.circuitBreaker()`), `"round-robin"`, `"weighted"` (smooth weighted round-robin over the new `weighted(target, n)` helper, which co-locates a relative weight with its target), or `{ strategy: "sticky", key, maxKeys? }` (exchanges sharing a key stick to one target, via an LRU-bounded affinity map). Side-effect-only like `multicast`: the selected target runs on its own clone and the original continues unchanged; a target failure stays isolated to its clone's error events, and an exhausted `failover` chain emits `route:operation:dispatch:exhausted`. Emits `route:operation:dispatch:selected` / `:exhausted`. The executor's step context gains a `runPath` capability (a single isolated nested run that reports its outcome) so `failover` can advance on a failed target.

- [#523](https://github.com/routecraftjs/routecraft/pull/523) [`10dc341`](https://github.com/routecraftjs/routecraft/commit/10dc3413ea61fe4a67673debf8ecfdaf9a0eb23c) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Add signed-webhook support to the `http()` source. `http({ rawBody: true })` attaches the exact wire bytes of the request body to the exchange as `routecraft.http.rawBody` (a `Uint8Array`), so any signature scheme can be verified in a route step. `http({ signature: { header, secret, scheme, prefix?, toleranceSec? } })` verifies the raw bytes before the route runs, covering `hmac-sha256-hex` (GitHub-style, optional prefix), `hmac-sha1-hex` (legacy), and `stripe-timestamped` (`t=...,v1=...` with freshness checking); failing requests return `401` with a bounded reason, raise `RC5039`, and emit `auth:rejected` with `scheme: "signature"`. Comparison is timing-safe, `signature` on a bodyless method fails at construction with `RC5003`, oversized bodies still 413 before any HMAC runs, and the gate is independent of the global `auth` middleware. Also fixes a latent module cycle (`exchange -> context -> route -> wrapper -> exchange`) surfaced by the new cross-runtime tests: type-only braced imports are now `import type`, which `verbatimModuleSyntax` fully elides instead of keeping as side-effect imports.

- [#481](https://github.com/routecraftjs/routecraft/pull/481) [`f43d5ea`](https://github.com/routecraftjs/routecraft/commit/f43d5ea3797c38e64df3210953999770e1056a5f) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Fold `.input()` validation into the pre-from filter chain (breaking behaviour change).

  Validation now runs at chain position [#4](https://github.com/routecraftjs/routecraft/issues/4) for every source shape: inside the synthetic parse step when the source attaches a parser, and as a standalone synthetic `input` step when it does not. Previously, parser-less sources validated eagerly in the consumer handler, so an `RC5002` bypassed the route-scope `.error()` handler entirely and surfaced as `route:exchange:dropped`. Now `.error()` can observe and recover an input failure exactly like an `authorize` or `parse` rejection, and an unrecovered failure takes the normal error path: `route:step:failed` (operation `"input"`), `route:error`, `context:error`, `route:exchange:failed`, while still rejecting the sender. Migrate observers accordingly: validation failures no longer emit `route:exchange:dropped`, and a cross-route failure (producer `.to(direct(...))` into a validating consumer) now fires `context:error` on both routes, the same accounting as any other consumer-route failure.

- [#546](https://github.com/routecraftjs/routecraft/pull/546) [`31bae7f`](https://github.com/routecraftjs/routecraft/commit/31bae7f1ab11e1ec302bc98b7a14ea01c84d463e) Thanks [@ex0b1t](https://github.com/ex0b1t)! - `jwt()` and `jwks()` now surface their configured `clockToleranceSec` on the returned options, alongside the `issuer` they already surfaced.

  A consumer that re-checks a verified principal's `expiresAt` needs to know the skew the verifier allowed. Without it, a token accepted by `jwks({ clockToleranceSec: 30 })` whose `exp` is 10 seconds in the past would be refused by the very layer meant to catch validators that ignore expiry. The field is left absent when the option was not configured, so a consumer can distinguish "not configured" from an explicit zero.

  `authorize()` now floors its expiry comparison to whole seconds, matching `jwt()` and jose. Its unfloored comparison put the boundary up to a second ahead of the verifier's, so a token verified in the same second it expired could be rejected a few milliseconds later.

  `jwt()`, `authorize()` and the MCP expiry gate now treat the expiry boundary as inclusive: a token whose `exp` equals the current second is expired. This matches `jose` (`exp <= now - tolerance`), which `jwks()` already went through, and RFC 7519 section 4.1.4, which requires the current time to be before `exp`. `jwt()` previously honoured such a token for one further second, so `jwt()` and `jwks()` disagreed by a second at the boundary.

- [#541](https://github.com/routecraftjs/routecraft/pull/541) [`a051bc0`](https://github.com/routecraftjs/routecraft/commit/a051bc07ef3536ed90c8427cf28c4323af1280e0) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Finish the role model's option laws: arity is no longer a discriminant, and "key present" means supplied.

  Three residuals survived the [#532](https://github.com/routecraftjs/routecraft/issues/532) refactor and are cleared here.

  `mail()`'s read side split on argument count: `mail(folder)` returned an `Enricher` and `mail(folder, options)` returned a `Source`, so adding a second argument changed the ROLE. That is law 2 ("options never change the adapter's type") expressed positionally, and law 4 only ever sanctioned KEY presence. Both shapes now return one read adapter (`MailFolderAdapter`) carrying `subscribe` and `fetch`, with the operation keyword picking between them. The change is additive: everything that compiled before still compiles and behaves identically, while `.from(mail('INBOX'))` and `.enrich(mail('INBOX', opts))` are newly valid.

  `json()`, `html()`, `csv()`, `jsonl()` and `xml()` treated a supplied-but-undefined `path` as an absent one, so options built programmatically (`json({ ...cfg })` where `cfg.path` is `string | undefined`) silently produced a transformer that ignored every file option beside it. That is the absence-axis twin of the widened-boolean hazard the laws already ban. A supplied `path` of `undefined` now throws `RC5003` like the empty string does; only an omitted key selects the transformer role. TypeScript already rejects the typed form under `exactOptionalPropertyTypes`, so this is the runtime backstop for untyped callers and casts. All five factories now share one guard (`selectsFileRole`) rather than hand-rolling the check, so the rule cannot drift apart between them again.

  The chunked adapters advertised `Source & Destination & Enricher` but nothing exercised the send and fetch roles of a chunked adapter, leaving the type's claim unverified. `.to(csv({ chunked: true }))` and `.enrich(csv({ chunked: true }))` are now covered, confirming that `chunked` concerns the subscribe role only.

  `.standards/adapter-architecture.md` gains law 4b (arity is not a discriminant) and tightens law 4's definition of presence.

- [#468](https://github.com/routecraftjs/routecraft/pull/468) [`6722d4a`](https://github.com/routecraftjs/routecraft/commit/6722d4a75de6c7d08ec438d97c1bc07ce780df98) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Harden `.retry()` backoff and remove the `exponential` option (breaking).

  `retry({ exponential })` is removed in favour of `factor`, a numeric growth multiplier: the wait before attempt `n` is `backoffMs * factor^(n - 1)`. Migrate `exponential: true` to `factor: 2` and `exponential: false` (or omitted) to `factor: 1` (the new default, fixed backoff). Passing `exponential` now throws `RC5003` at build with a migration hint. Two new options ship alongside: `maxBackoffMs` caps a single wait so a steep `factor` cannot grow unbounded, and `jitter` (`"none"` | `"full"` | a `0..1` fraction) randomises each wait to de-sync retry storms (it only ever shortens a wait, so the cap still holds).

- [#463](https://github.com/routecraftjs/routecraft/pull/463) [`f1896a5`](https://github.com/routecraftjs/routecraft/commit/f1896a542ae1a3bc4de76f5650ef0ab728ba6908) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Add the `sample` and `dedupe` flow-control operations.

  `sample({ every })` passes every Nth exchange and `sample({ intervalMs })` passes the first exchange in each time window, dropping the rest (silently, like a `filter` returning false). `dedupe(options?)` suppresses duplicate exchanges by a derived key with reserve-on-entry / commit-on-completion / release-on-failure semantics, an optional `key` function, and `ttl` / `maxKeys` bounds on the per-route in-memory key set. Both emit `route:operation:<op>:*` events. The default key derivation (SHA-256 of the body's JSON serialisation) is shared with `cache` via the new `hashExchangeBody` utility.

- [#481](https://github.com/routecraftjs/routecraft/pull/481) [`f43d5ea`](https://github.com/routecraftjs/routecraft/commit/f43d5ea3797c38e64df3210953999770e1056a5f) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Propagate an `AbortSignal` from `.timeout()` into the wrapped step.

  Promises cannot be cancelled, so an expired deadline used to leave the abandoned work running to completion in the background. The step now receives a signal through its step context that fires on expiry (abort reason: the `RC5011` error), at both step scope and route scope; nested timeouts link their signals so the earliest deadline wins. Function-form steps get it as a trailing argument (`.process((ex, { signal }) => fetch(url, { signal }))`, also on `.transform()`, `.to()`, and `.enrich()`), adapter authors read `ctx.signal` in `Step.execute`, and the built-in `http()` destination forwards it into its fetch automatically. `.tap()` deliberately receives no signal: taps run detached, so an abandoned attempt must not cancel an observation in flight. The `.timeout(ms)` surface is unchanged.

- [#434](https://github.com/routecraftjs/routecraft/pull/434) [`828e7c9`](https://github.com/routecraftjs/routecraft/commit/828e7c957637c896aca35073768fd0ec72ce13b8) Thanks [@ex0b1t](https://github.com/ex0b1t)! - `.input({ body: schema })` now retypes the route builder: the following `.from(source)` opens the pipeline with the schema's inferred output type, so the duplicated `.from<T>()` generic is no longer needed (an explicit generic still overrides). Adds `PreFromTypedBuilder` and the shared `PreFromStaging` surface. The mail send payload gains threading and custom header support: `inReplyTo` (seeds `References` too), `references`, and `headers`, so agent replies stitch into the original email thread.

- [#474](https://github.com/routecraftjs/routecraft/pull/474) [`545f433`](https://github.com/routecraftjs/routecraft/commit/545f433c69234c745d8a6a3d3a075eada22d60ab) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Add the `xml` adapter: read, write, and transform XML through a plain-object representation, mirroring the `json` and `csv` codec adapters. Works as a transformer (parse an XML string in the body), a source (read and parse a file), a returning destination (`mode: 'read'`), a write destination, and a `delete` destination. Malformed XML surfaces as an observable per-exchange `RC5016` failure honouring `onParseError` (`fail` / `abort` / `drop`). `fast-xml-parser` is loaded as an optional peer dependency through `loadOptionalPeer` (missing install reports `RC5017` with an install hint) and bundled by the CLI.

### Patch Changes

- [#481](https://github.com/routecraftjs/routecraft/pull/481) [`f43d5ea`](https://github.com/routecraftjs/routecraft/commit/f43d5ea3797c38e64df3210953999770e1056a5f) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Fix the published bundles silently dropping every core config applier (`mail`, `carddav`, `direct`, `cron`, `http`, `telemetry`).

  The package's `sideEffects` allowlist named only the dist entry points, which marked the `src` config modules as pure, so esbuild pruned their side-effect imports out of the bundle during the package's own build: `defineConfig({ mail: { accounts } })` typechecked but was never applied at runtime, and `mail("INBOX", { account: "default" })` failed with "IMAP host is required". The field is removed (dist ships only the entry bundles, so it granted consumers nothing), and the build now runs a post-build guard that imports both bundles and asserts every `registerConfigApplier` key found in the source is live in the registry.

- [#525](https://github.com/routecraftjs/routecraft/pull/525) [`f2b6e9f`](https://github.com/routecraftjs/routecraft/commit/f2b6e9f9ab533bf643a30ab99c92bc8662b66c92) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Route every mail adapter driver import (`imapflow`, `nodemailer`, `mailparser`) through `loadOptionalPeer`, so a missing optional peer surfaces as `RC5017` with an install hint instead of a raw module-not-found error, and warn at context construction when a `defineConfig` key has no registered config applier (a typo like `htttp`, or an applier whose registering module never loaded, was previously a silent no-op). Missing-peer errors are terminal at the mail source's reconnect boundary: a missing package can never be fixed by reconnecting, so the source surfaces the install hint immediately instead of burning up to 30 reconnect attempts into RC5010. A new contract test asserts no bare external dynamic import exists in core outside `loadOptionalPeer`.

- [#564](https://github.com/routecraftjs/routecraft/pull/564) [`fd5c640`](https://github.com/routecraftjs/routecraft/commit/fd5c64039dd55f04f8e229021f2911a23f22ad8a) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Stop the http plugin's OpenAPI auto-detection from advertising a workspace container's identity.

  `findPackageInfo` now yields nothing when the nearest `package.json` is a monorepo root (it declares a `workspaces` field, or a `pnpm-workspace.yaml` sits beside it), so `/openapi.json` serves the neutral fallbacks `Routecraft HTTP API` / `0.0.0` instead of the container's private, often stale `name` / `version`. A workspace container is repository infrastructure, not a service identity: release tooling never versions it, so its `version` drifts, and its metadata must not leak through a publicly served document. Apps run from their own directory are unaffected, `private: true` manifests without workspaces still auto-detect as before, and `builtins.openapi.info` continues to override everything.

- [#546](https://github.com/routecraftjs/routecraft/pull/546) [`31bae7f`](https://github.com/routecraftjs/routecraft/commit/31bae7f1ab11e1ec302bc98b7a14ea01c84d463e) Thanks [@ex0b1t](https://github.com/ex0b1t)! - `loadOptionalPeer` recognises more of the phrasings a runtime uses for a missing optional peer, so `RC5017` and its install hint fire where a raw `ERR_MODULE_NOT_FOUND` used to escape.

  Node names the package even when the import used a subpath, but Bun quotes the full specifier, so loading `pkg/subpath` reported a bare module-not-found on the runtime the CLI actually requires. The quoted name is now accepted with an optional subpath suffix.

  Detection also scans every quoted occurrence in the message rather than the first. A message that names a longer package sharing the requested one's prefix before naming the requested one (`'@modelcontextprotocol/server-legacy'` ahead of `'@modelcontextprotocol/server'`) failed the boundary check against the wrong occurrence and never examined the right one. The boundary itself is unchanged: a package whose name merely starts with the requested one is still not a match, and the resolved-path phrasing still means a broken install rather than an absent peer.

- [#560](https://github.com/routecraftjs/routecraft/pull/560) [`4c7cbfa`](https://github.com/routecraftjs/routecraft/commit/4c7cbfab2146dbc9625649b40ffe9d6b72e734b3) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Raise the optional `fast-xml-parser` peer floor to `^5.10.1`, excluding the `>=5.9.3 <5.10.1` window affected by GHSA-8r6m-32jq-jx6q (repeated DOCTYPE declarations reset entity expansion limits). The `xml()` adapter ships for the first time in this release, so no existing install has a floor established by Routecraft.
