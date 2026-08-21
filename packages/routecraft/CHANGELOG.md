# @routecraft/routecraft

## 0.7.0

### Minor Changes

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

- [#573](https://github.com/routecraftjs/routecraft/pull/573) [`8f01cf8`](https://github.com/routecraftjs/routecraft/commit/8f01cf8802e17217eb045116ed248fc22a3d09e5) Thanks [@ex0b1t](https://github.com/ex0b1t)! - `forward()` now carries the caller's identity and trace ([#567](https://github.com/routecraftjs/routecraft/issues/567)).

  `Route.buildForward()` built the forwarded exchange with no headers, so a forwarded call arrived anonymous and separately traced. A target declaring `.authorize()` refused it with `RC5012`; a target without one ran with no authority at all. The forwarded call also got a fresh correlation id, breaking the audit chain at the forward boundary.

  This affected every caller of `forward()`: route-scope and step-scope `.error()` handlers, `circuitBreaker` fallbacks, and `BlockClient.forward` in `@routecraft/ai`, which is the documented way to back an agent block with a route. A memory or knowledge block resolved that way was either refused by its target or served identically to every caller regardless of who asked.

  A `direct()` destination never had the bug because it hands the target its live exchange, headers and all. Forward builds a fresh envelope, so it has to pass the caller's headers explicitly. It now does, which brings the two in-process paths to parity.

  Headers travel by reference rather than as a copy. Both authenticity brands (`markAuthentic`, `markRestored`) are identity-keyed `WeakSet` membership, so any copy silently drops them: a copied restored principal would fail `authorize()` with `RC5023` ("self-asserted") instead of the correct `RC5043` ("restored, not verified live"), and re-branding one to compensate would launder an unverified identity into a trusted one. Propagation is unconditional and cannot escalate: it is the same frozen authority the calling route was already running under.

  `Route.getForward()` now takes the calling exchange as a required argument. It is `@internal`, and required rather than optional so a new call site cannot silently reintroduce the anonymous forward.

  **Engine-owned headers are re-established at every route ingress.** `buildExchange` is the single ingress constructor, so it now mints a fresh `routecraft.id` rather than letting one be inherited. An inherited exchange id collides in every store keyed by it: telemetry spans (`${exchangeId}:${contextId}`), the `exchanges` and `exchange_snapshots` tables, and suspension ids (`${exchangeId}~${sequence}`). The correlation id, not the exchange id, is what links a hop. This corrects the pre-existing `direct()` behaviour too, where the target route previously ran under the caller's exchange id.

  **Split hierarchy no longer crosses a route boundary.** `buildExchange` now drops `routecraft.split_hierarchy` at route ingress. A split group can only join within the executor run that created it, so a hierarchy arriving from another route was unjoinable by construction, and actively harmful: `.aggregate()` looks the trailing group id up in the context-wide split-parent store, so it would find the _caller's_ parent exchange and delete that entry on completion, corrupting an aggregation still in flight on the calling route. This also closes the same latent hazard on the pre-existing `direct()` path.

  Two consequences worth knowing. A target route with a strict `.input({ headers })` schema now sees the caller's headers and may reject a forward that previously passed. And forwarding a principal whose `expiresAt` has passed now surfaces the expiry error rather than `RC5012`, which is the correct failure but a different one.

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
