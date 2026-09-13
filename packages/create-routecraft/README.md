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

## What you get

One template, laid out for the folder convention `craft start` discovers:

```
capabilities/hello-world/   route.ts, its test, and a README explaining it
craft.config.ts             what discovery cannot work out on its own
README.md                   the project's own, naming what was scaffolded
package.json  tsconfig.json  eslint.config.mjs  .prettierrc  .gitignore
```

There is no entry file. `craft start` reads `capabilities/` from disk, so nothing is
registered by hand and nothing has to be kept in step with the folder.

`bun run start` boots the project and runs the sample capability, which fetches a user over
HTTP and logs a greeting, so the first command after scaffolding produces output rather
than a silent exit. `bun run test` runs the capability's own tests, which mock `fetch`.
Delete `capabilities/hello-world` when you no longer need it.

## Starting from a repository

`--example` takes a public GitHub URL, and replaces the starter template rather than adding
to it: the repository is a whole project, so the sample capability and the project README
are not written at all. `craft-harness` is the reference starting point: a working agent
harness laid out in the project convention, where every capability is an ordinary route you
own.

```bash
bunx create-routecraft my-agent --example https://github.com/routecraftjs/craft-harness
```

A plain repository URL takes the repository's default branch; add `/tree/<ref>` or
`/tree/<ref>/<subpath>` for a specific branch or tag, or a subdirectory inside one. A ref
whose name contains `/` works: `--example https://github.com/you/repo/tree/feature/login`
resolves against the repository's own ref list, so the boundary between the ref and the
path inside it is read rather than guessed.

The template's files win over the base scaffold, except for the project name you passed and
the package manager you chose, and its `dependencies`, `devDependencies`,
`peerDependencies` and `scripts` merge into the base manifest rather than replacing it.
**Every `@routecraft/*` version is the one this scaffolder belongs to**, whatever the
template pins: a template describes a project's shape, not which version of the framework
you get, and honouring its pins meant asking for `@canary` and being handed whatever that
repository last committed.

`node_modules`, `.git`, `.github/workflows` and the lockfiles (`package-lock.json`,
`npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`, `bun.lockb`) are never
copied. The workflows are excluded because a template's CI tests that template against its
own branches and secrets, which is not true in your project.

## Interactive Prompts

The CLI will guide you through:

1. **Project name**: Choose a name for your project
2. **Start from**: The starter template, or a GitHub repository you name
3. **Package manager**: Select bun, npm, pnpm, or yarn

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
