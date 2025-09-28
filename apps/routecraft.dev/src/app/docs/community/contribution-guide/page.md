---
title: Contribution Guide
---

How to contribute to RouteCraft. {% .lead %}

## Getting Started

- Fork the repository and create a feature branch from `main`.
- Make focused, incremental changes with clear commit messages.
- Run quality checks and tests locally before opening a PR.

## Editor recommendation

We recommend using Cursor as your editor. This repository includes Cursor rules that help contributors and AI-assisted workflows align with our conventions.

## Prerequisites

- Node.js 22+
- pnpm (workspace managed)
- Git

## Local Development

```bash
# Clone and install
git clone https://github.com/devoptix-labs/routecraft.git
cd routecraft
pnpm install

# Build, lint, typecheck, and test
pnpm build
pnpm lint
pnpm typecheck
pnpm test

# Run example routes
pnpm craft run ./examples/hello-world.mjs

# Run docs site locally
pnpm docs
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
- Keep routes small, composable, and isolated. Use `.from` for sources, pure steps for processing, `.to` for side effects.
- One function per step; accept a single options object or one adapter instance.
- Validate external inputs with `.validate(schema)`.
- Prefer purity for `.transform`, `.process`, `.filter`, `.tap`.
- Avoid cross-route globals; use `direct(...)` or `CraftContext` store.
- Match existing formatting and structure; keep functions short and readable.

## Testing

- Write unit tests for core behavior (`packages/routecraft/test/*`).
- Use example routes under `examples/` to verify end-to-end behavior.
- Run tests and coverage locally:

```bash
pnpm test
pnpm test:coverage
```

## Pull Request Checklist

Before opening a PR:

```bash
pnpm format        # check formatting
pnpm lint          # lint all packages
pnpm typecheck     # TypeScript checks
pnpm test          # run tests
pnpm build         # build all packages
```

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
- Check the docs under Introduction → Project Structure and Routes for fundamentals.
