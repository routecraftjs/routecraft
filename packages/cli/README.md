# @routecraft/cli

Run Routecraft capabilities from the terminal, boot a project, and drive a running instance. **Bun-only runtime** (>= 1.1.0); see the [Runtime reference](https://routecraft.dev/docs/reference/runtime) for the rationale and the Node embedding alternative.

## Installation

```bash
# Bun (recommended)
bun add -g @routecraft/cli

# npm / pnpm / yarn (still requires Bun on the host at runtime)
npm install -g @routecraft/cli
pnpm add -g @routecraft/cli
yarn global add @routecraft/cli
```

If Bun is missing, the CLI fails fast with a `[routecraft]` error pointing at the install instructions. Node users should embed `@routecraft/routecraft` programmatically rather than going through the CLI; see [Programmatic Invocation](https://routecraft.dev/docs/advanced/programmatic-invocation).

## Commands

| Command | What it does |
|---------|--------------|
| `craft run <file> [args...]` | Load one TypeScript or JavaScript file, start every route it exports, and keep the process running. Anything after the file is passed through to the route's CLI adapter |
| `craft start [dir]` | Boot a project from its folder convention (`craft.config.ts`, `capabilities/`, `plugins/`, `agents/`, `skills/`). `--once` shuts down after the first exchange settles and `--timeout <duration>` bounds that wait |
| `craft exec [route] [--field=value...]` | Dispatch to a route on a running instance and print the result; omit the route for the list of dispatchable endpoints. Reads the body from stdin too. `--format pretty \| json \| raw` |
| `craft ops health \| ready \| routes [id] \| deferrals [id] \| indicators [name]` | Read the ops surface of a running instance: health, readiness, the route listing, what is waiting on a deferral, and the health indicators |
| `craft acp` | Bridge an editor speaking the Agent Client Protocol to an instance; `--agent <name>` picks the agent. It reconnects on its own when the instance restarts |

`exec`, `ops` and `acp` reach the instance through its ops server: `--url` and `--token` name it directly, or a profile does.

### Profiles

A personal settings file, `.routecraft/settings.yaml`, holds named profiles with `url`, `token`, `agent` and `env`, so one command works against a laptop and a company instance alike. `--profile <name>` selects one on every command. A refusal names who issues acceptable tokens and which scope is missing.

### Environment

`run` and `start` load `.env`, then `.env.<profile>` when a profile is selected, then `.env.local` from the project directory, each overriding the one before. `--env <path>` replaces the cascade with one file.

### Logging

```text
--log-level <level>   Any pino level (trace, debug, info, warn, error, fatal) or silent (default: warn)
--log-file <path>     Write logs to a file instead of stdout
```

Both are global options, so they go before the command: `craft --log-level info --log-file craft.log run <file>`.

The CLI handles graceful shutdown on `SIGINT` / `SIGTERM` (a repeated one is ignored) and forces an immediate exit on `SIGQUIT` / `SIGBREAK`. TypeScript files are supported directly; Bun strips types natively, so there is no build step.

## Example

```typescript
// capabilities/timer-ping.ts
import { craft, timer, log } from '@routecraft/routecraft';

export default craft()
  .id('timer-ping')
  .from(timer({ interval: "1s" }))
  .transform((ex) => ({ timestamp: Date.now() }))
  .to(log());
```

```bash
craft run capabilities/timer-ping.ts
```

## Use as an MCP Server

The CLI is the entry point for exposing your capabilities to Claude Desktop, Cursor, and other MCP clients. The client must launch it with Bun (`bunx @routecraft/cli run ...`), not `npx` or `node`. See the [`@routecraft/ai`](https://www.npmjs.com/package/@routecraft/ai) package for the client configuration.

## Documentation

Every command and flag is in the [CLI reference](https://routecraft.dev/docs/reference/cli). For guides and examples, visit [routecraft.dev](https://routecraft.dev).

## License

Apache-2.0

## Links

- [Documentation](https://routecraft.dev)
- [GitHub Repository](https://github.com/routecraftjs/routecraft)
- [Issue Tracker](https://github.com/routecraftjs/routecraft/issues)
