# RouteCraft Internal Standards

Internal development standards for RouteCraft contributors (human and AI). These complement the public documentation at [routecraft.dev](https://routecraft.dev), which covers user-facing guides and API reference.

**Boundary:** If it tells you how to _use_ RouteCraft, it belongs in the docs site. If it tells you how to _build_ RouteCraft internally, it belongs here.

## Standards

| Document | Scope |
|----------|-------|
| [Adapter Architecture](./adapter-architecture.md) | Patterns, file structure, facade, authoring guide, skeletons, and anti-patterns for adapters |
| [Naming Policy](./naming-policy.md) | Source/Destination vs Server/Client naming conventions for interfaces and option types |
| [Error and Logging Policy](./error-and-logging-policy.md) | Throw/boundary rules, structured logging, level semantics, error code philosophy |
| [Type Safety and Schemas](./type-safety-and-schemas.md) | Type flow policy, Standard Schema usage, plugin vs config vs store guidance |

## Related

- [Definition of Done](../DEFINITION_OF_DONE.md) -- merge checklist for every change
- [Contribution Guide](https://routecraft.dev/docs/community/contribution-guide) -- development workflow, branching, PR checklist
