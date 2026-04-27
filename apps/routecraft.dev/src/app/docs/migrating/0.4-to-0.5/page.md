---
title: Migrating from 0.4.x to 0.5.0
---

What changed between Routecraft 0.4.0 and 0.5.0, and how to update. {% .lead %}

This guide covers every breaking change extracted from a direct diff of the public surface (`packages/*/src/index.ts`, public type definitions, and adapter factory signatures). It is split into three sections:

1. **Stable-API changes** every consumer needs to address.
2. **Experimental-API changes** that only affect you if you opted into the AI, MCP, mail, or auth surfaces flagged `@experimental` at 0.4.0.
3. **What is new in 0.5.0** — for context, no migration required.

If you stayed on the stable surface (route DSL, `http()`, `cron()`, `timer()`, `simple()`, `direct()`, `telemetry`, `logger`, `eslint-plugin`), the only changes that touch you are sections 1.1, 1.2, and 1.3.

---

## 1. Stable-API changes

### 1.1 Route metadata moves to the route builder

`title`, `description`, and `input` / `output` schemas were previously fields on `direct()` and `mcp()` source options. They are now route-level concerns expressed through new builder methods, so any source adapter inherits them automatically.

**New builder methods on `RouteBuilder`:**

- `.title(value: string)` — display title
- `.description(value: string)` — discoverable description
- `.input(schema | { body, headers })` — body and header validation, framework-enforced before the pipeline runs
- `.output(schema | { body, headers })` — output validation against the primary destination
- `.tag(value)` / `.tags(values)` — tags drive selectors like `tools({ tagged: "read-only" })` on the agent side; literals `"read-only" | "destructive" | "idempotent"` autocomplete and any string is accepted

`.input()` failures emit `exchange:dropped`; `.output()` failures route through the route's error handler or emit `exchange:failed`.

### 1.2 `direct()` source: endpoint is the route id

Previously, `direct()` source took an explicit endpoint name and discovery metadata as the second argument. Now the endpoint **is** the route id, and metadata lives on the route builder per section 1.1.

**Before (0.4.0):**

```ts
craft()
  .from(
    direct("ingest", {
      description: "Process inbound orders",
      schema: PostBody,
      headerSchema: HeaderSchema,
      keywords: ["orders"],
    }),
  )
  .to(...)
```

**After (0.5.0):**

```ts
craft()
  .id("ingest")
  .title("Ingest orders")
  .description("Process inbound orders")
  .input({ body: PostBody, headers: HeaderSchema })
  .from(direct())
  .to(...)
```

`DirectServerOptions` now contains only `channelType`. `description`, `schema`, `headerSchema`, and `keywords` are removed. A route without `.id()` becomes agent-only with a UUID endpoint. The framework now enforces route-id uniqueness instead of endpoint uniqueness.

The destination form is unchanged: `direct("fetch-order")` and `direct((exchange) => ...)` still work.

### 1.3 Logger writes to stdout by default

Framework logs now write to stdout, matching pino's default and 12-factor conventions. To send logs to a file, use the `--log-file` flag:

```bash
craft run server.js --log-file ./logs.txt
```

**Critical for stdio MCP servers:** routecraft logs will now corrupt the stdio MCP protocol stream unless you redirect them out of stdout. Use one of:

```bash
craft run mcp-server.js --log-file ./mcp.log
# or
craft run mcp-server.js --log-level silent
```

### 1.4 Define your config with `defineConfig`

`CraftConfig` switched from `type` to `interface` so ecosystem packages can declaration-merge first-class config keys onto it. The recommended way to author your config is now the new `defineConfig` helper, which preserves literal-type inference at the call site without you having to declare a config type yourself:

**Before (0.4.0):**

```ts
import type { CraftConfig } from "@routecraft/routecraft"

const config: CraftConfig = {
  plugins: [...],
  routes: [...],
}
export default config
```

**After (0.5.0):**

```ts
import { defineConfig } from "@routecraft/routecraft"
import "@routecraft/ai" // side-effect import enables first-class llm/agent/mcp/embedding keys

export default defineConfig({
  llm: { providers: { anthropic: { apiKey: process.env.ANTHROPIC_API_KEY } } },
  agent: { defaultOptions: { model: "anthropic:claude-opus-4-7" } },
  routes: [...],
})
```

If you actually extended the type, switch the `type` alias to an `interface`:

```ts
// Before
type MyConfig = CraftConfig & { custom: string }

// After
interface MyConfig extends CraftConfig {
  custom: string
}
```

