---
title: Contribution Guide
---

How to contribute to Routecraft. {% .lead %}

## Getting Started

- Fork the repository and create a feature branch from `main`.
- Make focused, incremental changes with clear commit messages.
- Run quality checks and tests locally before opening a PR.

## Prerequisites

- Bun 1.1.0+ (the workspace is Bun-managed; the `craft` CLI also requires Bun)
- Node.js 22+ (some scripts and the embedding test path run on Node)
- Git

## Local Development

```bash
# Clone and install
git clone https://github.com/routecraftjs/routecraft.git
cd routecraft
bun install

# Build, lint, typecheck, and test
bun run build
bun run lint
bun run typecheck
bun run test

# Run example capabilities
bun run craft run ./examples/dist/hello-world.js

# Run docs site locally
bun run docs
```

## Project Structure

- `packages/routecraft` – Core library (builder, DSL, context, adapters, consumers)
- `packages/cli` – CLI (`craft`) to run routes and contexts
- `apps/routecraft.dev` – Documentation site
- `examples/` – Runnable routes and tests

## Development Workflow

### Branching

Use a short, descriptive branch name with a prefix:

- `feat/<feature-name>`
- `fix/<bug-name>`
- `docs/<docs-change>`
- `refactor/<scope>`

Example:

```bash
git checkout main && git pull
git checkout -b feat/add-batch-consumer-option
```

### Conventional Commits

Follow the Conventional Commits spec:

```
feat(adapter): add retry option to timer adapter
fix(cli): handle missing route files more gracefully
docs(contributing): clarify testing commands
refactor(builder): simplify type inference for map()
```

## Coding Standards

- TypeScript everywhere; avoid `any`. Prefer precise types or `unknown` with narrowing.
- Keep capabilities small, composable, and isolated. Use `.from` for sources, pure steps for processing, `.to` for side effects.
- One function per step; accept a single options object or one adapter instance.
- Validate external inputs with a StandardSchemaV1-compliant `schema` on the source adapter or `.filter(fn)` for business rules.
- Prefer purity for `.transform`, `.process`, `.filter`, `.tap`.
- Avoid cross-capability globals; use `direct(...)` or `CraftContext` store.
- Match existing formatting and structure; keep functions short and readable.

## Testing

- Write unit tests for core behavior (`packages/routecraft/test/*`).
- Use example routes under `examples/` to verify end-to-end behavior.
- Run tests and coverage locally:

```bash
bun run test
bun run test:coverage
```

## Pull Request Checklist

Before opening a PR:

```bash
bun run format        # check formatting
bun run lint          # lint all packages
bun run typecheck     # TypeScript checks
bun run test          # run tests
bun run build         # build all packages
```

Or run the bundled `bun run all`, which executes lint --fix, format:write, typecheck, build, and test in one pass.

Include in your PR description:

- What changed and why
- Screenshots/logs if relevant
- Testing notes (steps to verify)

## CI and Auto-merge

- CI runs formatting, linting, type checks, tests, build, and example runs.
- Dependabot PRs are auto-approved and auto-merged after all checks pass.

## Releasing

- Releases are handled via GitHub releases and CI publish workflow.
- Ensure package versions align with tags when publishing.

## Questions and Help

- Open a GitHub Discussion or Issue for questions.
- Check the docs under Introduction → Project Structure and Capabilities for fundamentals.
