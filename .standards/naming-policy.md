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

### Shared fields between roles

When the two roles genuinely share fields (auth config, base URL, common headers, retry policy), factor them into **XxxBaseOptions** and have both `XxxServerOptions` and `XxxClientOptions` `extends XxxBaseOptions`. Export the union as **XxxOptions**:

```ts
export interface HttpBaseOptions { auth?: HttpAuth; baseUrl?: string; }
export interface HttpServerOptions extends HttpBaseOptions { /* server-only */ }
export interface HttpClientOptions extends HttpBaseOptions { /* client-only */ }
export type HttpOptions = HttpServerOptions | HttpClientOptions;
```

When the two roles do not share fields (e.g. `mail`: IMAP polling on the server side and SMTP send on the client side), declare each independently and export the union directly:

```ts
export interface MailServerOptions { /* IMAP-only */ }
export interface MailClientOptions { /* SMTP-only */ }
export type MailOptions = MailServerOptions | MailClientOptions;
```

Do not invent an empty `XxxBaseOptions` to make the structure look uniform; the union is what matters and an empty parent only adds friction. The decision rule is "would I write the same field on both Server and Client?" -- if yes for two or more fields, factor; otherwise, declare independently.

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

## Acronym casing

Acronyms in identifiers are cased as words: only the first letter is
capitalised, however the acronym is written in prose. `Http` (not `HTTP`),
`Csv`, `Jsonl`, `Mcp`, `Carddav` (not `CardDAV`). Prose and comments keep
the canonical spelling ("the CardDAV protocol", "an HTTP request"); only
identifiers fold. CONSTANT_CASE names uppercase the whole acronym as usual
(`CARDDAV_CLIENT_MANAGER`, `DEFAULT_CARDDAV_SERVER_URL`).

Why: mixed-caps acronyms produce unreadable juxtapositions
(`CardDAVVCardLike`) and inconsistent prefix searches; `Http` is the
established precedent across the codebase.

## File-family option pattern

Adapters in the file family (file, json, jsonl, csv) expose ONE options
type for file I/O, `XxxFileOptions`, discriminated by `mode`
(`'read' | 'write' | 'append' | 'delete'`) plus `chunked` for per-record
source emission, instead of separate `XxxSourceOptions` /
`XxxDestinationOptions` types. Fields that only apply to one mode say so
in their JSDoc (`createDirs` is destination-only, `onParseError` is
source-only). Factory overloads narrow the same type per call shape
(`XxxFileOptions & { chunked: true }`, `& { mode: 'read' }`); they never
introduce new option types. Transformer mode (no `path`) keeps its own
`XxxTransformerOptions`, and the adapter's `XxxOptions` is the union of
the two.

Why: the file adapters are one behaviour with modes, not two adapters;
split option types duplicated shared fields (`path`, `encoding`,
`reviver`) and needed a third "combined" type for the source+destination
overload. `JsonFileOptions` and `CsvFileOptions` set the pattern;
`JsonlFileOptions` folded `JsonlSourceOptions` / `JsonlDestinationOptions`
/ `JsonlCombinedOptions` into it.

## Summary

| What | Convention |
|------|-----------|
| Interfaces | `Source` / `Destination` (pipeline role; all adapters) |
| Option types (two-sided) | `XxxServerOptions` / `XxxClientOptions` |
| Option types (single-role) | `XxxOptions` |
| File-family file I/O | single `XxxFileOptions`, discriminated by `mode` / `chunked` |
| Acronyms in identifiers | first-letter caps only (`Http`, `Carddav`, `Jsonl`) |
| Schema fields | `input` / `output` (route builder and adapter options) |
| Domain prompt source | `user` (chat) or `using` (embedding); not `input` |

For the structural pattern (base, union, intersection), see [adapter-architecture.md](./adapter-architecture.md). For factory option-type rules, see [type-safety-and-schemas.md](./type-safety-and-schemas.md#factory-option-types).
