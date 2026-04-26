# Naming Policy

Naming conventions for Routecraft adapters, interfaces, and option types.

---

## Pipeline role (all adapters)

- **Source** = where messages enter the route (`.from(...)`). Interface: `Source<T>`; method: `subscribe`.
- **Destination** = where messages go (`.to()`, `.enrich()`, `.tap()`). Interface: `Destination<T, R>`; method: `send`.

Keep **Source** and **Destination** for these interfaces. They are protocol-agnostic and apply to every adapter (timer, log, direct, mcp, http, etc.).

## Protocol config (two-sided adapters only)

For adapters that can both receive and send on a protocol (direct, mcp, http, websocket), use **Server** and **Client** in **option type names only**:

- **XxxServerOptions** = options when the adapter is used as a source (we receive / we serve).
- **XxxClientOptions** = options when the adapter is used as a destination (we send / we call).

Examples: `DirectServerOptions` / `DirectClientOptions`, `McpServerOptions` / `McpClientOptions`, `HttpServerOptions` / `HttpClientOptions`.

## Single-role adapters

Adapters that only act as source or only as destination (timer, simple, log, noop) use a single options type: **XxxOptions** (e.g., `TimerOptions`, `LogOptions`). Do not use Server/Client in their option names.

## Schema field names

When an adapter or builder method declares a Standard Schema for a body / payload, use **`input`** and **`output`**. Do not invent variants like `schema`, `inputSchema`, `outputSchema`, `requestSchema`, or `responseSchema`, unless there is a standard.

### On the route builder

```ts
craft()
  .from(direct())
  .input(BodySchema)    // validates the source body
  .output(ResultSchema) // validates the final result
```

### On adapter option types

```ts
agent({
  system: "...",
  output: ResultSchema, // declared output shape, validated after the call
})

llm("anthropic:claude-sonnet-4-6", {
  output: ResultSchema,
})

const greet: FnOptions = {
  description: "Greets someone",
  input: NameSchema,    // validates the LLM-supplied input
  handler: async (input) => `hello ${input.name}`,
}
```

### Exceptions

- **External wire formats** keep their on-the-wire names. The MCP protocol defines tool descriptors with `inputSchema` / `outputSchema`; types that mirror the wire format (e.g., `McpTool` in `packages/ai/src/mcp/types.ts`) keep those names. Field-level renames here would lie about the protocol.
- **Domain-specific prompt sources** use a domain-accurate name, not `input`. Chat-shaped adapters use `user` (paired with `system`); embedding adapters use `using`. These compute the value the model consumes, which is conceptually different from a validating schema. The `input` name is reserved for schema fields, so collision-free naming forces a different word here.

### Why

A consistent vocabulary across the framework (`input` / `output`) means a reader can move between adapters without learning per-adapter renames. The previous mix (`schema`, `outputSchema`, etc.) made it harder to reason about which adapter validated what.

## Summary

| What | Convention |
|------|-----------|
| Interfaces | `Source` / `Destination` (pipeline role; all adapters) |
| Option types (two-sided) | `XxxServerOptions` / `XxxClientOptions` |
| Option types (single-role) | `XxxOptions` |
| Schema fields | `input` / `output` (route builder and adapter options) |
| Domain prompt source | `user` (chat) or `using` (embedding); not `input` |

For the structural pattern (base, union, intersection), see [adapter-architecture.md](./adapter-architecture.md). For factory option-type rules, see [type-safety-and-schemas.md](./type-safety-and-schemas.md#factory-option-types).
