# @routecraft/routecraft

Type-safe integration and automation framework for TypeScript/Node.js.

## Installation

```bash
npm install @routecraft/routecraft
```

or

```bash
pnpm add @routecraft/routecraft
```

## Quick Start

```typescript
import { craft, simple, log } from '@routecraft/routecraft';

export default craft()
  .id('my-route')
  .from(simple('Hello, World!'))
  .to(log());
```

## Features

- 🎯 **Type-safe**: Full TypeScript support with intelligent type inference
- 🔌 **Extensible**: Easy-to-write adapters for any integration
- 🚀 **Performant**: Built for high-throughput data processing
- 🛠️ **Developer-friendly**: Intuitive, fluent DSL
- 📦 **Lightweight**: Minimal dependencies

## Logging

Logs go to **stdout** by default at **warn** level. No file is used unless you set one.

- **Environment:** `LOG_FILE` or `CRAFT_LOG_FILE` to write logs to a file. `LOG_LEVEL` or `CRAFT_LOG_LEVEL` for the level (e.g. `info`, `warn`, `error`, or `silent` to disable).
- **CLI:** `craft run <file> --log-file <path>` and `--log-level <level>` (set before your app loads).
- **Config and precedence:** `craftConfig.log` provides default values; environment variables override those, and CLI flags override both. Env vars and CLI flags must be set before the logger is instantiated (before logger creation) to take effect—pass flags to the CLI early so they are applied prior to building the context.

## Documentation

For comprehensive documentation, examples, and guides, visit [routecraft.dev](https://routecraft.dev).

## Example

```typescript
import { craft, timer, log } from '@routecraft/routecraft';

export default craft()
  .id('timer-example')
  .from(timer({ intervalMs: 1000 }))
  .transform((ex) => ({ timestamp: Date.now() }))
  .to(log());
```

## Contributing

Contributions are welcome! Please see our [Contributing Guide](https://github.com/routecraftjs/routecraft/blob/main/CONTRIBUTING.md).

## License

Apache-2.0

## Links

- [Documentation](https://routecraft.dev)
- [GitHub Repository](https://github.com/routecraftjs/routecraft)
- [Issue Tracker](https://github.com/routecraftjs/routecraft/issues)

