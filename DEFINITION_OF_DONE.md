# Definition of Done

Every change -- feature, fix, refactor -- must satisfy the checklists below before it can be merged. CI enforces builds, linting, formatting, and type checking automatically. The checklists here cover what CI **cannot** catch.

## Scope

The checklists below apply to **packages that ship code**: anything under `packages/*` whose published artefact contains executable JavaScript or TypeScript declarations. Documentation-only packages (no `.js`, `.ts`, or `.d.ts` files in their `files` allowlist; for example `@routecraft/skills`, which ships only Markdown and JSON) are exempt from the General Checklist test rule and the per-surface checklists. They must still satisfy: Conventional Commits, the no-em-dashes rule, and any policy that applies to documentation prose.

## General Checklist (every change)

- [ ] New or changed behavior has corresponding tests in `packages/*/test/**/*.test.ts`
- [ ] Bug fixes include a regression test that fails without the fix
- [ ] Every test has JSDoc with `@case`, `@preconditions`, and `@expectedResult`
- [ ] JSDoc on any public API you touched is accurate and up to date (`@param`, `@returns`, `@example`)
- [ ] No `@ts-ignore` or `@ts-expect-error` without an explanation comment
- [ ] No `any` types in production code (test files are exempt)
- [ ] Every new public API symbol has a TSDoc release tag: `@experimental`, `@beta`, or stable (no tag). Only promote maturity level after the API has proven itself across releases
- [ ] Symbols marked `@internal` are **never** re-exported from a package's public entry point (`index.ts`). Internal helpers must stay internal
- [ ] Magic strings (header keys, store keys, event prefixes) used by consumers are exported as named constants or enums from the package's public entry point so users get autocomplete and type safety
- [ ] Any meaningful behavior (lifecycle transition, operation execution, success, failure) emits a typed event via `CraftContext`. See the **Events and Tracing** checklist below
- [ ] Write commit messages following [Conventional Commits](https://www.conventionalcommits.org/); use the `/git-commit-message` slash command for detailed formatting
- [ ] Do not use em-dashes in documentation, JSDoc, comments, or written output

## Events and Tracing (every change that introduces observable behavior)

> Routecraft's event system is the foundation for metrics, tracing, alerting, and auditing.
> Every meaningful thing that happens must be observable through events.
> Event types live in `packages/routecraft/src/types.ts`.
> Event docs are at `apps/routecraft.dev/src/app/docs/reference/events/page.md`.

- [ ] New behavior emits events for at least: started, completed/stopped, and failed states
- [ ] Event names follow the existing hierarchical convention (e.g., `route:{routeId}:operation:{type}:{adapterId}:started`)
- [ ] Event payloads are type-safe: add a new entry to `EventDetailsMapping` in `types.ts` with a typed payload shape
- [ ] Payloads include enough context for correlation: `contextId`, `routeId`, `exchangeId`, or `correlationId` as appropriate
- [ ] Duration-sensitive operations include timing information (start timestamp at minimum; duration where practical)
- [ ] Failure events include the error or reason for failure
- [ ] Adapter operations expose structured `metadata` in their event payloads (IDs, status codes, counts -- not large bodies)
- [ ] Wildcard subscriptions still work: new event names must be compatible with `*` and `**` glob patterns
- [ ] New events are documented on the events reference page with their payload shape and when they fire
- [ ] If the change removes or renames an event, treat it as a breaking change and document the migration path
- [ ] Event payloads do not hold live mutable references that could change after emission. The `Exchange` wrapper, `headers`, and `principal` are shallow-frozen by `DefaultExchange` and safe to attach by reference; `body` is intentionally left mutable so adapter authors can attach arbitrary user payloads, so any payload that includes `exchange.body` (or other unfrozen fields like nested `principal.claims`) must be snapshotted (spread / `structuredClone`) at emission time when subscribers depend on payload stability.

## When you add or modify an adapter

> Adapters live in `packages/routecraft/src/adapters/` and `packages/ai/src/`.
> Reference docs are at `apps/routecraft.dev/src/app/docs/reference/adapters/page.md`.
> Conceptual docs are at `apps/routecraft.dev/src/app/docs/introduction/adapters/page.md`.

- [ ] Add the adapter to the overview table on the reference page
- [ ] Add a dedicated section with: function signature, description, code example(s), options table (Field | Type | Default | Required | Description)
- [ ] If the adapter has options, document every property in the options table
- [ ] Add or update the conceptual guide if the adapter introduces a new pattern
- [ ] Export the adapter from the package's `index.ts`
- [ ] If it is an AI adapter (`packages/ai/`), also update the AI package exports
- [ ] New adapters must include a JSDoc release tag on the factory function (see General Checklist)
- [ ] If the adapter depends on a third-party package, add it as an optional `peerDependency` (with `peerDependenciesMeta.<name>.optional = true`) in `@routecraft/routecraft` and as a regular `dependency` in `@routecraft/cli` so the CLI bundles it
- [ ] Optional peer drivers load via `loadOptionalPeer` (`packages/routecraft/src/adapters/shared/optional-peer.ts`), not a bespoke `try/catch`. The missing-peer error is `RC5017` with an install hint. See `.standards/ci-cd.md` § 6 for the contract; cron and html are the canonical references.
- [ ] If the adapter has a runtime-specific code path (e.g. `Bun.sql` under Bun + `pg` under Node, or `Bun.s3` + `@aws-sdk/client-s3`), add a `packages/<pkg>/test/cross-runtime/<name>.cross.test.ts` that exercises the same observable contract on both runtimes. The `adapter-cross-runtime (bun)` and `adapter-cross-runtime (node)` CI jobs run the suite on each runtime; both must pass.
- [ ] Adapter implementations do not mutate the exchange parameter. Processor / Destination / aggregator code builds a derived exchange via spread or `DefaultExchange.rewrap`; direct assignment to `exchange.body`, `exchange.headers[...]`, or `exchange.principal` is absent. Drop signalling uses `markDropped(exchange)`. (See `.standards/type-safety-and-schemas.md` § Exchange Immutability.)

## When you add or modify an operation

> Operations live in `packages/routecraft/src/operations/`.
> Reference docs are at `apps/routecraft.dev/src/app/docs/reference/operations/page.md`.
> Conceptual docs are at `apps/routecraft.dev/src/app/docs/introduction/operations/page.md`.

- [ ] Add the operation to the overview table on the reference page (with correct category)
- [ ] Add a dedicated section with: method signature (including generics), description, code example(s), key behaviors
- [ ] Document any incompatibilities (e.g., `batch()` is incompatible with `direct()`)
- [ ] Add or update the conceptual guide if needed
- [ ] If the operation is work-in-progress, mark it with `{% badge %}wip{% /badge %}`

## When you add or modify a consumer

> Consumers live in `packages/routecraft/src/consumers/`.

- [ ] Document configuration options (e.g., `size`, `time`, `merge` for batch)
- [ ] Document emitted events (e.g., `batch:started`, `batch:flushed`, `batch:stopped`)
- [ ] Update the operations reference if the consumer is selected via an operation (like `.batch()`)

## When you add or modify configuration/context options

> Reference docs are at `apps/routecraft.dev/src/app/docs/reference/configuration/page.md`.

- [ ] Add new properties to the configuration reference page with type, default, and description
- [ ] Update code examples to show the new option in use
- [ ] If it affects lifecycle behavior, update `apps/routecraft.dev/src/app/docs/reference/events/page.md`

## When you add or modify error codes

> Error reference is at `apps/routecraft.dev/src/app/docs/reference/errors/page.md`.

- [ ] Add the error code with description, cause, and suggested fix
- [ ] Use the existing `RC***` code format

## When you add or modify a plugin

> Reference docs are at `apps/routecraft.dev/src/app/docs/reference/plugins/page.md`.
> Conceptual docs are at `apps/routecraft.dev/src/app/docs/introduction/plugins/page.md`.

- [ ] Add to the reference page with interface, options, and example
- [ ] Update the conceptual guide if it introduces new plugin patterns

## When you add or modify a CLI command

> Reference docs are at `apps/routecraft.dev/src/app/docs/reference/cli/page.md`.

- [ ] Document the command, flags, and usage examples on the CLI reference page
- [ ] Ensure the CLI smoke test in CI still passes
