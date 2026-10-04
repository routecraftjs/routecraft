# Plugin Architecture

Routecraft is a small kernel and a set of plugins. Every feature we ship is a
plugin that reaches the kernel through the same sockets a third party uses,
and no first-party package reaches the kernel through a path a third party
cannot. This standard is the contract that claim rests on: what the kernel
owns, what a plugin declares, how the route chain is ordered, and where every
first-party feature now lives.

The [plugins reference](../apps/routecraft.dev/app/content/docs/reference/plugins/index.mdx)
explains the model to a consumer. This standard says how it is built, and
records every migration decision the design left open.

---

## 1. The kernel and its boundary

The kernel lives in `packages/routecraft/src/kernel/`. It owns five things and
implements none of what plugs into them:

| The kernel owns | Where |
|---|---|
| Lifecycle: install, order, bind, freeze, start, stop | `kernel/host.ts`, driven by `CraftContext` |
| Resolution: every required port resolved to one provider | `kernel/host.ts` |
| Ordering: hooks placed in the slots of the fixed chain | `kernel/hooks.ts` |
| Execution: one exchange through a route | `pipeline/executor.ts` (unchanged home) |
| Continuation: how a parked exchange is written, claimed and resumed | `kernel/continuation/` |

The kernel never imports a plugin module. `test/kernel-boundary.bun.test.ts`
reads the direct import edges of `kernel/`, `pipeline/`, `context.ts`,
`route.ts`, `builder.ts`, `step-builder-base.ts`, `exchange.ts`, `project.ts`
and `config-applier.ts`, and fails on any edge into `plugins/`, `auth/` or
`adapters/direct/`. A new kernel file joins the check by living in one of
those places. Where the kernel needs a plugin's service, the contract lives in
the kernel and the plugin provides it: `kernel/direct.ts` declares `DIRECT`,
and a route forwards from an error handler through `DIRECT.send()`.

`CraftContext` stays the runtime host a route and an adapter run inside. It is
not handed to plugins.

## 2. A plugin

A plugin is a plain descriptor, built with `definePlugin()`:

| Field | Declares | Read |
|---|---|---|
| `id` | identity, dotted (`routecraft.deferral`, `acme.approvals`) | before anything binds |
| `namespace` | the prefix its strings live under; default: last id segment | before anything binds |
| `requires` | ports it cannot run without | resolution |
| `optional` | ports it uses when present | resolution |
| `provides` | ports it offers | resolution |
| `replaces` | ports whose default provider it displaces | resolution |
| `points` | moments it declares and invokes from its own steps | before anything binds |
| `facet` | `(exchange) => view`: `ex.<namespace>`, computed on every read | static |
| `steps` | step factories; each key becomes a builder method | static |
| `installs` | plugins it brings along: placed ahead of it, installed once per id, and never when the application lists that id itself | before anything binds |
| `repeatable` | several installs coexist (`id#1`, `id#2`, in list order); such a plugin contributes through another plugin's port and may not provide, replace, or declare hooks, points, steps or a facet | before anything binds |
| `hooks` | handlers and wrappers in the chain's slots, each with a phase | static, placed when routes compile |
| `keepsAlive` | the plugin owns a lifetime past the routes (a listener) | at completion |
| `bind(c)` | requires, provides, observes, registers routes | in dependency order |
| `start(c)` / `stop(c, info)` | acquires and releases what needs a running application | after routes start; reverse at stop |

`CraftPlugin` and its `apply` are removed. There is one plugin shape.

### The plugin context

`bind`, `start` and `stop` receive a `PluginContext`, never the `CraftContext`:

| Member | What it reaches |
|---|---|
| `require(port)` / `lookup(port)` | a declared port's provider; `require` throws, `lookup` answers `undefined` |
| `provide(port, value)` | in `bind` only, a port this plugin declared in `provides` |
| `observe(event, handler)` / `emit(event, details)` | the event bus |
| `onDispose(fn)` | released at stop, LIFO, every one run even when another throws; also when this plugin's own `bind` throws after registering it |
| `routes` | `register(...definitions)` in `bind`; `list()` and `get(id)` read views |
| `execution` | `deliver` (resolves `unknown`; the caller narrows), `resume`, `sweep`, `capabilities`, `whenStarted`, `requestStop` |
| `frozen` | true once the last `bind` returned; a provider collecting contributions through its port refuses later ones with `RC1110` |
| `logger`, `id`, `namespace` | |

