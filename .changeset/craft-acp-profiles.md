---
"@routecraft/cli": minor
---

`craft acp`, the bridge an editor runs, and profiles that point it somewhere (#599).

**`craft acp`** pipes an editor to a running instance over the [Agent Client Protocol](https://agentclientprotocol.com): newline-delimited JSON on the editor's standard input and output, Streamable HTTP on the instance's side, every message forwarded verbatim in both directions. Nothing in it parses the protocol, so a version this build has never heard of crosses unchanged. It never starts an app, which is what lets one editor entry reach a laptop or a company instance by switching a profile and changing nothing else. There is no login: the profile's token authenticates as it does for every other command, and `--agent` travels as a `Routecraft-Agent` header because the protocol has no field for one. Standard output belongs to the protocol, so every diagnosis goes to standard error.

**Profiles.** `profiles:` in the settings file names sets of `url`, `token`, `format`, `agent` and `env`, and `profile:` selects one; `--profile` and `CRAFT_PROFILE` select one too, in that order of precedence. Every command that reaches an instance takes `--profile`, as do `run` and `start`. Inside one file a profile beats a bare key, because it is the more specific thing the person asked for; between files the project still beats the home directory, so a profile in somebody's home directory can never redirect an instance a repository pinned. A profile named nowhere is refused, naming the profiles that do exist and the file that chose it, rather than falling back to the loopback default. Defining profiles changes nothing until one is selected.

**A profile selects an environment too.** `run` and `start` read `.env`, then `.env.<profile>` when one is selected, then `.env.local`. A profile's `env:` escapes that cascade, as a path to one file or as values written inline (which, like a file, never override a variable the process already carries), and `--env` beats both. The environment is in place before the project's config is imported, so a config file reading `process.env` at module scope sees it.

**`craft chat` is removed**, with no shim, no alias and no pointer. It was never released. An editor speaking the Agent Client Protocol is what replaced it, and a terminal chat client is a product somebody else sells.
