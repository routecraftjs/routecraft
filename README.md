<div align="center">

  <img src="./routecraft.svg" alt="Routecraft Logo" width="200" />

  <p><strong>A type-safe integration and automation framework for TypeScript/Node.js</strong></p>
  <p>Brought to you by <a href="https://devoptix.nl">DevOptix</a></p>

  <a href="https://github.com/routecraftjs/routecraft/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/routecraftjs/routecraft/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-22%2B-3c873a?logo=node.js">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.9%2B-3178c6?logo=typescript">
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/License-Apache%202.0-blue"></a>
  <a href="https://github.com/routecraftjs/routecraft/issues"><img alt="Issues" src="https://img.shields.io/github/issues/routecraftjs/routecraft"></a>
  <a href="https://github.com/routecraftjs/routecraft/pulls"><img alt="PRs" src="https://img.shields.io/badge/PRs-welcome-brightgreen"></a>

</div>

## About

Routecraft lets you author small, focused routes with a fluent DSL and run them across multiple runtimes. It is inspired by Apache Camel and designed for clear boundaries: sources, pure processing steps, and explicit destinations.

## Installation

```bash
# Create a new project
npm create routecraft@latest

# Or add to existing project
npm install @routecraft/routecraft
```

## Quick Example

```ts
import { craft, timer, log } from '@routecraft/routecraft'

export default craft()
  .id('hello-world')
  .from(timer({ intervalMs: 1000, repeatCount: 5 }))
  .transform(() => 'Hello, RouteCraft!')
  .to(log())
```

Run it: `craft run my-route.mjs`

📚 [Full Documentation](https://routecraft.dev)

## Key Features

- Type-safe DSL: `craft().from(...).transform(...).to(...)`
- Isolated routes with their own `AbortController` and backpressure-aware consumers
- Built-in adapters: `simple`, `timer`, `direct`; utilities: `log`, `noop`, `fetch`
- Runtimes: CLI and Node.js programmatic API
- First-class testing with Vitest and example routes

## Monorepo Structure

- `packages/routecraft` – Core library (builder, DSL, context, adapters, consumers)
- `packages/cli` – CLI to run files or folders of routes and start contexts
- `apps/routecraft.dev` – Documentation site (docs, examples, guides)
- `examples/` – Runnable example routes and tests

## Examples

- Browse the [`examples/`](./examples) directory for ready-to-run sample routes and tests.
- Try: `pnpm craft run ./examples/hello-world.mjs`

## Contributing

Contributions are welcome! Please read our contribution guide at https://routecraft.dev/docs/community/contribution-guide for guidelines on how to propose changes, add adapters, and write routes.

## License

Licensed under the [Apache 2.0 License](./LICENSE).
