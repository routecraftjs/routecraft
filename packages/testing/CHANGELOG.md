# @routecraft/testing

## 0.7.0

### Minor Changes

- [#695](https://github.com/routecraftjs/routecraft/pull/695) [`2ad7da5`](https://github.com/routecraftjs/routecraft/commit/2ad7da560cc1fd885095b1c563e65631ccdf473c) Thanks [@mikemikimike](https://github.com/mikemikimike)! - Expose context-level logger calls through a separately restored `t.contextLogger` spy.

- [#630](https://github.com/routecraftjs/routecraft/pull/630) [`2432c0e`](https://github.com/routecraftjs/routecraft/commit/2432c0e5bccf1bdb73399439f2229beea910ee22) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Durable agents: `ctx.suspend()` parks the tool loop through the core suspension store, the loop survives restarts and resumes mid-conversation, MCP advertises and carries the acknowledgment, and a cancelled run fails honestly ([#268](https://github.com/routecraftjs/routecraft/issues/268), [#269](https://github.com/routecraftjs/routecraft/issues/269), [#552](https://github.com/routecraftjs/routecraft/issues/552), [#581](https://github.com/routecraftjs/routecraft/issues/581)).

  **`ctx.suspend({ schema?, ttl?, meta? })` on `FnHandlerContext`.** A handler that cannot answer now returns the sentinel; the runtime flushes the batch's in-flight siblings (their real results persist), stops the loop, and parks the exchange with `stepState = { agentId, messages, suspendedToolCallId, turnsUsed, usage? }`. Execution one replies with the core `Suspended` value; there is no agent-specific result type, which is what makes nested escalation work. `ctx.suspensionId` and `ctx.suspension` (`{ id, token }`) are populated before the handler runs so an approval request can carry a working resume link. `SuspendError` stays honoured as the throw-form escape hatch and now carries `schema` / `ttl` / `meta`; its JSDoc names the footgun (a handler's own `try/catch` swallows a thrown suspension, which the sentinel cannot reproduce). Either form parks with no declared contract when `schema` is omitted.

  **Rehydration.** A resume re-enters the agent step with the payload swapped into the suspended call's tool result; the system prompt, blocks, and tools are re-resolved live (only resolved strings ever persist, and `lifetime: "context"` blocks stay in the running context). The `maxTurns` budget and the accumulated token spend survive the park, so a cancelled resumed run reports the whole run's cost; a run resuming with the budget exhausted takes the ordinary max-turns path. Two suspend signals in one batch produce exactly one park: the first in the model's own emission order wins and the loser becomes a retryable tool error the resumed model sees.

  **Refusals.** `ctx.suspend()` outside an agent dispatch on a route-bound exchange refuses with the new `AI1006` at the call, writing nothing. Rehydration state the agent cannot re-enter (malformed `stepState`, a route rebound to a different agent, a thread missing the suspended call) fails with the new `AI1007`. An unconfigured context fails the park with `RC5052` naming the one config line.

  **MCP carries Suspended ([#581](https://github.com/routecraftjs/routecraft/issues/581)).** A tool whose route can park (a static `.suspend()`, or an agent step, whose tools MAY park) and declares `.output()` advertises `outputSchema` as the derived `oneOf: [Output, Suspended]`; the author declares only the output arm. The acknowledgment rides `structuredContent` on an ordinary `isError: false` result, and the park emits the new `plugin:mcp:tool:suspended` `{ tool, suspensionId }` instead of `completed`: a parked run reported as finished is a false receipt. `McpTool.outputSchema`'s root type loosens to admit the `oneOf` root.

  **Cooperative cancellation ([#552](https://github.com/routecraftjs/routecraft/issues/552)).** The dispatch signal now merges the route's signal with the step's, so a route-scope `.timeout()` reaches the model call instead of letting an abandoned run finish the turn and discard it; the signal is checked between turns and reaches `Direct(...)` tool dispatch, which refuses to start after an abort and unwinds promptly mid-flight (the downstream route finishes under its own lifecycle). A cancelled run fails with the new `AI1005`, whose `cause` is the exported `AgentCancellationCause` carrying typed `turnsUsed` and `usage` fields (cache tokens included) instead of returning a partial `AgentResult` that reads like success. Parent-cancels-sub-agents is specced (skipped test) and lands with [#226](https://github.com/routecraftjs/routecraft/issues/226). The `AI1xxx` range's charter widens to "agent blocks, configuration, and runtime".

  **Breaking.** `FnHandlerContext.checkpointId` is renamed `suspensionId` (the v0 rename [#417](https://github.com/routecraftjs/routecraft/issues/417) recorded; it was a stub nothing populated). `FnHandlerContext` gains a required `suspend` member, so hand-built handler contexts must provide one; `makeFnHandlerContext` and `testFn` both do, and `@routecraft/testing`'s `TestFnHandlerContext` now includes a structural `suspend` that returns the sentinel shape for assertions without parking anything.

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

- [#637](https://github.com/routecraftjs/routecraft/pull/637) [`5a9758c`](https://github.com/routecraftjs/routecraft/commit/5a9758cadb2c0539f167d6fbee6f3f963f84fee8) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Retention counts from settlement, not from the park ([#634](https://github.com/routecraftjs/routecraft/issues/634)).

  `purgeSettled` used to measure the retention window from `suspendedAt` because the store carried no settlement timestamp, so a record that parked for 89 days and resolved on day 89 was purged one day after settling. Records now carry `settledAt`, stamped on every terminal transition (resumed, expired, denied), and retention measures from it: a settled record gets the full configured window from the moment it settled, however long it was parked before that.

  **The SQLite store migrates itself to schema v4.** Resumed rows backfill exactly from `resumed_at`. Expired and denied rows carry no trustworthy settlement evidence (a due time is not a settlement time, and a long outage can put the two far apart), so they are stamped with the migration moment and keep one full retention window from the upgrade: they may live longer than they would have under the old clock, and are never purged earlier than the new contract promises.

  `parseDuration(value, field)` is now exported from `@routecraft/routecraft`, so code that computes a ttl can validate it under exactly the rules the suspend surfaces apply. `ctx.suspend({ ttl })` (and its `testFn` twin) now validate the ttl at the call site with `RC5003`, matching `.suspend()`, instead of surfacing a malformed duration after the handler has unwound.

- [#678](https://github.com/routecraftjs/routecraft/pull/678) [`4f6e503`](https://github.com/routecraftjs/routecraft/commit/4f6e503d3bf4d6d85cad89aec0352496d7954b5b) Thanks [@ex0b1t](https://github.com/ex0b1t)! - `startAndWaitReady()` no longer rejects when a startup exchange fails while another source is still coming up.

  `awaitRoutesReady` rejected on any `context:error`, which treated two different things as one: a route or plugin that failed to START, and an exchange that failed while RUNNING. The distinction was already in the payload, since the pipeline attaches the exchange it was executing and every start-path emitter leaves it undefined, so the guard now settles only on the bare form.

  The conflation made a whole shape of route untestable. A route with a startup-firing source (`simple()` alongside a `cron()`, the usual way to run a scheduled probe once at boot) emits its first exchange immediately, while a sibling source that readies behind a lazy driver import does not. `route:started` waits for every source, so a failing startup exchange lands first, and the caller got a rejection out of `startAndWaitReady()` rather than a started context. The failure was in `errors` the whole time; a test asserting on it never reached the assertion.

  It also read as a flake rather than as this. Which side won depended on whether the sibling's driver import was already warm, so the same test passed alone, passed in one file order, and failed in another.

  A route or plugin that genuinely fails to start still rejects, and still fails fast rather than timing out with no cause named.

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
