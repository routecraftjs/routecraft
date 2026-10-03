---
"@routecraft/routecraft": minor
"@routecraft/ai": minor
"@routecraft/os": minor
"@routecraft/cli": minor
"@routecraft/testing": minor
"create-routecraft": minor
---

Plugins become the one way to extend Routecraft, and the framework's own features are built the same way (`.standards/plugin-architecture.md`).

- **A plugin is a descriptor.** `definePlugin({ id, requires, optional, provides, replaces, hooks, points, steps, facet, installs, repeatable, bind, start, stop })`. The kernel installs plugins in dependency order, binds each, freezes the application, compiles every route, starts, and stops in reverse with each plugin's disposers. A plugin receives a `PluginContext` (ports, events, `onDispose`, `routes`, `execution`, `logger`), never the `CraftContext`. Faults that name the plugin responsible are `RC1101` to `RC1116`, raised before any plugin binds where they can be.
- **Ports.** `port<T>("owner.capability@1")` is how plugins share anything; `c.require` / `c.lookup` / `c.provide`, and `context.require` / `context.lookup` for adapters at runtime. Store keys remain for state private to one module.
- **The chain is fixed and its positions are filled through ports.** `.authorize()`, `.throttle()`, `.circuitBreaker()`, `.retry()`, `.timeout()`, `.concurrency()` and `.cache()` are unchanged on the builder; the default plugins (`routecraft.resilience`, `routecraft.cache`, `routecraft.auth`) fill them through `RESILIENCE`, `CACHE` and `ENFORCEMENT`, and a plugin may `replace` one. A configured position with no provider is `RC1111` and the application does not start.
- **Hooks in named slots.** `beforeAuth`, `afterAuth`, `admitted`, `perAttempt`, `exit` and `error`, each with the phases observe, mutate (returns a header and body patch) and validate (`refuse(reason)`, which is `RC5068`). Order within a phase follows the plugin list; `hooks.order` and `hooks.disable` in config settle conflicts, and two hooks writing one header warn. Plugins may declare their own points and invoke them from their steps.
- **Typed plugin steps and `defineProject`.** A plugin's `steps` become builder methods, typed by `step<In, Out>()` (with the `Body` placeholder, and `StepMethods` for methods generic at the call site). `defineProject({ plugins, ...config })` returns `{ craft, config, plugins }`; its `craft()` is typed by exactly the installed plugins, so a step or facet of an uninstalled plugin is a compile error. `craft.config.ts` default-exports it; a plain config still loads.
- **Facets.** A plugin's facet is `ex.<namespace>`, computed on every read.
- **Principals.** The default `routecraft.principals` plugin provides `AUTHORITY`; every mint and trust check goes through the application's authority.
- **Continuations.** The kernel owns park, resume and sweep; the deferral plugin provides `CONTINUATIONS` and drives the sweep through `execution.sweep()`.
- **Agents.** `agentPlugin()` installs are repeatable contributions to one agent runtime that provides `AGENTS`; `SESSION_STORE` and `MCP` are ports.
- **Faster types.** A full typecheck of the monorepo dropped from about a minute to under ten seconds, and `test/type-budget.bun.test.ts` pins the cost of ten plugins.

**Breaking:**

- `CraftPlugin`, `apply(ctx)` and `teardown(ctx, info)` are removed: declare an `id` and move `apply` into `bind(c)`, `teardown` into `stop(c, info)`. A plugin still shaped with `apply` is refused with `RC9901` naming the change. The lifecycle events `plugin:applying` / `plugin:applied` are `plugin:binding` / `plugin:bound`.
- `ex.principal` is `ex.auth.principal` in route callables; library code reads `principalOf(exchange)`. `exchange.deferral` outside route callables is `deferralOf(exchange)`.
- `registerDsl` and augmenting `StepBuilderBase` are removed; declare `steps` on a plugin.
- `RouteDefinition`'s chain fields carry configuration; `preParseFilters`, `postParseFilters` and `postFromFilters` are gone.
- Store keys that crossed plugins are ports: `OPS_HEALTH_STATE` / `OPS_RESOURCES` (use `OPS`), `DIRECT_DEFAULTS` and the direct capability keys (use `DIRECT`), `ADAPTER_AGENT_REGISTRY`, `ADAPTER_FN_REGISTRY`, `ADAPTER_AGENT_DEFAULT_OPTIONS` and the MCP keys (use `AGENTS`, `MCP`), `DEFERRAL_RUNTIME` (use `CONTINUATIONS`), `CARDDAV_CLIENT_MANAGER` (use `CARDDAV`).
- `CraftConfig.plugins` is a readonly array, and default plugins are installed ahead of the application's own, so a lifecycle event's `pluginIndex` counts them.
