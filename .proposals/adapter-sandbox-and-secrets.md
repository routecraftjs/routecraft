# Proposal: Adapter sandbox and secret isolation

Status: planned, not yet implemented. Sequenced after the Exchange immutability refactor (`claude/immutable-route-exchange-2WOUf`). Pre-v1; breaking changes are acceptable.

## Why

A community marketplace of adapters is on the roadmap. Today the framework hands every adapter a live `CraftContext` reference, and `CraftContext.store` is a single shared `Map` that holds:

- LLM API keys (`ADAPTER_LLM_PROVIDERS`, `packages/ai/src/llm/types.ts:8`)
- Mail credentials (`MAIL_CLIENT_MANAGER`, `packages/routecraft/src/adapters/mail/shared.ts:27`)
- Embedding keys (`ADAPTER_EMBEDDING_PROVIDERS`)
- MCP auth tokens (`ADAPTER_MCP_CLIENT_SERVERS`)
- Direct route metadata, agent registries, function registries

Every adapter `send()` / `process()` call currently does `getExchangeContext(exchange)` (`packages/routecraft/src/exchange.ts:306`) and gets the full context back. There is no namespace, no access control, and no redaction. A buggy or malicious community adapter, or an LLM whose tool got prompt-injected, can call `context.getStore(ADAPTER_LLM_PROVIDERS)` and walk away with every API key the host provided.

The most acute path: `makeFnHandlerContext` in `packages/ai/src/agent/tool-bridge.ts:152-157` injects the full context into every agent tool handler. A tool that returns a stringified secret hands it straight to the model.

The Exchange immutability work closes the principal-rewrite path (`principal` becomes readonly). It does not close the credential-exfiltration paths above. Those need their own design.

## Threat model

The system must protect against:

1. A buggy adapter reading store keys it does not own.
2. A malicious adapter mutating shared state another adapter depends on.
3. An adapter leaking the live context to an AI agent (intentionally or via a tool result).
4. An adapter reading environment variables it was not explicitly handed.

We are not yet defending against adversarial code in a multi-tenant runtime; that is a worker-thread / V8-isolate problem and is out of scope.

## Design

### A. `Secret<T>` wrapper (highest leverage)

```ts
class Secret<T> {
  #value: T;
  constructor(value: T) { this.#value = value; }
  toString(): string { return "[REDACTED]"; }
  toJSON(): string { return "[REDACTED]"; }
  [Symbol.for("nodejs.util.inspect.custom")]() { return "[REDACTED]"; }
  // No public getter.
}
```

`unwrapSecret` lives in a non-exported internal module that only framework I/O helpers (`SafeHttp`, the LLM dispatcher, the MCP client, DB clients) can import.

Effect:

- Logging a config object never leaks the secret.
- Returning a `Secret` from a tool result never leaks it to the LLM (`JSON.stringify` calls `toJSON` and gets `[REDACTED]`; the AI SDK uses JSON).
- An adapter wanting to use a secret hands it to a framework I/O helper; never reads it directly.

### B. Adapters never receive `CraftContext`

Replace with a per-call narrowed `AdapterContext`:

```ts
export type AdapterContext = {
  readonly logger: Logger;
  readonly signal: AbortSignal;
  readonly http: SafeHttp;
  readonly store: ScopedStore;
};
```

The engine builds one per step. The public `getExchangeContext` is removed from package entrypoints. The symbol-keyed fallback at `packages/routecraft/src/exchange.ts:388-391` (`Symbol.for("routecraft.exchange.internals")`) is deleted; the WeakMap becomes the only path and is not exported.

### C. Adapter manifest

```ts
defineAdapter({
  name: "@community/postgres",
  version: "1.0.0",
  reads: [],                                 // store keys readable
  writes: ["@community/postgres/pool"],      // store keys writable
  secrets: ["connectionString"],             // secrets the user injects
  factory(opts: { connectionString: Secret<string> }, ctx: AdapterContext) { ... }
});
```

The framework enforces declarations at runtime. `ctx.store.get(key)` on undeclared key throws. `ctx.store.set(key, value)` on unowned key throws. Plugins use the same gate via `PluginContext`.

Store keys gain a namespace convention `@scope/package/name` for clear ownership.

### D. Default-deny on agent tool handlers

Change `makeFnHandlerContext` (`packages/ai/src/agent/tool-bridge.ts:152-157`):

```ts
function makeFnHandlerContext(toolName, _ctx, abortSignal): FnHandlerContext {
  return {
    logger: frameworkLogger.child({ tool: toolName }),
    abortSignal,
    // context: omitted by default
  };
}
```

Tools opt in explicitly:

