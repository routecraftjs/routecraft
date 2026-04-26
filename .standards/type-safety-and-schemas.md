# Type Safety and Schemas

Type flow policy, Standard Schema usage, and plugin vs config guidance for Routecraft.

---

## Type Safety Policy

Routecraft must be **100% type safe**. The exchange body (or destination result) type must be **passed by every operation always** -- no operation should drop or widen the type to `unknown` unless that is the explicit contract (e.g., a source with no schema).

### What this means

- **Sources** (e.g., `direct`, `mcp`, `simple`): Declare the body type `T` they produce. When a schema is provided, infer `T` from the schema (e.g., `StandardSchemaV1.InferOutput<S>`) so the route is typed from the start.
- **Destinations** (e.g., `to`, `tap`, `enrich`): Declare the result type `R` they return. When a schema or typed option is provided (e.g., `llm(..., { output })`), the result type must reflect it.
- **Steps** (transform, process, filter, validate, header, split, aggregate, enrich): Input is `Current`; output type must be explicit. After a step, the route's `Current` type must be updated so the next step receives the correct type.
- **Helpers** (e.g., `only`, `json`): Preserve or infer types. `only(getValue, into)` should type `getValue` as `(r: R) => V` and, when `into` is a string literal, allow the builder to infer the enriched body type.
- **Runtime:** The builder chain is fully typed. The runnable `Route` and event/consumer handlers receive `Exchange` (body: `unknown`) at runtime; use `Route<T>` when you know the body type, or narrow/assert in handlers.

### Rules

1. **No unnecessary `unknown`.** Prefer inferring types from schemas, callbacks, or literal options so that `unknown` is only used when there is no type information.
2. **Generics must flow.** Every public API that accepts or produces a body/result type must use generics (`Source<T>`, `Destination<T, R>`, `Transformer<T, R>`, `DestinationAggregator<T, R>`) and the builder must propagate `Current` through the chain.
3. **New operations and adapters:** Declare input and output types; ensure the route builder's `Current` is updated after the step so downstream steps stay typed.
4. **Tests:** Add type-level tests (e.g., `expectTypeOf`) where new type inference or propagation is added, so regressions are caught.

---

## Factory option types

Adapter factories must use the option interface directly. Do not wrap factory args in `Partial<>`.

### Rule

```ts
// Good: required fields are required, optional fields are marked ? on the interface.
export interface EmbeddingOptions<T = unknown> {
  using: (exchange: Exchange<T>) => string | string[];
}

export function embedding<T>(
  modelId: EmbeddingModelId,
  options: EmbeddingOptions<T>, // not Partial<EmbeddingOptions<T>>
): Destination<T, EmbeddingResult> { ... }
```

```ts
// Bad: Partial<> hides the requirement, so embedding(modelId, {}) typechecks
// but throws at runtime.
export function embedding<T>(
  modelId: EmbeddingModelId,
  options?: Partial<EmbeddingOptions<T>>,
): Destination<T, EmbeddingResult> { ... }
```

If every field on the option interface is optional, the factory parameter itself can be optional (`options?: HttpOptions`). The interface stays the source of truth for what is required.

### Where `Partial<>` is allowed

`Partial<>` is a legitimate type for **partial overrides**, not for factory args:

| Site | Why `Partial<>` is correct |
|------|---------------------------|
| Plugin `defaultOptions?: Partial<T>` | Defaults can supply any subset of fields. |
| `MergedOptions<T>.options: Partial<T>` | Adapter instance options merge with context defaults. |
| Internal merge helpers (e.g., `MailClientManager.resolveImapOptions(account, overrides: Partial<MailServerOptions>)`) | Per-call overrides are partial by definition. |

### Why

The factory is the user-facing system boundary, so it carries the strongest contract. Wrapping its args in `Partial<>` defeats the type system: the interface declares `using` as required, but `Partial<>` quietly makes it optional, so the failure surfaces at runtime instead of at the call site. The embedding adapter shipped with this exact bug for the duration the wrapper was in place.

The framework boundary (plugin defaults, `MergedOptions<T>`) is a different surface where partial values are the actual contract. Keep `Partial<>` there; remove it from factories.

---

## Standard Schema over Library-Specific APIs

Prefer **`@standard-schema/spec`** types so code works with any spec-compliant library (Zod, Valibot, ArkType, etc.) instead of coupling to one.

### Types to use

| Type | Purpose |
|------|---------|
| `StandardSchemaV1` | Validation/parsing. Has `~standard.validate(value)`. Use in option types, plugin options, and route schema parameters. |
| `StandardJSONSchemaV1` | JSON Schema conversion. Has `~standard.jsonSchema.input(options)`. Use for OpenAPI, MCP tool schemas, or other JSON Schema output. |

Import only from `@standard-schema/spec` (e.g., `import type { StandardSchemaV1 } from "@standard-schema/spec"`). Do not depend on `zod`, `valibot`, or `arktype` in shared/core code.