**Adapters** keep their per-context state in `CraftContext.getStore()` /
`setStore()`; that is adapter memory, not a plugin contract. Whenever a plugin
offers something an adapter or another plugin uses, it is a port: the adapter
calls `context.require(PORT)` or `context.lookup(PORT)` at runtime. No store
key crosses a plugin boundary.

### Ports

`port<T>("name@version")` returns a token. Two different tokens with one name
in one application is `RC1103`, which is how two copies of a contract module in
one process are caught. A plugin requires a capability, never a plugin.

### Lifecycle

1. **Identity.** One plugin per id (`RC1101`), one per namespace (`RC1102`),
   one token per port name (`RC1103`).
2. **Resolution.** Every required port resolves to one provider (`RC1104`). Two
   providers neither of which declares `replaces` is `RC1105`, naming both. A
   `replaces` for a port the plugin does not also `provides`, or two plugins
   replacing one port, is `RC1106`.
3. **Order.** A topological sort over requires and optional edges; ties keep
   list order. A repeatable plugin also binds ahead of every other consumer of
   the ports it uses, so a plugin reading what was contributed (ACP building a
   route per registered agent) sees every contribution wherever it was listed.
   A cycle is `RC1107` with the edges.
4. **Bind**, in that order. `require` of an undeclared port is `RC1108`; a
   declared `provides` left unprovided after `bind`, or a `provide` of an
   undeclared port, is `RC1109`.
5. **Freeze.** Anything a plugin context is asked to accept after the last
   `bind` is `RC1110`.
6. **Compile.** Routes register; every hook is placed; a route that needs a
   port nobody provides is `RC1111`; a hook naming a slot or point that does
   not exist is `RC1112`.
7. **Start.** Routes start and signal readiness, then each plugin's `start`.
8. **Stop.** Reverse order, consumers before providers, failures aggregated.

The unwind, readiness and teardown guarantees of
[Plugin Lifecycle](./plugin-lifecycle.md) hold: a failed bind or start tears
down exactly what bound, in reverse, and the original error surfaces
unchanged. A start refused before any route runs (`RC1111`, `RC5052`) stops
the plugins bound at build, since its caller has no reason to.

Events: `plugin:binding`, `plugin:bound`, `plugin:starting`,
`plugin:started`, `plugin:stopping`, `plugin:stopped`, each carrying the
plugin's real `id`.

### Config keys

`registerConfigApplier(key, factory)` stays: a config key is how an
application installs a plugin with options in one line (`deferral: {}`,
`http: {...}`). The factory returns a plugin descriptor and is pure, because
`defineProject` and the application each call it. A key and an explicit
plugin with the same id is `RC1101`. A key whose plugin adds steps or a facet
merges its plugin type into `ConfigKeyPlugins` beside the applier, so a
project that sets the key is typed by it without naming the plugin.

### Default plugins

Installed in every application, ahead of its own plugins:
`routecraft.direct`, `routecraft.resilience`, `routecraft.cache`,
`routecraft.principals`, `routecraft.auth`. An application plugin with the
same id takes a default's place; a plugin that `replaces` a default's port is
selected over it. Each shipped plugin's module registers it once when the
package loads (`registerShippedPlugin(factory, { default })`, internal): the
id, steps and facet are read from the descriptor, so nothing restates them.
They are defaults because they are installed by default, not because the
kernel knows their names. The registry is module-local, so a second copy of
the package never installs its defaults into the first copy's applications.
Ahead, so the application's plugins keep their relative order: a plugin that
requires a default binds after it either way.

## 3. The chain

The chain around every route has a fixed order. Two kinds of place:

- A **position** belongs to the framework and holds one thing. A plugin may
  replace what fills it through the position's port. It cannot move, remove or
  add one.
- A **slot** sits between positions. Any number of plugins add hooks there.

