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