```ts
fn("get-user-by-id", { needsStore: ["@app/users/repo"] }, async (input, ctx) => { ... });
```

Tool outputs are screened for `Secret` instances before being returned to the LLM.

### E. Plugins use `PluginContext`

`apply(ctx: CraftContext)` becomes `apply(ctx: PluginContext)`. Scoped store, scoped event subscription, capability methods (`registerAdapterFactory`, `registerSecretProvider`). First-party plugins (telemetry) opt into `trusted: true` for broad access.

### F. Logger redaction

With `Secret<T>` in place, structured logs are mostly safe by default. Add Pino `redact` defaults (`*.password`, `*.apiKey`, `*.token`, `authorization`) in `packages/routecraft/src/logger.ts`. Exchange body logging stays opt-in.

### G. Worker / VM isolation: not now

True process isolation is the right answer for actively malicious code in a multi-tenant runtime. Out of scope. Capability narrowing + `Secret` + default-deny closes the realistic threat model at near-zero runtime cost.

## Migration plan (single PR after immutability lands)

1. Introduce `Secret<T>` in `packages/routecraft/src/secret.ts` with internal `unwrapSecret` in a sibling module.
2. Introduce `AdapterContext` in `packages/routecraft/src/adapter-context.ts` and `PluginContext` in `plugin-context.ts`. Engine builds one per step.
3. Make `getExchangeContext` framework-private. Remove the symbol fallback in `exchange.ts:388-391`.
4. Add adapter manifest type and runtime enforcement on `ScopedStore.get` / `set`.
5. Convert first-party adapters: mail, direct, cron, file, http, LLM providers, MCP, embedding, agent. Credentials become `Secret<string>`.
6. Update `makeFnHandlerContext` to omit context by default. Add per-tool capability declarations. Screen outputs for `Secret`.
7. Migrate plugin signature; first-party telemetry opts into `trusted: true`.
8. Add Pino `redact` defaults in `logger.ts`.
9. New standards doc `.standards/adapter-security.md`. Update `.standards/adapter-architecture.md`.
10. Update marketplace-facing docs in `apps/routecraft.dev`.

## Critical files

- `packages/routecraft/src/secret.ts` (new) plus internal `secret-internal.ts` for `unwrapSecret`
- `packages/routecraft/src/adapter-context.ts` (new), `plugin-context.ts` (new)
- `packages/routecraft/src/context.ts` (scoped store, manifest enforcement, plugin signature)
- `packages/routecraft/src/exchange.ts` (remove public `getExchangeContext`, drop `INTERNALS_KEY` symbol fallback)
- `packages/routecraft/src/brand.ts` (remove the externally-exposed internals symbol)
- `packages/routecraft/src/logger.ts` (Pino redact defaults)
- `packages/routecraft/src/adapters/mail/shared.ts`, `send-destination.ts`
- `packages/routecraft/src/adapters/direct/shared.ts`
- `packages/routecraft/src/adapters/cron/source.ts`
- `packages/routecraft/src/adapters/http/destination.ts`
- `packages/routecraft/src/adapters/file/destination.ts`, `source.ts`
- `packages/ai/src/llm/types.ts`, `plugin.ts`, dispatcher
- `packages/ai/src/embedding/types.ts`, `plugin.ts`
- `packages/ai/src/mcp/types.ts`, `adapters/mcp/destination.ts`
- `packages/ai/src/agent/tool-bridge.ts`
- `packages/ai/src/agent/store.ts`, `plugin.ts`
- `packages/ai/src/fn/store.ts`
- `.standards/adapter-architecture.md`
- `.standards/adapter-security.md` (new)
- `apps/routecraft.dev/src/app/docs/...`

## Verification

- `bun run typecheck`: removing the public `getExchangeContext` export should produce compile errors at every adapter call site that currently reaches the context. Convert each.
- New test: `JSON.stringify({ apiKey: new Secret("sk-..." )})` returns `[REDACTED]`. Same for `util.inspect` and template-string coercion.
- New test: an adapter whose manifest does not declare `reads: ["@some/key"]` cannot read that key at runtime; `ctx.store.get("@some/key")` throws.
- New test: an agent tool registered without `needsContext` cannot reach `CraftContext`. A tool that returns a `Secret` instance has its output redacted before reaching the model.
- Audit: `grep -r "Symbol.for(\"routecraft.exchange.internals\")"` returns no public exports.
- Audit: `grep -r "process.env" packages/` returns only first-party plugin code that explicitly resolves env vars at startup; no adapter reads env directly.
- Run a full LLM route end-to-end with a fake provider asserting the unwrapped key matches the user-supplied `Secret`.
