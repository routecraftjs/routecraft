# Routecraft

Type-safe integration and automation framework. Monorepo with Bun workspaces (>=1.1.0).

## Quick Reference

- Install: `bun install`
- Build: `bun run build`
- Test: `bun run test`
- Lint: `bun run lint`
- Typecheck: `bun run typecheck`
- Format: `bun run format`
- Run examples: `bun run craft run ./examples/dist/hello-world.js`
- Run docs site: `bun run docs`
- All-in-one pre-PR check: `bun run all`

## Key Rules

- No `any` in production code (test files are exempt)
- No `@ts-ignore` or `@ts-expect-error` without an explanation comment
- No em-dashes in documentation, JSDoc, comments, or written output
- Use Standard Schema (`@standard-schema/spec`), not Zod/Valibot directly in shared code
- Follow Conventional Commits for commit messages; use `/git-commit-message` for detailed formatting
- Source/Destination for interfaces; Server/Client for option type names only (two-sided adapters)
- Every test must have JSDoc with `@case`, `@preconditions`, and `@expectedResult`
- The published `craft` CLI binary uses `#!/usr/bin/env bun` and `engines.bun >= 1.1.0`; the core library targets both Node 22.0+ and Bun. The root `bun run craft` workspace shortcut invokes the built `dist/index.js` via `node` for development convenience -- this is intentional and does not loosen the binary's runtime requirement.
- New optional-peer dynamic imports MUST go through `loadOptionalPeer` (`packages/routecraft/src/adapters/shared/optional-peer.ts`) and emit `RC5017` with an install hint. Existing bespoke try/catch sites (mail, jose, telemetry sqlite, several `@routecraft/ai` modules) are scheduled for migration in #287; cite that issue when touching them.
- Use `bun run <script>` for `package.json` scripts and `bunx <bin>` for one-shot binary execution (e.g. `bunx madge`, `bunx create-routecraft`)

## Internal Standards

Detailed coding standards for contributors live in `.standards/`:

- [Adapter Architecture](.standards/adapter-architecture.md) -- patterns, file structure, facade, authoring guide
- [Exchange State Model](.standards/exchange-state-model.md) -- where state lives on an exchange (`body`/`headers` vs derivations), halt/continue contract
- [Naming Policy](.standards/naming-policy.md) -- Source/Destination vs Server/Client conventions
- [Error and Logging Policy](.standards/error-and-logging-policy.md) -- throw/boundary rules, log levels, error codes
- [Type Safety and Schemas](.standards/type-safety-and-schemas.md) -- type flow, Standard Schema, plugin vs config
- [Type Safety Registries](.standards/type-safety-registries.md) -- declaration-merging registries for typed adapters and endpoints
- [Testing](.standards/testing.md) -- runner conventions, JSDoc-on-every-test, helpers, lifecycle, assertion patterns
- [CI/CD](.standards/ci-cd.md) -- PR gates, hook policy, peer-dependency rules, release flow
- [Resilience Wrappers](.standards/resilience-wrappers.md) -- dual-mode wrapper pattern (`.error()` and future resilience ops), authoring contract

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
