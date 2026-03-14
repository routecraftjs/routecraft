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

## Summary

| What | Convention |
|------|-----------|
| Interfaces | `Source` / `Destination` (pipeline role; all adapters) |
| Option types (two-sided) | `XxxServerOptions` / `XxxClientOptions` |
| Option types (single-role) | `XxxOptions` |

For the structural pattern (base, union, intersection), see [adapter-architecture.md](./adapter-architecture.md).