### In public APIs and options

- **Schema options:** Type as `StandardSchemaV1`. Example: `schema?: StandardSchemaV1` on direct/mcp options.
- **Validation:** Call `schema['~standard'].validate(value)` and handle `result.issues` / `result.value`. Do not use `z.parse()` or library-specific APIs in framework code.
- **JSON Schema from a schema:** If the schema has `~standard.jsonSchema?.input`, call it with the draft you need. Do not use `z.toJSONSchema()` or library-specific converters in shared code.
- **Type inference from schema:** Use `StandardSchemaV1.InferOutput<S>` so the body or result type is inferred when a schema is provided; when omitted, keep the type as `unknown`.

### When library-specific code is acceptable

- **Tests** may use a single library (e.g., Zod) for convenience.
- **Example apps** may use one library for the whole example.
- **Internal validation** of plugin/config options can use a specific library if not exposed as "accept any schema."

### In examples and docs

- Examples can use any compliant library. Prefer showing one (e.g., Zod) for clarity, but mention that any Standard Schema implementation works.
- When documenting "schema" parameters, refer to "Standard Schema" or `StandardSchemaV1` and link to [standardschema.dev](https://standardschema.dev).

---

## Plugin vs Config vs Store

### Use a plugin when

- Something must be **started, stopped, or managed** as a process (lifecycle). Examples: `mcpPlugin` starts the MCP server, spawns stdio subprocesses.
- Or you want a **typed, validated config helper** that populates the context store. Document it clearly in JSDoc (e.g., "Config only; no lifecycle hooks."). Example: `llmPlugin`.

Plugins may be lifecycle-only, config-helper-only, or both.

### Context store

The context store is the underlying mechanism for sharing config between plugins and adapters. Prefer plugin helpers to populate it (typed options, validation). Advanced users can set store directly: `builder.store(KEY, value)`.

### Route: named vs inline

Adapters in routes can be:

- **Named:** Reference a pre-registered backend by id (e.g., `mcp("browser:screenshot")`, `llm("ollama:llama3")`). Config comes from context store (plugin or `builder.store()`). Preferred for recurring, credentialed, or auditable backends.
- **Inline:** Full options in the route (e.g., `http({ url, method })`, `mcp({ url, tool })`, `agent({ modelId, ... })`). Use for ad-hoc or dynamic cases.

### stdio = plugin only

Routes **never** spawn processes. Stdio MCP clients are registered in `mcpPlugin({ clients: { name: { command, args } } })` and managed at `contextStarted` / `contextStopping`. The route API does not expose a stdio option; only HTTP (inline `url` or named `serverId`) is valid in a route.

---

## Module Augmentation

Every `declare module` block inside `packages/*/src/**` must target the published package specifier, never a relative path.

```ts
// Good
declare module "@routecraft/routecraft" {
  interface RouteBuilder<Current> {
    myMethod(...): RouteBuilder<Current>;
  }
}

// Bad -- relative specifier
declare module "./builder.ts" { ... }
declare module "../exchange.ts" { ... }
```

### Why

`tsup` bundles per-package declarations into a single `dist/index.d.ts`. Relative specifiers survive verbatim into that bundle and no longer resolve in a consumer's module graph. TypeScript then silently drops the augmentation, so the added methods and header keys vanish from the public types. Our own unit tests still compile (they import from `../src/`, where relative specifiers resolve at source-compile time), so the regression is invisible until a real consumer hits it.

Using the package specifier attaches the augmentation to the same `RouteBuilder` / `RoutecraftHeaders` / `StoreRegistry` that is re-exported from the entry point, so it merges correctly in both source compilation and the bundled `.d.ts`.

### Guard

`packages/create-routecraft/test/integration.test.ts` scaffolds a real project, installs `@routecraft/routecraft` via `file:` protocol, and runs `tsc --noEmit`. That typecheck resolves types through `dist/index.d.ts`, so any `declare module` with a relative specifier in the published bundle fails the test at a consumer boundary.

### Scope

This rule applies to every augmentation block, including:

- `RouteBuilder` sugar (`.log`, `.debug`, `.map`, `.schema`) in `packages/routecraft/src/dsl.ts`
- `RoutecraftHeaders` entries in `packages/routecraft/src/auth/types.ts` and per-adapter shared files
- `StoreRegistry` entries in per-adapter shared files (cron, direct, mail, split, etc.)
- Any future augmentation of a type exported from `@routecraft/routecraft`

A lint rule covering this in `@routecraft/eslint-plugin-routecraft` would be the right final state; until that lands, the integration test is the guard.

---

## References

- Standard Schema: [standardschema.dev](https://standardschema.dev)
- Standard JSON Schema: [standardschema.dev/json-schema](https://standardschema.dev/json-schema)
- Package: `@standard-schema/spec` (dependency in routecraft and ai packages)
- Builder source: `packages/routecraft/src/builder.ts`
- Types source: `packages/routecraft/src/types.ts`
