# @routecraft/cli

Run Routecraft capabilities from the terminal.

## Installation

```bash
npm install -g @routecraft/cli
```

or

```bash
pnpm add -g @routecraft/cli
```

## Usage

```bash
craft run my-capability.ts
```

The CLI loads your capability file, starts all registered capabilities, and keeps the process running. It handles graceful shutdown on `SIGINT`/`SIGTERM` and automatically loads a `.env` file from the current directory if present.

TypeScript files are supported directly -- no build step required.

## Options

```bash
craft run [options] <file>

Options:
  --log-level <level>   Log level: info, warn, error, silent (default: warn)
  --log-file <path>     Write logs to a file instead of stdout
  -h, --help            Display help information
  -V, --version         Display version information
```

## Example

```typescript
// capabilities/timer-ping.ts
import { craft, timer, log } from '@routecraft/routecraft';

export default craft()
  .id('timer-ping')
  .from(timer({ intervalMs: 1000 }))
  .transform((ex) => ({ timestamp: Date.now() }))
  .to(log());
```

```bash
craft run capabilities/timer-ping.ts
```

## Use as an MCP Server

The CLI is the entry point for exposing your capabilities to Claude Desktop, Cursor, and other MCP clients. See the [`@routecraft/ai`](https://www.npmjs.com/package/@routecraft/ai) package for setup instructions.

## Documentation

For full guides and examples, visit [routecraft.dev](https://routecraft.dev).

## License

Apache-2.0

## Links

- [Documentation](https://routecraft.dev)
- [GitHub Repository](https://github.com/routecraftjs/routecraft)
- [Issue Tracker](https://github.com/routecraftjs/routecraft/issues)
