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

```diff
  craft()
+   .id("ingest")
+   .title("Ingest orders")
+   .description("Process inbound orders")
+   .input({ body: PostBody, headers: HeaderSchema })
-   .from(direct("ingest", {
-     description: "Process inbound orders",
-     schema: PostBody,
-     headerSchema: HeaderSchema,
-     keywords: ["orders"],
-   }))
+   .from(direct())
    .to(...)
```

`DirectServerOptions` now contains only `channelType`. `description`, `schema`, `headerSchema`, and `keywords` are removed. A route without `.id()` becomes agent-only with a UUID endpoint. The framework now enforces route-id uniqueness instead of endpoint uniqueness.

The destination form is unchanged: `direct("fetch-order")` and `direct((exchange) => ...)` still work.

### 1.3 Logger writes to stdout by default

Framework logs now write to stdout, matching pino's default and 12-factor conventions. Any consumer parsing stderr for routecraft logs needs to switch streams.

```diff
- craft run server.js 2>./logs.txt
+ craft run server.js 1>./logs.txt
# or: &> for both
```

**Critical for stdio MCP servers:** routecraft logs will now corrupt the stdio MCP protocol stream unless you redirect them.

```bash
craft run mcp-server.js --log-file ./mcp.log
# or
craft run mcp-server.js --log-level silent
```

### 1.4 `CraftConfig` is now an interface

`CraftConfig` switched from `type` to `interface` so ecosystem packages can declaration-merge first-class config keys onto it.

This only matters if you wrote:

```diff
- type MyConfig = CraftConfig & { custom: string }
+ interface MyConfig extends CraftConfig { custom: string }
```

Runtime behaviour is unaffected.

### 1.5 ESLint rule removal

The `mcp-server-options` rule was removed. It enforced the old `mcp(name, { description })` shape, which no longer exists after the metadata hoist (1.1). The framework now validates at subscribe time with a clearer error.

If you have this rule explicitly configured, drop it:

```diff
  rules: {
-   "routecraft/mcp-server-options": "error",
  }
```

---

## 2. Experimental-API changes

These all carried `@experimental` at 0.4.0. If you opted in, here are the renames and removals.

### 2.1 `mail()` — body reshape and verify option

`MailMessage.text` and `MailMessage.html` are grouped under a single `body` object. Mailparser collapses MIME into at most one of each, so the correct abstraction is a grouped alternative-pair.

```diff
- console.log(message.text)
- console.log(message.html)
+ console.log(message.body.text)
+ console.log(message.body.html)
```

`MailMessage.attachments` is unchanged.

**New:** `verify?: "off" | "headers" | "strict"` on `MailServerOptions` (default `"headers"`). When set, populates a new `MailMessage.sender?: MailSender` field with sender analysis (mailing-list and auto-forward detection, ARC/DMARC trust). The `"strict"` mode requires the `mailauth` peer dependency.

### 2.2 `agent()` — model id, prompt fields, and tool authorisation

```diff
- agent({
-   modelId: "anthropic:claude-opus-4-7",
-   systemPrompt: "You are a summariser.",
-   userPrompt: (ex) => `Summarise: ${ex.body}`,
-   allowedRoutes: ["fetch-order", "cancel-order"],
-   allowedMcpServers: ["docs-server"],
- })
+ agent({
+   model: "anthropic:claude-opus-4-7",
+   system: "You are a summariser.",
+   user: (ex) => `Summarise: ${ex.body}`,
+   tools: tools(["fetch-order", "cancel-order", "mcp_docs-server:search"]),
+ })
```

Field-level changes:

- `modelId` → `model`. **Now optional** when `agentPlugin({ defaultOptions: { model } })` provides a default. Resolution order at dispatch: instance value > plugin default > throw `RC5003`.
- `systemPrompt` → `system`. Both `string` and `(exchange) => string` are accepted (parity with `llm()`).
- `userPrompt` → `user`. Same shape widening.
- `allowedRoutes` and `allowedMcpServers` are **removed**. Tool authorisation goes through the new `tools()` helper, which resolves explicit references and tag selectors against the live fn / direct / mcp registries.
- New optional `output?: StandardSchemaV1` for structured output, mirroring `llm({ output })` and the route-level `.output(schema)`.

