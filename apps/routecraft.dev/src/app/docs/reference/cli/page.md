---
title: CLI
---

Run Routecraft capabilities from the command line. {% .lead %}

## Basic usage

```bash
craft <command> [options]
```

Global options:

| Option | Description |
| --- | --- |
| -h, --help | Show usage help |
| -v, --version | Print version and exit |

{% callout type="note" title="More commands coming" %}
`dev`, `build`, `start`, and `exec` are planned for future releases.
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

{% callout type="warning" title="Experimental" %}
`shutdownHandler` is marked `@experimental` and may change in future releases.
{% /callout %}
