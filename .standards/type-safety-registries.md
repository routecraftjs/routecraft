# Type Safety: Registries

Compile-time safety for string-based adapter APIs via declaration merging.

---

## How registries work

Routecraft ships empty marker interfaces. You augment them in your project via `declare module`. When populated, adapter string parameters narrow from `string` to your registered keys - giving autocomplete and red-line errors for anything not registered. When the registries are empty (the default), everything falls back to `string` with no breaking changes.

---

## Direct endpoints

**Without registry:** `direct('anything')` accepts any string. Typos only fail at runtime.

**With registry:**

```typescript
// src/types/routecraft.d.ts
declare module '@routecraft/routecraft' {
  interface DirectEndpointRegistry {
    'payments':       PaymentRequest;
    'orders':         OrderRequest;
    'notifications':  NotificationPayload;
  }
}
```

Now:

```typescript
direct('payments', {})       // OK
direct('orders', {})         // OK
direct('invoices', {})       // red line: 'invoices' not in registry

// ForwardFn in error handlers is also constrained:
craft()
  .error((err, exchange, forward) => {
    forward('payments', { ... })   // OK
    forward('invoices', { ... })   // red line
  })
  .from(...)
```

The value type in the registry (`PaymentRequest`, `OrderRequest`, etc.) is used by `ResolveBody` to infer the body type when calling `direct(endpoint)` as a destination. When you write `.to(direct('payments'))`, TypeScript constrains the exchange body to `PaymentRequest`. Set values to the actual request body type for full inference:

```typescript
interface DirectEndpointRegistry {
  'payments': PaymentRequest;
}
```

**What this does NOT cover:**

- Auto-discovering endpoints from your route files. TypeScript cannot scan across files to collect string literals from function calls. If you write `craft().from(direct('payments', {}))` in `routes/payments.ts`, the string `'payments'` is not automatically added to the registry. You must declare it manually.
- Verifying that a registered endpoint has a matching `.from()` source at runtime. The registry says "this name is valid" but does not check that a route actually listens on it. If you register `'invoices'` but never write `craft().from(direct('invoices', {}))`, the type is happy but the message will hang at runtime.

---

## LLM providers

**Without registry:** `llm('anything:model')` accepts any string.

**With registry:**

```typescript
// src/types/routecraft.d.ts
declare module '@routecraft/ai' {
  interface LlmProviderRegistry {
    openai:    true;
    anthropic: true;
    ollama:    true;
  }
}
```

Now:

```typescript
llm('openai:gpt-5')            // OK
llm('anthropic:claude-opus-4-6') // OK
llm('ollama:llama3.2')         // OK
llm('qwen:model')              // red line: 'qwen' not in registry
llm('gemini:gemini-2.5-pro')   // red line: 'gemini' not registered
```

**What this does NOT cover:**

- Syncing the registry with your `llmPlugin({ providers: { ... } })` config. These are two separate declarations - one compile-time, one runtime. You must keep them in sync manually. If you add `gemini` to the plugin config but forget to update the registry, `llm('gemini:...')` will show a red line but work at runtime. The reverse (in registry but not in plugin config) compiles fine but crashes at runtime.
- Model-level validation. The registry constrains the provider prefix (before `:`), not the model name. `llm('ollama:this-model-does-not-exist')` will compile and only fail when the Ollama API is called. Knowing which models are actually available requires runtime introspection (e.g., polling Ollama's `/api/tags` endpoint) which is out of scope for compile-time types.

---

## MCP servers

**Without registry:** `mcp('server:tool')` accepts any `${string}:${string}`.

**With registry:**

```typescript
// src/types/routecraft.d.ts
declare module '@routecraft/ai' {
  interface McpServerRegistry {
    'github':         true;
    'local-postgres': true;
    'filesystem':     true;
  }
}
```

Now:

```typescript
mcp('github:create_issue')      // OK
mcp('local-postgres:query')     // OK
mcp('unknown-server:tool')      // red line: 'unknown-server' not in registry
```

**What this does NOT cover:**

- Tool-level validation. The registry constrains the server name prefix, not the tool name after `:`. `mcp('github:nonexistent_tool')` compiles fine and only fails when the MCP server is called. Knowing which tools a server exposes requires pinging the server and reading its tool list at dev-time.
- Syncing with `mcpPlugin({ clients: { ... } })` config. Same drift risk as LLM providers above.

---

## Putting it together

A single declaration file for your project:

```typescript
// src/types/routecraft.d.ts
import type { PaymentRequest, OrderRequest } from '../domain';

declare module '@routecraft/routecraft' {
  interface DirectEndpointRegistry {
    'payments':      PaymentRequest;
    'orders':        OrderRequest;
    'dead-letter':   unknown;
  }
}

declare module '@routecraft/ai' {
  interface LlmProviderRegistry {
    openai:    true;
    anthropic: true;
    ollama:    true;
  }

  interface McpServerRegistry {
    'github':    true;
    'postgres':  true;
  }
}
```

---

## How codegen would fix the manual declaration requirement

The core limitation is that TypeScript cannot scan your project to discover endpoint names, provider configs, or MCP tool lists. A CLI command could do this scan instead and write the declaration file for you.

### What `craft typegen` would do

```bash
bun run craft typegen
```

1. **Direct endpoints** - scan all `.ts` files for `direct('name', {` and `direct('name', options)` patterns (the two-argument form = source). Collect all string literals. Write them into `DirectEndpointRegistry`.

2. **LLM providers** - read your `craft.config.ts`, find the `llmPlugin({ providers: { ... } })` call, extract the provider keys. Write them into `LlmProviderRegistry`.

3. **MCP servers** - read your `craft.config.ts`, find `mcpPlugin({ clients: { ... } })`, extract server IDs. For each server, optionally ping it with `--introspect` to fetch its tool list and generate `McpServerToolRegistry`.

4. Output a generated file (never edit manually):

```typescript
// src/types/routecraft.generated.d.ts  (generated - do not edit)

declare module '@routecraft/routecraft' {
  interface DirectEndpointRegistry {
    'payments':      unknown;
    'orders':        unknown;
    'dead-letter':   unknown;
  }
}

declare module '@routecraft/ai' {
  interface LlmProviderRegistry {
    openai:    true;
    ollama:    true;
  }

  interface McpServerRegistry {
    'github':   true;
    'postgres': true;
  }
}
```

### Watch mode

```bash
bun run craft typegen --watch
```

Re-runs on file save. As soon as you add `craft().from(direct('invoices', {}))`, the `invoices` entry appears in the registry and `direct('invoices')` destinations immediately become valid.

### Commit the generated file

The generated file should be committed. This gives the team a clear diff when endpoints or providers change, and CI can verify the file is not stale:

```bash
bun run craft typegen && git diff --exit-code src/types/routecraft.generated.d.ts
```

### What codegen still cannot fix

- **Verifying a registered endpoint has a live listener** - codegen can discover source endpoints, but it cannot know at build time whether the route that listens on `'payments'` is actually started and reachable.
- **LLM model validation** - knowing which models Ollama has downloaded requires hitting a live API. Codegen with `--introspect` could generate a set of known model IDs by calling `ollama list`, but this would only be accurate at generation time.
- **MCP tool argument types** - MCP tools expose JSON Schema for their arguments. Codegen with `--introspect` could generate typed wrappers, but this is a larger feature (typed tool call arguments, not just server name safety).
