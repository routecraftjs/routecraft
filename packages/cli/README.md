# @routecraft/cli

CLI for running RouteCraft routes.

## Installation

```bash
npm install -g @routecraft/cli
```

or

```bash
pnpm add -g @routecraft/cli
```

## Usage

Run a RouteCraft route file:

```bash
craft run myroute.mjs
```

The CLI will:
- Load your route file
- Execute the route
- Keep the process running for continuous processing
- Handle graceful shutdown on SIGINT/SIGTERM

## Options

```bash
craft run [options] <file>

Options:
  -h, --help     Display help information
  -V, --version  Display version information
```

## Environment Variables

The CLI automatically loads environment variables from a `.env` file in the current directory if present.

## Example Route File

```typescript
// myroute.mjs
import { craft, timer, log } from '@routecraft/routecraft';

export default craft()
  .id('timer-example')
  .from(timer({ intervalMs: 1000 }))
  .transform((ex) => ({ timestamp: Date.now() }))
  .to(log());
```

Run it:

```bash
craft run myroute.mjs
```

## Documentation

For more information, visit [routecraft.dev](https://routecraft.dev).

## License

Apache-2.0

## Links

- [Documentation](https://routecraft.dev)
- [GitHub Repository](https://github.com/routecraftjs/routecraft)
- [Issue Tracker](https://github.com/routecraftjs/routecraft/issues)

