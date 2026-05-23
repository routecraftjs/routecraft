# Routecraft Internal Standards

Internal development standards for Routecraft contributors (human and AI). These complement the public documentation at [routecraft.dev](https://routecraft.dev), which covers user-facing guides and API reference.

**Boundary:** If it tells you how to _use_ Routecraft, it belongs in the docs site. If it tells you how to _build_ Routecraft internally, it belongs here.

## Standards

| Document | Scope |
|----------|-------|
| [Adapter Architecture](./adapter-architecture.md) | Patterns, file structure, facade, authoring guide, skeletons, and anti-patterns for adapters |
| [Exchange State Model](./exchange-state-model.md) | Where state lives on an exchange (`body`/`headers` vs derivations like `id`/`principal`/`logger`), halt/continue serialization contract, getter pattern for cross-cutting concerns |
| [Naming Policy](./naming-policy.md) | Source/Destination vs Server/Client naming, schema field names (`input`/`output`), prompt-source field names |
| [Error and Logging Policy](./error-and-logging-policy.md) | Throw/boundary rules, structured logging, level semantics, error code philosophy |
| [Type Safety and Schemas](./type-safety-and-schemas.md) | Type flow policy, factory option types (no `Partial<>` on factory args), Standard Schema usage, plugin vs config vs store guidance |
| [Type Safety Registries](./type-safety-registries.md) | Declaration-merging registries for typed adapters and endpoints; codegen direction |
| [Testing](./testing.md) | Runner conventions, JSDoc-on-every-test, helpers from `@routecraft/testing`, lifecycle pattern, assertion patterns |
| [CI/CD](./ci-cd.md) | PR gates, hook policy, peer-dependency rules, optional peer dependencies, release flow |
| [Resilience Wrappers](./resilience-wrappers.md) | Dual-mode wrapper pattern (`.error()` and future `.retry()`/`.timeout()`/`.cache()`/...), authoring contract, stacking + cascade rules |
| [Security](./security.md) | JWT / JWKS verification rules, principal propagation across the exchange, bearer-token handling, OAuth `userinfo` enrichment, RFC 9728 metadata, `authorize()` semantics |
| [API Stability](./api-stability.md) | The v0 policy: the whole public API is unstable, so we tag only `@internal` (non-public) and `@deprecated`; per-symbol `@experimental` / `@beta` / `@stable` tiers arrive at v1 |

## Related

- [Definition of Done](../DEFINITION_OF_DONE.md) -- merge checklist for every change
- [Contribution Guide](https://routecraft.dev/docs/community/contribution-guide) -- development workflow, branching, PR checklist
