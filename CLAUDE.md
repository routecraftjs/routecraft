# Routecraft

Type-safe integration and automation framework. Monorepo with pnpm workspaces.

## Quick Reference

- Build: `pnpm build`
- Test: `pnpm test`
- Lint: `pnpm lint`
- Typecheck: `pnpm typecheck`
- Format: `pnpm format`
- Run examples: `pnpm craft run ./examples/dist/hello-world.js`
- Run docs site: `pnpm docs`

## Key Rules

- No `any` in production code (test files are exempt)
- No `@ts-ignore` or `@ts-expect-error` without an explanation comment
- No em-dashes in documentation, JSDoc, comments, or written output
- Use Standard Schema (`@standard-schema/spec`), not Zod/Valibot directly in shared code
- Follow Conventional Commits for commit messages; use `/git-commit-message` for detailed formatting
- Source/Destination for interfaces; Server/Client for option type names only (two-sided adapters)
- Every test must have JSDoc with `@case`, `@preconditions`, and `@expectedResult`

## Internal Standards

Detailed coding standards for contributors live in `.standards/`:

- [Adapter Architecture](.standards/adapter-architecture.md) -- patterns, file structure, facade, authoring guide
- [Naming Policy](.standards/naming-policy.md) -- Source/Destination vs Server/Client conventions
- [Error and Logging Policy](.standards/error-and-logging-policy.md) -- throw/boundary rules, log levels, error codes
- [Type Safety and Schemas](.standards/type-safety-and-schemas.md) -- type flow, Standard Schema, plugin vs config
- [Type Safety Registries](.standards/type-safety-registries.md) -- declaration-merging registries for typed adapters and endpoints
- [Testing](.standards/testing.md) -- runner conventions, JSDoc-on-every-test, helpers, lifecycle, assertion patterns
- [CI/CD](.standards/ci-cd.md) -- PR gates, hook policy, peer-dependency rules, release flow

## Merge Checklist

See [DEFINITION_OF_DONE.md](DEFINITION_OF_DONE.md) for what must be satisfied before any change can be merged.

## Packages

| Package | Path | Description |
|---------|------|-------------|
| `@routecraft/routecraft` | `packages/routecraft` | Core library (builder, DSL, context, adapters, consumers) |
| `@routecraft/ai` | `packages/ai` | AI and MCP integrations |
| `@routecraft/cli` | `packages/cli` | CLI (`craft`) to run routes and contexts |
| `@routecraft/testing` | `packages/testing` | Test utilities (spy logger, testContext, pseudo, fixtures) |
| `@routecraft/eslint-plugin-routecraft` | `packages/eslint-plugin-routecraft` | ESLint plugin |
| `create-routecraft` | `packages/create-routecraft` | Project scaffolder |

## Documentation

- Docs site source: `apps/routecraft.dev/src/app/docs/`
- Key reference pages: adapters, operations, configuration, events, errors, plugins, CLI
- Source of truth is always the code under `packages/*/src/`
