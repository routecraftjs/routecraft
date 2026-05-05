# @routecraft/os

System-native adapters for Routecraft -- shell execution, process management, and other OS-level primitives.

## Status

**Placeholder.** This package is reserved on npm and in the workspace; the first adapters are scheduled for a future release. The `dist/` published today contains an empty module surface.

Track progress in the [Routecraft issue tracker](https://github.com/routecraftjs/routecraft/issues) and watch [`packages/os`](https://github.com/routecraftjs/routecraft/tree/main/packages/os) for the first PRs.

## Planned scope

- `shell()` -- run shell commands as a Source or Destination, with stdout / stderr / exit-code surfaced on the exchange.
- `process()` -- spawn long-running subprocesses; lifecycle managed by the route.
- Additional OS-level primitives as they're proven in real capabilities.

## Installation

Once the first adapter ships:

```bash
# Bun (recommended)
bun add @routecraft/os

# npm / pnpm / yarn
npm install @routecraft/os
pnpm add @routecraft/os
yarn add @routecraft/os
```

## License

Apache-2.0
