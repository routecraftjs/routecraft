# Routecraft

A modern, type-safe routing and integration framework for TypeScript/Node.js. Routecraft makes it easy to define, compose, and run data pipelines, event-driven flows, and integrations—locally or in production.

## Monorepo Structure

- **`packages/routecraft`** – Core library (routing engine, context, adapters, etc.)
- **`packages/cli`** – Command-line interface for running and managing Routecraft projects
- **`examples/`** – Example routes, adapters, and test cases

## Requirements

- **Node.js v22+** (see `package.json` and `.nvmrc` if present)
- [pnpm](https://pnpm.io/) (recommended for workspace management)

## Quick Start (Development)

1. **Clone the repo:**

   ```sh
   git clone https://github.com/routecraftjs/routecraft.git
   cd routecraft
   ```

2. **Install dependencies:**

   ```sh
   pnpm install
   ```

3. **Build all packages:**

   ```sh
   pnpm build
   ```

4. **Run lint and type checks:**

   ```sh
   pnpm lint
   pnpm typecheck
   ```

5. **Run tests:**
   ```sh
   pnpm test
   ```

## CLI Usage

The CLI is available as `craft` (see `packages/cli`).

### Development Usage (Workspace)

For development within this repository, use the workspace script:

```sh
pnpm craft run ./examples/hello-world.mjs
pnpm craft run ./examples --exclude "*.test.ts"
pnpm craft start ./path/to/your-config.ts
```

### Global Installation

To install the CLI globally for use anywhere:

1. **Build the CLI:**

   ```sh
   pnpm build
   ```

2. **Install globally:**

   ```sh
   npm install -g ./packages/cli
   ```

3. **Use the `craft` command globally:**
   ```sh
   craft run ./examples/hello-world.mjs
   craft start ./path/to/your-config.ts
   ```

**Note:** If you encounter issues with the global installation, uninstall and reinstall:

```sh
npm uninstall -g @routecraftjs/cli
npm install -g ./packages/cli
```

### CLI Commands

- **Run routes from a file or directory:**

  ```sh
  craft run ./examples/hello-world.mjs
  craft run ./examples --exclude "*.test.ts"
  ```

- **Start a context from a config file:**

  ```sh
  craft start ./path/to/your-config.ts
  ```

- The config file should export a `CraftConfig` as its default export.
- See `packages/routecraft/src/context.ts` for the config shape.

## Adding Your Own Routes/Configs

- Create a TypeScript or JavaScript file exporting a valid Routecraft route or config.
- Use the CLI to run or start your context as shown above.
- See the `examples/` directory for inspiration.

## Examples

- Browse the [`examples/`](./examples) directory for ready-to-run sample routes and tests.
- Try: `pnpm craft run ./examples/hello-world.mjs`

## License

This project is licensed under the [Apache 2.0 License](./LICENSE).
