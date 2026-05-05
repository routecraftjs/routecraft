# @routecraft/cli

Run Routecraft capabilities from the terminal. **Bun-only runtime** (>= 1.1.0); see the [Runtime reference](https://routecraft.dev/docs/reference/runtime) for the rationale and the Node embedding alternative.

## Installation

```bash
# Bun (recommended)
bun add -g @routecraft/cli

# npm / pnpm / yarn (still requires Bun on the host at runtime)
npm install -g @routecraft/cli
pnpm add -g @routecraft/cli
yarn global add @routecraft/cli
```

## Usage

```bash
craft run my-capability.ts
```

The CLI loads your capability file, starts all registered capabilities, and keeps the process running. It handles graceful shutdown on `SIGINT`/`SIGTERM` and automatically loads a `.env` file from the current directory if present.

TypeScript files are supported directly -- Bun strips types natively, no build step required.

If Bun is missing, the CLI fails fast with a `[routecraft]` error pointing at the install instructions. Node users should embed `@routecraft/routecraft` programmatically rather than going through the CLI -- see [Programmatic Invocation](https://routecraft.dev/docs/advanced/programmatic-invocation).

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
