# Naming Policy

Naming conventions for Routecraft adapters, interfaces, and option types.

---

## Pipeline role (all adapters)

- **Source** = stream IN, 0..N exchanges (`.from(...)`). Interface: `Source<T>`; method: `subscribe`.
- **Destination** = push OUT, per exchange, strictly void (`.to()`, `.tap()`). Interface: `Destination<T>`; method: `send`.
- **Enricher** = pull IN, per exchange, produces a value (`.enrich()`; also accepted by `.to()` / `.tap()`). Interface: `Enricher<T, R>`; method: `fetch`.

Keep **Source**, **Destination**, and **Enricher** for these interfaces. They are protocol-agnostic and apply to every adapter (timer, log, direct, mcp, http, etc.). Class names follow the role: `{Concept}EnricherAdapter` for the fetch role (`HttpEnricherAdapter`, `MailEnricherAdapter`), `{Concept}DestinationAdapter` for the send role.

## Protocol config (two-sided adapters only)

For adapters that can both receive and send on a protocol (direct, mcp, http, websocket), use **Server** and **Client** in **option type names only**:

- **XxxServerOptions** = options when the adapter is used as a source (we receive / we serve).
- **XxxClientOptions** = options when the adapter reaches out (we send / we call). Which pipeline role that is depends on the protocol: request/response clients (`http`, `mcp`, `direct`) call and get an answer back, so their client side is the **enricher** (`fetch`); a fire-and-forget client is a **destination** (`send`). The `Client` name describes which end of the protocol we are on, not which slot the adapter implements. Two-sided adapters whose client half does both name the slots, not the options.

Examples: `DirectServerOptions` / `DirectClientOptions`, `McpServerOptions` / `McpClientOptions`, `HttpServerOptions` / `HttpClientOptions`.

### Shared fields between roles

The base-options factoring pattern (`XxxBaseOptions` extended by both role types, exported `XxxOptions` union) is documented user-facing in the custom-adapters guide (`apps/routecraft.dev/app/content/docs/advanced/custom-adapters/index.mdx`, "Options naming" section). The decision rule is "would I write the same field on both Server and Client?" -- if the roles genuinely share fields, factor into a base (the `direct` adapter factors one for a single shared field); if they share nothing (`mail`), declare each role independently and export the union directly. Do not invent an empty `XxxBaseOptions` to make the structure look uniform; the union is what matters and an empty parent only adds friction.

### Discriminating the two sides

Every call shape of a multiplexed factory must be distinguishable by a **required, side-unique key** (or by argument kind: string vs object vs function). At most one side per facade may offer an all-optional "bare default" form; that slot goes to the most common zero-config use.

| Facade | Discrimination |
|--------|----------------|
| `http` | `path` (server/source) vs `url` (client/enricher), both required |
| `mcp` | bare object (source) vs required `url` / `serverId` (client/enricher) |
| `carddav` | bare object (source + enricher) vs required `action` (destination) |
| `direct` | bare/options object (source) vs endpoint string/function (enricher) |
| `mail` | bare object (send) vs required `folder` (enricher) vs required `action` (operations) |

Key-sniffing heuristics over *optional* keys are forbidden. TypeScript resolves overloads from arguments only (never from the `.to()` / `.enrich()` context), so when two sides are both all-optional the compiler silently picks the first structurally matching overload while the runtime guesses from whichever keys happen to be present -- the two drift apart and the types lie (issue #433 is the case study; the mail adapter's old `hasServerKeys()` shipped four keys out of sync). Optional phantom/brand fields do not fix this: they do not affect assignability of object literals.

When an ambiguous shape can still reach the factory at runtime (plain JS), throw `RC5003` naming the conflicting keys; never guess a side.

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

Adapters in the file family (file, json, jsonl, csv, xml, html) expose ONE
options type for file I/O, `XxxFileOptions`, shared by all three roles.
There is no `mode` option: the operation keyword selects the role
(`.from()` subscribes, `.to()` sends, `.enrich()` fetches). Send behavior
is tuned by same-type options (`append: true`, `delete: true`, mutually
exclusive, guarded with `RC5003` at construction); `chunked: true` is the
one sanctioned option that changes the Source item type (per-record
emission) and requires the literal `true` (a widened boolean is a compile
error). Fields that only apply to one role say so in their JSDoc
(`createDirs` is send-only, `onParseError` is source-only). Factory
overloads narrow the same type per call shape (`XxxFileOptions &
{ chunked: true }`); they never introduce new option types. Transformer
mode (no `path`) keeps its own `XxxTransformerOptions`, and the adapter's
`XxxOptions` is the union of the two. `path` always means a file path;
a transformer's extraction key uses a different name (json's `pointer`).

Why: the file adapters are one behaviour across roles, not two adapters;
split option types duplicated shared fields (`path`, `encoding`,
`reviver`) and needed a third "combined" type. The old `mode` option
changed the adapter's TYPE from an option VALUE, which forced overload
sprawl and widened-option holes (see issue #532); roles-on-slots removed
it.

## Summary

| What | Convention |
|------|-----------|
| Interfaces | `Source` / `Destination` / `Enricher` (pipeline role; all adapters) |
| Option types (two-sided) | `XxxServerOptions` / `XxxClientOptions` |
| Option types (single-role) | `XxxOptions` |
| File-family file I/O | single `XxxFileOptions`, shared by all roles; `chunked` / `append` / `delete` options |
| Acronyms in identifiers | first-letter caps only (`Http`, `Carddav`, `Jsonl`) |
| Schema fields | `input` / `output` (route builder and adapter options) |
| Domain prompt source | `user` (chat) or `using` (embedding); not `input` |

For the structural pattern (base, union, intersection), see [adapter-architecture.md](./adapter-architecture.md). For factory option-type rules, see [type-safety-and-schemas.md](./type-safety-and-schemas.md#factory-option-types).
