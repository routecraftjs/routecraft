# @routecraft/os

## 0.8.0

### Minor Changes

- [#869](https://github.com/routecraftjs/routecraft/pull/869) [`70410b3`](https://github.com/routecraftjs/routecraft/commit/70410b33f162da8bacaa9517d2ba4dc6195752fe) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Plugins become the one way to extend Routecraft, and the framework's own features are built the same way (`.standards/plugin-architecture.md`).

  - **A plugin is a descriptor.** `definePlugin({ id, requires, optional, provides, replaces, hooks, points, steps, facet, installs, repeatable, bind, start, stop })`. The kernel installs plugins in dependency order, binds each, freezes the application, compiles every route, starts, and stops in reverse with each plugin's disposers. A plugin receives a `PluginContext` (ports, events, `onDispose`, `routes`, `execution`, `logger`), never the `CraftContext`. Faults that name the plugin responsible are `RC1101` to `RC1117`, raised before any plugin binds where they can be.
  - **Ports.** `port<T>("owner.capability@1")` is how plugins share anything, and a plugin that `replaces` one is named at boot (at warn for `AUTHORITY` and `ENFORCEMENT`); `c.require` / `c.lookup` / `c.provide`, and `context.require` / `context.lookup` for adapters at runtime. Store keys remain for state private to one module.
  - **The chain is fixed and its positions are filled through ports.** `.authorize()`, `.throttle()`, `.circuitBreaker()`, `.retry()`, `.timeout()`, `.concurrency()` and `.cache()` are unchanged on the builder; the default plugins (`routecraft.resilience`, `routecraft.cache`, `routecraft.auth`) fill them through `RESILIENCE`, `CACHE` and `ENFORCEMENT`, and a plugin may `replace` one. The same methods placed after `.from()` wrap one step and resolve the same provider at run time (`scope: "step"` on the run), so a replacement fills both scopes. A configured position with no provider is `RC1111` and the application does not start, at route scope and at step scope alike: a wrapper after `.from()` is checked when its route starts, nested branches included, and resolves its position on the first exchange.
  - **Hooks in named slots.** `beforeAuth`, `afterAuth`, `admitted`, `perAttempt`, `exit` and `error`, each with the phases observe, mutate (returns a header and body patch) and validate (`refuse(reason, { kind })`, which is `RC5068`; a door answers the caller with the kind and the reason: the http doors with the status the kind maps to, the MCP server with a tool error, the ACP mount with `-32602` or `-32001`). Every hook declares an `id`, which is what `hooks.order` and `hooks.disable` address as `pluginId/id`; a hook without one is `RC1117`. Order within a phase follows the plugin list; `hooks.order` and `hooks.disable` in config settle conflicts, and two hooks writing one header warn. Plugins may declare their own points and invoke them from their steps; another plugin's hooks at a point go under `hooks.points`. A mutate hook may not write an engine-owned header (`RC1115`). An admission resume runs `afterAuth` and `admitted` around the `authorize` it re-runs, so a post-authorize policy hook guards an exchange admitted through a step-up.
  - **Error-path parks are validated.** `.error(handler, { schema })` at route scope and an error hook's `schema` declare what a resume payload must satisfy when that handler parks with `recovery.defer(request)`; the resume door reads the schema back live and validates against it (`RC5049`), and a schema that changed under a parked exchange refuses the resume (`RC5048`). The `request` takes no `schema`. A door that dispatched the ingress route answers a rejected payload as the submitter's input error, the way it answers the route's own `.input()` refusal.
  - **A plugin step's definition is part of its fingerprint.** `.withTax(0.1)` and `.withTax(0.2)` hash apart for the route-scope cache and for a continuation, as adapter arguments already did, and so do two `step(fn)` callbacks with different source when the callback is in the continuation tail: a redeploy that changes that callback refuses the resume with `RC5048`. Every `step(fn)` digest changes with this release, so a continuation parked under an earlier build does not resume. The digest reads the callback's source and never its closures, so a value that changes what the step does belongs in the factory arguments or on the adapter, where it is digested.
  - **Two copies of the package resolve as one port, and one copy is the supported configuration.** A port's key is the registered symbol for its name, so the ESM and CJS builds of one install, or a global CLI beside a project's own copy, share every port; a shape change ships under a new version segment. A token carrying a port's name under another key is `RC1103`. The bindings a door trusts for a refusal are module-local, so a refusal raised by one copy is answered by a door of the other as a plain failure; the context warns at build when more than one copy is loaded.
  - **Shutdown has one owner.** A build that fails while a bind's `c.execution.requestStop()` already has a shutdown in flight joins it, and a `context:stopping` observer that calls `stop()` joins it too, so a plugin's `stop` and its disposers run once however many exits reach them.
  - **An outcome the engine cannot schedule is `RC5032`.** A step that resolves a kind this build does not know, or nothing at all, fails the exchange naming the step and the kind, instead of answering the caller with the input and skipping the rest of the route.
  - **The default cache is the application's.** The default `CACHE` plugin keeps one in-memory provider per context, so two applications in one process running one route id over one body never serve each other's entries. `ResolvedCacheOptions.provider` is `undefined` when the call site supplied none; a `CACHE` provider settles it with `bindCacheProvider(options, fallback)`, and `cacheProvider(fallback)` builds the framework's positions over a provider of your choice.
  - **A claimed continuation queues at a step-scope bulkhead.** The executor hands a resumed exchange a `StepContext` with `mustWait`, so `.concurrency({ mode: "reject" })` after `.from()` queues it for a slot the way the route-scope bulkhead does, instead of spending the approval on a refusal.
  - **Two bundles bringing different descriptors under one single id is `RC1101`** unless the application lists that id as a single plugin and chooses (repeatable descriptors under one id each install, numbered); one descriptor brought by two bundles still installs once. The order a repeatable plugin takes ahead of the readers of its ports never closes a cycle: a contributor that already reaches a reader binds after it.
  - **Hooks run in the order the application lists the plugins.** A dependency reorders binding and never a phase; `hooks.order` still settles a phase explicitly.
  - **One HTTP plugin descriptor serves two applications.** Mount tables and unmounts are per `PluginContext`, so a descriptor reused across contexts never hands one listener the other's routes or lets one stop tear the other down.
  - **The route view a plugin reads is read-only down the graph.** `c.routes.get(id).definition` refuses a write (`RC1110`), at the type (`RouteDefinitionView`) and at runtime.
  - **Structural steps are a public protocol.** `NESTED_STEPS`, `NestedSteps` and `NestingStep` are exported: a raw step that runs steps of its own reports them, so the plugin-ownership check, the positions, the continuation digest and `.defer()` see inside it.
  - **The guards that keep a caller out are structural.** The cache-versus-authenticate guard reads the `AUTHENTICATES` mark (a registered symbol every authenticating step carries, exported for yours) and a validate hook's refusal is read by its registered brand, so the package's other build (ESM beside CJS) cannot slip past either; `bun scripts/verify-dist.mjs mixed` holds both against the shipped artifacts.
  - **An `ENFORCEMENT` replacement can refuse the caller itself.** `authorizationRefusal(exchange, error)` binds a refusal to the exchange it refuses, the way the shipped gate does, so a door answers the caller instead of reporting a server fault.
  - **The kernel refuses more at install and at start.** A port provided twice or as `undefined` is `RC1109`; a hook name used in two slots of one plugin, or an unknown run kind, is `RC1112` / `RC1115`; a plugin step named `then` or `toJSON` is `RC1116`; a plugin id holding `/`, `#` or whitespace is `RC1117`; a position provider missing the member a route needs is `RC1111` naming the plugin, at both scopes, instead of a `TypeError` at the first exchange; an error hook answering `recovery.defer()` without `mayDefer: true` is `RC1115` and the park is reported, never silent; a `bind` or `start` hook awaiting `c.execution.whenStarted()` is `RC1118` instead of a hang.
  - **A cached value is copied, never shared.** The bundled `MemoryCacheProvider` keeps a structured clone of what it stores and hands every reader its own clone, concurrent waiters included, so an exchange that changes a body it received never changes what the next hit reads; a value a copy cannot carry is refused (`RC5028`) rather than shared by reference.
  - **`PortLookup`** names what a port is looked up on (a plugin context or a context), for helpers that take either.
  - **Typed plugin steps and `defineProject`.** A plugin's `steps` become builder methods, typed by `step<In, Out>()` (with the `Body` placeholder, and `StepMethods` for methods generic at the call site). `defineProject({ plugins, ...config })` returns `{ craft, config, plugins }`; its `craft()` is typed by exactly the installed plugins, so a step or facet of an uninstalled plugin is a compile error. `craft.config.ts` default-exports it; a plain config still loads.
  - **Facets.** A plugin's facet is `ex.<namespace>`, computed on every read. Reading one in an application that does not install its plugin is `RC1111`.
  - **Principals.** The default `routecraft.principals` plugin provides `AUTHORITY`; every mint and trust check goes through the application's authority. `restrict-principal-minting` also flags an authority's `mint()` and `brand()`.
  - **Continuations.** The kernel owns park, resume and sweep; the deferral plugin provides `CONTINUATIONS` and drives the sweep through `execution.sweep()`.
  - **Agents.** `agentPlugin()` installs are repeatable contributions to one agent runtime that provides `AGENTS`; `SESSION_STORE` and `MCP` are ports. A repeatable plugin binds ahead of the other consumers of its ports, so `acpPlugin()` and the `acp` key serve every registered agent whatever the list order; a contribution after the application froze is `RC1110`.
  - **Faster types.** A full typecheck of the monorepo dropped from about a minute to under ten seconds, and `test/type-budget.bun.test.ts` pins the cost of ten plugins.

  **Breaking:**

  - `CraftPlugin`, `apply(ctx)` and `teardown(ctx, info)` are removed: declare an `id` and move `apply` into `bind(c)`, `teardown` into `stop(c, info)`. A plugin still shaped with `apply` is refused with `RC1117` naming the change. The lifecycle events `plugin:applying` / `plugin:applied` are `plugin:binding` / `plugin:bound`.
  - `ex.principal` is `ex.auth.principal` in route callables; library code reads `principalOf(exchange)`. `exchange.deferral` outside route callables is `deferralOf(exchange)`.
  - `registerDsl` and augmenting `StepBuilderBase` are removed; declare `steps` on a plugin.
  - `RouteDefinition`'s chain fields carry configuration; `preParseFilters`, `postParseFilters` and `postFromFilters` are gone.
  - Store keys that crossed plugins are ports: `OPS_HEALTH_STATE` / `OPS_RESOURCES` (use `OPS`), `DIRECT_DEFAULTS` and the direct capability keys (use `DIRECT`), `ADAPTER_AGENT_REGISTRY`, `ADAPTER_FN_REGISTRY`, `ADAPTER_AGENT_DEFAULT_OPTIONS` and the MCP keys (use `AGENTS`, `MCP`), `DEFERRAL_RUNTIME` (use `CONTINUATIONS`), `CARDDAV_CLIENT_MANAGER` (use `CARDDAV`).
  - `CraftConfig.plugins` is a readonly array, and default plugins are installed ahead of the application's own, so a lifecycle event's `pluginIndex` counts them.
  - `delegate(subject, actor, options, authority)` takes the authority (`authorityOf(exchange)`) instead of defaulting to the built-in one. `markAuthentic`, `isAuthentic`, `markRestored` and `isRestored` are no longer exported: brand and check through `authorityOf(exchangeOrContext)`, or `defaultAuthority` where no application is at hand. `restrict-principal-minting` flags `defaultAuthority.mint()` and `brand()` and no longer names `markAuthentic`.
  - `route:error-handler:*` events report an `error` slot hook with `scope: "slot"`, `recoveryStrategy: "error-slot-hook"` and `hook` (the `pluginId/hookId`) in place of `scope: "context"` and `handlerIndex`; `CraftContext.hasDeferringErrorHandler()` is `hasDeferringErrorHook()`.
  - `DeferralRuntime` (the `CONTINUATIONS` port) carries only what the kernel reads: `store`, `signer`, `defaultTtlMs`, `expiryLeaseMs`, `retentionMs` and `path`. `backend`, `ownsStore` and `sweepIntervalMs` stay with the deferral plugin, and `createDeferralRuntime()` returns `{ runtime, backend, ownsStore, sweepIntervalMs }`.
  - `McpService.local`, `stdio` and `clients` are read-only; a tool is served through `registerLocal(entry)`, which refuses a duplicate endpoint and returns the withdrawal. `AgentRegistry.resolvedFunctions` is `resolvedFunction(id)`.
  - `ResolvedCacheOptions` and `ResolvedConcurrencyOptions` are public: they are what a `CACHE` or `RESILIENCE` provider receives.
  - `PluginContext.execution.deliver()` resolves `unknown`; narrow the reply where you know its shape.
  - A second `llmPlugin()`, `embeddingPlugin()` or `shellPlugin()` in one application is `RC1101` rather than the last one silently winning.
  - `cacheProvider` is a function (`cacheProvider(fallback?)`) returning the framework's `CachePositions` over the given fallback; the internal `defaultMemoryCacheProvider` is gone. A plugin replacing `CACHE` receives `ResolvedCacheOptions` whose `provider` may be `undefined` and settles it with `bindCacheProvider`.

## 0.7.0

### Minor Changes

- [#718](https://github.com/routecraftjs/routecraft/pull/718) [`b7255b0`](https://github.com/routecraftjs/routecraft/commit/b7255b0d69a0dcd1b4b33965a9391d287f847bca) Thanks [@ex0b1t](https://github.com/ex0b1t)! - The `docker` isolation tier for `shell()` ([#715](https://github.com/routecraftjs/routecraft/issues/715), closing [#647](https://github.com/routecraftjs/routecraft/issues/647)): a throwaway container per command on a Docker Engine daemon, driven through `dockerode` as an optional peer, the only tier that contains the filesystem. `image` is required with no default and passed as one field, `mounts` declares the host paths exposed (absolute and in normal form, so a `..` from data cannot widen them) and nothing else is visible, `name` defaults to `rc-<routeId>-<exchangeId>` so a run can be found, network is denied unless granted, the command replaces the image's entrypoint rather than composing with it, `HOME` is a private tmpfs inside the container, the container is removed on exit, and no daemon is a loud `OS1001` naming the remedy. A host tier refuses the container options with `OS1004` rather than dropping them.

  On every tier, `timeout`, `env` and `stdin` now resolve per exchange. `stdin` is written and closed before the command reads, so a token that must appear in neither `docker inspect` nor the process list has a place to travel. The tier contract becomes a union of a host kind (`wrap`) and a container kind (`execute`), discriminated by `kind`.

  The isolation smoke in CI runs the docker tier's guarantees against the runner's daemon.

- [#667](https://github.com/routecraftjs/routecraft/pull/667) [`67189a4`](https://github.com/routecraftjs/routecraft/commit/67189a4036ec9462110b138996c517d89eb80262) Thanks [@ex0b1t](https://github.com/ex0b1t)! - `shell({ timeout })` and `shellPlugin({ timeout })` now take a `Duration`.

  Both were documented as "milliseconds before the command is killed" and typed as a
  bare `number`, which left `@routecraft/os` outside the framework-wide convention
  that every authored time option accepts `number | "30s"`.

  This is a widening, not a rename: the option was already correctly named, so every
  existing numeric value keeps working unchanged.

  ```ts
  shellPlugin({ timeout: 30_000 }); // still fine
  shellPlugin({ timeout: "30s" }); // now also fine
  ```

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

- [#445](https://github.com/routecraftjs/routecraft/pull/445) [`a382d0c`](https://github.com/routecraftjs/routecraft/commit/a382d0c517bc9ea6edcd2de739b4810b44853af6) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Fold browser automation into `@routecraft/os`. `agentBrowser()` now ships from `@routecraft/os` instead of the standalone `@routecraft/browser` package, which is deprecated. Update imports from `@routecraft/browser` to `@routecraft/os`; the factory, options, and result shape are unchanged.

### Patch Changes

- [#525](https://github.com/routecraftjs/routecraft/pull/525) [`f2b6e9f`](https://github.com/routecraftjs/routecraft/commit/f2b6e9f9ab533bf643a30ab99c92bc8662b66c92) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Complete the `loadOptionalPeer` migration for the remaining bespoke sites: the mcp server's `express` load and the `agentBrowser()` `agent-browser` load now surface a missing optional peer as `RC5017` with an install hint instead of a hand-rolled error, and no longer mislabel an installed-but-broken package as missing. The optional-peer contract test now scans all four code packages, exempting regular dependencies and required peers, with the mcp `streamableHttp` sub-export probe registered as the one sanctioned bespoke exception.