| In order | Kind | Filled by |
|---|---|---|
| `error` | slot | hooks; the route's own `.error()` runs first |
| `beforeAuth` | slot | hooks |
| `authorize` | position | `ENFORCEMENT` (auth plugin) |
| `afterAuth` | slot | hooks |
| `parse`, `input` | positions | the kernel; not replaceable |
| `admitted` | slot | hooks |
| `throttle`, `circuitBreaker`, `retry` | positions | `RESILIENCE` |
| `perAttempt` | slot | wrappers |
| `timeout`, `concurrency` | positions | `RESILIENCE` |
| `cacheCheck` | position | `CACHE` |
| the pipeline | | the route's steps |
| `cacheStore` | position | `CACHE` |
| `exit` | slot | hooks, over completed exchanges only |

### Phases and order

A hook names a slot and a phase, never another plugin.

| Phase | May | Enforced |
|---|---|---|
| `observe` | read | returning anything but `undefined` is `RC1115` |
| `mutate` | return a changed exchange | |
| `validate` | allow, or refuse with `refuse(reason)` | returning a changed exchange is `RC1115` |

A slot runs observe, then mutate, then validate. `exit` has no validate phase
(`RC1115` at compile). In the `error` slot `mutate` is the deciding phase: a
hook answers with a recovery (a body, `recovery.drop`, `recovery.defer`) or
`undefined` to pass, and the first answer decides. Inside a phase, hooks run in
the order the application lists the plugins.

A refusal throws `RC5068` naming the hook and its reason, which reaches the
`error` slot like any failure.

Two mutate hooks writing the same header in one slot: the later wins and the
framework warns once per route naming both. A hook that declares `writes`
moves that warning to start. A mutate hook may not write an engine-owned
header (`routecraft.id`, `routecraft.route`, `routecraft.operation`,
`routecraft.split_hierarchy`): that is `RC1115`, the contract `.header()`
enforces.

Hooks at a point another plugin declares go under `hooks.points`, keyed by
point name, so the slot keys stay closed and a misspelled slot is a compile
error.

The application settles conflicts, in config:

```ts
hooks: {
  order: { "beforeAuth/mutate": ["legacy", "tenancy"] },
  disable: ["legacy/setTenantFromPath"],
}
```

A name in `order` or `disable` that matches no hook is `RC1112`. `disable`
applies to slots; a position is never switched off.

### Survival

Every hook declares the run kinds it applies to (`normal`, `resume`,
`debounce`, `errorChannel`) with `runs`, defaulting to `normal` only. The
`error` slot is the exception and defaults to every kind: a failure on a
resumed or released run is still the route's failure, and a handler that
heard only first runs would miss exactly the failures a park produces. The
per-position table in `pipeline/chain-policy.ts` stays the source for
positions.

The run carries its kind, independent of which hooks exist: a resume, a
debounce release and an error-channel re-entry each report their own kind to
the `error` slot, to points and to `perAttempt`. Detached runs re-enter below
admission, so `beforeAuth`, `afterAuth` and `admitted` never run on them,
with one exception: an admission resume (a park raised before the route
admitted the exchange) completes the admission its first run never reached,
so it runs `afterAuth` and `admitted` around the `authorize` it re-runs.
`beforeAuth` ran on the first run and does not run again.

A `perAttempt` wrapper calls `proceed()` once. A second call is `RC1115`, and
an attempt the wrapper started is settled before the slot settles even when
the wrapper did not await it, so retry never runs two attempts at once.

## 4. Steps, the project, and facets

```ts
export const dedupe = definePlugin({
  id: "acme.dedupe",
  steps: {
    dedupe: (opts: { key: (body: Order) => string }) =>
      step<Order, Order>(async (exchange) => ...),
  },
});

export const { craft } = defineProject({ plugins: [dedupe] });
craft().id("orders").from(source).dedupe({ key: (o) => o.id }).to(sink);
```

- `step<In, Out>(execute)` builds a typed step. The method exists when the
  current body is assignable to `In` and returns the builder at `Out`.
- `Body` is a placeholder type: `step<Body, Body>` with `(fn: (b: Body) => ...)`
  in the factory's arguments gives a body-preserving method typed at whatever
  the body is when it is called.
- A step whose type depends on a call-site generic (`.defer<Schema>()`)
  declares its method type by merging into `StepMethods<S, This>` under its
  namespace. The `steps` entry still provides the runtime.
- `defineProject({ plugins, ...config })` returns `{ craft, config, plugins }`.
  It composes the plugins exactly as the application does (config-key
  plugins, the listed ones, the defaults, and what they bring), so its
  `craft` has exactly the installed steps; its types are the listed plugins,
  the defaults and each set key's `ConfigKeyPlugins` entry. A step or facet
  of an uninstalled plugin is a compile error.
