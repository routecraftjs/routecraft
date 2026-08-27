# create-routecraft

Scaffold a new Routecraft project with best practices and example capabilities.

## Usage

```bash
# Bun (recommended)
bunx create-routecraft

# npm
npm create routecraft@latest

# pnpm
pnpm create routecraft@latest

# yarn
yarn create routecraft
```

## What's Included

The scaffolded project includes:

- Pre-configured TypeScript setup
- Example capabilities demonstrating key features
- Ready-to-use project structure
- Development dependencies configured
- ESLint and testing setup

## Starting from a repository

`--example` also takes a public GitHub URL. `craft-harness` is the reference starting point:
a working agent harness laid out in the project convention, where every capability is an
ordinary route you own.

```bash
bunx create-routecraft my-agent --example https://github.com/routecraftjs/craft-harness
```

A plain repository URL always takes `main`; add `/tree/<branch>/<subpath>` for a specific
branch or a subdirectory. The template's files win over the base scaffold, except for the
project name you passed and the package manager you chose, and its `dependencies`,
`devDependencies` and `scripts` merge into the base manifest rather than replacing it.
Lockfiles, `node_modules` and `.git` are never copied.

## Interactive Prompts

The CLI will guide you through:

1. **Project name**: Choose a name for your project
2. **Package manager**: Select bun, npm, pnpm, or yarn
3. **Template**: Pick from available starter templates

## Next Steps

After creating your project, install dependencies and start the dev loop. Substitute the install/run command for the package manager you chose at the prompt:

```bash
# Bun
cd your-project-name
bun install
bun run start

# npm
cd your-project-name
npm install
npm run start
```

The `start` script invokes the `craft` CLI under the hood, which requires Bun >= 1.1.0 on the host regardless of which package manager you chose for dependency management.

## Documentation

For more information about Routecraft, visit [routecraft.dev](https://routecraft.dev).

## License

Apache-2.0

## Links

- [Documentation](https://routecraft.dev)
- [GitHub Repository](https://github.com/routecraftjs/routecraft)
- [Issue Tracker](https://github.com/routecraftjs/routecraft/issues)
