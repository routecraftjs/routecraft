# @routecraft/os

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