Inline `LlmModelConfig` credentials on `agent({...})` are no longer accepted. Provider credentials now live exclusively on `llmPlugin`:

```diff
- agent({
-   model: { provider: "anthropic", apiKey: "...", model: "claude-opus-4-7" },
-   ...
- })
+ // Configure the provider once on llmPlugin
+ llmPlugin({ providers: { anthropic: { apiKey: "..." } } })
+ // Reference by id from agents
+ agent({
+   model: "anthropic:claude-opus-4-7",
+   ...
+ })
```

**Removed type exports** from `@routecraft/ai`: `AgentModelId`, `AgentPromptSource`. If you imported either, switch to `LlmModelId` and `LlmPromptSource`.

### 2.3 `llm()` — schema field renames

```diff
  llm("anthropic:claude-opus-4-7", {
-   outputSchema: ResultSchema,
-   systemPrompt: "You are...",
-   userPrompt: (ex) => `Summarise ${ex.body}`,
+   output: ResultSchema,
+   system: "You are...",
+   user: (ex) => `Summarise ${ex.body}`,
  })
```

The result body still exposes `text`, `output`, and `usage` — no shape change to `LlmResult` / `LlmResultWithOutput`.

### 2.4 `embedding()` — `using` is now type-required

```diff
- embedding("openai:text-embedding-3-small", {})  // typechecked, threw RC5003 at runtime
+ embedding("openai:text-embedding-3-small", { using: (ex) => ex.body.text })
```

Adapter factory option types are no longer wrapped in `Partial<>`, so required fields are now required at the type level. `llm()`, `direct()`, and `mail()` had no actually-required option fields, so no call-site change is needed for those.

### 2.5 `mcp()` source — metadata hoist and isolated registry

The `mcp()` source no longer takes an endpoint name or descriptive metadata as arguments. The tool name is the route id; description, title, and input / output schemas come from the route builder.

```diff
  craft()
+   .id("search")
+   .description("Full-text search across documents")
+   .input({ body: SearchQuery })
-   .from(mcp("search", {
-     description: "Full-text search across documents",
-     schema: SearchQuery,
-     keywords: ["search", "docs"],
-     annotations: { readOnlyHint: true },
-   }))
+   .from(mcp({ annotations: { readOnlyHint: true } }))
    .process(searchHandler)
    .to(...)
```

`McpServerOptions` now holds only MCP-protocol extras: `annotations` and `icons`. A non-empty `.description()` on the route is required for the MCP framework to expose the tool.

**Local-tool registry isolation:** MCP local tools no longer share the `direct()` registry. They have their own (`MCP_LOCAL_TOOL_REGISTRY`). Plugin-side changes:

- `McpPluginOptions.tools` predicate signature changed: it now receives an `McpLocalToolEntry` (the new local-tool shape), not a direct entry.
- `McpServerOptions.keywords` and `McpLocalToolEntry.keywords` are removed.

### 2.6 Auth surface moved to `@routecraft/routecraft`

`jwt()`, `jwks()`, and the principal types previously lived in `@routecraft/ai`. They now live in `@routecraft/routecraft`.

```diff
- import { jwt, jwks, type AuthPrincipal } from "@routecraft/ai"
+ import { jwt, jwks, type Principal, type OAuthPrincipal } from "@routecraft/routecraft"
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

### 2.7 New first-class AI config keys (additive)

Importing `@routecraft/ai` now augments `CraftConfig` with first-class `llm`, `mcp`, `embedding`, and `agent` keys via declaration merging. The `plugins: [llmPlugin(...), agentPlugin(...)]` shape is still supported, but a more concise option is available:

```ts
import { defineConfig } from "@routecraft/routecraft"
import "@routecraft/ai" // side-effect import registers the keys

export default defineConfig({
  llm: { providers: { anthropic: { apiKey: process.env.ANTHROPIC_API_KEY } } },
  agent: { defaultOptions: { model: "anthropic:claude-opus-4-7" } },
  routes: [
    /* ... */
  ],
})
```

This is purely additive. No migration is required.

---

## 3. What is new in 0.5.0

For context only. None of these require any migration.

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