Runtime behaviour is unaffected.

### 1.5 ESLint rule removal

The `mcp-server-options` rule was removed. It enforced the old `mcp(name, { description })` shape, which no longer exists after the metadata hoist (1.1). The framework now validates at subscribe time with a clearer error.

If you have this rule explicitly configured, drop it from your ESLint config:

```ts
// remove this line from rules
"routecraft/mcp-server-options": "error",
```

---

## 2. Experimental-API changes

These all carried `@experimental` at 0.4.0. If you opted in, here are the renames and removals.

### 2.1 `mail()` — body reshape and verify option

`MailMessage.text` and `MailMessage.html` are grouped under a single `body` object. Mailparser collapses MIME into at most one of each, so the correct abstraction is a grouped alternative-pair.

**Before (0.4.0):**

```ts
console.log(message.text)
console.log(message.html)
```

**After (0.5.0):**

```ts
console.log(message.body.text)
console.log(message.body.html)
```

`MailMessage.attachments` is unchanged.

**New:** `verify?: "off" | "headers" | "strict"` on `MailServerOptions` (default `"headers"`). When set, populates a new `MailMessage.sender?: MailSender` field with sender analysis (mailing-list and auto-forward detection, ARC/DMARC trust). The `"strict"` mode requires the `mailauth` peer dependency.

### 2.2 `agent()` — model id, prompt fields, and tool authorisation

**Before (0.4.0):**

```ts
agent({
  modelId: "anthropic:claude-opus-4-7",
  systemPrompt: "You are a summariser.",
  userPrompt: (ex) => `Summarise: ${ex.body}`,
  allowedRoutes: ["fetch-order", "cancel-order"],
  allowedMcpServers: ["docs-server"],
})
```

**After (0.5.0):**

```ts
agent({
  model: "anthropic:claude-opus-4-7",
  system: "You are a summariser.",
  user: (ex) => `Summarise: ${ex.body}`,
  tools: tools(["fetch-order", "cancel-order", "mcp_docs-server:search"]),
})
```

Field-level changes:

- `modelId` → `model`. **Now optional** when `agentPlugin({ defaultOptions: { model } })` provides a default. Resolution order at dispatch: instance value > plugin default > throw `RC5003`.
- `systemPrompt` → `system`. Both `string` and `(exchange) => string` are accepted (parity with `llm()`).
- `userPrompt` → `user`. Same shape widening.
- `allowedRoutes` and `allowedMcpServers` are **removed**. Tool authorisation goes through the new `tools()` helper, which resolves explicit references and tag selectors against the live fn / direct / mcp registries.
- New optional `output?: StandardSchemaV1` for structured output, mirroring `llm({ output })` and the route-level `.output(schema)`.

Inline `LlmModelConfig` credentials on `agent({...})` are no longer accepted. Provider credentials now live exclusively on `llmPlugin`:

**Before (0.4.0):**

```ts
agent({
  model: { provider: "anthropic", apiKey: "...", model: "claude-opus-4-7" },
  // ...
})
```

**After (0.5.0):**

```ts
// Configure the provider once on llmPlugin
llmPlugin({ providers: { anthropic: { apiKey: "..." } } })

// Agents reference the model by id
agent({
  model: "anthropic:claude-opus-4-7",
  // ...
})
```

**Removed type exports** from `@routecraft/ai`: `AgentModelId`, `AgentPromptSource`. If you imported either, switch to `LlmModelId` and `LlmPromptSource`.

### 2.3 `llm()` — schema field renames

**Before (0.4.0):**

```ts
llm("anthropic:claude-opus-4-7", {
  outputSchema: ResultSchema,
  systemPrompt: "You are...",
  userPrompt: (ex) => `Summarise ${ex.body}`,
})
```

**After (0.5.0):**

```ts
llm("anthropic:claude-opus-4-7", {
  output: ResultSchema,
  system: "You are...",
  user: (ex) => `Summarise ${ex.body}`,
})
```

The result body still exposes `text`, `output`, and `usage` — no shape change to `LlmResult` / `LlmResultWithOutput`.

### 2.4 `embedding()` — `using` is now type-required

**Before (0.4.0):**

```ts
embedding("openai:text-embedding-3-small", {})
// typechecked at compile time, but threw RC5003 at runtime
```

**After (0.5.0):**

```ts
embedding("openai:text-embedding-3-small", {
  using: (ex) => ex.body.text,
})
```

