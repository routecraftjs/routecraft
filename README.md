<div align="center">

  <img src="./routecraft.svg" alt="Routecraft Logo" width="200" />

  <p><strong>A type-safe integration and automation framework for TypeScript/Node.js</strong></p>
  <p>Brought to you by <a href="https://devoptix.nl">DevOptix</a></p>

  <a href="https://github.com/devoptix-labs/routecraft/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/devoptix-labs/routecraft/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-22%2B-3c873a?logo=node.js">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.9%2B-3178c6?logo=typescript">
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/License-Apache%202.0-blue"></a>
  <a href="https://github.com/devoptix-labs/routecraft/issues"><img alt="Issues" src="https://img.shields.io/github/issues/devoptix-labs/routecraft"></a>
  <a href="https://github.com/devoptix-labs/routecraft/pulls"><img alt="PRs" src="https://img.shields.io/badge/PRs-welcome-brightgreen"></a>

</div>

## About

Routecraft lets you author small, focused routes with a fluent DSL and run them across multiple runtimes. It is inspired by Apache Camel and designed for clear boundaries: sources, pure processing steps, and explicit destinations.

## Key Features

- Type-safe DSL: `craft().from(...).transform(...).to(...)`
- Isolated routes with their own `AbortController` and backpressure-aware consumers
- Built-in adapters: `simple`, `timer`, `channel`; utilities: `log`, `noop`
- Runtimes: CLI and Node.js programmatic API
- First-class testing with Vitest and example routes

## Monorepo Structure

- `packages/routecraft` – Core library (builder, DSL, context, adapters, consumers)
- `packages/cli` – CLI to run files or folders of routes and start contexts
- `apps/routecraft.dev` – Documentation site (docs, examples, guides)
- `examples/` – Runnable example routes and tests

## Quick Start (Development)

1. Clone and install

   ```sh
   git clone https://github.com/devoptix-labs/routecraft.git
   cd routecraft
   pnpm install
   ```

2. Build, check, and test

   ```sh
   pnpm build
   pnpm lint
   pnpm typecheck
   pnpm test
   ```

3. Run examples

   ```sh
   pnpm craft run ./examples/hello-world.mjs
   pnpm craft run ./examples --exclude "*.test.ts"
   ```

## CLI Usage

Run routes from a file or directory, or start a context from a config file.

```sh
craft run ./examples/hello-world.mjs
craft run ./examples --exclude "*.test.ts"
craft start ./path/to/your-config.ts
```

- The config file should export a `CraftConfig` default export.
- See `packages/routecraft/src/context.ts` for the config shape.



## Examples

- Browse the [`examples/`](./examples) directory for ready-to-run sample routes and tests.
- Try: `pnpm craft run ./examples/hello-world.mjs`

## Contributing

Contributions are welcome! Please read our contribution guide at https://routecraft.dev/docs/community/contribution-guide for guidelines on how to propose changes, add adapters, and write routes.

## License

Licensed under the [Apache 2.0 License](./LICENSE).
