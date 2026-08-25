---
"@routecraft/os": minor
"@routecraft/ai": minor
"@routecraft/eslint-plugin-routecraft": minor
---

`shell()`, isolated by default, and the framework half of the `Bash` agent tool (#181, #343).

**`shell(command, args?, options?)` in `@routecraft/os`** runs a command and produces `{ stdout, stderr, exitCode, signal?, truncated }`. It is fetch-shaped, like `agentBrowser()` beside it: `.enrich()` merges the result, `.to()` replaces the body with it, `.tap()` discards it.

**It never invokes a shell.** The program is spawned directly with an argument vector, so no `bash` or `sh -c` interprets a command line and an argument can never become a command. That is the security boundary, and it is stronger than escaping. Ask for shell interpretation visibly with `shell("bash", ["-c", script])`.

**Mark what came from outside with `untrusted()`.** Direct spawning stops an argument becoming a command; it does not stop one posing as an *option* to the program you invoked, which is how `--upload-pack=evil` reaches `git clone`. Marked values get flag-injection protection, every argument gets control-character hygiene. Protection is per value because blanket protection strips the leading dashes off the author's own flags. The new `require-untrusted-shell-args` lint rule catches a value you forgot to mark.

**Isolation tiers, named for their mechanism so the name is the promise.** `unshare` (Linux kernel namespaces) is the default; `none` is an explicit opt-out. The `unshare` tier guarantees no network egress unless the call sets `network: true`, no visible host processes, no host privileges, and contained mounts. It does **not** contain filesystem reads: the command can still read every file the caller can, `~/.ssh` and `.env` included. That non-promise is documented on the adapter page rather than left implied.

A tier that cannot be established fails with `OS1001` naming the cause and the ways out. `shell()` never degrades to a weaker tier.

**The environment is granted, not inherited.** A command gets `PATH`, `HOME`, `LANG`, `TZ` and nothing else; further variables are declared per call with `env` (values) or `passEnv` (forwarded by name). Per-call options beat the `ROUTECRAFT_SHELL_ISOLATION` operator override, which beats `shellPlugin()` context defaults.

**The command-pattern matcher**, also exported from `@routecraft/os`, turns `Bash(git status:*)` into a decision about a command an agent proposed. It is operator-aware, because a prefix test is defeated by the first thing anyone tries: it splits on shell operators and requires every subcommand to match, strips wrappers so `timeout 5 rm -rf /` is judged as `rm -rf /`, matches on word boundaries so `git status:*` does not admit `git statusfoo`, honours quoting so a `;` inside a commit message is text, and refuses substitution and redirection outright. Destructive forms and exec wrappers are never covered by a prefix grant.

**A generic specifier seam in `@routecraft/ai`.** `FnOptions` gains an optional declaration of how a tool compiles its own use-site specifiers into a guard, and `tools()` parses `Tool(spec)` once for every tool that declares one, unioning repeated entries. A specifier attached to a tool that accepts none is a hard error rather than a silently ignored constraint, because ignoring it would widen the grant.

**Agent-file loader fixes.** A scoped entry such as `Bash(git status:*)` is now recognised by its tool name, so a real `.claude/agents/*.md` file carrying one loads instead of failing with unknown-tool. Granting a narrowable tool without a specifier warns once, so an unrestricted grant is never invisible. `disallowedTools` naming a tool removes its scoped grants too.