Adapter factory option types are no longer wrapped in `Partial<>`, so required fields are now required at the type level. `llm()`, `direct()`, and `mail()` had no actually-required option fields, so no call-site change is needed for those.

### 2.5 `mcp()` source — metadata hoist and isolated registry

The `mcp()` source no longer takes an endpoint name or descriptive metadata as arguments. The tool name is the route id; description, title, and input / output schemas come from the route builder.

**Before (0.4.0):**

```ts
craft()
  .from(
    mcp("search", {
      description: "Full-text search across documents",
      schema: SearchQuery,
      keywords: ["search", "docs"],
      annotations: { readOnlyHint: true },
    }),
  )
  .process(searchHandler)
  .to(...)
```

**After (0.5.0):**

```ts
craft()
  .id("search")
  .description("Full-text search across documents")
  .input({ body: SearchQuery })
  .from(mcp({ annotations: { readOnlyHint: true } }))
  .process(searchHandler)
  .to(...)
```

`McpServerOptions` now holds only MCP-protocol extras: `annotations` and `icons`. A non-empty `.description()` on the route is required for the MCP framework to expose the tool.

**Local-tool registry isolation:** MCP local tools no longer share the `direct()` registry. They have their own (`MCP_LOCAL_TOOL_REGISTRY`). Plugin-side changes:

- `McpPluginOptions.tools` predicate signature changed: it now receives an `McpLocalToolEntry` (the new local-tool shape), not a direct entry.
- `McpServerOptions.keywords` and `McpLocalToolEntry.keywords` are removed.

### 2.6 Auth surface moved to `@routecraft/routecraft`

`jwt()`, `jwks()`, and the principal types previously lived in `@routecraft/ai`. They now live in `@routecraft/routecraft`.

**Before (0.4.0):**

```ts
import { jwt, jwks, type AuthPrincipal } from "@routecraft/ai"
```

**After (0.5.0):**

```ts
import {
  jwt,
  jwks,
  type Principal,
  type OAuthPrincipal,
} from "@routecraft/routecraft"
```

Type changes:

- `AuthPrincipal` → `Principal`. The base shape no longer declares `scheme`; each subtype carries its own.
- `OAuthPrincipal` is the discriminated subtype for OAuth flows.
- `McpAuthValidator` is removed.

`jwt()` behaviour tightened:

- Tokens without an `exp` claim are now rejected by default. Pass `requireExp: false` to opt out.
- HS\* (symmetric) tokens are no longer accepted by default. Pass `acceptHmac: true` to opt in.
- `issuer` and `audience` are now required configuration fields.

`oauth()` factory:

- `OAuthFactoryOptions.getClient` was renamed to `client`.
- `OAuthPrincipal.expiresAt` is now contractually enforced.

### 2.7 First-class AI config keys (additive)

Importing `@routecraft/ai` now augments `CraftConfig` with first-class `llm`, `mcp`, `embedding`, and `agent` keys via declaration merging, so you can configure them directly on `defineConfig` instead of inside `plugins[]`. See section 1.4 for the recommended shape. The `plugins: [llmPlugin(...), agentPlugin(...)]` form continues to work — no migration required if you prefer it.

---

## 3. What is new in 0.5.0

For context only. None of these require any migration.

### Dual-mode wrapper operations (`.error()` first)

`.error()` becomes the first **dual-mode wrapper**. The same method name now applies at two distinct scopes depending on where you call it on the route builder:

- **Route scope** — call it _before_ `.from()`. Catches any unhandled error from the pipeline and halts the route. This is the existing 0.4.0 behaviour, unchanged.
- **Step scope** — call it _after_ `.from()`. Wraps **only the immediately next step**. On success the pipeline continues untouched; on failure the handler runs, its return value replaces the body, and the pipeline continues with the next step. The builder's body type is preserved across the wrapper, so step-level `.error()` is fully type-safe.

