---
title: Changelog
---

All notable changes to Routecraft. {% .lead %}

Routecraft is in active development -- APIs may change between minor versions.

---

---

## v0.6.0 {% badge color="gray" %}In development{% /badge %}

This section covers every change landing on `main` since the v0.5.0 release. 0.6.0 is the architecture release before v1: the contracts that freeze at v1 changed shape once, now, so they do not have to change after, and the engine rework brings a significant performance improvement to route and event processing. See the [0.5.x to 0.6.0 migration guide](/docs/migrating/0.5-to-0.6) for all upgrade steps.

### Core {% badge color="red" %}Breaking{% /badge %}

- **Fixed event names; identity in the payload** -- hierarchical names like `route:<id>:exchange:failed` become a fixed set (`route:exchange:failed`) with `routeId` in `details`. Wildcard patterns on `ctx.on()` / `ctx.once()` are replaced by exact names, the `"*"` catch-all, and the `forRoute()` filter helper (the `event()` source adapter keeps its pattern support); ecosystem packages declare events by merging into `EventDetailsMap`. `plugin:registered` is removed (it duplicated `plugin:starting`).
- **`Subscription` source contract** -- source adapters receive a single `Subscription` object (`{ context, signal, meta, ready(), complete(), emit() }`) instead of five positional parameters. `.from()` additionally accepts async generator functions and (async) iterables, and `@routecraft/testing` adds a `testSubscription()` helper.
- **`StepOutcome` step contract** -- custom `Step` implementations return what happened (`continue` / `complete` / `drop` / `branch` / `fanOut`) and the executor owns all scheduling; the wrapper buffer/relay protocol is gone. Per-execution metadata rides the outcome instead of mutating the shared `Step` instance. Custom aggregators return `{ body, headers? }` instead of a fabricated `Exchange`.
- **Namespaced error-code registry** -- ecosystem packages own codes under a claimed namespace via `registerErrorCodes()` plus `ErrorCodeRegistry` declaration merging; `RC` is reserved for core. Adds `RC1003` (error-code registration failed).
- **Type-enforced builder positioning** -- `craft()` returns a pre-`from` builder, so pipeline operations before `.from()` are compile errors; builder generics move to a state bag (`RouteBuilder<{ body: T }>`, `AnyRouteBuilder` for lists).
- **Splitters return child bodies** -- `.split()` callbacks return values (or `splitChild(body, headers)` for per-child header overrides) instead of hand-built `Exchange` instances; the framework owns child construction.
- **Consumer SPI** -- `Consumer.register` receives the `Message` envelope and consumer classes construct from one `ConsumerDeps` bag; `Message`, `ProcessingQueue`, `ConsumerType`, and `ConsumerDeps` are exported.
- **Per-adapter header key objects** -- `HeadersKeys` keeps framework keys only; adapter keys move to `TimerHeaders` / `CronHeaders` / `FileHeaders` / `CsvHeaders` / `JsonlHeaders` / `MailHeaders` / `CarddavHeaders`; `HEADER_MAIL_*` / `HEADER_CARDDAV_*` and `HeaderKeysRegistry` are removed (wire keys unchanged). `.header()` rejects every engine-owned `routecraft.*` key up front.
- **`client.sendDirect` and public capability discovery** -- `CraftClient.send` is renamed `sendDirect` (response generic defaults to `unknown`); `context.capabilities()` replaces reads of the internal direct registry, and `ADAPTER_DIRECT_REGISTRY` / `getDirectChannel` / `sanitizeEndpoint` are no longer exported.
- **Naming sweeps** -- `CardDAV*` exports become `Carddav*` (acronym casing per the `Http` precedent), the carddav option types adopt the two-sided Server/Client naming (`CarddavServerOptions` for the read role, `CarddavClientOptions` for writes and deletes), and jsonl's three file option types fold into one `JsonlFileOptions`.
- **`choice()` variadic surface; `BranchBuilder` renamed, `ChoiceSubBuilder` removed** -- the fluent callback `.choice(c => c.when(p, fn).otherwise(fn))` becomes variadic `.choice(when(p, fn), ..., otherwise(fn))` with standalone `when` / `otherwise` helpers imported from `@routecraft/routecraft`, the path surface now shared with the new `multicast`. `BranchBuilder` is renamed `PathBuilder`; `ChoiceSubBuilder` is gone.
- **Adapter role model: `Source` / `Destination` / `Enricher`** -- mid-route reads used to be modelled as "a `Destination` whose `send` returns the content", so one slot carried two contracts and factories had to infer their category from option values (`mode: 'read'`, path-string sniffing, category-by-absence). The slot is split instead: `Destination.send` is strictly void (the body flows through unchanged) and the new `Enricher.fetch` pulls a value in. The operation keyword picks the role: `.from()` subscribes, `.to()` / `.tap()` prefer `send` and fall back to `fetch`, `.enrich()` fetches. Pull-in adapters are typed `Enricher` and renamed to match (`HttpEnricherAdapter`, `MailEnricherAdapter`, `DirectEnricherAdapter`, `LlmEnricherAdapter`, `AgentEnricherAdapter`, `EmbeddingEnricherAdapter`, `McpEnricherAdapter`, `AgentBrowserEnricherAdapter`); route-level behaviour of `.to(http({ url }))`, `.to(direct("x"))` and `.to(llm(...))` is unchanged. `ToResultBody` is deleted, `CallableDestination<T>` is void-only, and `CallableEnricher<T, R>`, `Enricher<T, R>`, `SendContext` and `ToTarget` are new exports. `@routecraft/ai`, `@routecraft/os` and `@routecraft/testing` raise their core peer range to `>=0.6.0`.
- **`.enrich()` replaces the body by default** -- with the aggregator omitted, `.enrich(x)` now replaces the body with the fetched value instead of spread-merging it. `only()` and `none()` remain for merging and the `replace()` helper is deleted (it is the default now); the aggregator type is renamed `DestinationAggregator` to `EnrichAggregator`. A fetch resolving `undefined` means "no value" and leaves the body unchanged, reflected in the new `FetchedBody` helper type.
- **File-family adapters drop `mode`** -- `file`, `csv`, `json`, `jsonl`, `xml` and `html` select their role by position; send behaviour uses `append: true` / `delete: true` (mutually exclusive, `RC5003` at construction). `jsonl`'s send now overwrites by default, so audit every `.to(jsonl(...))` event log and restore `append: true` where you relied on the old default. The same flip applies to `.tap()`: a migrated `.tap(json({ path }))` resolves to `send` and writes, where `mode: 'read'` used to read and discard; use `.enrich()` to read. The per-mode aliases (`FileReadAdapter`, `CsvReadAdapter`, `JsonReadAdapter`, `JsonlReadAdapter`, `XmlReadAdapter`, `HtmlReadAdapter`) are deleted, and `json()`'s transformer extraction option is renamed `path` to `pointer` so `path` always means a file path.
- **Send receipts move to headers** -- sends that produce a receipt surface it through headers instead of replacing the body. `.to(mail())` sets `routecraft.mail.sentMessageId` / `.accepted` / `.rejected` / `.response` (the inbound `routecraft.mail.messageId` is left untouched so mail-to-mail routes keep their correlation id), and carddav writes and deletes set `routecraft.carddav.url` / `.uid` / `.etag` plus `.created` for insert-vs-update. `MailSendResult`, `CarddavWriteResult` and `CarddavDeleteResult` are deleted. Adapters write receipts through the new `SendContext.setHeader` sink, subject to the same framework-owned key rule as `.header()`, and observability hooks split per slot (`getMetadata(result)` for fetch, `getSendMetadata(receipts)` for send).
- **Option laws: arity is not a discriminant, key presence means supplied** -- `mail()`'s read side used to split on argument count, so `mail(folder)` returned an `Enricher` and `mail(folder, options)` returned a `Source`: a second argument changed the role. Both shapes now return one read adapter (`MailFolderAdapter`) carrying `subscribe` and `fetch`, with the operation keyword choosing between them, so `.from(mail('INBOX'))` and `.enrich(mail('INBOX', opts))` are newly valid and everything that compiled before still does. Separately, `json()`, `html()`, `csv()`, `jsonl()` and `xml()` treated a supplied-but-`undefined` `path` as an absent one, silently producing a transformer that ignored every file option beside it; a supplied `path` of `undefined` now throws `RC5003` like the empty string does, and only an omitted key selects the transformer role.
- **`.input()` validation folds into the pre-from filter chain** -- validation now runs at chain position #4 for every source shape, inside the synthetic parse step where the source attaches a parser and as a standalone synthetic `input` step where it does not. Parser-less sources used to validate eagerly in the consumer handler, so an `RC5002` bypassed the route-scope `.error()` handler and surfaced as `route:exchange:dropped`. `.error()` can now observe and recover an input failure exactly like an `authorize` or `parse` rejection, and an unrecovered failure takes the normal error path (`route:step:failed` with operation `"input"`, then `route:error`, `context:error`, `route:exchange:failed`) while still rejecting the sender. Migrate observers accordingly: a cross-route failure now fires `context:error` on both routes.
- **`.retry({ exponential })` removed in favour of `factor`** -- the wait before attempt `n` is `backoffMs * factor^(n - 1)`. Migrate `exponential: true` to `factor: 2` and `exponential: false` (or omitted) to `factor: 1`, the new default; passing `exponential` throws `RC5003` at build with a migration hint. `maxBackoffMs` caps a single wait so a steep factor cannot grow unbounded, and `jitter` (`"none"` / `"full"` / a `0..1` fraction) de-syncs retry storms, only ever shortening a wait so the cap still holds.
- **Delegation-aware `Principal` and `authorize()`** -- distinguishes a user acting directly, a party acting on a user's behalf, and an agent acting under its own authority. `Principal` gains `actor` (RFC 8693 `act`, nested, outermost-only policy input), `subjectProfile` (`user` / `service` / `ai_agent`), `mayAct` (RFC 8693 `may_act`, enforced in-process) and `grantId`. The new `delegate()` helper and `.delegate()` operation mint delegated principals: subject and roles pass through, scopes become the intersection of subject and consent ceiling, chains nest, expiry takes the minimum. `authorize()` gains `subject`, `actor` and `maxDelegationDepth` matchers, and `jwt()` / `jwks()` parse `act` / `may_act` / `sub_profile` with a new `ClaimMappers.roles` mapper, failing closed on unparseable delegation claims. Adds `RC5034` to `RC5038`. **Breaking:** `authorize()` defaults to `actor: 'none'`, so principals carrying an actor (including Clerk impersonation sessions) are rejected until a route declares its permitted actors; `.delegate()` fails closed when the resolver returns `undefined`, stripping the subject's direct principal so the exchange continues anonymous (pass `{ otherwise: 'keep' }` for continuations serving the caller directly). A missing scope now raises `RC5038` (recoverable, with `missing.scopes` on the cause) instead of `RC5015`.

