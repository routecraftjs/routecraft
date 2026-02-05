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

