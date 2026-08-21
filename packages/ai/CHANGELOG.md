# @routecraft/ai

## 0.7.0

### Minor Changes

- [#577](https://github.com/routecraftjs/routecraft/pull/577) [`65803ee`](https://github.com/routecraftjs/routecraft/commit/65803ee4640343de70bfa1dfdf918931e6544105) Thanks [@ex0b1t](https://github.com/ex0b1t)! - `agents()` owns the `agents/` folder walk ([#324](https://github.com/routecraftjs/routecraft/issues/324)).

  The loader now matches [Claude Code's subagent convention](https://code.claude.com/docs/en/sub-agents), so an existing `.claude/agents/` tree loads unmodified. The layout rules live here rather than in the CLI, so a programmatic caller and the project runtime walk the tree the same way.

  **Recursive, and identity comes from frontmatter.** A `.md` file at any depth is one agent, identified by its frontmatter `name`. The filename and the folders above it are grouping and carry no identity, which is the rule that lets `review/security-reviewer.md` declare `name: security` and still resolve as `agent("security")`.

  **Breaking (0.x, so `minor`): the filename no longer has to match the frontmatter `name`.** Trees that relied on the old strict check still load; nothing that worked before stops working. What changes is that a mismatch is no longer an error.

  **Bundles and the reserved folder.** A directory holding `AGENT.md` is exactly one agent and is not descended into, so it can hold assets scoped to that agent. This is the one place the relaxed filename rule does not apply: the frontmatter `name` must match the bundle directory name, mirroring the check `skills()` already applies to its nested form. A directory named `skills` is never scanned for agents at any depth, so a bundle's own skills folder cannot fail the boot on its first file.

  **Duplicate names throw**, naming both files. Silent shadowing is the failure that surfaces months later as "why is this agent behaving like the other one".

  **`skills:` frontmatter is accepted again**, with different semantics from the key removed in 0.6: it declares where an agent's skills come from (local paths, `npm:` package refs) rather than naming blocks. The loader validates the list and surfaces it verbatim; resolving a ref needs the house and bundle folders, which a direct `agents()` call is not given, so it leaves the declaration for the project runtime to consume and records the fact at debug level.

  `readMarkdownDir` grows `recursive` and `reservedDirectories`, and reports the bundle directory on documents found through a sentinel. Two shared-walk changes reach `skills()` as well: `node_modules` and dot-directories are skipped at every level, and a symlink to a file is followed while a symlink to a directory is not, which is what keeps the walk loop-free. `skills()` also now builds its record on a null-prototype object, so a skill named `__proto__` registers as a real key instead of vanishing.

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

### Patch Changes

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
