# Routecraft Internal Standards

Internal development standards for Routecraft contributors (human and AI). These complement the public documentation at [routecraft.dev](https://routecraft.dev), which covers user-facing guides and API reference.

**Boundary:** If it tells you how to _use_ Routecraft, it belongs in the docs site. If it tells you how to _build_ Routecraft internally, it belongs here.

## Standards

| Document | Scope |
|----------|-------|
| [Positioning](./positioning.md) | What Routecraft is for: the connective layer between agents, MCP servers and systems, never a reimplementation of what it connects. Enable a capability, never own it, with the Docker sandbox as the bar; protocol, operation or product as the fast test; the three questions behind it; the four homes a capability can land in; a named consumer as the demand test; and the instruction to raise a misplaced feature before building it, as a challenge rather than a veto |
| [Adapter Architecture](./adapter-architecture.md) | Patterns, file structure, facade, authoring guide, skeletons, and anti-patterns for adapters |
| [Exchange State Model](./exchange-state-model.md) | Where state lives on an exchange (`body`/`headers` vs derivations like `id`/`principal`/`logger`), halt/continue serialization contract, getter pattern for cross-cutting concerns |
| [Naming Policy](./naming-policy.md) | Source/Destination vs Server/Client naming, schema field names (`input`/`output`), prompt-source field names |
| [Error and Logging Policy](./error-and-logging-policy.md) | Throw/boundary rules, structured logging, level semantics, error code philosophy |
| [Type Safety and Schemas](./type-safety-and-schemas.md) | Type flow policy, factory option types (no `Partial<>` on factory args), Standard Schema usage, plugin vs config vs store guidance |
| [Plugin Architecture](./plugin-architecture.md) | The kernel and its import boundary, the plugin descriptor, ports, the fixed chain with its slots and phases, typed steps, facets and `defineProject`, the continuation protocol, the default plugins, and the RC1101-RC1117 faults |
| [Plugin Lifecycle](./plugin-lifecycle.md) | The three hooks (`bind` / `start` / `stop`) in dependency order, which work belongs in each, what a `start()` hook may do, ordering and failure semantics, readiness via `whenStarted()` |
| [Testing](./testing.md) | Runner conventions, JSDoc-on-every-test, helpers from `@routecraft/testing`, lifecycle pattern, assertion patterns |
| [CI/CD](./ci-cd.md) | PR gates, hook policy, peer-dependency rules, optional peer dependencies, release flow |
| [Package Boundaries](./package-boundaries.md) | Standards-in-core vs vendors-grouped-by-ecosystem, the bounded package count, core dependency policy (minimal-dependency ambition with pragmatic exceptions), packages created on first adapter |
| [Resilience Wrappers](./resilience-wrappers.md) | Dual-mode wrapper pattern (`.error()`, `.retry()`, `.timeout()`, `.cache()`, `.throttle()`, `.circuitBreaker()`, `.concurrency()`), authoring contract, stacking + cascade rules |
| [Pre-from Filter Chain](./pre-from-filter-chain.md) | Fixed ordered chain at route scope (`error` / `authorize` / `parse` / `input` / `throttle` / `circuitBreaker` / `retry` / `timeout` / `concurrency` / `cacheCheck` / pipeline / `cacheStore`); the platform picks the order, and every position is filled through a port by a provider, the shipped defaults unless a plugin replaces one |
| [Security](./security.md) | JWT / JWKS verification rules, principal propagation across the exchange, bearer-token handling, OAuth `userinfo` enrichment, RFC 9728 metadata, `authorize()` semantics |
| [API Stability](./api-stability.md) | The v0 policy: the whole public API is unstable, so we tag only `@internal` (non-public) and `@deprecated`; per-symbol `@experimental` / `@beta` / `@stable` tiers arrive at v1 |
| [Content and Docs](./content-and-docs.md) | Where content belongs across the docs site and blog (the five surfaces), the defaults axis between introduction and advanced (Fundamentals and Beyond the defaults), code-lives-once, nav-matches-folders, the `route.ts` public-surface decision, and the static-export redirect constraint |

## Related

- [Definition of Done](../DEFINITION_OF_DONE.md) -- merge checklist for every change
- [Contribution Guide](https://routecraft.dev/docs/community/contribution-guide) -- development workflow, branching, PR checklist
