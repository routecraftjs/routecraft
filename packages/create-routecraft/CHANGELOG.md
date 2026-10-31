# create-routecraft

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

## 0.7.2

### Patch Changes

- [#858](https://github.com/routecraftjs/routecraft/pull/858) [`747f312`](https://github.com/routecraftjs/routecraft/commit/747f312a9d1cd8dfa4d16393476d38901cc8828c) Thanks [@ex0b1t](https://github.com/ex0b1t)! - A scaffolded project is agent-connected from the first run. Its `greet` capability stands behind `mcp()` as well as `direct()`, `craft.config.ts` serves MCP over stdio, `@routecraft/ai` and `@modelcontextprotocol/server` (`^2.0.0`) are dependencies, and the README shows how Claude Code, Cursor and VS Code connect to it and call the tool. `bun run start` still logs the greeting, and the capability's test mocks the `mcp()` source so it starts no transport.

  `@routecraft/ai`'s peer range on `@routecraft/routecraft` is now `>=0.7.2-0 <1.0.0`, so `@routecraft/ai` 0.7.2 needs core 0.7.2 or later.

- [#858](https://github.com/routecraftjs/routecraft/pull/858) [`747f312`](https://github.com/routecraftjs/routecraft/commit/747f312a9d1cd8dfa4d16393476d38901cc8828c) Thanks [@ex0b1t](https://github.com/ex0b1t)! - The scaffolder now pins each `@routecraft/*` package at that package's own version instead of the scaffolder's. Only the core train shares one number; `@routecraft/ai` and `@routecraft/os` version independently, so 0.7.1 asked for `@routecraft/os@^0.7.1`, a release that does not exist, and every scaffold of an example using `@routecraft/os` (craft-harness among them) failed to install. The versions are captured when the scaffolder is built, so they are the ones it was released with.

## 0.7.1

### Patch Changes

- [#833](https://github.com/routecraftjs/routecraft/pull/833) [`ea96e05`](https://github.com/routecraftjs/routecraft/commit/ea96e05a00a69a754b9e8257f70fdac43760ebbb) Thanks [@ex0b1t](https://github.com/ex0b1t)! - A scaffolded project lists `@routecraft/cli` under `dependencies` rather than `devDependencies`. `craft start` is how the project runs in production, so `bun install --production` left an image without the `craft` binary it starts with. When an example repository lists the CLI as a dev dependency, the runtime entry wins and it is declared once. A project scaffolded earlier moves the entry itself: `bun remove @routecraft/cli && bun add @routecraft/cli`, or move the line from `devDependencies` to `dependencies` in `package.json` and run `bun install`. A bare `bun add` keeps an entry in the group it is already in.

- [#839](https://github.com/routecraftjs/routecraft/pull/839) [`df7f018`](https://github.com/routecraftjs/routecraft/commit/df7f018770e1fe669b68189f630d4873cc1e1545) Thanks [@ex0b1t](https://github.com/ex0b1t)! - A Bun project now scaffolds with a production `Dockerfile` and `.dockerignore`. The image runs on the distroless Bun image as the unprivileged `nonroot` user, pins the Bun version the project pins, and keeps `.env` files out of the build context. It is the image Routecraft's own CI scans on every change, and it passes the container scans enterprise registries run where the `oven/bun:1-slim` image the deployment guide used to suggest carried critical OS vulnerabilities.

- [#829](https://github.com/routecraftjs/routecraft/pull/829) [`62503d5`](https://github.com/routecraftjs/routecraft/commit/62503d5db7ad1c6ae8e5d860a6db3541418ad532) Thanks [@ex0b1t](https://github.com/ex0b1t)! - A scaffolded project's `start` script shows its sample greeting again. 0.7.0 moved the script to `craft start` at the default `warn` level, so the greeting the README promises, logged at `info`, never appeared. The script is now `craft start --log-level info`, as it was in 0.6.

## 0.7.0

### Minor Changes

- [#787](https://github.com/routecraftjs/routecraft/pull/787) [`5dcc38a`](https://github.com/routecraftjs/routecraft/commit/5dcc38a7d0e0216158c261395c983491543cb79d) Thanks [@claude](https://github.com/apps/claude)! - One template, laid out for `craft start`, and CI runs the scaffold's own tests ([#776](https://github.com/routecraftjs/routecraft/issues/776)).

  `bunx create-routecraft my-app` now always scaffolds the same project: a sample capability under `capabilities/`, a README naming what was made, and `start` wired to `craft start`. The `none` / `hello-world` choice is gone, and with it `index.ts`, `index-empty.ts`, `index-with-example.ts`, `templates/examples/` and the per-example `deps.json`.

  **The default used to be an empty project.** `--yes` and the first entry of the prompt both resolved to `none`, which wrote `export default []` and then printed `bun run start` as the next step. That command booted a context with zero routes and exited. A new user's first command produced nothing, and there was no README to say what to do instead.

  **It also taught the pre-0.7 model.** `start` was `craft --log-level info run index.ts` with routes wired by hand, while the example already sat at `capabilities/hello-world/route.ts`, which `craft start` discovers on its own. The template contradicted the project-structure docs and craft-harness both.

  ```
  before (--yes)            after
    index.ts                  capabilities/hello-world/route.ts
    craft.config.ts           capabilities/hello-world/route.bun.test.ts
    package.json              capabilities/hello-world/README.md
    ...                       craft.config.ts
                              README.md
    start: craft --log-level info run index.ts
                              package.json
                              ...
                            start: craft start
  ```

  **The scaffolded test failed, and CI could not see it.** The template's own `route.bun.test.ts` asserted `expect(t.logger.info).toHaveBeenCalled()` against `testContext()`, whose spy is runner-agnostic rather than a `bun:test` mock, so `bun run test` failed on a freshly scaffolded project. It shipped because the integration suite only ever installed and type-checked a scaffold. It now runs the scaffold's own test script, which is the gate that would have caught it.

  **`--example <url>` replaces the template rather than adding to it.** A repository is a whole project, so the sample capability and the project README are not written at all when one is given. Previously the sample capability did not exist to collide; now it would have been left standing inside somebody else's harness.

  `adapters/` and `plugins/` are no longer created. Git cannot carry an empty directory, so they vanished on the author's first commit; the README names the convention instead.

  **Also fixed:** `processTemplate` replaces the longest placeholder first. `PACKAGE_MANAGER` is a prefix of `PACKAGE_MANAGER_RUN`, and object key order decided which won, leaving `bun@1.3.9_RUN` in the output. It throws nowhere and is only ever noticed by a reader.

- [#699](https://github.com/routecraftjs/routecraft/pull/699) [`3f64e8c`](https://github.com/routecraftjs/routecraft/commit/3f64e8c71452b0b4357a920ab2f4073d15e1f9f0) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Scaffolding from a repository keeps the files it copies, and deferred agent threads can be rewritten in place.

  **The scaffolder no longer loses files ([#653](https://github.com/routecraftjs/routecraft/issues/653)).** A built-in example copied with `force: false` and no `errorOnExist`, so an example file landing where the base template already wrote one vanished with nothing in the output to say so. The collisions are now walked before the copy and named afterwards.

  **A URL example's `package.json` is merged, not overwritten.** It used to replace the base manifest outright, which threw away the project name the user had just typed and the package manager they picked, and meant `mergeExampleDeps` never ran on that path at all. The template still wins on everything it declares; `name` and `packageManager` stay with the scaffold, and the three dependency maps plus `scripts` merge key by key.

  **A `/tree/<branch>` URL no longer needs a subpath.** The pattern demanded one, so a whole repository at a named branch was unexpressible and a template repository could not scaffold from the branch under test in its own CI. The parser is now `parseGitHubExampleUrl`, exported and tested on its own. A branch is still one path segment: `feature/my-branch` parses as branch `feature` with subpath `my-branch`, because nothing in the URL says which slash is the boundary, and the JSDoc now says so instead of claiming multi-segment support the pattern never had.

  **The copy filter matches path segments.** It matched substrings, so `.gitignore` and every file under `.github/` were dropped along with the `.git` directory they were never aimed at, and a capability folder named `pnpm-lock.yaml-parser` went with the lockfile. `bun.lock` and `bun.lockb` join the lockfiles that are deliberately excluded.

  **Breaking (0.x, so `minor`): `DeferralStore` gains a required `replaceStepState` member.** A custom store implementation has to add it; the two shipped backends already have it, so a deployment that uses `memory` or `sqlite` is unaffected.

  **`DeferralStore.replaceStepState`** compare-and-swaps the opaque `stepState` slot of a record that is still `deferred`, leaving every other field alone. It is the one write that edits a deferred record in place rather than settling it, and it exists for compaction: a thread that has outgrown the model's context window can only be shrunk while the exchange stays deferred. The compare is a `stepStateFingerprint` of the state the caller read, so two rewrites of the same read produce one winner, and the swap only matches a still-deferred row, so a resume that got there first wins outright. Both shipped backends implement it, and the cross-runtime suite proves they agree.

  **`replaceDeferredThread` and `assertResumableThread`** (`@routecraft/ai`) put an agent's thread through that swap safely. A rewrite that breaks tool-call / tool-result pairing, duplicates a call id, empties the thread, or drops the deferred call the approver's answer lands on is refused with **`AI1008`** before the store is touched, so a failed compaction costs nothing and the run resumes uncompacted.

  **`AI1009`** separates "the prompt does not fit the model's context window" from every other dispatch failure. The two need opposite reactions and no shared status code distinguishes them; the classifier reads OpenAI's `context_length_exceeded` where there is one and matches the phrasings Anthropic, Google and the local runtimes actually emit otherwise. Every other failure is rethrown untouched, with its retryability intact.

- [#788](https://github.com/routecraftjs/routecraft/pull/788) [`b2f8e48`](https://github.com/routecraftjs/routecraft/commit/b2f8e48e1e59befc935d7b91b121d250a67af11a) Thanks [@claude](https://github.com/apps/claude)! - Scaffolding from a repository resolves the ref, keeps one routecraft version, and leaves the template's CI behind ([#777](https://github.com/routecraftjs/routecraft/issues/777)).

  Three defects on the `--example <url>` path, all found by using it.

  **A ref whose name contains a slash could not be scaffolded from.** `parseGitHubExampleUrl` took one path segment as the branch and the rest as a subpath, so `/tree/claude/my-branch` cloned branch `claude` and looked for `my-branch/` inside it. Every `feat/*`, `fix/*` and `claude/*` branch failed, and the README documented it as unresolvable.

  It is resolvable, and the remote answers it. The scaffolder now asks `git ls-remote --heads --tags` before cloning and takes the longest ref that prefixes the remainder. That is exact rather than a heuristic: git stores refs as a directory tree, so `refs/heads/claude` and `refs/heads/claude/foo` cannot both exist, and at most one ref can prefix any remainder. It is also what GitHub does when it renders a `/tree/` URL.

  ```bash
  # worked before and still does
  --example https://github.com/you/repo
  --example https://github.com/you/repo/tree/main/examples/api
  --example https://github.com/you/repo/tree/v1.2.0

  # refused before, works now
  --example https://github.com/you/repo/tree/feature/login
  ```

  A plain repository URL now takes the repository's default branch instead of assuming `main`, so a repository whose default is `master` or `trunk` scaffolds too. A miss names the branches and tags that do exist, bounded, rather than suggesting the repository might not be public when it just answered with its ref list.

  **An example's routecraft pins overrode the version you asked for.** The manifest merge let the example win, so `create-routecraft@canary` against a template pinning an older canary installed that older canary, and `@routecraft/os` came out eight days behind the rest of a train the changeset config versions in lockstep. Every `@routecraft/*` entry now takes this scaffolder's own version, whatever the template pins. Everything else the template declares is still its own choice.

  **`.github/workflows` is no longer copied.** A template's CI tests that template against its own branches and secrets. Copied into a new project it either fails on the first push or is guarded into never running and sits there as config nobody wrote. Excluded by path prefix rather than by segment name, so a capability folder called `workflows/` survives.

## 0.6.0

### Patch Changes

- [#560](https://github.com/routecraftjs/routecraft/pull/560) [`4c7cbfa`](https://github.com/routecraftjs/routecraft/commit/4c7cbfab2146dbc9625649b40ffe9d6b72e734b3) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Raise the `@inquirer/prompts` dependency floor to `^8.5.2`.
