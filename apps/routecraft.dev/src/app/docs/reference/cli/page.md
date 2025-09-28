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
| [run <path>](#run) | Execute routes from a file or directory once and exit |
| [dev](#dev) | Start development mode (watch, hot reload, admin portal) |
| [build](#build) | Build for production and emit a routes manifest |
| [start <config>](#start) | Start a RouteCraft context from a config file |


### Run

Execute routes from a single file once and exit.

```bash
craft run <file> [--env <.env path>]
```

Options:

| Option | Description |
| --- | --- |
| <file> | File containing routes to execute |
| --env <path> | Load environment variables from a .env file |

### Dev {% badge %}wip{% /badge %}

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

### Build {% badge %}wip{% /badge %}

Build for production and emit a routes manifest.

Status: planned

```bash
craft build [--env <.env path>]
```

Options:

| Option | Description |
| --- | --- |
| --env <path> | Load environment variables from a .env file |

### Start {% badge %}wip{% /badge %}

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


