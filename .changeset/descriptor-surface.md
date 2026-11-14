---
"@routecraft/routecraft": minor
"@routecraft/ai": minor
"@routecraft/cli": minor
"@routecraft/eslint-plugin-routecraft": minor
---

The command line reads a project and nothing else, and a plugin declares its commands and logins on its descriptor.

Breaking: `defineConfig` is removed. `craft.config.ts` default-exports `defineProject({ ... })`, which takes the same keys; a plain default-exported object and the named `craftConfig` export are refused with the new `RC1120`, whose message says how to rewrite the shape it found. `defineProject` checks keys at the top level and inside each config block, not at every depth as `defineConfig` did.

Breaking: `craft run <file>` no longer reads a `craftConfig` export. It runs the routes in, first match wins: `--config <path>`, the file's own `export const project`, the `craft.config` beside the nearest `package.json` when it installs every plugin the routes were built with (`--no-config` skips it), the project the routes were built with, and otherwise the defaults. A capability no longer re-exports the config.

Breaking: `telemetry()` is `telemetryPlugin()`, a plugin descriptor like the others; the `telemetry` config key is unchanged. `SqliteConnection`, the SQLite span processor and event writer, `ATTR` and `SPAN_KIND` leave the entry.

New: `tooling: { commands, logins }` on a plugin descriptor. `craft <namespace> <command>` runs a plugin's command and `craft connect` runs its logins, both read from the project's resolved plugin list without starting it. A command is handed the project root, the logger and the credential store narrowed to the owners its own plugin's logins declare. `pluginTooling(config)` and `scopedCredentialStore()` are exported for other tools, with `projectOf(route)` and `installedPluginIds(config)`. The process-wide registries (`registerProjectCommand`, `projectCommand`, `registerCredentialLogins`, `collectCredentialLogins`), which never shipped in a stable release, are gone.

`craft` keeps `run`, `start`, `exec`, `connect`, `disconnect`, `tui` and `help`; a plugin declaring commands under one of them, or a command named like a subcommand `craft` ships under `ops`, is refused with `RC1117`.

The `RC1111` raised for reading `ex.deferral` without the deferral runtime names the fix (`deferral: {}`), and `servers` and `telemetry` refuse their own renamed options instead of the context doing it for them.

`restrict-principal-minting` also flags `.authenticate()` on a route built with a project's `craft()`.