- The root `craft()` export is typed by the catalogue `@routecraft/routecraft`
  ships. A route using an uninstalled plugin's step refuses to start
  (`RC1111`); reading an uninstalled plugin's facet fails with `RC1111` at
  the read.
- A step factory builds a new step per call: the method labels and tags what
  it returns, and a step it already returned (or a frozen one) is `RC1116`.
  A step named like a builder method or field is `RC1116` too.
- `test/type-budget.bun.test.ts` installs ten plugins and fails when `tsc` over
  the fixture exceeds its time budget or a wrong argument stops producing a
  readable error.

Facets: a plugin's facet is `ex.<namespace>`, typed in project routes,
computed from body and headers on every read, never stored. The kernel defines
the getter; the exchange's own fields (`id`, `headers`, `body`, `logger`,
`context`) and its prototype's members are reserved (`RC1114`).
`ex.principal` is removed: it is `ex.auth.principal`, and library code reads
`principalOf(exchange)`.

`registerDsl` and the `StepBuilderBase` augmentation are removed. The sugar
`.log()`, `.debug()`, `.map()` and `.schema()` are ordinary builder methods.

## 5. Where every first-party feature lives

| Plugin | Provides | Steps / hooks / facet |
|---|---|---|
| `routecraft.direct` | `DIRECT` (endpoint registry, options) | |
| `routecraft.resilience` | `RESILIENCE` (throttle, circuitBreaker, retry, timeout, concurrency) | |
| `routecraft.cache` | `CACHE` | |
| `routecraft.principals` | `AUTHORITY` (mint, brand, isAuthentic, restore, isRestored, read) | |
| `routecraft.auth` | `ENFORCEMENT` | steps `authenticate`, `delegate`; facet `ex.auth` |
| `routecraft.deferral` | `CONTINUATIONS` (store, signer, default deadline) | steps `defer`, `resume`; facet `ex.deferral` |
| `routecraft.telemetry` | | observes |
| `routecraft.servers` | `WEB_INGRESS` | |
| `routecraft.http` | `HTTP` | |
| `routecraft.ops` | `OPS` (health, resources, indicators) | |
| `routecraft.remotes` | `REMOTES` | |
| `routecraft.cron`, `.mail`, `.carddav` | their adapter port | |
| `routecraft.ai.llm`, `.embedding`, `.mcp`, `.agent`, `.sessions`, `.acp` | their ports | |
| `routecraft.os.shell` | `SHELL` | |

Every mint and every trust check goes through the application's authority,
`authorityOf(exchangeOrContext)`. Nothing defaults to the built-in one:
`delegate()`, the ingress mounts and the AI handler contexts take the
authority as an argument, so a replaced `AUTHORITY` cannot be bypassed by an
omitted parameter. `isAuthentic` is never true for a restored record. The
standalone `markAuthentic` / `isAuthentic` / `markRestored` / `isRestored`
helpers are the default authority's internals.

Position config stays on the builder (`.retry()`, `.authorize()`, `.cache()`
and the rest) because positions are the framework's; the builder method
configures the position and the provider fills it. A route that configures a
position whose provider is missing refuses to start (`RC1111`).

### What a replacement must preserve

Replacing a security-relevant port moves the invariants written against the
shipped provider. The kernel keeps what it can enforce structurally; the rest
is the replacement's obligation, and delegating to the exported default
(`defaultAuthority`, `enforcementProvider`, `cacheProvider`) keeps it.

| Port | The kernel still guarantees | The replacement must guarantee |
|---|---|---|
| `AUTHORITY` | every mint, brand, restore and trust check goes through the one provider (`authorityOf`); restored principals come back through `restore` | `isAuthentic` is true only for what it minted or branded, and never for a `restore`d record (`keep()` and `delegate()` trust on `isAuthentic` alone); `restore` returns a new object `isRestored` recognises |
| `ENFORCEMENT` | the position runs where the chain puts it, and on the run kinds `CHAIN_SURVIVAL` allows | the refusal codes keep their meaning (`RC5012` no principal, `RC5023` not authentic, `RC5043` restored, `RC5015` role or predicate, `RC5038` scope, `RC5034`-`RC5036` actor); a door maps a refusal to the caller only when the shipped gate raised it, so a replacement composes `enforcementProvider`'s gate rather than throwing its own |
| `CACHE` | check runs after `authorize` and `input`, store after the pipeline | the default key carries the principal and the route, or one caller's cached body serves another |
| `CONTINUATIONS` | the door order, the compare-and-swap, the continuation hash, the outcome cache and expiry through the error channel | the signer refuses a forged or expired token, and the secret policy holds: no secret is `RC5040` outside a named `NODE_ENV` |

