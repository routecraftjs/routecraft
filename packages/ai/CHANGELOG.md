# @routecraft/ai

## 0.7.0

### Minor Changes

- [#718](https://github.com/routecraftjs/routecraft/pull/718) [`b7255b0`](https://github.com/routecraftjs/routecraft/commit/b7255b0d69a0dcd1b4b33965a9391d287f847bca) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Named agent sessions with a durable transcript, an inbox, and interrupt ([#716](https://github.com/routecraftjs/routecraft/issues/716)).

  **`agent(name, { session })`**, and `session` on the inline form, make an agent remember: every message for one session id continues one transcript, kept under `(agent, session)` and loaded, appended and stored back per turn. Absent `session`, nothing changes. The model is told its own session id in a `## Session` system block.

  **Where sessions live.** Records go to their own store, chosen by a new `sessions: { store }` key on `defineConfig` (or `sessionsPlugin()`): SQLite at `.routecraft/sessions.db` by default, created by the first session written rather than at boot, `"memory"` by opt-in, or a `SessionStore` of your own, a four-operation contract (`get`, `create`, `replace` under a version compare-and-swap, `keys`) that both shipped backends, `SqliteSessionStore` and `MemorySessionStore`, pass the same contract suite against. `ROUTECRAFT_SESSION_STORE` names it from the environment. An explicitly configured path that cannot be opened fails at startup, and a value naming neither a location nor a backend is refused with `RC5003`; a store failure is the new `AI1012`. The continuation a turn stores between turns stays in the suspension store, because it is a parked exchange, so `session` still needs a `suspension` block. Core exports its SQLite seam so the session store opens on the same runtime split as the suspension store and shares its path resolution, busy classification and transactional migration runner (`resolveSqliteDriver`, `resolveDatabasePath`, `isSqliteBusy`, `migrateSqlite`).

  **One turn at a time per session.** A message that arrives while a turn is running goes to the session's durable inbox; its caller is acknowledged with `AgentResult.session.status === "queued"` and the queued messages become the next turn's first user message, in order, as one message with the parts in order. That turn starts on its own at the boundary, and runs on the route: a turn that ends with work outstanding stores its exchange's continuation at the agent step (body and headers, as a `.suspend()` park stores them), and the boundary turn is that continuation revived in process, so the route's steps after the agent run on the boundary turn's reply. **`interrupt: true`**, on either form, cancels the running turn through the existing cancellation path, keeps its partial transcript (including the tool call that was in flight), and starts a turn with what queued plus the interrupting message. A turn a restart cut short is treated the same way at the next turn. The stored record carries a shape version, so a record another release wrote fails as `AI1010` naming the store rather than as a provider refusal one turn later.

  **`AgentResult.session`** carries `{ agent, id, status, queued }`. **`FnHandlerContext.session`** hands a tool the session it runs in. A turn runs under the principal of the exchange it runs on; every inbox item records its poster's subject and the delivered message renders it per part as quoted data, and the record keeps the subject that started the session (`startedBy` on the management API). Who may post is the route's `.authorize()`.

  **Contributed management resources.** Core's ops plugin gains `registerOpsResource(ctx, { name, description, list, describe })`: a read-only resource another package contributes, served under the introspection tier at `GET /ops/{name}` and `GET /ops/{name}/{segment...}`, with `parsePageQuery`, `takePage` and `decodeCursor` exported so a contributor pages on the route listing's cursor contract; a throw from a contributor is a 500 carrying its code, and `RC5059` a 400. `@routecraft/ai` registers **`agent-sessions`**, which lists every session with its turn state, inbox depth and background calls in flight, filtered by `agent` and paged by `limit` and `after`.

  New events: `route:agent:session:queued`, `:interrupted`, `:restored`, `:parked`, `:revived`. New error codes `AI1010` and `AI1012`. Core exports `parkAside` and `reviveSuspension` as internals for a tier that stores a continuation beside a completing run and revives it itself. The internal one-run module of the agent tier is renamed from `session.ts` to `run.ts` (`AgentCancellationCause` stays exported).

- [#577](https://github.com/routecraftjs/routecraft/pull/577) [`65803ee`](https://github.com/routecraftjs/routecraft/commit/65803ee4640343de70bfa1dfdf918931e6544105) Thanks [@ex0b1t](https://github.com/ex0b1t)! - `agents()` owns the `agents/` folder walk ([#324](https://github.com/routecraftjs/routecraft/issues/324)).

  The loader now matches [Claude Code's subagent convention](https://code.claude.com/docs/en/sub-agents), so an existing `.claude/agents/` tree loads unmodified. The layout rules live here rather than in the CLI, so a programmatic caller and the project runtime walk the tree the same way.

  **Recursive, and identity comes from frontmatter.** A `.md` file at any depth is one agent, identified by its frontmatter `name`. The filename and the folders above it are grouping and carry no identity, which is the rule that lets `review/security-reviewer.md` declare `name: security` and still resolve as `agent("security")`.

  **Breaking (0.x, so `minor`): the filename no longer has to match the frontmatter `name`.** Trees that relied on the old strict check still load; nothing that worked before stops working. What changes is that a mismatch is no longer an error.

  **Bundles and the reserved folder.** A directory holding `AGENT.md` is exactly one agent and is not descended into, so it can hold assets scoped to that agent. This is the one place the relaxed filename rule does not apply: the frontmatter `name` must match the bundle directory name, mirroring the check `skills()` already applies to its nested form. A directory named `skills` is never scanned for agents at any depth, so a bundle's own skills folder cannot fail the boot on its first file.

  **Duplicate names throw**, naming both files. Silent shadowing is the failure that surfaces months later as "why is this agent behaving like the other one".

  **`skills:` frontmatter is accepted again**, with different semantics from the key removed in 0.6: it declares where an agent's skills come from (local paths, `npm:` package refs) rather than naming blocks. The loader validates the list and surfaces it verbatim; resolving a ref needs the house and bundle folders, which a direct `agents()` call is not given, so it leaves the declaration for the project runtime to consume and records the fact at debug level.

  `readMarkdownDir` grows `recursive` and `reservedDirectories`, and reports the bundle directory on documents found through a sentinel. Two shared-walk changes reach `skills()` as well: `node_modules` and dot-directories are skipped at every level, and a symlink to a file is followed while a symlink to a directory is not, which is what keeps the walk loop-free. `skills()` also now builds its record on a null-prototype object, so a skill named `__proto__` registers as a real key instead of vanishing.

- [#718](https://github.com/routecraftjs/routecraft/pull/718) [`b7255b0`](https://github.com/routecraftjs/routecraft/commit/b7255b0d69a0dcd1b4b33965a9391d287f847bca) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Background tools ([#717](https://github.com/routecraftjs/routecraft/issues/717)): `directTool(routeId, { background: true })` returns `{ handle, status: "running" }` to the model at once and posts the route's result, or its failure, to the calling agent session's inbox when the route finishes, attributed to the handle. The completion starts the next turn on its own: the calling turn's exchange was parked when it ended with the call outstanding, and the settlement revives it, runs the turn with the completion as its user message, and the route's downstream steps on the reply. At boot, the calls a dead process was waiting on are reported lost and their sessions' continuations revived. A property of how the agent awaits the route, not of the route, which stays an ordinary `direct()` route. Refused with `RC5003` on an agent dispatched without `session`. The handle rides the dispatched exchange as the `routecraft.agent.background.handle` header (`AgentHeadersKeys`). New events `route:agent:session:background:started`, `:completed`, `:failed`.

- [#586](https://github.com/routecraftjs/routecraft/pull/586) [`a9b355c`](https://github.com/routecraftjs/routecraft/commit/a9b355c66ebf7572e46705626bf2909664b7da50) Thanks [@ex0b1t](https://github.com/ex0b1t)! - `craft start`, the convention-based project runtime ([#131](https://github.com/routecraftjs/routecraft/issues/131)), and drop-in compatibility for Claude Code agent files ([#340](https://github.com/routecraftjs/routecraft/issues/340)).

  **`craft start [dir]`** boots a whole project from its folder layout instead of a hand-written barrel: `craft.config.ts`, then `plugins/`, then any folder an ecosystem package has claimed, then `capabilities/`. Both the root-level and `src/`-nested layouts work, and a folder that is absent is skipped. A directory holding `route.ts` is one capability and is not descended into, so colocated tests, fixtures and private helpers are never imported. A `plugins/` module that default-exports a factory is an error naming the file, because a factory needs arguments the runtime cannot invent.

  **`registerProjectDiscoverer`** lets a package claim a convention folder and turn it into a config fragment, which is how `agents/` and `skills/` get their meaning without the CLI ever depending on `@routecraft/ai`. A discoverer receives a context object (the folder, the content root, the project root, and the configuration accumulated so far) and declares its ordering as `after: ["skills"]` rather than a magic number. Cycles are an error; a dependency on a folder nobody registered is satisfied. A claimed folder present with no discoverer registered fails loudly, naming the erased type-import case, since that is the one the author will be staring at.

  Skills compose house folder, then frontmatter `skills:` refs in declared order, then the bundle's own folder, most specific winning and every source named in the startup log. Refs are local paths or `npm:` package refs resolved against installed packages only. Precedence is code wins, convention fills the gaps, applied per field: an agent declared in `craft.config.ts` keeps every field it set and discovery contributes only the skill set it left unset.

  `--once` shuts down after the first exchange reaches a terminal outcome, and pairs with `--timeout <ms>` so a project that produces nothing reports instead of hanging.

  **Claude Code agent files** load without edits: unknown frontmatter is ignored with a warning, `tools` and `disallowedTools` accept Claude's comma-separated string, `model` accepts the `opus` / `sonnet` / `haiku` aliases and `inherit`, and a reference to a Claude built-in this runtime does not provide is dropped with a warning rather than failing the load. `disallowedTools` without `tools` is rejected at load: a per-agent list replaces the context default rather than narrowing it, so a deny list alone cannot be honoured and silently inheriting the denied tools would be the worst reading of the file.

  New error code `AI1004` for a `skills:` ref that does not resolve.

- [#630](https://github.com/routecraftjs/routecraft/pull/630) [`2432c0e`](https://github.com/routecraftjs/routecraft/commit/2432c0e5bccf1bdb73399439f2229beea910ee22) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Durable agents: `ctx.suspend()` parks the tool loop through the core suspension store, the loop survives restarts and resumes mid-conversation, MCP advertises and carries the acknowledgment, and a cancelled run fails honestly ([#268](https://github.com/routecraftjs/routecraft/issues/268), [#269](https://github.com/routecraftjs/routecraft/issues/269), [#552](https://github.com/routecraftjs/routecraft/issues/552), [#581](https://github.com/routecraftjs/routecraft/issues/581)).

  **`ctx.suspend({ schema?, ttl?, meta? })` on `FnHandlerContext`.** A handler that cannot answer now returns the sentinel; the runtime flushes the batch's in-flight siblings (their real results persist), stops the loop, and parks the exchange with `stepState = { agentId, messages, suspendedToolCallId, turnsUsed, usage? }`. Execution one replies with the core `Suspended` value; there is no agent-specific result type, which is what makes nested escalation work. `ctx.suspensionId` and `ctx.suspension` (`{ id, token }`) are populated before the handler runs so an approval request can carry a working resume link. `SuspendError` stays honoured as the throw-form escape hatch and now carries `schema` / `ttl` / `meta`; its JSDoc names the footgun (a handler's own `try/catch` swallows a thrown suspension, which the sentinel cannot reproduce). Either form parks with no declared contract when `schema` is omitted.

  **Rehydration.** A resume re-enters the agent step with the payload swapped into the suspended call's tool result; the system prompt, blocks, and tools are re-resolved live (only resolved strings ever persist, and `lifetime: "context"` blocks stay in the running context). The `maxTurns` budget and the accumulated token spend survive the park, so a cancelled resumed run reports the whole run's cost; a run resuming with the budget exhausted takes the ordinary max-turns path. Two suspend signals in one batch produce exactly one park: the first in the model's own emission order wins and the loser becomes a retryable tool error the resumed model sees.

  **Refusals.** `ctx.suspend()` outside an agent dispatch on a route-bound exchange refuses with the new `AI1006` at the call, writing nothing. Rehydration state the agent cannot re-enter (malformed `stepState`, a route rebound to a different agent, a thread missing the suspended call) fails with the new `AI1007`. An unconfigured context fails the park with `RC5052` naming the one config line.

  **MCP carries Suspended ([#581](https://github.com/routecraftjs/routecraft/issues/581)).** A tool whose route can park (a static `.suspend()`, or an agent step, whose tools MAY park) and declares `.output()` advertises `outputSchema` as the derived `oneOf: [Output, Suspended]`; the author declares only the output arm. The acknowledgment rides `structuredContent` on an ordinary `isError: false` result, and the park emits the new `plugin:mcp:tool:suspended` `{ tool, suspensionId }` instead of `completed`: a parked run reported as finished is a false receipt. `McpTool.outputSchema`'s root type loosens to admit the `oneOf` root.

  **Cooperative cancellation ([#552](https://github.com/routecraftjs/routecraft/issues/552)).** The dispatch signal now merges the route's signal with the step's, so a route-scope `.timeout()` reaches the model call instead of letting an abandoned run finish the turn and discard it; the signal is checked between turns and reaches `Direct(...)` tool dispatch, which refuses to start after an abort and unwinds promptly mid-flight (the downstream route finishes under its own lifecycle). A cancelled run fails with the new `AI1005`, whose `cause` is the exported `AgentCancellationCause` carrying typed `turnsUsed` and `usage` fields (cache tokens included) instead of returning a partial `AgentResult` that reads like success. Parent-cancels-sub-agents is specced (skipped test) and lands with [#226](https://github.com/routecraftjs/routecraft/issues/226). The `AI1xxx` range's charter widens to "agent blocks, configuration, and runtime".

  **Breaking.** `FnHandlerContext.checkpointId` is renamed `suspensionId` (the v0 rename [#417](https://github.com/routecraftjs/routecraft/issues/417) recorded; it was a stub nothing populated). `FnHandlerContext` gains a required `suspend` member, so hand-built handler contexts must provide one; `makeFnHandlerContext` and `testFn` both do, and `@routecraft/testing`'s `TestFnHandlerContext` now includes a structural `suspend` that returns the sentinel shape for assertions without parking anything.

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

- [#573](https://github.com/routecraftjs/routecraft/pull/573) [`8f01cf8`](https://github.com/routecraftjs/routecraft/commit/8f01cf8802e17217eb045116ed248fc22a3d09e5) Thanks [@ex0b1t](https://github.com/ex0b1t)! - `forward()` now carries the caller's identity and trace ([#567](https://github.com/routecraftjs/routecraft/issues/567)).

  `Route.buildForward()` built the forwarded exchange with no headers, so a forwarded call arrived anonymous and separately traced. A target declaring `.authorize()` refused it with `RC5012`; a target without one ran with no authority at all. The forwarded call also got a fresh correlation id, breaking the audit chain at the forward boundary.

  This affected every caller of `forward()`: route-scope and step-scope `.error()` handlers, `circuitBreaker` fallbacks, and `BlockClient.forward` in `@routecraft/ai`, which is the documented way to back an agent block with a route. A memory or knowledge block resolved that way was either refused by its target or served identically to every caller regardless of who asked.

  A `direct()` destination never had the bug because it hands the target its live exchange, headers and all. Forward builds a fresh envelope, so it has to pass the caller's headers explicitly. It now does, which brings the two in-process paths to parity.

  Headers travel by reference rather than as a copy. Both authenticity brands (`markAuthentic`, `markRestored`) are identity-keyed `WeakSet` membership, so any copy silently drops them: a copied restored principal would fail `authorize()` with `RC5023` ("self-asserted") instead of the correct `RC5043` ("restored, not verified live"), and re-branding one to compensate would launder an unverified identity into a trusted one. Propagation is unconditional and cannot escalate: it is the same frozen authority the calling route was already running under.

  `Route.getForward()` now takes the calling exchange as a required argument. It is `@internal`, and required rather than optional so a new call site cannot silently reintroduce the anonymous forward.

  **Engine-owned headers are re-established at every route ingress.** `buildExchange` is the single ingress constructor, so it now mints a fresh `routecraft.id` rather than letting one be inherited. An inherited exchange id collides in every store keyed by it: telemetry spans (`${exchangeId}:${contextId}`), the `exchanges` and `exchange_snapshots` tables, and suspension ids (`${exchangeId}~${sequence}`). The correlation id, not the exchange id, is what links a hop. This corrects the pre-existing `direct()` behaviour too, where the target route previously ran under the caller's exchange id.

  **Split hierarchy no longer crosses a route boundary.** `buildExchange` now drops `routecraft.split_hierarchy` at route ingress. A split group can only join within the executor run that created it, so a hierarchy arriving from another route was unjoinable by construction, and actively harmful: `.aggregate()` looks the trailing group id up in the context-wide split-parent store, so it would find the _caller's_ parent exchange and delete that entry on completion, corrupting an aggregation still in flight on the calling route. This also closes the same latent hazard on the pre-existing `direct()` path.

  Two consequences worth knowing. A target route with a strict `.input({ headers })` schema now sees the caller's headers and may reject a forward that previously passed. And forwarding a principal whose `expiresAt` has passed now surfaces the expiry error rather than `RC5012`, which is the correct failure but a different one.

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

- [#685](https://github.com/routecraftjs/routecraft/pull/685) [`604a92f`](https://github.com/routecraftjs/routecraft/commit/604a92f1f5acd343a129d92fe5842428fa04a28d) Thanks [@ex0b1t](https://github.com/ex0b1t)! - `llm()` and `agent()` can ask for a reasoning effort, and reach a provider
  directly.

  Reasoning effort is the main cost and latency dial on a current model and it is
  per call, not per deployment: a narrow classifier and a hard agent turn want
  opposite settings against the same model id. Nothing in `LlmOptions` reached it,
  and there was no passthrough to reach it with either.

  Two shapes ship together. `reasoning: "none" | "low" | "medium" | "high"` is the
  portable one, mapped to each provider's own control (`reasoningEffort` on
  OpenAI, `effort` and `thinking` on Anthropic, `thinkingConfig.thinkingLevel` on
  Gemini, `reasoning.effort` on OpenRouter, `think` on Ollama). A level a provider
  cannot express maps to the nearest one it supports rather than throwing, since
  an option that refuses on some providers is not portable; the mapping table is
  documented, including where it is lossy, and Gemini's inability to turn thinking
  off is stated rather than implied.

  `providerOptions` is the labelled escape hatch, forwarded to the SDK verbatim
  for what the normalised form cannot say (Anthropic's thinking token budget,
  Gemini's `thinkingBudget`). The two merge per provider namespace and per setting
  within it, and the authored value wins for the settings it names.

  `AgentOptions` gains the same sampling block as `LlmOptions` (`temperature`,
  `maxTokens`, `topP`, both penalties, `reasoning`, `providerOptions`), and
  `agentPlugin({ defaultOptions })` can set it for every agent in a context. The
  agent had no sampling surface at all: its model call was built from two
  constants, so an agent could not ask for a different temperature either. The
  defaults are the values it hardcoded, so an agent that declares none behaves
  exactly as before.

  Both paths from an authored option to the provider call used to copy the
  sampling block field by field, which is why an option could typecheck and reach
  nothing. They now carry the whole block, and the list of keys they walk is
  exhaustive by construction: adding an option to the block without listing it
  fails to compile.

  Also fixed while building the agent path: a second `agentPlugin` install's
  `defaultOptions` silently dropped every field except `model`, `tools` and
  `blocks`, so a `maxTurns` or `principal` set by a later install never applied.
  Every single-valued default now either applies or throws on conflict, which is
  what the function already documented.

- [#700](https://github.com/routecraftjs/routecraft/pull/700) [`a97f6b2`](https://github.com/routecraftjs/routecraft/commit/a97f6b260f6143c2139b15a596c2074920403a14) Thanks [@(ex)](<https://github.com/(ex)>)! - `agent()` and `llm()` accept content parts in the user prompt ([#697](https://github.com/routecraftjs/routecraft/issues/697)).

  A user prompt can now be an array of typed parts instead of a string, so a route that receives a voice note hands the audio to the model rather than transcribing it first and prompting with the text. The same holds for an image on a mail or a PDF pulled from a drive.

  ```ts
  .to(agent({
    system: 'answer the caller',
   => [
      { type: 'file', data: ex.body.audio, mediaType: 'audio/ogg' },
      { type: 'text', text: 'Answer the question in the recording.' },
    ],
  }))
  ```

  **The parts are the SDK's own vocabulary**, deliberately: `text`, `file` and `image` mirror the Vercel AI SDK's `TextPart`, `FilePart` and `ImagePart`, so one mapping serves every provider the SDK supports instead of one translation per provider. A type-level test pins `LlmPromptPart[]` as assignable to the SDK's `UserContent`, so a shape change in a future SDK release fails our compile rather than a user's dispatch.

  **Nothing is pre-validated per provider.** A provider that cannot read a part fails through its own error. The llm reference page carries the current support list and the caveat that it is per model as well as per provider.

  **`system` stays string-only.** No provider takes content parts there.

  **A string prompt behaves exactly as before.** `user` as a string, a callback returning a string, and an omitted `user` all resolve as they always have; an empty parts array is treated as an empty prompt, matching what an empty string already does. Note that the two destinations already differed on an empty prompt and still do: `llm()` falls back to the body, `agent()` sends it as given. The reference page now says so, because a callback that maps attachments to parts returns an empty array on an exchange carrying none.

  Two limits worth knowing, both documented on the reference page. A part carrying a URL is downloaded by the SDK from your process unless the provider declares it can fetch the URL itself. And a suspension boundary carries JSON data only, so an agent that parks refuses a `Uint8Array` or a `URL` instance in a part at park time, naming the exact part: on a route that can park, pass a base64 string, or the URL as a plain string, which the SDK still reads as a URL.

  `AgentUserPromptSource` now aliases the widened `LlmUserPromptSource`; `LlmPromptSource` is unchanged and still types `system`.

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

- [#656](https://github.com/routecraftjs/routecraft/pull/656) [`f20bbbc`](https://github.com/routecraftjs/routecraft/commit/f20bbbcc87034f03d4db408a39a618a60fa688f4) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Publish `structuredContent` from the advertised schema, not the body's runtime shape ([#574](https://github.com/routecraftjs/routecraft/issues/574)).

  A route exposed with `.from(mcp())` that declares a non-object output was broken against a spec-compliant client on every call:

  ```ts
  craft().id("get-price").output({ body: z.string() }).from(mcp());
  ```

  `tools/call` attached `structuredContent` only when the published body happened to be a plain non-array object, so a string or array body skipped it while the tool still advertised an output schema. The installed `@modelcontextprotocol/client` throws on exactly that pair: _has an output schema but did not return structured content_.

  **Wire-visible change: primitive and array output tools now return `structuredContent` where they previously returned text only.** On the 2025 protocol era it arrives in the SEP-2106 envelope, `{"result": "42.50"}`, matching the `{type:"object", properties:{result:...}}` advertisement the same era already projected that tool's `outputSchema` into. On the 2026 era the value is carried directly, unwrapped, as that era's wire shape allows. A client reading only the `content` text block sees no change, and a tool declaring an object output is byte-identical to before.

  **A suspendable tool is repaired, not merely improved.** A route that can `.suspend()` advertises a `oneOf` root, which the 2025 era wrapped on the advertisement side while the acknowledgment went out bare. The acknowledgment additionally carries an enumerable symbol brand, which that era's `z.record(z.string(), ...)` wire schema rejects when it sits at the top of `structuredContent`. The two together meant every park over MCP answered with JSON-RPC `-32602` rather than an acknowledgment. Both are resolved by publishing the envelope the advertisement already promised.

  The decision now comes from the advertised schema rather than the value in hand. The result is projected through the SDK's `Server.projectCallToolResult`, which is the seam the SDK exposes for low-level `setRequestHandler("tools/call")` authors, so the era's envelope rule is applied in one place for both the advertisement and the reply instead of being re-derived here. The projection covers proxied tools on the same path.

  Wrapping stays a wire concern. `enforceAdvertisedOutput` still validates the route's declared schema unwrapped, and an author who wrote `.output({ body: z.string() })` never writes or sees `{ result: ... }`: the envelope is applied after the route's contract is satisfied and never reaches the body the pipeline carries.

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

- [#659](https://github.com/routecraftjs/routecraft/pull/659) [`cfd9d6e`](https://github.com/routecraftjs/routecraft/commit/cfd9d6e400b0f34c4e97acf8ba4f968288b826ae) Thanks [@ex0b1t](https://github.com/ex0b1t)! - **Breaking: `currentTime()` and `randomUuid()` are removed from `@routecraft/ai` ([#596](https://github.com/routecraftjs/routecraft/issues/596)).**

  Both were fn factories you assigned a tool name in `agentPlugin({ functions })`. Both are gone, with no deprecation cycle: the whole v0 API is unstable, so breaking changes land directly and get declared loudly rather than aged out.

  They fail the test every shipped export has to pass. Registering `CurrentTime: currentTime()` costs exactly the same declaration lines as writing the handler inline, so the export saved an import and cost the framework a public symbol to maintain, version and document forever. A clock is three lines of JavaScript. It should be yours, not ours.

  **What to write instead.** Declare the fn inline in the same `functions:` block, under the same tool name, and every `tools([...])` reference keeps working unchanged:

  ```ts
  CurrentTime: {
    description: "Current date and time in ISO 8601.",
    input: z.object({}),
    handler: () => new Date().toISOString(),
  },
  ```

  The `randomUuid()` replacement is the same shape with `handler: () => crypto.randomUUID()`.

  Add `tags: ["read-only", "idempotent"]` (`["read-only"]` for the UUID fn) if you select tools by tag in a `tools((catalog) => ...)` builder, since the removed factories set those tags for you.

  **Known external consumer:** eywa registers both today. The migration is the three-line swap above, once per fn, with no change to the agents that reference them.

  `directTool(routeId, overrides?)` is unaffected and is now the only fn builder the framework ships.

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

- [#691](https://github.com/routecraftjs/routecraft/pull/691) [`bf69fd0`](https://github.com/routecraftjs/routecraft/commit/bf69fd05ace6978e9b8f1b418342c7c8f58a6af6) Thanks [@mikemikimike](https://github.com/mikemikimike)! - `llm()` and `agent()` prompt callbacks, like `embedding()`, can be parameterized with the route body type so typed input schemas are available without casts.

### Patch Changes

- [#685](https://github.com/routecraftjs/routecraft/pull/685) [`604a92f`](https://github.com/routecraftjs/routecraft/commit/604a92f1f5acd343a129d92fe5842428fa04a28d) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Peer ranges on `@routecraft/routecraft` admit the canaries of the line they
  belong to.

  `@routecraft/ai` and `@routecraft/testing` declared `>=0.7.0 <1.0.0` and
  `@routecraft/os` declared `>=0.6.0 <1.0.0`. A prerelease satisfies a range only
  when some comparator carries a prerelease on the same `major.minor.patch`, so
  none of them admitted `0.7.0-canary-*`. Changesets rewrites a peer that is out
  of range to the exact version being published, which is only coherent inside
  the batch that produced it: `ai` and `os` publish in their own batches, so
  their pins pointed at a core canary that had already moved, and a downstream
  install of both at the `canary` tag resolved a second copy of core whose
  `Exchange` and `StoreRegistry` types are structurally distinct from the first.

  All three now read `>=0.7.0-0 <1.0.0`.

  The lower bound names the version the next release will publish, and has to
  move whenever that version changes, because `-0` reaches no further than the
  one version it sits on: `>=0.7.0-0` refuses `0.7.1-canary-1` as surely as it
  refuses `0.8.0-canary-1`. That is one edit per released version, and it belongs
  to the change that proposes the next one. A contract test now fails the gate
  when a declared range no longer admits the version that governs it, naming the
  manifest, the range and the version it refuses, so the maintenance is caught
  here rather than downstream.

- [#685](https://github.com/routecraftjs/routecraft/pull/685) [`604a92f`](https://github.com/routecraftjs/routecraft/commit/604a92f1f5acd343a129d92fe5842428fa04a28d) Thanks [@ex0b1t](https://github.com/ex0b1t)! - `gemini:gemini-3.7-flash` is offered by autocomplete.

  `LlmModelId` is a suggestion list rather than a constraint (it ends in
  `| string`), so the model was always usable; it just did not appear when
  typing. The Gemini section's comment no longer says "preview" either, since
  the line it describes is no longer only previews.

- [#720](https://github.com/routecraftjs/routecraft/pull/720) [`5fce5a6`](https://github.com/routecraftjs/routecraft/commit/5fce5a65f315507f500cad3135472eeec3dcdfc8) Thanks [@ex0b1t](https://github.com/ex0b1t)! - A failed MCP tool call no longer repeats its own message. An ordinary error thrown inside a route reached the client as `Error: X: X`, because the framework wraps it with its message as the RC message and the error itself as the cause, and the cause was appended regardless; a cause is now appended only when it says something the message does not.

- [#637](https://github.com/routecraftjs/routecraft/pull/637) [`5a9758c`](https://github.com/routecraftjs/routecraft/commit/5a9758cadb2c0539f167d6fbee6f3f963f84fee8) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Retention counts from settlement, not from the park ([#634](https://github.com/routecraftjs/routecraft/issues/634)).

  `purgeSettled` used to measure the retention window from `suspendedAt` because the store carried no settlement timestamp, so a record that parked for 89 days and resolved on day 89 was purged one day after settling. Records now carry `settledAt`, stamped on every terminal transition (resumed, expired, denied), and retention measures from it: a settled record gets the full configured window from the moment it settled, however long it was parked before that.

  **The SQLite store migrates itself to schema v4.** Resumed rows backfill exactly from `resumed_at`. Expired and denied rows carry no trustworthy settlement evidence (a due time is not a settlement time, and a long outage can put the two far apart), so they are stamped with the migration moment and keep one full retention window from the upgrade: they may live longer than they would have under the old clock, and are never purged earlier than the new contract promises.

  `parseDuration(value, field)` is now exported from `@routecraft/routecraft`, so code that computes a ttl can validate it under exactly the rules the suspend surfaces apply. `ctx.suspend({ ttl })` (and its `testFn` twin) now validate the ttl at the call site with `RC5003`, matching `.suspend()`, instead of surfacing a malformed duration after the handler has unwound.

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

- [#540](https://github.com/routecraftjs/routecraft/pull/540) [`0233ced`](https://github.com/routecraftjs/routecraft/commit/0233cedf5a9c99d72042da9a349eccfca6466408) Thanks [@ex0b1t](https://github.com/ex0b1t)! - `mcpPlugin({ clients })` now rejects a client name that is empty, contains `__`, or ends in `_`, throwing RC5003 at startup.

  The key becomes the server segment of the `mcp__<server>__<tool>` tool name agents see, and resolution splits that at the first separator after the prefix. A client called `a__b` exposing `c` generated `mcp__a__b__c`, which read back as server `a`, tool `b__c`. A client ending in `_` is worse than unresolvable: `foo_` exposing `bar` composes `mcp__foo___bar`, the same name `foo` exposing `_bar` composes, and the resolved tool map is keyed by that name with later-wins, so one client silently shadowed the other and a model's call reached the wrong tool.

  Previously nothing failed at startup and every tool on such a client was dropped at dispatch with only a warning, so a typo cost an agent its whole toolset with no signal until something asked for it.

  **Breaking.** A context whose client key has one of these shapes built successfully before and now throws at `mcpPlugin()`. The rejection is namespace-wide: `mcpPlugin()` validates its options at construction, before it can know whether an agent will join the same context, so it applies even to a context that only uses `.to(mcp("name:tool"))` or `proxy`, where the composed wire name never appears. Renaming a client means updating the key, every `mcp("name:tool")` ref, and every `proxy` ref that names it. The error suggests a concrete replacement name, and a test pins that every suggestion it makes is one the validator accepts.

  A single underscore inside the name is unaffected (`my_company_api`), and because only the server half is constrained, a remote may keep using `__` in its own tool names.

- [#546](https://github.com/routecraftjs/routecraft/pull/546) [`31bae7f`](https://github.com/routecraftjs/routecraft/commit/31bae7f1ab11e1ec302bc98b7a14ea01c84d463e) Thanks [@ex0b1t](https://github.com/ex0b1t)! - MCP protocol revision 2026-07-28: the MCP server is now stateless.

  `mcpPlugin({ transport: 'http' })` used to mint a session id per client and hold a live `Server` + transport pair in an in-process map keyed by that id. Every request after `initialize` had to land on the process that owned the session, so an MCP server could not be scaled horizontally without sticky sessions and could not run on per-request compute at all. That was also the only stateful thing in an otherwise stateless framework: a Routecraft route is already a request-to-exchange pipeline with no affinity.

  Revision 2026-07-28 removes protocol-level sessions entirely, and this release adopts it. The server builds a fresh instance per request from one factory, so any replica can answer any request behind a plain round-robin load balancer. The authenticated principal now travels with the request instead of through request-scoped ambient storage.

  2025-era clients keep working: a request carrying no per-request `_meta` envelope is served through the SDK's stateless 2025 path from the same factory. Outbound MCP clients (`mcpPlugin({ clients })`, `mcp()` as an enricher, agent tool dispatch) negotiate with `server/discover` and fall back to the `initialize` handshake against servers that only speak 2025.

  Breaking changes:

  - The optional peer `@modelcontextprotocol/sdk` (v1) is replaced by the v2 package split. Install the packages for the surfaces you use: `@modelcontextprotocol/server` and `@modelcontextprotocol/node` for `transport: 'http'`, `@modelcontextprotocol/server` for `transport: 'stdio'`, and `@modelcontextprotocol/client` for outbound clients. `express` is no longer a peer at all.
  - Successful authentication now logs at `debug` rather than `info` on both auth paths. Auth is verified per request rather than once per session, so an `info` line per tool call would put a subject identifier in the log stream at agent-loop rates. The `auth:success` event is unchanged and remains the signal to subscribe to.
  - Outbound MCP clients advertise the real `@routecraft/ai` package version as `clientInfo.version` instead of a hardcoded `1.0.0`.
  - The `plugin:mcp:session:created` and `plugin:mcp:session:closed` events are removed. There are no sessions to observe; use `plugin:mcp:tool:called` / `:completed` / `:failed` for per-call observability.
  - `McpHeadersKeys.SESSION` is removed, along with the `"routecraft.mcp.session"` exchange header. Read `McpHeadersKeys.REQUEST` (`"routecraft.mcp.request"`) instead: a per-request correlation id. The old key never identified a session, and its value shape changed with this release, so an alias would have misled rather than helped.
  - `Access-Control-Expose-Headers` no longer lists `Mcp-Session-Id` or `Last-Event-ID`. The revision removed both sessions and SSE resumability, so neither header is ever emitted.
  - 2025-era exchanges over HTTP are answered as a single SSE frame rather than a plain JSON body. Both are valid Streamable HTTP and every MCP client handles both; only code parsing the raw response body is affected.

  `oauth()` becomes a resource-server helper rather than an authorization-server proxy:

  - It no longer mounts `/authorize`, `/token`, `/register` or `/revoke`. The MCP server verifies bearer tokens, enforces `requiredScopes`, and advertises its Authorization Server through RFC 9728 metadata; clients run the flow directly against the IdP. Revision 2026-07-28 deprecated Dynamic Client Registration in favour of Client ID Metadata Documents and steers MCP servers towards delegating to a dedicated provider, so proxying it was working against the spec.
  - `oauth({ endpoints, client })` are removed. Pass `issuer` instead (or let `jwks()` / `jwt()` supply it), plus the optional `requiredScopes`. `OAuthAuthOptions`, `OAuthProxyEndpoints`, `OAuthClientInfo`, `OAuthClientSupplier` and `isOAuthAuth` are removed with them. `mcpPlugin` refuses the old `{ provider, endpoints, verifyAccessToken }` shape at construction with the migration message, rather than starting and then refusing every request.
  - A token missing a required scope is now refused with `403 insufficient_scope` and a `WWW-Authenticate` naming the missing scope, rather than the SDK middleware's response.
  - Verification failures caused by infrastructure (an unreachable JWKS endpoint, a failed `userinfo` fetch) answer `500` on every auth mode, so a client retries rather than discarding a credential that is probably valid. Previously only the OAuth path did this.
  - A principal whose `expiresAt` has elapsed (or is not a finite timestamp) is refused with `401` on every auth mode, whether or not a route declares an expiry requirement. The removed SDK bearer middleware enforced this only on the OAuth path. The check honours `clockToleranceSec`, taken from `jwks()` / `jwt()` automatically or passed to `oauth()` for a raw `verify`, so the gate cannot refuse a token the verifier accepted within skew.
  - `requiredScopes` entries are validated against the RFC 6749 scope-token grammar at construction. A scope containing a space, a quote or a backslash would have been split or would have broken the `WWW-Authenticate` header it is echoed into.
  - The `auth:rejected` detail no longer carries `path: "oauth"`; there is one auth path.

  Migration: point clients at your IdP's own authorization and token endpoints. They will find it from the `authorization_servers` field of `/.well-known/oauth-protected-resource`, which Routecraft serves, and from the `resource_metadata` hint on a `401`.

- [#483](https://github.com/routecraftjs/routecraft/pull/483) [`53d6aa0`](https://github.com/routecraftjs/routecraft/commit/53d6aa0043068f8dc421d7aca7e7c003092b9258) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Proxy selected tools from registered MCP clients through the Routecraft MCP server.

  `mcpPlugin({ proxy })` re-exposes tools from `clients` without a route per tool: `"server:tool"` proxies one tool, `"server:*"` (or bare `"server"`) proxies every tool the client advertises, and the `{ ref, name?, description?, annotations? }` form renames or re-documents a single tool. Proxied tools appear in `tools/list` with the remote input/output schema, title, description, annotations, and icons passed through, and `tools/call` dispatches over the client's registered transport and auth with the raw remote result (`content`, `structuredContent`, `isError`) returned verbatim. Selection resolves against the live tool registry (memoized on a registry change version), so wildcards follow tool refresh and stdio restarts without per-request recomputation. An exact ref and a wildcard covering the same remote tool compose, with the exact entry's overrides and guard applying regardless of config order. Collisions between different remote tools are deterministic: local `.from(mcp())` routes win over proxied tools, and earlier `proxy` entries win over later ones, each with a warning. Exposed names must match `[A-Za-z0-9_-]{1,64}`; non-conforming remote names are skipped with a warning unless renamed. Refs are validated at plugin creation (unknown client, malformed ref, wildcard rename, duplicate exposed name all throw); colons beyond the first split stay in the tool segment, matching the agent ref grammar.

  Proxy entries also accept a per-tool `guard` with the same contract as the agent's `tools([{ name, guard }])`: it runs before dispatch with the raw args and a handler context carrying the MCP caller's read-only `principal` (from the HTTP transport's `auth`), and throwing rejects the call as an `isError` result. A guard's own thrown message reaches the caller (the author wrote it for them), but a framework dispatch/transport failure returns a generic message to the caller, with the full detail going only to the server log and the `plugin:mcp:tool:failed` event, so configured upstream URLs and connection internals are never disclosed to MCP clients. Unlike agent tools, no schema validation runs before a proxy guard (the remote server validates after it), so guards must treat the input as untrusted. On wildcard refs the guard attaches to every expanded tool. Guard rejections and dispatch failures emit `plugin:mcp:tool:failed` with the full proxied metadata (`proxied`, `serverId`, `remoteTool`). The `ToolGuard` type moved to `fn/types.ts` (still re-exported from its previous path) so the agent bridge and the MCP proxy share one guard contract.

  Proxied calls run no route pipeline (no `authorize()`, validation, or resilience wrappers) and do not forward the caller's principal; the Routecraft-to-client hop authenticates with the client's registered `auth`. Reserve raw `proxy` entries for simple, read-only tools, use `guard` for identity and role checks, and put anything needing stateful guardrails behind a `.from(mcp())` route.

  Supporting changes: the `tools` filter now applies to `tools/call` as well as `tools/list`, so a filtered-out local tool is no longer callable; `McpToolRegistryEntry` retains `title`, `outputSchema`, and `icons` from remote listings (an explicit `icons: []` opt-out passes through instead of inheriting the server icon); `McpToolRegistry` exposes a `version` counter that bumps only when a source's tools actually change; `StdioClientManager.callToolRaw`, `dispatchMcpCallRaw`, and `callRemoteToolRaw` expose the raw MCP result path (`dispatchMcpCall` is now a thin extract wrapper over it); the `plugin:mcp:tool:*` events carry optional `proxied` / `serverId` / `remoteTool` fields; and `McpProxyToolConfig`, `McpRawToolResult`, `McpStdioToolCaller`, and `MCP_TOOL_NAME_PATTERN` are exported from the package root.

- [#419](https://github.com/routecraftjs/routecraft/pull/419) [`9d9d7f0`](https://github.com/routecraftjs/routecraft/commit/9d9d7f0e4d61717d12760c0aff50ae4341ac5ab0) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Declare core as a peer dependency with a real semver range (plus a workspace devDependency for development) instead of duplicating it as a regular dependency.

### Patch Changes

- [#525](https://github.com/routecraftjs/routecraft/pull/525) [`f2b6e9f`](https://github.com/routecraftjs/routecraft/commit/f2b6e9f9ab533bf643a30ab99c92bc8662b66c92) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Complete the `loadOptionalPeer` migration for the remaining bespoke sites: the mcp server's `express` load and the `agentBrowser()` `agent-browser` load now surface a missing optional peer as `RC5017` with an install hint instead of a hand-rolled error, and no longer mislabel an installed-but-broken package as missing. The optional-peer contract test now scans all four code packages, exempting regular dependencies and required peers, with the mcp `streamableHttp` sub-export probe registered as the one sanctioned bespoke exception.

- [#560](https://github.com/routecraftjs/routecraft/pull/560) [`4c7cbfa`](https://github.com/routecraftjs/routecraft/commit/4c7cbfab2146dbc9625649b40ffe9d6b72e734b3) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Raise the `ai` dependency floor to `^6.0.246`.

- [#434](https://github.com/routecraftjs/routecraft/pull/434) [`828e7c9`](https://github.com/routecraftjs/routecraft/commit/828e7c957637c896aca35073768fd0ec72ce13b8) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Forward a configured `baseURL` to the Anthropic and Gemini LLM providers (previously only OpenAI honoured it, so explicit config lost to the ambient `ANTHROPIC_BASE_URL` environment variable), and load the `yaml` front-matter parser for `agents()` / `skills()` through `loadOptionalPeer` so a missing package surfaces as RC5017 with an install hint instead of a misleading front-matter parse error.
