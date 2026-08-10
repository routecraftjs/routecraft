---
title: CLI
---

Run Routecraft capabilities from the command line. {% .lead %}

{% callout type="note" title="Bun-only runtime" %}
The `craft` CLI runs on Bun (>=1.1.0). Node users should embed `@routecraft/routecraft` programmatically instead -- see [Programmatic Invocation](/docs/advanced/programmatic-invocation) and the [Runtime reference](/docs/reference/runtime).
{% /callout %}

## Basic usage

```bash
craft <command> [options]
```

Global options (must appear **before** the subcommand):

| Option | Description |
| --- | --- |
| -h, --help | Show usage help |
| -v, --version | Print version and exit |
| --log-level \<level\> | Log level (info, warn, error, silent). Applied before the logger initializes. |
| --log-file \<path\> | Write logs to a file instead of stdout |

Because `run` uses pass-through options, anything after `run <file>` is forwarded to the route file's CLI adapter. Put `--log-level` and `--log-file` before `run`:

```bash
craft --log-level info --log-file craft.log run ./capabilities/orders.ts
```

{% callout type="note" title="More commands coming" %}
`dev`, `build`, and `exec` are planned for future releases.
{% /callout %}

## Project scaffolding

New projects are created via `bunx create-routecraft` (or the equivalent for your package manager), a separate scaffolding package -- not a `craft` subcommand:

{% code-tabs %}
{% code-tab label="bun" language="bash" %}
```bash
bunx create-routecraft [project-name]
```
{% /code-tab %}

{% code-tab label="npm" language="bash" %}
```bash
npm create routecraft@latest [project-name]
```
{% /code-tab %}

{% code-tab label="pnpm" language="bash" %}
```bash
pnpm create routecraft@latest [project-name]
```
{% /code-tab %}

{% code-tab label="yarn" language="bash" %}
```bash
yarn create routecraft [project-name]
```
{% /code-tab %}

{% /code-tabs %}

Options:

| Option | Description |
| --- | --- |
| -h, --help | Show usage help |
| -y, --yes | Skip interactive prompts and use defaults |
| -f, --force | Overwrite existing directory |
| --skip-install | Skip installing dependencies |
| -e, --example \<name or url\> | Example to use (none, hello-world) or GitHub URL |
| --use-npm, --use-pnpm, --use-yarn, --use-bun | Choose package manager |
| --no-git | Skip git initialization |

## Commands

### run

Load one or more capabilities from a TypeScript file and start the Routecraft context. The process runs as long as the capabilities run -- finite capabilities exit after completing; long-lived sources keep the process running until the context is stopped or a signal is received.

```bash
craft run <file> [--env <.env path>]
```

The file must export a capability (or array of capabilities) as its default export, and optionally a `craftConfig` named export. See the [Configuration reference](/docs/reference/configuration) for the config export format.

Options:

| Option | Description |
| --- | --- |
| `<file>` | TypeScript or JavaScript file (.ts/.mjs/.js/.cjs) to execute |
| `--env <path>` | Load environment variables from a .env file |

### start

Boot a whole project from its [folder convention](/docs/introduction/project-structure)
instead of a hand-written barrel file. Where `run` executes one entry file, `start` reads
`craft.config.ts` and then discovers what the project declares on disk: capabilities,
plugins, agents, and skills.

```bash
craft start [dir] [--env <.env path>] [--once]
```

With no argument it starts the project in the current directory. Both the root-level and the
`src/`-nested layouts work.

Options:

| Option | Description |
| --- | --- |
| `[dir]` | Project root. Defaults to the current directory |
| `--env <path>` | Load environment variables from a .env file |
| `--once` | Shut down cleanly after the first exchange reaches a terminal outcome on any route |

What it loads, and in what order:

1. `craft.config.ts` from the project root, via its named `craftConfig` export. A default
   export is accepted with a warning. Importing this file is what pulls ecosystem packages
   into the module graph.
2. `plugins/`, one plugin instance per module.
3. Folder discoverers, in their registered order. `@routecraft/ai` claims `skills/` and then
   `agents/`, so an agent can compose the house skills rather than replacing them.
4. `capabilities/`, one or more routes per capability.

Code wins and convention fills the gaps: whatever `craft.config.ts` declares is kept, and
discovery supplies only what it left out. Every discovered capability, plugin and agent is
logged with the file it came from.

`--once` is for CI smoke checks and cron-style one-shot invocations. A failure and a drop
count as terminal alongside a completion, so a broken exchange reports instead of hanging
until the job is killed; a first exchange that failed exits non-zero. A project whose sources
never produce an exchange (an HTTP server with no traffic, say) will wait, which is what makes
`--once` a smoke check rather than a timeout.

```bash
craft start ./apps/eywa --once
```

## Shutdown helpers

When building a custom runner (e.g. embedding Routecraft inside an Express server or CLI tool), use `shutdownHandler` for graceful two-stage shutdown:

```ts
import { ContextBuilder, shutdownHandler } from '@routecraft/routecraft';

const { context, client } = await new ContextBuilder()
  .routes(myRoutes)
  .build();

const cleanup = shutdownHandler(context);
await context.start();
```

**First signal** (Ctrl+C): stops accepting new requests, drains in-flight routes, runs plugin teardown, then exits cleanly.

**Second signal** (Ctrl+C again): forces an immediate exit for when graceful shutdown is stuck or taking too long.

The function returns a cleanup callback that removes the signal handlers, useful in tests or when you manage the lifecycle yourself.
