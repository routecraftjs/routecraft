---
"@routecraft/routecraft": minor
"@routecraft/os": minor
"@routecraft/ai": minor
"@routecraft/eslint-plugin-routecraft": minor
---

`shell()`, isolated by default, and the framework half of the `Bash` agent tool (#181, #343).

**`shell(command, args?, options?)` in `@routecraft/os`** runs a command and produces `{ stdout, stderr, exitCode, signal?, truncated }`. It is fetch-shaped, like `agentBrowser()` beside it: `.enrich()` merges the result, `.to()` replaces the body with it, `.tap()` discards it.

**It never invokes a shell.** The program is spawned directly with an argument vector, so no `bash` or `sh -c` interprets a command line and an argument can never become a command. That is the security boundary, and it is stronger than escaping. Ask for shell interpretation visibly with `shell("bash", ["-c", script])`.

**Mark what came from outside with `untrusted()`.** Direct spawning stops an argument becoming a command; it does not stop one posing as an *option* to the program you invoked, which is how `--upload-pack=evil` reaches `git clone`. Marked values get flag-injection protection, every argument gets control-character hygiene. Protection is per value because blanket protection strips the leading dashes off the author's own flags. The new `require-untrusted-shell-args` lint rule catches a value you forgot to mark.

**A tier refuses an option it cannot satisfy, and never ignores one.** `network` defaults to denied, so `isolation: "none"` was handing back full egress under a default that said otherwise. That combination is now refused with `OS1004`, naming `network: true` as the way to accept egress out loud. Running uncontained costs two visible words rather than one silent default, and denied egress is the guarantee worth protecting: the `unshare` tier deliberately does not contain filesystem reads, so no-network is what stands between a command reading a credential and sending it somewhere.

**The environment baseline carries fixed values, not inherited ones.** Granting the names while inheriting the values reopened what the grant model exists to close: `HOME` pointed at the caller's real home, so every command found `~/.aws/credentials` and `~/.ssh/config` unasked, and `PATH` was the caller's, so one writable entry on it chose the program. `PATH`, `HOME`, `LANG` and `TZ` now have documented fixed values, and `passEnv` is how a command asks for the caller's own.

**Isolation tiers, named for their mechanism so the name is the promise.** `unshare` (Linux kernel namespaces) is the default; `none` is an explicit opt-out. The `unshare` tier guarantees no network egress unless the call sets `network: true`, no visible host processes, no host privileges, contained mounts, invisible host SysV IPC objects, and a hostname of its own. It does **not** contain filesystem reads: the command can still read every file the caller can, `~/.ssh` and `.env` included. That non-promise is documented on the adapter page rather than left implied.

A tier that cannot be established fails with `OS1001` naming the cause and the ways out. `shell()` never degrades to a weaker tier.

**The environment is granted, not inherited.** A command gets `PATH`, `HOME`, `LANG`, `TZ` and nothing else; further variables are declared per call with `env` (values) or `passEnv` (forwarded by name). Per-call options beat the `ROUTECRAFT_SHELL_ISOLATION` operator override, which beats `shellPlugin()` context defaults.

**A lazily-resolved tool is no longer a lesser tool.** `directTool(routeId)` returns a thunk, because `craft.config.ts` is evaluated before any route is registered and the tool needs the route's `.description()` and `.input()`. Paths that read the registry entry before that resolution saw a thunk carrying nothing and reported the absence as a property of the tool. After context start a route-backed tool now answers every question an eagerly authored one does: the `tools()` catalogue reports its description and tags, so a builder filtering on either still selects it.

That is what `Bash: directTool("bash-runner")` with `tools: Bash` in an agent file needs to work end-to-end, and the `Bash` tool itself is assembly rather than framework: a route running `shell()` on an isolation tier, shipped by the scaffolder's template.

**Agent-file loader.** `disallowedTools` matches the reference it names and nothing else, so a deny for one `Direct(...)` route cannot remove another. The deny-only error explains that honouring a deny list against inherited defaults was declined rather than citing a ticket that has since been closed.

**Guard refusals are countable.** A call-time guard rejection emits `route:agent:tool:refused`, carrying the tool and the error code and nothing else. It is separate from `route:agent:tool:denied`, which fires when a policy withholds a tool at selection time so the model never sees it: counting them together would mix "this agent may not have that tool" with "this agent asked for something its guard rejected", and the second is what tells an operator an agent is probing the edges of what it was given. The refused input is deliberately absent even under snapshot capture, because a refused tool input is the input least worth trusting and can carry a token someone passed as an argument.
