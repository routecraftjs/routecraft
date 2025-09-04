---
title: CLI
---

The Craft CLI allows you to develop, build, start your application, and more. {% .lead %}

## Basic usage

```bash
craft <command> [options]
```

## Reference

Global options:

| Option | Description |
| --- | --- |
| -h, --help | Show usage help |
| -v, --version | Print version and exit |

Commands:

| Command | Description |
| --- | --- |
| [dev](#dev) | Start development mode (watch, hot reload, admin portal) |
| [build](#build) | Build for production and emit a routes manifest |
| [start <config>](#start) | Start a RouteCraft context from a config file |
| [run <path>](#run) | Execute routes from a file or directory once and exit |
| [info](#info) | Display version, environment, and diagnostics |

### Dev

Start development mode with file watching, hot reload, and the admin portal.

Status: planned

```bash
craft dev [--env <.env path>] [--port <number>] [--open] [--no-ui]
```

Options:

| Option | Description |
| --- | --- |
| --env <path> | Load environment variables from a .env file |
| --open | Open admin portal in the default browser |
| --no-ui | Start without the admin portal |

### Build

Build for production and emit a routes manifest.

Status: planned

```bash
craft build [--env <.env path>]
```

Options:

| Option | Description |
| --- | --- |
| --env <path> | Load environment variables from a .env file |

### Start

Start a RouteCraft context from a config file. The admin portal can be enabled via configuration.

```bash
craft start <config> [--env <.env path>]
```

Options:

| Option | Description |
| --- | --- |
| <config> | Path to a config file exporting a CraftConfig |
| --env <path> | Load environment variables from a .env file |
| --open | Open admin portal in the default browser |
| --no-ui | Start without the admin portal |

### Run

Execute routes from a file or directory once and exit.

```bash
craft run <path> [--exclude <glob...>] [--env <.env path>]
```

Options:

| Option | Description |
| --- | --- |
| <path> | File or directory to load routes from |
| --exclude <glob...> | Glob patterns to exclude (e.g., "*.test.ts") |
| --env <path> | Load environment variables from a .env file |

### Info

Display version, environment, and diagnostic information.

Status: planned

```bash
craft info [--json]
```

Options:

| Option | Description |
| --- | --- |
| --json | Output machine-readable JSON |

Example output:

```text
RouteCraft CLI v0.x
Node: v22.x
Packages:
  @routecraftjs/cli x.y.z
  @routecraftjs/routecraft x.y.z
Working directory: /path/to/project
```

```json
{
  "cliVersion": "0.x",
  "nodeVersion": "22.x",
  "packages": {
    "@routecraftjs/cli": "x.y.z",
    "@routecraftjs/routecraft": "x.y.z"
  },
  "cwd": "/path/to/project"
}
```
