# @routecraft/eslint-plugin-routecraft

## 0.8.0

### Minor Changes

- [#966](https://github.com/routecraftjs/routecraft/pull/966) [`f3e510c`](https://github.com/routecraftjs/routecraft/commit/f3e510c0d9081593d7fa685869fe271ee4fcbab8) Thanks [@ex0b1t](https://github.com/ex0b1t)! - One defer contract: a resume payload is `input` everywhere, a step declares that it defers or resumes and the kernel hands it the handle, and a third party can build what the shipped `.defer()`, `.resume()` and agent step are built on ([#809](https://github.com/routecraftjs/routecraft/issues/809), [#817](https://github.com/routecraftjs/routecraft/issues/817)).

  **Breaking: the payload is `input`.** `.defer({ schema })` is `.defer({ input })`, a resume request (the mapper's return value and the unmapped `.resume()` body) is `{ token, input }` in place of `{ token, result }`, `ex.deferral.result` is `ex.deferral.input`, and the header `routecraft.deferral.result` is `routecraft.deferral.input`. Whatever builds an approval link or form sends `input`.

  **Breaking: deferring is declared.** `DeferSignal`, `markDeferCapable`, `peekResumeStepState`, `deferAside`, `reviveDeferral`, `deferralScope`, `decodePersistable` and `decodeOutcome` leave the entry. In their place:

  - A step declares `step(fn, { defers: { revival: "next-step" | "this-step" } })`, or `[DEFERS]()` on a raw step or an adapter, and is handed `ctx.defer`, with `ctx.defer.revived`, `ctx.defer.refused` and `ctx.defer.aside()`.
  - A resume door declares `step(fn, { resumes: true })`, or `[RESUMES]()`, and is handed `ctx.resume`. The kernel records the principal the route verified; a request naming `resumedBy` is `RC5003`, from a `.resume()` mapper too. `step()` types `ctx.defer` by the revival the step declares (`DeferHandleFor`), and a step that calls `ctx.defer()` and then returns is `RC5032`.
  - A step result naming a deferral that the kernel did not issue is refused with `RC5032`.
  - A plugin reads and drives parked exchanges through `c.continuations` (`get`, `list`, `verifyToken`, `resume`, `sweep`, `mintToken`, `rewriteStepState`), which replaces `c.execution.resume` and `c.execution.sweep`. An adapter reaches the read-only half with `continuationsOf(exchange)`.

  **Breaking: an adapter does not read the context off an exchange.** `getExchangeContext` and `getExchangeRoute` leave the entry. What a plugin provides through a port is read with `lookupOf(exchange, PORT)`, state private to one module is an `applicationState<T>()` holder (`set(c.application, value)` in `bind`, `of(exchange)` in an adapter, `get(context.application)` in a source), the logger is `exchange.logger`, trace headers are decided by `sendsTraceContextFor(exchange)`, and background work is `c.execution.trackTask(task, { route })` or `context.trackTask(task, { route })`. `deferredPrincipal` and `reidentificationDeviation` leave the entry: they are members of `c.continuations`. The `llm()` and `embedding()` adapters no longer expose `mergedOptions(context)`.

  **Breaking: the `CONTINUATIONS` port is `routecraft.continuations@2`.** The kernel encodes `stepState`, `meta` and the settled outcome before the store sees them, so a custom `DeferralStore` persists them as the JSON they arrive as. `deferralStoreConformance(name, open, runner)` in `@routecraft/testing` is the suite the shipped stores pass; run it against your own. The signer is typed `ResumeTokenSigning`.

  **A parked exchange finds its defer site by what follows it.** A step added or removed ahead of a defer point no longer refuses the exchanges parked there. The digest binds which kind of site parked, so a step that parked itself on a 0.8 canary is refused once with `RC5048`, as a record from 0.7 is. Two sites of one kind followed by identical steps that both moved are refused with `RC5048` as ambiguous. The `RC5032` and `RC5048` messages say what to change.

  A `schema` left where a resume payload is now declared as `input` is refused (`RC5003`, or `RC1115` on an error hook) rather than dropped. `context.stop()` waits for tasks tracked with no route, as `drain()` does.

  **New lint rule `restrict-continuation-minting`**, an error in both presets: `continuations.mintToken()`, `resume()`, `rewriteStepState()`, `deferral.tokenFor()` and the continuations signer's `mint()` run no door policy, so each call site is sanctioned with a scoped disable comment or a per-file override.

  Also off the entry, none of which a route needs: `ResolvedSampleOptions`, `ResolvedDedupeOptions`, `ResolvedThrottleOptions`, `ResolvedCircuitBreakerOptions`, `RouteEnablement` and `hashExchangeBody`.

  See section 18 of the 0.7 to 0.8 migration guide.

## 0.7.2

## 0.7.1

## 0.7.0

### Minor Changes

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

## 0.6.0