The application names every replaced port at boot, at warn for `AUTHORITY`
and `ENFORCEMENT`, because a dependency's `installs` can bring a replacement
the application's own config never mentions.

## 6. The continuation protocol

The kernel owns park, resume and sweep (`kernel/continuation/`): the record
write, the site and tail hash, the door order, the compare-and-swap, the
outcome cache, expiry through the error channel, claim healing and retention.
It reaches storage only through `CONTINUATIONS`. The deferral plugin provides
that port over the memory or SQLite store, mints and verifies resume tokens,
sets the default deadline, calls `execution.sweep()` on its cadence, and
contributes `.defer()`, `.resume()`, the `ex.deferral` facet and the
`/ops/deferrals` resource.

The door stays on the ingress route: `.resume(mapper, { authorize, elevate })`.
Its order: token, call binding, `authorize`, lifecycle disclosure, deadline,
live tail, payload, compare-and-swap, `elevate` applied after the claim, the
suffix, the recorded outcome.

## 7. Migration decisions

The rows the design left open, decided:

| Question | Decision | Why |
|---|---|---|
| Which shipped positions become ports | authorize, the five resilience positions, both cache positions; parse and input stay kernel-owned | parse and input are properties of the route's source and schema; no consumer needs to replace them |
| The operations plugin | the route grammar (`from`, `to`, `transform`, `filter`, `split`, `choice`, ...) stays on the builder | it holds no state and needs no port; equal reach is the `steps` socket, which a third party uses with the same outcomes we do |
| Door location | on the ingress route, `.resume(mapper, { authorize, elevate })` | the door is where the token arrives; a deferred-route door would need a second ingress anyway |
| Default door policy | bearer, unchanged | changing it is a separate security decision with its own consumer impact |
| Event names | unchanged, except the plugin lifecycle events | renaming every event buys nothing a payload field does not |
| Error codes | the existing `RC` numbering stays; kernel faults take `RC1101`-`RC1117` and `RC5068` | |
| Context error handlers (#818) | become `error` slot hooks; `registerHandler` and the `handlers` config key are removed before release | one mechanism, not two |
| How the CLI finds the project | `craft.config.ts` default-exports `defineProject(...)`; a plain config object still works | |
| Roles, actors, delegation | stay on the principal, owned by the principals plugin | the spike's `subject` / `grants` / `lent` shape was a spike simplification |
| Packages | first-party plugins stay in the package they ship in | the boundary is the import graph test, not the package count |

## 8. Error codes

| Code | Fault |
|---|---|
| RC1101 | two plugins share an id |
| RC1102 | two plugins share a namespace |
| RC1103 | two port tokens share a name |
| RC1104 | a required port has no provider |
| RC1105 | two providers of one port, neither a replacement |
| RC1106 | an invalid replacement |
| RC1107 | a dependency cycle |
| RC1108 | `require` of an undeclared port |
| RC1109 | a declared port left unprovided, or an undeclared port provided |
| RC1110 | a contribution after freeze |
| RC1111 | a route needs a port nobody provides |
| RC1112 | a hook, order or disable entry names nothing that exists |
| RC1113 | two plugins declare one point |
| RC1114 | a facet not named by its namespace, or named after a reserved field |
| RC1115 | a hook broke its phase |
| RC1116 | two plugins declare one step, or a step shadows a builder method |
| RC1117 | an invalid plugin descriptor: no id, the pre-0.8 `apply` shape, a non-port in a port list, or a repeatable plugin declaring what one install may |
| RC5068 | a `validate` hook refused the exchange |

## Related

- [Plugin Lifecycle](./plugin-lifecycle.md) -- unwind, readiness, teardown
- [Pre-from Filter Chain](./pre-from-filter-chain.md) -- positions and survival
- [Exchange State Model](./exchange-state-model.md) -- facets are derivations