### Core

- **Recovery directives** -- `.error()` handlers may return `recovery.drop(reason?)` (discard the failing exchange) or `recovery.rethrow()` (decline recovery) instead of a recovery body or a manual throw.
- **Open error and principal models** -- `rcError` accepts a per-occurrence `retryable` override; `RCMeta.category` and `Principal.kind` accept ecosystem-defined strings alongside the known values.
- **Plugin identity and lifecycle** -- plugins may declare `name` (used as `pluginId` on events and logs) and reserve `dependsOn`; `registerTeardown` callbacks unwind LIFO; `getRoutes()` returns a copy.
- **`route:source:failed` lifecycle event** -- fires when a source subscription rejects (the source gave up producing), with `{ routeId, route, adapter?, error }`. Unlike `route:stopping` it never fires for an orderly shutdown, so it is the signal to alarm on for a dead channel.
- **`concurrency` (bulkhead) wrapper operation** -- `.concurrency({ max })` bounds how many exchanges run an operation at once, the sibling of `.throttle()` (which bounds a rate). Dual-mode like the other resilience wrappers: step scope wraps the next step, route scope bounds the whole pipeline at the innermost resilience position, inside `.retry()` / `.timeout()`, so a slot is held per attempt and freed between retry backoffs. The default `queue` mode applies backpressure (bounded by `maxQueue`) and `mode: "reject"` fails fast with the new retryable `RC5026`; a `key` selector partitions the pool per user, tenant or pool (bounded by `maxKeys`). Emits `route:concurrency:queued` / `:acquired` / `:released` / `:rejected`.
- **`dispatch` load-balancing operation** -- `.dispatch(strategy, ...targets)` runs exactly one of several targets, the sibling of `multicast` (all targets) and `choice` (one by predicate). The leading strategy is `"failover"` (try targets in order until one succeeds, pairing with per-target `.retry()` / `.circuitBreaker()`), `"round-robin"`, `"weighted"` (smooth weighted round-robin over the new `weighted(target, n)` helper) or `{ strategy: "sticky", key, maxKeys? }` (exchanges sharing a key stick to one target via an LRU-bounded affinity map). Side-effect-only like `multicast`: the selected target runs on its own clone and the original continues unchanged. Emits `route:operation:dispatch:selected` / `:exhausted`.
- **`debounce` flow-control operation** -- `.debounce({ waitMs })` suppresses bursts, releasing only the last exchange in a burst after a quiet period (file-change batching, search-as-you-type). Each arrival resets the quiet timer and supersedes the one being held; an optional `key` debounces per group and an optional `maxWaitMs`, measured from the burst start and never reset, guarantees eventual release under continuous activity. A pending exchange is flushed on drain rather than lost. Route scope only. Emits `route:operation:debounce:held` / `:dropped` / `:released`, and adds two primitives it is the first to need: `StepContext.captureDownstream()` and `Route.onDrain()`.
- **`sample` and `dedupe` flow-control operations** -- `sample({ every })` passes every Nth exchange and `sample({ intervalMs })` passes the first in each time window, dropping the rest silently like a `filter` returning false. `dedupe(options?)` suppresses duplicates by a derived key with reserve-on-entry, commit-on-completion and release-on-failure semantics, an optional `key` function, and `ttl` / `maxKeys` bounds on the per-route key set. The default key derivation (SHA-256 of the body's JSON serialisation) is shared with `cache` through the new `hashExchangeBody` utility.
- **`.timeout()` propagates an `AbortSignal`** -- an expired deadline used to leave the abandoned work running to completion in the background, because promises cannot be cancelled. The step now receives a signal that fires on expiry (abort reason: the `RC5011` error) at both step and route scope, with nested timeouts linked so the earliest deadline wins. Function-form steps get it as a trailing argument (`.process((ex, { signal }) => fetch(url, { signal }))`, likewise on `.transform()`, `.to()` and `.enrich()`), adapter authors read `ctx.signal` in `Step.execute`, and the built-in `http()` destination forwards it automatically. `.tap()` deliberately receives no signal: taps run detached, so an abandoned attempt must not cancel an observation in flight. The `.timeout(ms)` surface is unchanged.
- **`.input({ body })` retypes the builder** -- the following `.from(source)` opens the pipeline with the schema's inferred output type, so the duplicated `.from<T>()` generic is no longer needed (an explicit generic still overrides). Adds `PreFromTypedBuilder` and the shared `PreFromStaging` surface.
- **`jwt()` and `jwks()` surface `clockToleranceSec`** -- a consumer re-checking a verified principal's `expiresAt` needs to know the skew the verifier allowed, or a token accepted by `jwks({ clockToleranceSec: 30 })` whose `exp` is 10 seconds past would be refused by the very layer meant to catch validators that ignore expiry. The field is absent when the option was not configured, so "not configured" stays distinguishable from an explicit zero. `authorize()` now floors its expiry comparison to whole seconds, and `jwt()`, `authorize()` and the MCP expiry gate treat the boundary as inclusive (a token whose `exp` equals the current second is expired), matching jose and RFC 7519 section 4.1.4; `jwt()` previously honoured such a token for one further second, so it and `jwks()` disagreed at the boundary.

### AI & MCP {% badge color="red" %}Breaking{% /badge %}

- **AI error codes renamed** -- `RC5025` / `RC5026` / `RC5027` become `AI1001` / `AI1002` / `AI1003` under the new `AI` namespace; update any code or alerting that matches on `error.rc`.

- **Agent blocks replace skills** -- `AgentOptions.skills` and `agentPlugin({ skills })` are removed in favour of a `blocks` record that unifies skills, memory, identity, and instructions, with progressive disclosure now the default.
- **`skills({ source })` and `fromFile(path)` builders** -- `skills` now returns a `blocks` record to spread into `blocks: { ... }`; `fromFile` reads a UTF-8 file at resolution time.
- **Nested block groups** -- a `blocks` value can be a single block or a nested `blocks` group, so `skills({ source })` can stay grouped under one key (`blocks: { skills: await skills(...) }`) instead of being spread flat. Groups flatten to `group__leaf` names.
- **Tag selectors on `tools()` removed** -- the `{ tagged }` / `{ tagged, from }` variants and the `tags` override on `directTool` are gone. Use the new `tools((catalog) => [...])` builder form for dynamic selection.
- **Block-loader calls partitioned out of `toolCalls`** -- progressive loads surface on `AgentResult.blocksLoaded` and emit `agent:block:*` events instead of `agent:tool:*`.
- **`skills:` frontmatter on `agents()` rejected** -- supply `blocks` through the per-agent overrides map instead.
- **New error codes `AI1001`-`AI1003`** -- block resolution failure, name collision / reserved `_block_` prefix, and block misconfiguration.
- **`direct_<routeId>` and `_block_load_<name>` tool names renamed** -- synthetic tool names now use `__` as their sole structural separator, so they become `direct__<routeId>` and `_block__load__<name>`. Fn ids and `mcp__<server>__<tool>` are unchanged, and the `Direct(...)` / `MCP(...)` authoring grammar does not change. Update anything pinning a generated name: tool-name guards, assertions on `toolCalls[].toolName` or `blocksLoaded[].toolName`, recorded transcripts, evals. See the [migration guide](/docs/migrating/0.5-to-0.6#tool-name-normalisation).
- **`ResolvedTool.source` is a new required field** -- a resolver-set `fn` / `direct` / `mcp` / `block` discriminant. Affects only code that hand-constructs a `ResolvedTool`.
- **`Direct(<routeId>)` and fn ids validated against the provider charset** -- a name that cannot survive as a provider tool name (`/^[A-Za-z0-9_-]{1,64}$/`) now raises `RC5003` naming the offending character or length, rather than being rejected by the provider later. Expose an unsafe route id under a tool-safe alias with `directTool(routeId)`. An MCP client tool whose remote name cannot form a valid wire name is dropped with a warning instead of failing the dispatch.
- **MCP protocol revision 2026-07-28: the server is stateless** -- `mcpPlugin({ transport: 'http' })` used to mint a session id per client and hold a live `Server` and transport pair in an in-process map keyed by it, so every request after `initialize` had to land on the process owning the session. The revision removes protocol-level sessions entirely: the server builds a fresh instance per request from one factory, so any replica can answer any request behind a plain round-robin load balancer, and the authenticated principal travels with the request instead of through request-scoped ambient storage. 2025-era clients keep working through the SDK's stateless 2025 path from the same factory, and outbound clients negotiate with `server/discover` before falling back to the `initialize` handshake. The optional peer `@modelcontextprotocol/sdk` (v1) is replaced by the v2 package split: install `@modelcontextprotocol/server` plus `@modelcontextprotocol/node` for `transport: 'http'`, `@modelcontextprotocol/server` for `transport: 'stdio'`, and `@modelcontextprotocol/client` for outbound clients. `express` is no longer a peer. The `plugin:mcp:session:created` / `:closed` events and `McpHeadersKeys.SESSION` are removed (read `McpHeadersKeys.REQUEST`, a per-request correlation id, instead), `Access-Control-Expose-Headers` no longer lists `Mcp-Session-Id` or `Last-Event-ID`, successful authentication logs at `debug` rather than `info` because auth is now verified per request, and 2025-era HTTP exchanges are answered as a single SSE frame rather than a plain JSON body.
- **`oauth()` becomes a resource-server helper** -- it no longer mounts `/authorize`, `/token`, `/register` or `/revoke`. The MCP server verifies bearer tokens, enforces `requiredScopes` and advertises its Authorization Server through RFC 9728 metadata, so clients run the flow directly against the IdP; revision 2026-07-28 deprecated Dynamic Client Registration in favour of Client ID Metadata Documents, so proxying it worked against the spec. `oauth({ endpoints, client })` is removed along with `OAuthAuthOptions`, `OAuthProxyEndpoints`, `OAuthClientInfo`, `OAuthClientSupplier` and `isOAuthAuth`; pass `issuer` instead (or let `jwks()` / `jwt()` supply it) plus the optional `requiredScopes`, and `mcpPlugin` refuses the old shape at construction with the migration message rather than starting and then refusing every request. A token missing a required scope is refused with `403 insufficient_scope` and a `WWW-Authenticate` naming it; infrastructure failures (unreachable JWKS, failed `userinfo` fetch) answer `500` on every auth mode so a client retries rather than discarding a probably-valid credential; and an elapsed or non-finite `expiresAt` is refused with `401` on every auth mode, honouring `clockToleranceSec`. Point clients at your IdP's own endpoints, which they will find from the `authorization_servers` field of `/.well-known/oauth-protected-resource`.
- **MCP client names reject `__` and a trailing `_`** -- the `clients` key becomes the server segment of the `mcp__<server>__<tool>` name agents see, and resolution splits at the first separator after the prefix, so a client called `a__b` exposing `c` generated `mcp__a__b__c` and read back as server `a`, tool `b__c`. A trailing underscore was worse: `foo_` exposing `bar` and `foo` exposing `_bar` compose the same name, and the resolved tool map is later-wins, so one client silently shadowed the other and a model's call reached the wrong tool. Both now throw `RC5003` at `mcpPlugin()` with a concrete suggested replacement, where previously nothing failed at startup and every tool on such a client was dropped at dispatch with only a warning. The rejection is namespace-wide, so it applies even to a context that only uses `.to(mcp("name:tool"))` or `proxy`. A single underscore inside the name is unaffected, and a remote may keep using `__` in its own tool names.

### AI & MCP

- **`agentPlugin({ toolPolicy })`** -- repository-wide admission control for the agent tool surface, keyed by tool kind (`fn` / `direct` / `mcp`), each `true`, `false`, or a predicate over a read-only tool descriptor. Omit it and nothing changes; supply it and the surface becomes an allowlist where every kind must be decided. Enforced at the single point every agent form converges on, so inline, registered, markdown, and nested agents are all covered, and multiple installs compose with AND. See the [tool policy reference](/docs/reference/plugins/agentplugin#tool-policy).
- **`route:agent:tool:denied` event** -- emitted once per tool refused admission by a policy, carrying `agentName`, `toolName`, `toolKind`, and a `reason` of `rule`, `rule-error`, or `unknown-provenance`, so denials are alertable and auditable rather than only logged.
- **`mcpPlugin({ proxy })` re-exposes client tools** -- proxy tools from registered `clients` through the Routecraft MCP server without a route per tool: `"server:tool"` proxies one, `"server:*"` (or bare `"server"`) proxies everything the client advertises, and the `{ ref, name?, description?, annotations? }` form renames or re-documents one. Proxied tools appear in `tools/list` with the remote schemas, title, description, annotations and icons passed through, and `tools/call` dispatches over the client's registered transport and auth with the raw result returned verbatim. Selection resolves against the live registry (memoized on a change version), so wildcards follow tool refresh and stdio restarts. Collisions are deterministic: local `.from(mcp())` routes win over proxied tools and earlier `proxy` entries win over later ones, each with a warning. A per-tool `guard` runs before dispatch with the raw args and the MCP caller's read-only `principal`, and its own thrown message reaches the caller while a framework dispatch or transport failure returns a generic message so upstream URLs and connection internals are never disclosed. Proxied calls run no route pipeline (no `authorize()`, validation or resilience wrappers) and do not forward the caller's principal, so reserve raw entries for simple read-only tools and put anything needing stateful guardrails behind a `.from(mcp())` route.
- **`baseURL` honoured by the Anthropic and Gemini providers** -- previously only OpenAI honoured a configured `baseURL`, so explicit config lost to the ambient `ANTHROPIC_BASE_URL` environment variable. The `yaml` front-matter parser for `agents()` / `skills()` also loads through `loadOptionalPeer`, so a missing package surfaces as `RC5017` with an install hint instead of a misleading front-matter parse error.

### Internals

- **Engine restructuring** -- `CraftContext` delegates events to an internal `EventBus`; adapter config keys (`cron`, `direct`, `mail`, `telemetry`, `http`) move to per-module config appliers; the route engine splits into `pipeline/` modules (executor, validation, synthetic steps). Two behavioural notes: context store seeding for adapter config now happens in `initPlugins()` (called automatically by `start()`), and plugin teardown (including `registerTeardown` callbacks) drains in reverse order.
- **Uniform factory tagging** -- every public adapter factory is tagged for `mockAdapter()`, enforced by a conformance test; previously `direct`, `simple`, `timer`, `cron`, `log`, `noop`, and others (plus two transformer-mode branches of `html()` / `json()`) were silently unmockable.
- **Every optional peer loads through `loadOptionalPeer`** -- the mail drivers (`imapflow`, `nodemailer`, `mailparser`), the MCP server's `express` load and `agentBrowser()`'s `agent-browser` load now surface a missing package as `RC5017` with an install hint instead of a raw module-not-found or hand-rolled error, and no longer mislabel an installed-but-broken package as missing. Missing-peer errors are terminal at the mail source's reconnect boundary, since no amount of reconnecting installs a package, so the hint arrives immediately instead of after 30 attempts. Detection also handles the phrasings Bun uses (a quoted full specifier with an optional subpath) and scans every quoted occurrence rather than the first, so a message naming a longer package that shares the requested one's prefix no longer defeats the boundary check. A contract test now scans all four code packages for bare external dynamic imports.
- **Config appliers restored in the published bundles** -- the package's `sideEffects` allowlist named only the dist entry points, marking the `src` config modules pure, so esbuild pruned their side-effect imports out of the bundle during the package's own build: `defineConfig({ mail: { accounts } })` typechecked but was never applied at runtime and `mail("INBOX", { account: "default" })` failed with "IMAP host is required". Every core config applier (`mail`, `carddav`, `direct`, `cron`, `http`, `telemetry`) was affected. The field is removed and a post-build guard now imports both bundles and asserts every `registerConfigApplier` key found in the source is live in the registry. Separately, a `defineConfig` key with no registered applier (a typo like `htttp`, or an applier whose module never loaded) warns at context construction instead of being a silent no-op.
- **Core declared as a peer dependency of `@routecraft/ai`** -- with a real semver range, plus a workspace devDependency for development, instead of duplicating core as a regular dependency.
- **Dependency floors refreshed** -- every workspace moves to the newest in-range minor and patch release ahead of 0.6.0. Runtime ranges that moved: `ai` on `@routecraft/ai`; `@opentelemetry/sdk-trace-base`, `fast-xml-parser`, `imapflow`, `jose` and `mailparser` on `@routecraft/cli`; and `@inquirer/prompts` on `create-routecraft`. Optional peer ranges keep their existing wide floors and no major upgrades are included.

### Adapters

- **HTTP source** {% badge color="red" %}Breaking{% /badge %} -- `http()` is now a two-sided adapter. `http({ path, method? })` exposes a route over HTTP via `defineConfig({ http: { port, host, auth } })`; Bun runtimes bind through `Bun.serve` and Node 22+ uses a zero-dependency `node:http` shim. Global auth accepts `jwt()` / `jwks()` bearer or `apiKey({...})`; per-route constraints reuse `.authorize({...})`. Per-route auth handling has three modes via `http({ auth: "required" | "optional" | "skip" })`: secure-by-default `"required"`, `"optional"` (admit anonymously, attach principal when a valid credential is present, reject invalid credentials), and `"skip"` (bypass the middleware entirely for truly identity-free routes like RSS or probes). Built-in `/health`, `/ready`, and `/openapi.json` endpoints register automatically. Each is configured via the uniform `http: { builtins: { health, ready, openapi } }` block with `{ enabled, requireAuth }` per endpoint (Spring-Actuator-inspired). Defaults gate the `routes` count on `/ready` from anonymous callers (`requireAuth: true`) and keep `/openapi.json` public (`requireAuth: false`, matching the Stripe / GitHub / Twilio convention). Request bodies are parsed by `Content-Type` (JSON / text / urlencoded / multipart), capped by `maxBodySize`. Adds error codes `RC5018` (request rejected) and `RC5019` (server bind failed). **Breaking:** the destination option type `HttpOptions<T>` is renamed `HttpClientOptions<T>` (the source uses `HttpServerOptions`); a type-only change with no runtime impact.
- **Codec read and delete roles** -- `file()`, `json()`, `csv()`, `jsonl()`, `xml()` and `html()` can be read mid-route and can delete. `.enrich(json({ path }))` reads and parses, or extracts, the file and pulls the value in like an HTTP `GET` (dynamic function paths supported), and `delete: true` is an idempotent file removal that passes the body through unchanged. The role follows from the operation keyword rather than a `mode` option; see the role-model entry above for the final shape.
- **CSV and JSONL decode transformers** -- calling `csv()` or `jsonl()` with no `path` now returns a transformer that parses a CSV / JSONL string already in the body (for example an `http()` response), matching the existing `json()` and `html()` decode transformers. Adds `CsvTransformerOptions`, `CsvFileOptions`, and `JsonlTransformerOptions`; `csv()`'s `path` is now optional. A dynamic (function) path used as a destination now works for `html()` too, where it previously threw at construction.
- **`xml` adapter** -- read, write and transform XML through a plain-object representation, mirroring the `json` and `csv` codec adapters. Works as a transformer (parse an XML string already in the body), a source (read and parse a file), an enricher (pull a parsed file in mid-route), a write destination and a delete destination. Malformed XML surfaces as an observable per-exchange `RC5016` failure honouring `onParseError` (`fail` / `abort` / `drop`). `fast-xml-parser` loads as an optional peer through `loadOptionalPeer` and is bundled by the CLI.
- **`directory` source adapter** -- `directory({ path })` scans a directory and lists its entries, each a `DirectoryEntry` carrying `path`, `name`, `ext`, `relativePath`, `size`, `modifiedAt`, `createdAt` and `isDirectory`. It emits a single exchange with the full listing by default; `chunked: true` emits one exchange per entry, matching the `csv` and `jsonl` convention. Supports `recursive` and `includeDirs`, lists files only by default, and orders entries deterministically by relative path. Filtering is left to the normal operations so you can narrow by metadata or name and then read content with the `file` adapter. Entries that vanish mid-scan and broken symlinks are skipped with a debug log, other unreadable entries with a warning, and a missing or unreadable directory throws.
- **CSV appends no longer splice records together** -- an append now terminates its chunk with a newline, where repeated `.to(csv({ append: true }))` writes previously produced `a,bc,d` from `a,b` and `c,d`, and appends are serialised per path so concurrent writes can no longer both emit the header.
- **Signed webhooks on the `http()` source** -- `http({ rawBody: true })` attaches the exact wire bytes as `routecraft.http.rawBody` (a `Uint8Array`) so any signature scheme can be verified in a route step, and `http({ signature: { header, secret, scheme, prefix?, toleranceSec? } })` verifies those bytes before the route runs, covering `hmac-sha256-hex` (GitHub-style, optional prefix), `hmac-sha1-hex` (legacy) and `stripe-timestamped` (`t=...,v1=...` with freshness checking). Failing requests return `401` with a bounded reason, raise `RC5039` and emit `auth:rejected` with `scheme: "signature"`. Comparison is timing-safe, `signature` on a bodyless method fails at construction with `RC5003`, oversized bodies still `413` before any HMAC runs, and the gate is independent of the global `auth` middleware.

### Mail

- **Mail source envelope moves to headers** {% badge color="red" %}Breaking{% /badge %} -- `.from(mail(...))` now follows the payload-on-`body`, envelope-on-`headers` convention shared with the HTTP source. The exchange `body` is a `MailBody` (`{ text?, html?, attachments? }`) and the envelope (`from`, `to`, `cc`, `bcc`, `subject`, `date`, `messageId`, `replyTo`, `flags`, `sender`, `rawHeaders`) lands on `routecraft.mail.*` headers, declaration-merged into `RoutecraftHeaders` and exported on the `MailHeaders` key object. `.input({ body })` now validates against the message content alone. The fetch destination (`.enrich(mail(...))`) still returns `MailMessage[]` unchanged. New exported type `MailBody`.
- **Direct mail no longer misclassified as auto-forwarded** -- a single first-hop ARC seal (`i=1`, `cv=none`) added by the delivering MX is no longer read as forwarding, so DMARC-aligned direct mail stays `direct` / `verified` instead of `unverified`. Mailing-list and validated-forward classification are unchanged.
- **Connection recovery covers every failure path, and is configurable** -- IDLE-mode fetch failures and the initial connect at route start now go through the same reconnect-with-backoff loop as IDLE drops and poll fetch failures (previously they killed the route), and the folder is drained right after a reconnect so mail that arrived during an outage is delivered immediately. New `reconnect: { maxAttempts?, baseDelayMs?, maxDelayMs? } | false` option on `MailServerOptions` (defaults match the old hardcoded 30 / 1s / 60s; `maxAttempts: Infinity` never gives up; `false` fails fast). Because the initial connect retries, the source signals readiness before the first connection succeeds, so `route:started` no longer guarantees the mailbox was reachable. New exported type `MailReconnectOptions`. When any source gives up for good, the new core `route:source:failed` event fires with `{ routeId, route, adapter?, error }` so a dead channel can be alarmed on ([#425](https://github.com/routecraftjs/routecraft/issues/425)).
- **Threading and custom headers on the send payload** -- `inReplyTo` (which seeds `References` too), `references` and `headers`, so agent replies stitch into the original email thread.
- **IMAP operations report their metadata again** -- `move` / `copy` / `delete` / `flag` / `unflag` / `append` lost their metadata when the role model split the observability hooks; the adapter's hook is renamed `getSendMetadata` to match the slot the step resolves.

### Packages {% badge color="red" %}Breaking{% /badge %}

- **`agentBrowser()` moves to `@routecraft/os`** -- browser automation folds into `@routecraft/os` and the standalone `@routecraft/browser` package is deprecated. Update imports; the factory, options and result shape are unchanged.

### Docs site

- **Blog at [/blog](/blog)** -- Markdoc-backed posts with a featured + latest layout.
- **Cheat sheet at [/cheat-sheet](/cheat-sheet)** -- searchable single-page DSL reference, print-to-PDF friendly.
- **[0.5.x to 0.6.0 migration guide](/docs/migrating/0.5-to-0.6)** -- step-by-step upgrade notes for every breaking change above.

---

## [v0.5.0](https://github.com/routecraftjs/routecraft/releases/tag/v0.5.0) {% badge color="yellow" %}Pre-release{% /badge %}

*May 2026*

Several breaking changes across the core, AI, mail, telemetry, logger, and CLI surfaces. See the [0.4.x to 0.5.0 migration guide](/docs/migrating/0.4-to-0.5) for the full public-API diff and step-by-step upgrade notes.

### Core

- **Dual-mode wrapper pattern** -- `.error()` becomes a route-level wrapper rather than a top-level method, and source-level parse errors flow through the same handler.
- **Immutable Exchange** -- the `Exchange` is frozen with explicit copy-on-write; state is unified on `{ body, headers }`.
- **`.authorize()` route-entry guard** -- a route-only authorization validator that replaces `requirePrincipal` and raises `RC5020` when a credential expires mid-run.
- **Field-shaping helpers `keep` and `mask`** -- two `.transform()` helpers: `keep` is grant-based, fail-closed allowlisting; `mask` obfuscates values regardless of caller.
- **Choice operation** -- a conditional routing primitive with `transform()` and `enrich()` on branch builders.
- **Discovery metadata on the route builder** -- route id, description, and validation move from source options to the builder.

### AI & MCP {% badge color="red" %}Breaking{% /badge %}

- **Agent runtime** -- tool-calling loop, streaming via `onEvent` / `onDelta`, agent destination, and per-binding tool description overrides.
- **`tools()` DSL** -- declarative tool registration, selection, and resolution.
- **Agent configuration overhaul** -- `agentPlugin.agents` is a record (no `defineAgent`), and `system` / `user` accept a string or function. See the [migration guide](/docs/migrating/0.4-to-0.5).
- **MCP OAuth 2.1 server** -- OAuth 2.1 provider with principal hierarchy, plus a general MCP HTTP auth surface and tool annotations.
- **MCP protected-resource metadata** -- resource identity moves to `mcpPlugin({ title, resource })`; both validator and OAuth-proxy modes auto-mount RFC 9728 metadata. Field-by-field moves are in the [migration guide](/docs/migrating/0.4-to-0.5).
- **Plugin-level `userinfo` enrichment** -- `mcpPlugin({ userinfo })` hydrates the principal after verification, enabling the WorkOS AuthKit pattern. Lives on the plugin, orthogonal to the auth mode.
- **`ClaimMappers.{email,name,roles}` removed** -- superseded by `userinfo` enrichment; the token-level mappers remain.
- **New error codes `RC5020`-`RC5022`** -- token expired during processing, principal enrichment failed, and userinfo `sub` invariant violated.

### Adapters

- **Adapter mocking** -- `mockAdapter` swaps any tagged adapter in tests; the `file`, `csv`, `json`, `jsonl`, and `html` factories are tagged out of the box.
- **`direct<TIn, TOut>()` distinct types** -- a route can accept one body shape and emit another.
- **Mail (IMAP) reliability** -- reconnect on transient fetch failures, a reshaped `MailMessage` body, and a verify-sender option.
- **Optional peer loader everywhere** -- every optional-peer import now routes through `loadOptionalPeer` and emits `RC5017` with an install hint.

### Telemetry {% badge color="red" %}Breaking{% /badge %}

- **Bun-only SQLite sink** -- the built-in telemetry sink uses `bun:sqlite`; `better-sqlite3` is removed. Node deployments that relied on it must bring their own sink.

### Logger

- **stdout default** -- the logger writes to stdout instead of stderr.

### CLI & Tooling

- **Bun-only `craft` CLI** -- the published binary now requires Bun >= 1.1.0.
- **Bun monorepo** -- installs, scripts, and lockfile migrate from pnpm to Bun.
- **`create-routecraft` refactor** -- scaffolder extracted into a library with expanded test coverage.
- **`bun:test` everywhere** -- the internal suite migrates off vitest, retained only for the cross-runtime tests.

### Docs

- **Migration guide** -- new [0.4.x to 0.5.0 migration guide](/docs/migrating/0.4-to-0.5).
- **Canary docs at `/next/`** -- canary builds deploy alongside the stable build at the root.
- **Operator reference** -- `log` and `debug` documented; `map` and `schema` clarified.
- **Claude Code skills** -- Agent Skills for authoring adapters and capabilities bundled at the repo root.

---

## [v0.4.0](https://github.com/routecraftjs/routecraft/releases/tag/v0.4.0) {% badge color="yellow" %}Pre-release{% /badge %}

*March 2026*

### Adapters

- **Cron source** -- new adapter for scheduling capabilities with cron expressions.
- **JSONL adapter and chunked mode** -- read and write line-delimited JSON with chunked streaming for large files.
- **Modular adapter structure** -- adapters refactored into a consistent file layout with a unified DSL registration system.
- **Merged options** -- `cron` and `direct` adapters now support merged options across config and route.

### AI & MCP

- **stdio MCP client** -- spawn and manage stdio-based MCP servers with a unified tool registry.
- **Bearer token authentication** -- secure MCP HTTP transport with bearer tokens.

### Framework

- **Terminal UI** -- new TUI for inspecting running contexts and routes.
- **Reduced public API surface** -- internal-only exports are no longer published, tightening the long-term API contract.

### TypeScript

- **Declaration-merging registries** -- compile-time adapter safety via type registries that adapter packages can extend.

### Testing

- **Spy adapter assertions** -- richer assertion helpers in `@routecraft/testing` for spying on capability output.

### Docs

- **Light mode** -- hero section and syntax highlighting now respect light mode.
- **Copy-to-clipboard** -- code blocks gain a copy button.
- **Community resources** -- new section linking external content and contributors.
- **Dark-mode contrast** -- prose strong text is more readable on dark backgrounds.

---

## [v0.3.0](https://github.com/routecraftjs/routecraft/releases/tag/v0.3.0) {% badge color="yellow" %}Pre-release{% /badge %}

*March 2026*

### Adapters

- **Agent, embedding, and LLM adapters** -- new adapters for integrating AI agent workflows, embedding models, and large language models directly into capabilities.
- **HTTP adapter** -- first-class HTTP source and destination support.
- **Browser and HTML adapters** -- interact with web pages and parse HTML content.
- **JSON adapter** -- dedicated adapter for JSON data sources.
- **Grouping adapter** -- group messages by key before forwarding.
- **File adapter** -- read and write text, JSON, and CSV files with a unified adapter.

### AI & MCP

- **`@routecraft/testing` package** -- expanded testing utilities with MCP integration support.
- **Consistent adapter pattern** -- all adapters now follow a unified pattern for configuration, lifecycle, and error handling.

### Events

- **Hierarchical event model** -- new operation-level events with parent-child relationships, enabling fine-grained observability across capability execution.

### TypeScript

- **TypeScript support** -- author capabilities in TypeScript with full type inference and compile-time validation.

### Docs

- **Capability-centric terminology** -- all documentation renamed from "routes" to "capabilities" for consistency.
- **Advanced guides** -- new documentation covering advanced patterns, capability composition, and adapter authoring.

---

## [v0.2.0](https://github.com/routecraftjs/routecraft/releases/tag/v0.2.0) {% badge color="yellow" %}Pre-release{% /badge %}

*February 2026*

### AI & MCP

- **New `@routecraft/ai` package** -- MCP integration with full schema validation via Zod. Expose any capability as an MCP tool for Claude Desktop, Cursor, and other MCP clients.
- **MCP server support** -- run your capabilities as an MCP server with a single CLI command.
- **MCP client support** -- call external MCP servers from within a capability using the `mcpPlugin`.

### Adapters & Operations

- **`direct` adapter validation** -- improved validation and error messages for inter-capability communication.
- **`aggregate` operation** -- default aggregator now flattens arrays and combines scalars automatically.
- **`batch` operation** -- new ESLint rule (`batch-before-from`) enforces correct batch positioning at the route level.
- **`pseudo` adapter** -- new adapter for stubbing sources and destinations in tests and local development.

### Framework

- **Cross-instance identity** -- supports multiple package copies and `npx`-based installs resolving to the same context identity.
- **Logging configuration** -- enhanced logging setup with more control over levels and output format.

---

## [v0.1.1](https://github.com/routecraftjs/routecraft/releases/tag/v0.1.1) {% badge color="yellow" %}Pre-release{% /badge %}

*November 2025*

Quality-of-life improvements.

### Adapters

- **Custom log messages** -- adapters and operations now support custom log message overrides.
- **Fetch adapter** -- automatically parses JSON responses, no manual parsing needed.

### Framework

- **`.env.local` support** -- environment variables in `.env.local` are loaded automatically alongside `.env`.

### Tooling

- **`create-routecraft`** -- project scaffolding now supports example selection and template file configuration.
- **CodeSandbox** -- added online playground link in the installation docs for zero-install experimentation.

---

## [v0.1.0](https://github.com/routecraftjs/routecraft/releases/tag/v0.1.0) {% badge color="yellow" %}Pre-release{% /badge %}

*October 2025*

Initial release.

### Framework

- **Fluent DSL** -- `craft().from().to()` builder syntax for authoring capabilities.
- **Core operations** -- `transform`, `filter`, `enrich`, `aggregate`, `split`, `validate`, `tap`, `process`, `header`, and more.
- **Backpressure** -- simple and batch consumers with built-in backpressure support.
- **CraftContext** -- route lifecycle management with hot reload in development.
- **Error handling** -- structured RC error codes with Pino logging.

### Adapters

- **Built-in adapters** -- `simple`, `timer`, `direct`, `log`, `noop`, `fetch`.

### Tooling

- **CLI** -- `craft run` and `craft watch` commands.
- **`create-routecraft`** -- project scaffolding tool.
- **ESLint plugin** -- `require-named-route` rule out of the box.
- **Test utilities** -- `@routecraft/testing` package with `testContext` and `spy` adapter.