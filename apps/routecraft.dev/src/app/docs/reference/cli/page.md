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

## Commands

### add

Download a capability from the [community registry](/docs/registry), verify its SHA-256 hash, install dependencies, and update `index.ts`.

```bash
craft add <specifier> [options]
```

The specifier is a capability id or `id@version`:

```bash
craft add elastic-logs
craft add elastic-logs@1.0.0
```

Options:

| Option | Description |
| --- | --- |
| --registry \<url\> | Registry URL (default: routecraftjs/routecraft-registry on GitHub) |
| --dir \<path\> | Target directory for capability files (default: ./capabilities) |
| --no-index | Skip updating index.ts |
| --no-verify | Skip SHA verification (not recommended) |

If the capability declares `requiredCapabilities`, they are installed recursively. Circular dependencies are detected and rejected.

See the [Registry page](/docs/registry) for full details on the trust model and manifest format.

## Project scaffolding

New projects are created via `npm create routecraft`, a separate scaffolding package -- not a `craft` subcommand:

{% code-tabs %}
{% code-tab label="npm" language="bash" %}
```bash
npm create routecraft@latest [project-name]
```
{% /code-tab %}

{% code-tab label="yarn" language="bash" %}
```bash
yarn create routecraft [project-name]
```
{% /code-tab %}

{% code-tab label="pnpm" language="bash" %}
```bash
pnpm create routecraft@latest [project-name]
```
{% /code-tab %}

{% code-tab label="bun" language="bash" %}
```bash
bunx create-routecraft [project-name]
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
| --no-src-dir | Place project files at root instead of src/ |
| --no-git | Skip git initialization |
| --list | List available examples from the registry |

### run

Load one or more capabilities from a TypeScript file and start the Routecraft context. The process runs as long as the capabilities run -- finite capabilities exit after completing; long-lived sources keep the process running until the context is stopped or a signal is received.

```bash
craft run <file> [--env <.env path>]
```

The file must export a capability (or array of capabilities) as its default export, and optionally a `craftConfig` named export. See the [Configuration reference](/docs/reference/configuration) for the config export format.

Options:

| Option | Description |
| --- | --- |
| \<file\> | TypeScript or JavaScript file (.ts/.mjs/.js/.cjs) to execute |
| --env \<path\> | Load environment variables from a .env file |