This pattern is the foundation for future resilience operations (retry, cache, timeout, circuit breaker, throttle, delay) — each will adopt the same dual-mode shape so users learn it once. See [issue #140](https://github.com/routecraftjs/routecraft/issues/140) for the full design.

#### Step-scope example: recover from one flaky call

```ts
craft()
  .id("resilient-pipeline")
  .from(timer({ intervalMs: 60_000 }))
  .transform(prepareRequest)
  .error((err, ex) => ({ fallback: true, reason: String(err) }))
  .to(http({ url: "https://flaky.api/endpoint" }))
  .to(database())
```

If the `http()` call fails, the step-level handler returns the fallback object as the new body and the pipeline continues to `database()`.

#### Combined route + step scope

```ts
craft()
  .id("with-safety-net")
  .error((err, ex, forward) => forward("errors.catchall", ex.body)) // route-level
  .from(timer({ intervalMs: 60_000 }))
  .transform(prepareRequest)
  .error((err) => ({ fallback: true })) // step-level
  .to(http({ url: "https://flaky.api/endpoint" }))
  .to(database())
```

The step-level handler recovers `http()` failures silently. If the step-level handler itself throws, the route-level handler takes over and forwards to `errors.catchall`. The route is not stopped; the next exchange processes normally.

#### Operation categories

For reference, route-builder operations now fall into three groups:

| Category            | Position relative to `.from()` | Examples                                                |
| ------------------- | ------------------------------ | ------------------------------------------------------- |
| Route-only          | Before                         | `.id()`, `.batch()`                                     |
| Dual-mode wrapper   | Before _or_ after              | `.error()` (more to follow in 0.6.0)                    |
| Pipeline            | After                          | `.transform()`, `.filter()`, `.to()`, `.process()`, ... |

ESLint rules continue to enforce route-only positioning. Wrapper positioning is enforced by the builder type system.

### Agent runtime

- Tool-calling loop on `agent()` with whitelisted access to fn handlers, direct routes, and remote MCP tools.
- `tools()` helper for declarative tool authorisation (explicit names, tag selectors, per-binding guards and overrides).
- `fn()` primitive for ad-hoc in-process functions registered via `agentPlugin({ functions })`.
- Streaming agents: opt in via `stream: true` to receive an `AgentStream` body. The HTTP server bridges to SSE automatically.
- `defaultFns`: built-in read-only fns (`currentTime`, `randomUuid`).
- Forward-compat hooks landed for durable agents (0.6.0): `SuspendError` (`@experimental`), `FnHandlerContext.checkpointId`, `AgentSession`.

### Choice operation

```ts
craft()
  .id("dispatch")
  .from(direct())
  .choice((c) =>
    c
      .when((ex) => ex.body.priority === "urgent", (b) =>
        b.transform(prepUrgent).to(direct("urgent-queue")),
      )
      .when((ex) => ex.body.amount > 1000, (b) =>
        b.transform(prepHighValue).to(direct("review-queue")),
      )
      .otherwise((b) => b.to(direct("standard-queue"))),
  )
```

Branches share the operations catalog with the parent route via a shared `StepBuilderBase`. Branches that end in `b.halt()` short-circuit; unmatched exchanges with no `otherwise` are dropped with reason `"unmatched"`.

### Programmatic invocation

```ts
import { CraftClient } from "@routecraft/routecraft"

const client = new CraftClient(context)
const result = await client.send("ingest", { orderId: "abc" })
```

Lets you invoke routes from outside the framework lifecycle (test runners, scripts, embeds).

### Adapter mocking

`@routecraft/testing` now ships `mockAdapter`, `tagAdapter`, and `factoryArgs`. Combined with the new `RC_ADAPTER_OVERRIDES` store key, these let tests swap factory output without touching the route under test.

### MCP OAuth 2.1 server provider

The `mcp()` source can now sit behind an OAuth 2.1 authorisation server. The framework ships JWT and JWKS verifiers, an `oauth()` factory, and a typed `OAuthPrincipal` shape.

### Runner argv channel

A new `RUNNER_ARGV` store key lets adapters read remaining CLI arguments after the runner has parsed its own flags, without coupling to a specific runner package.

---

## Quick reference: import path moves

| Symbol                                | 0.4.0                | 0.5.0                  |
| ------------------------------------- | -------------------- | ---------------------- |
| `jwt`, `jwks`, `JwtAuthOptions`, ...  | `@routecraft/ai`     | `@routecraft/routecraft` |
| `AuthPrincipal`                       | `@routecraft/ai`     | `Principal` from `@routecraft/routecraft` |
| `McpAuthValidator`                    | `@routecraft/ai`     | removed                |

## Quick reference: removed exports

| Symbol                       | Replacement                                       |
| ---------------------------- | ------------------------------------------------- |
| `AgentModelId`               | `LlmModelId`                                      |
| `AgentPromptSource`          | `AgentUserPromptSource` (alias of `LlmPromptSource`) |
| `AuthPrincipal`              | `Principal`                                       |
| `McpAuthValidator`           | none — use the new `oauth()` factory + verifiers  |
