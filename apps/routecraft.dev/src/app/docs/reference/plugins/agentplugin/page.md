---
title: agentPlugin
---

[← All plugins](/docs/reference/plugins) {% .lead %}

```ts
import { agentPlugin } from '@routecraft/ai'
```

Register named agents in the context store so routes can reference them by name via `agent("id")`. Registered agents are distinct from route-backed agents: a registration carries its own description because it is not backed by a route; the id is the record key. Duplicate ids across multiple `agentPlugin` installs throw at context init.

```ts
import { agentPlugin, llmPlugin } from '@routecraft/ai'
import type { CraftConfig } from '@routecraft/routecraft'

export const craftConfig: CraftConfig = {
  plugins: [
    llmPlugin({ providers: { anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! } } }),
    agentPlugin({
      agents: {
        summariser: {
          description: 'Summarises documents into bullet points',
          model: 'anthropic:claude-opus-4-7',
          system: 'You are a summariser. Be concise.',
        },
        'translator-en-fr': {
          description: 'Translates English text to French',
          model: 'anthropic:claude-opus-4-7',
          system: 'Translate the input from English to French.',
        },
      },
    }),
  ],
}
```

Then in any route:

```ts
import { agent } from '@routecraft/ai'

craft()
  .id('daily-digest')
  .from(timer({ intervalMs: 24 * 60 * 60 * 1000 }))
  .to(agent('summariser'))
  .to(direct('reply'))
```

**Options:**

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `agents` | `Record<string, AgentRegisteredOptions>` | No | Agents keyed by id. Duplicate ids across installs throw at context init. Defaults to `{}`. |

**Entry shape (`AgentRegisteredOptions`):**

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `description` | `string` | Yes | Human-readable description. Surfaces in observability and is used as the tool description when the agent is exposed to other agents |
| `model` | `LlmModelId` | No\* | `"provider:model"` string resolved via `llmPlugin`. Required unless `defaultOptions.model` supplies a fallback; otherwise dispatch throws `RC5003` |
| `system` | `string \| (exchange) => string` | Yes | System prompt. Static string or a function that derives it from the exchange (mirrors `llm({ system })`) |
| `user` | `string \| (exchange) => string` | No | User prompt override. Static string or a function that derives it from the exchange. Defaults to `exchange.body` (string as-is, JSON for objects) when omitted |
| `tools` | `ToolSelection` | No | Tool whitelist built via `tools([...])`. Inherits `defaultOptions.tools` when omitted; an explicit value replaces the default entirely |
| `maxTurns` | `number` | No | Cap on tool-calling turns. Inherits `defaultOptions.maxTurns` when omitted |
| `blocks` | `Blocks` (`Record<string, BlockBody \| false>`) | No | Contributions to the agent's system context, keyed by name. Each block has a `mode` (`"inject"` to concatenate into the system prompt as `## <name>\n\n<content>`, or `"progressive"` to surface as a synthetic `_block_load_<name>` tool the model invokes on demand) and an optional `lifetime` (`"dispatch"` re-runs the resolver every call, `"context"` caches once per `CraftContext`). Set an entry to `false` to remove a default inherited from `agentPlugin({ defaultOptions: { blocks } })`. Use `skills({ source })` to load markdown skills. See the [blocks reference](#agent-blocks) |
| `principal` | `boolean \| (principal, exchange) => string` | No | Append a `## Caller` section describing `exchange.principal`. `true` for the built-in block, a function to render it yourself. Inherits `defaultOptions.principal` when omitted; a per-agent value (including `false`) overrides it. See [Telling the agent who the caller is](/docs/reference/adapters/agent#telling-the-agent-who-the-caller-is) |
| `output` | `StandardSchemaV1` | No | Schema for structured output. Validated and parsed onto `AgentResult.output` after dispatch (runtime ships in a follow-up release) |

Agents loaded from markdown via [`agents("./dir")`](/docs/reference/adapters/agent) accept the same fields as frontmatter, except for `blocks`. `principal` is supported in frontmatter as a boolean (`principal: true`); the function-renderer form is a closure YAML cannot express, so set it via the per-agent override map (`agents("./dir", { zoe: { principal: (p) => ... } })`) or `agentPlugin({ defaultOptions })`. `blocks` is override-only because resolvers may carry functions; supply them via the same override map (`agents("./dir", { zoe: { blocks: await skills({ source: "./skills" }) } })`).

**Resolution semantics:**

- `agent("name")` resolves only registered agents. Route-backed agents are called via `.to(direct("route-id"))` and run the full pipeline of the target route; `agent("name")` runs the registered agent's LLM call inline.
- The plugin throws at context init (`RC5003`) on: duplicate ids across installs, empty id key, missing description, malformed model string when present, empty system, or a non-`ToolSelection` `tools` value.
- The agent throws at dispatch (`RC5003`) when neither the agent nor `defaultOptions.model` supplies a model.
- `agent("unknown")` fails at dispatch (`RC5004`) with the list of registered agent ids.

See the [`agent`](/docs/reference/adapters/agent) adapter for usage patterns.

## Agent blocks

Blocks are an agent's contribution to its system context, expressed as a `Blocks` record (`{ [name: string]: BlockBody | Blocks | false }`) keyed by block name. A value is either a single block (a `BlockBody` leaf) or a nested `Blocks` group. A leaf is either always injected into the system prompt (`mode: "inject"`) or surfaced as a synthetic loader tool the model invokes on demand (`mode: "progressive"`, the default for `skills`). They replace the 0.5 `skills` field and unify with memory, identity, instructions, and any future system-prompt contribution.

```ts
import { agent, skills } from '@routecraft/ai'

agent({
  model: 'anthropic:claude-sonnet-4-6',
  system: 'You are an analyst.',
  blocks: {
    identity: {
      mode: 'inject',
      value: 'You are precise and concise.',
    },
    // A named group keeps every skill under the `skills` namespace
    // instead of dissolving them into the top level.
    skills: await skills({ source: './skills' }),
    'tenant-config': {
      mode: 'inject',
      lifetime: 'context',
      value: (_exchange, context) => {
        const config = context.services.get(TenantConfig)
        return `Tenant: ${config.name}`
      },
    },
  },
})
```

**`BlockBody` shape:**

| Field         | Type                                                                                                     | Required | Description                                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `description` | `string`                                                                                                 | Yes\*    | Required when `mode === "progressive"` so the model can decide whether to load. Ignored for inject blocks.                                        |
| `mode`        | `"inject" \| "progressive"`                                                                              | Yes      | `"inject"` concatenates into the system prompt as `## <name>\n\n<content>`. `"progressive"` registers a `_block_load_<name>` tool the model invokes on demand. |
| `lifetime`    | `"dispatch" \| "context"`                                                                                | No       | Defaults to `"dispatch"` (re-run resolver each call). `"context"` runs the resolver once per `CraftContext` and caches the result (cache key is the body's object identity, so concurrent dispatches share one resolution). |
| `value`       | `string \| (exchange, context, events, client) => string \| Promise<string>`                             | Yes      | Static string used verbatim, or a function. `client.forward(routeId, payload)` is the same callable route `.error()` handlers receive. `events` is reserved (always `[]`) for a forthcoming exchange-event log. |

The block's name is the record key (not a field on the body). Names starting with the reserved `_block_` prefix are rejected with `RC5026` at every nesting level. An empty-string key is rejected with `RC5026`.

**Nested groups:**

A block value may be a nested `Blocks` record instead of a single body. This keeps a named collection, such as the skills returned by `skills({ source })`, grouped under one key rather than dissolving into the top-level namespace:

```ts
blocks: {
  skills: await skills({ source: './skills' }), // a group of progressive leaves
  tone: { mode: 'inject', value: 'Be terse.' }, // a single leaf
}
```

Groups flatten depth-first into a single canonical name joined by `__`. A leaf `onboarding` under group `skills` resolves to `skills__onboarding` for its system-prompt heading (`## skills__onboarding`), its loader tool (`_block_load_skills__onboarding`), and its `blocksLoaded` summary. `__` (not `/`) is used because loader tool names reach the provider unsanitised and must match `^[a-zA-Z0-9_-]{1,64}$`. A leaf is distinguished from a group by the presence of a string `mode` field; any other object value is a group.

These rules are enforced at `agent()` / `agentPlugin()` construction, not deferred to dispatch: two blocks that flatten to the same name are rejected with `RC5026`; a flattened name that lands in the reserved `_block_` namespace (including combinations like a group `_block` with a leaf `x` resolving to `_block__x`) is rejected with `RC5026`; and a progressive block whose flattened loader-tool name would break the provider charset or exceed 64 characters is rejected with `RC5027`. A blocks tree that contains a cycle is also rejected rather than recursed without bound.

Grouping also isolates collisions: a skill named `tone` inside the `skills` group resolves to `skills__tone` and no longer clashes with a top-level `tone` block. To remove or replace a whole group, set or override its top-level key (see below); per-member merge inside a group is not supported.

**Removing a default:**

Set a name to `false` to drop a default block from a specific agent:

```ts
agent({
  ...,
  blocks: {
    // Override the "house-style" default
    'house-style': { mode: 'inject', value: 'Be terse.' },
    // Drop the "safety" default for this agent only
    safety: false,
  },
})
```

A `false` for a name not present in defaults is silently ignored, so adding or removing defaults later cannot break agent definitions.

**Builders:**

- `skills({ source, mode?, lifetime? })` -- loads markdown skills as a `Blocks` record. `source` accepts a single `.md` file or a directory (flat `<name>.md` and nested `<name>/SKILL.md` may coexist). Defaults to `mode: "progressive"`.
- `fromFile(path)` -- returns a resolver that reads a UTF-8 text file at resolution time.

**Loader tools and observability:**

Progressive blocks register one synthetic tool per block named `_block_load_<blockName>` with no input schema. The handler runs the resolver against the dispatch's live exchange and returns the resolved string back to the model. Loader invocations are excluded from `AgentResult.toolCalls` and surface on `AgentResult.blocksLoaded?: AgentBlockLoadSummary[]` instead, so post-dispatch user-tool assertions stay clean. On the context bus they emit `route:<id>:agent:block:loaded` and `:agent:block:error` rather than the `:agent:tool:*` events.

**Defaults merging:**

`agentPlugin({ defaultOptions: { blocks } })` installs shared blocks for every agent in the context. The merge differs from how `tools` merges: a per-agent `blocks` record does **not** replace defaults wholesale. Defaults are merged in by name, and a per-agent block whose key matches a default replaces only that entry (or removes it when set to `false`). Non-colliding defaults still apply. This lets a context install identity / memory / tenant blocks once and have individual agents add, replace, or remove entries.

Two `agentPlugin` installs that each supply `defaultOptions.blocks` merge additively: each install contributes named entries, but the same name appearing in two installs throws `RC5003` so you never silently inherit one over the other.

**Errors:**

| Code     | Meaning                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------- |
| `RC5025` | Block resolver threw or returned a non-string. Inject mode aborts the dispatch; progressive mode reports back to the model as a tool error so it can self-correct. |
| `RC5026` | Block name collides with another block, a user tool, or uses the reserved `_block_` prefix.                   |
| `RC5027` | Block misconfigured: invalid `mode`, missing `description` on a progressive block, non-string non-function `value`, etc.       |

## Functions (`functions`)

`agentPlugin` also registers ad-hoc in-process **functions** that agents whitelist as tools (follow-up story). Functions are keyed by id in the same plugin config and share the same duplicate-id-throws-at-init semantics as agents.

Functions are an agent-only concept: there is no public dispatch API for fns outside the agent tool loop. If you want to call a "named processor" from a route, write `.process(...)` inline.

```ts
import { agentPlugin } from '@routecraft/ai'
import { z } from 'zod'

agentPlugin({
  functions: {
    currentTime: {
      description: 'Current UTC timestamp in ISO 8601',
      input: z.object({}),
      handler: async () => new Date().toISOString(),
    },
    sendSlackMessage: {
      description: 'Post a message to a Slack channel',
      input: z.object({ channel: z.string(), text: z.string() }),
      handler: async (input, ctx) => {
        ctx.logger.info({ channel: input.channel }, 'Posting to Slack')
        return { ok: true }
      },
    },
  },
})
```

**Options:**

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `functions` | `Record<string, FnOptions>` | No | Functions keyed by id. Duplicate ids across installs throw at context init. Defaults to `{}`. |

**Entry shape (`FnOptions`):**

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `description` | `string` | Yes | Human-readable description. Used in observability and as the tool description when exposed to an agent |
| `input` | `StandardSchemaV1` | Yes | Standard Schema for the input (Zod, Valibot, ArkType, etc.). Validated at invocation time |
| `handler` | `(input, ctx) => Promise<TOut> \| TOut` | Yes | Called with validated input and a `FnHandlerContext` (`{ logger, abortSignal, context }`) |

**Errors at context init (`RC5003`):** missing description, `input` is not a Standard Schema, `input`'s `validate` is not a function, missing handler, empty id key, duplicate id across installs.

## Testing fns

There is no public `invokeFn` helper. Agents are the only legitimate dispatcher for registered fns. To exercise a fn's input schema and handler in isolation in tests, use `testFn` from `@routecraft/testing`:

```ts
import { testFn } from '@routecraft/testing'
import { z } from 'zod'

const greet = {
  description: 'Greets someone',
  input: z.object({ name: z.string() }),
  handler: async (input, ctx) => `hello ${input.name}`,
}

const out = await testFn(greet, { name: 'alice' })
// out === 'hello alice'
```

`testFn` validates the input against the `input` schema, calls the handler with a synthetic `{ logger, abortSignal }` context, and returns the handler's output. Validation failures throw `RC5002`. It works structurally on any `{ input, handler }` shape, so real `FnOptions` values pass without modification.

## Agent tools

> **Status: live.** Tools an agent declares via `tools([...])` are bridged into the Vercel AI SDK's tool-calling loop at dispatch time. The model sees each tool's name, description, and JSON schema; the SDK validates tool-call arguments against the schema, reports validation errors back to the model for self-correction, and otherwise invokes the agent's handler. Synchronous in-memory loop today; streaming and durable suspend/resume are tracked separately ([streaming agents](https://github.com/routecraftjs/routecraft/issues/257), [durable agents epic](https://github.com/routecraftjs/routecraft/issues/258)).

Tags, the `tools([...])` selector, the builder helpers, and the context-level `defaultOptions` bag compose to give an agent a typed, whitelisted set of capabilities.

```ts
import {
  agentPlugin,
  agent,
  currentTime,
  directTool,
  randomUuid,
  tools,
} from '@routecraft/ai'

agentPlugin({
  functions: {
    CurrentTime: currentTime(),                     // built-in (read-only, idempotent)
    RandomUuid: randomUuid(),                        // built-in (read-only)
    sendSlack: { description, input, handler, tags: ['destructive', 'messaging'] },
    fetchOrder: directTool('fetch-order'),          // wraps a direct route as a fn
  },
  agents: {
    researcher: {
      description, system,                          // model + tools inherit from defaultOptions
      tools: tools([
        'CurrentTime',                              // bare ref
        'fetchOrder',
        'Direct(cancel-order)',                     // direct route
        { name: 'sendSlack', guard: requireApproval },
      ]),
    },
  },
  defaultOptions: {
    model: 'anthropic:claude-opus-4-7',             // applies to agents that omit `model`
    tools: tools(['CurrentTime', 'fetchOrder']),
  },
})
```

#### `tools(items)` -- array form

Flat array of items. Each item is one of:

- **Bare string**: name lookup. Plain ids resolve against the fn registry; `Direct(<routeId>)` wraps a direct route via `directTool` (the LLM-facing tool name stays `direct_<routeId>`); `MCP(server:tool)` resolves against `MCP_TOOL_REGISTRY` (populated by `defineConfig.mcp` / `mcpPlugin({ clients })`), and `MCP(server)` (or the raw `mcp__server__tool` / `mcp__server` / `mcp__server__*` forms) expands at dispatch time to every tool the named server exposed. The raw `mcp__server__tool` form is the string Claude Code agent files carry, so they resolve unchanged.
- **`{ name, guard?, description? }`**: same name lookup, with optional per-binding overrides. The guard runs after schema validation and before the handler; throwing surfaces back to the LLM as a tool error so the model can self-correct. The `description` override applies only to this binding for fn-style names. MCP references reject `description` (the MCP server is the source of truth for description and schema; do not override).

Examples:

```ts
agent({
  tools: tools([
    'CurrentTime',                                  // fn
    'Direct(orders/fetch)',                         // direct route
    'MCP(Nuclino:list_teams)',                      // one MCP tool
    'MCP(Stripe)',                                  // all tools from one MCP server
    {
      name: 'MCP(Nuclino:get_item)',
      guard: (input, ctx) => {
        if (!ctx.principal?.scopes?.includes('nuclino.read')) {
          throw new Error('missing nuclino.read scope');
        }
      },
    },
  ]),
});
```

#### `tools((catalog) => items)` -- builder form

Programmatic escape hatch when explicit enumeration is impractical. The builder receives a `ToolsCatalog` snapshot of the live registries and returns the same shape the array form accepts.

```ts
agent({
  tools: tools((catalog) => [
    // Explicit, reviewed at call site
    'fetchOrder',
    'Direct(escalate)',

    // Dynamic, user-controlled
    ...catalog.fns
      .filter((f) => f.tags?.includes('read-only'))
      .map((f) => f.name),
  ]),
});
```

`ToolsCatalog` shape:

| Field     | Type                                                                          | Description                                                       |
| --------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `fns`     | `ReadonlyArray<{ name; description?; tags? }>`                                | Fns from `agentPlugin({ functions })`. Deferred wrappers (`directTool`) appear by name only; filter on their underlying routes via `catalog.routes` if you need tag-based selection of routes. |
| `routes`  | `ReadonlyArray<{ id; description?; tags? }>`                                  | Direct routes from `ADAPTER_DIRECT_REGISTRY`. Reference via `"Direct(<id>)"` in the returned items. |
| `mcp`     | `ReadonlyArray<{ server; tool; description?; tags? }>`                        | MCP tools populated by `mcpPlugin({ clients })`. Reference via `"MCP(<server>:<tool>)"` or `"mcp__<server>__<tool>"`. |

The builder runs once per agent dispatch (same lifecycle as the array resolver). Builder errors are wrapped in `RC5003` with the original chained. The framework ships no helpers on `ToolsCatalog`: any filter is user code, and `.filter()` at the call site is an obvious signal that the set is dynamic (vs the declarative tag selectors removed in 0.6, which were a security footgun because they implicitly extended an agent's surface when new tagged fns were registered).

Resolution rules:

- Final list deduplicated by tool name (later refs win).
- A `directTool(routeId)` fn-registry wrapper and the underlying direct route share the same surface; reference via the fn id you registered.
- `description` is the only override permitted at the use site, and only on the explicit `{ name }` form for fn-style names. Input schema, tags, and any other registration-time fields are not overridable here. Register a separate fn with `directTool(routeId, { description, input })` if you need a fundamentally different view. MCP refs reject `description` outright.
- The agent does NOT forward `FnHandlerContext.principal` to the MCP server. Principal authenticates the caller into Routecraft; MCP `auth` (configured on the client) authenticates the Routecraft → MCP hop. To thread user-specific data into an MCP call, put it in the tool's input as a regular argument and let the MCP server enforce its own policy. See `.standards/security.md` §11.

#### Builders

| Builder | Use |
|---|---|
| `directTool(routeId, overrides?)` | Adapt a registered direct route as a fn. Pulls description, input schema, and tags from the route's discovery bundle by default; `overrides` accepts `description` and `input` to replace either of those (tags pass through unchanged). |
| `currentTime()` / `randomUuid()` | Built-in fn factories (read-only / idempotent). Assign each a tool name in your `functions:` config, the same way as `directTool`. |

MCP tools are NOT exposed via a builder. Use the `MCP(server:tool)` / `MCP(server)` grammar (or the raw `mcp__server__tool` form) inside `tools([...])` instead; the registry populated by `defineConfig.mcp` is the source of truth.

When to hand an agent a raw `MCP(...)` tool versus a wrapped `Direct(...)` route -- and why a guard cannot stand in for the wrap -- is covered in [Calling an MCP](/docs/advanced/call-an-mcp#guardrails-raw-guarded-or-wrapped).

#### Tags

Apply with `.tag(value | values[])` on routes and `tags?: Tag[]` on `FnOptions`. Empty strings are rejected; surrounding whitespace is trimmed at storage so exact comparisons match.

`KnownTag` (a literal-suggested type) covers the framework's well-known tags:

```ts
type KnownTag = 'read-only' | 'destructive' | 'idempotent';
```

Any user string is also accepted; the `KnownTag` literals just power autocomplete.

Tags are exposed on `ToolsCatalog` entries so the builder form of `tools()` can filter on them. They do not drive any framework-level selector (the `{ tagged }` variant on `tools()` was removed in 0.6.0); the security boundary belongs at the agent's call site, not in implicit registry queries.

#### Context-level `defaultOptions`

Mirrors the `llmPlugin({ defaultOptions })` pattern: a single bag of values applied to any agent that omits the corresponding field.

| Field | Type | Inherited by |
|---|---|---|
| `defaultOptions.model` | `LlmModelId` (string) | Agents that omit `model` |
| `defaultOptions.tools` | `ToolSelection` (from `tools([...])`) | Agents that omit `tools` |
| `defaultOptions.maxTurns` | `number` | Agents that omit `maxTurns` |
| `defaultOptions.principal` | `boolean \| (principal, exchange) => string` | Agents that omit `principal` |
| `defaultOptions.blocks` | `{ [name: string]: BlockBody \| Blocks }` | All agents (merged by name into per-agent `blocks`; see [Agent blocks](#agent-blocks)). A default may be a nested group; a `false` removal sentinel at any nesting level is rejected with `RC5003` (defaults cannot remove themselves). |

Resolution at dispatch is per-key: instance value > plugin default > (for `model`) throw, (for `tools`) `undefined`. Agents that set `model`, `tools`, `maxTurns`, or `principal` replace the default entirely (override, not extend). Per-agent `blocks` merges into defaults by name (see the [Defaults merging](#agent-blocks) note in the blocks section).

For `model` / `tools` / `maxTurns` / `principal`, two `agentPlugin` installs that each set the same field throw at context init. `blocks` merges additively across installs by name; a name set in two installs throws.

```ts
agentPlugin({
  defaultOptions: {
    model: 'anthropic:claude-opus-4-7',
    tools: tools(['CurrentTime', 'fetchOrder']),
  },
  agents: {
    researcher: { description, system },                            // inherits both
    fast:       { description, model: 'anthropic:claude-haiku-4-5', system },
  },
})
```

#### Soft dependency on `llmPlugin`

Agent model references use the `"providerId:modelName"` format and resolve against the LLM provider registry populated by `llmPlugin`. **You must install `llmPlugin` with the relevant providers.** This is intentional: provider credentials live in one place, and agents reference them by id. There is no inline-credentials escape hatch on `agent({...})`; centralised wiring via `llmPlugin` is the only path.

#### Turn cap (`maxTurns`)

The Vercel AI SDK's tool-calling loop runs until the model returns a final text response or a stop condition fires. Each iteration is one **turn** (one model call plus the resulting tool calls / results). The agent caps turn count to **8 by default**; override per agent via `maxTurns:` or context-wide via `defaultOptions.maxTurns`. When the cap fires the SDK returns whatever text the model produced last; downstream logic should treat truncated output as a possible outcome.

#### Human-in-the-loop (today: blocking; tomorrow: durable)

The current loop is synchronous and in-memory. A tool handler that `await`s for a while pins the agent's await chain until it resolves. Practical sweet spot:

| Tool wait time | Viability today |
|---|---|
| Under a minute | Fine. HTTP timeouts and restart risk are low. |
| 1–10 minutes | Works on most platforms. Acceptable for "ask user, get reply during a meeting" flows. |
| 10 min – 1 hour | Marginal. Platform request timeouts (Vercel, CloudRun, etc.) cap how long an HTTP request can hang. Use queue / cron entry points if the tool may take this long. |
| Hours – days | Not viable in the synchronous loop. Wait for the [durable agents epic](https://github.com/routecraftjs/routecraft/issues/258). `SuspendError` is exported today as a forward-compat stub so handler code can be written against the eventual surface. |

A blocking tool handler today looks like:

```ts
{
  description: "Ask a human for approval via email; wait up to 15 min.",
  input: z.object({ question: z.string() }),
  handler: async (input) => {
    return await pollUntilReply(input.question, { timeoutMs: 15 * 60 * 1000 })
  },
}
```

When the durable epic lands, the same handler migrates by replacing the blocking await with `throw new SuspendError({ reason: "awaiting-human-approval" })` and consuming the resume callback in a separate route. The runtime contract (return value, schema, `FnHandlerContext`) stays identical.

#### Observability: two channels

Agents emit on two distinct channels with different shapes and use cases:

**1. Context bus** (`ctx.on('route:*:agent:*', ...)`): coarse decision events. Broadcast to every subscriber. Use for telemetry, dashboards, audit trails, TUIs. Always emitted; no opt-in needed.

| Event | Fields | When |
|---|---|---|
| `route:<id>:agent:tool:invoked` | `toolCallId`, `toolName`, `input` | Agent decided to call a tool. |
| `route:<id>:agent:tool:result` | `toolCallId`, `toolName`, `output`, `duration` | Tool handler returned successfully. |
| `route:<id>:agent:tool:error` | `toolCallId`, `toolName`, `error`, `duration` | Tool handler / guard / input validation threw. |
| `route:<id>:agent:finished` | `finishReason`, `inputTokens?`, `outputTokens?`, `totalTokens?` | Agent dispatch returned a consolidated result. |
| `route:<id>:agent:error` | `error` | Provider / transport error during dispatch. |

All events also carry `routeId`, `exchangeId`, `correlationId`. Wildcard subscriptions (`route:*:agent:tool:*`) work as expected.

```ts
ctx.on("route:*:agent:tool:invoked", ({ details }) => {
  console.log(`[${details.routeId}] tool ${details.toolName} called with`, details.input);
});

ctx.on("route:*:agent:finished", ({ details }) => {
  metrics.increment("agent.calls.total", { route: details.routeId });
  metrics.histogram("agent.tokens.total", details.totalTokens ?? 0);
});
```

**2. `onDelta` callback** (per-dispatch, opt-in): token-level deltas, directed delivery, back-pressure-aware. Use for streaming tokens to a chat UI / SSE / WebSocket where you want to render text as the model writes it.

```ts
agent({
  model: "openai:gpt-4o",
  system: "Be helpful.",
  tools: tools(["search"]),
  onDelta: (delta) => {
    sse.send({ data: delta.text, type: delta.type });
  },
})
```

Setting `onDelta` switches dispatch from `generateText` to `streamText`; externally the destination still returns a consolidated `AgentResult` once the stream drains.

`AgentDelta` is a narrow discriminated union:

| Type | Fields | When |
|---|---|---|
| `text-delta` | `text` | Each token (or token chunk) emitted by the model. |
| `reasoning-delta` | `text` | Provider reasoning text (Anthropic extended thinking, OpenAI o1). Useful for "thinking..." UI. |

Behaviour notes:

- **Listener errors are contained.** A throw inside `onDelta` is caught and logged; the dispatch keeps running and the consolidated `AgentResult` still reaches downstream ops.
- **Async listeners are awaited.** Returning a `Promise` from `onDelta` applies back-pressure to the stream, which is what you want when forwarding to a slow consumer (database, remote SSE channel).
- **Stream errors still throw.** Provider errors propagate out of the dispatch promise; the `agent:error` context event also fires. Failure handling matches the non-streaming path.
- **Per-agent only.** `onDelta` is not part of `defaultOptions` because delta sinks are typically request-scoped.

For named agents that share a definition across requests, accept `onDelta` at the call site:

```ts
.to(agent("summariser", { onDelta: (d) => sse.send(d.text) }))
```

The 90% use case is forwarding tokens into an HTTP SSE response so a UI updates as the model writes. For everything else (per-tool observability, finish reasons, total usage, errors) use the context bus.

#### Asserting on agent behaviour (`AgentResult.toolCalls`)

For programmatic assertions ("the agent must have replied via `replyEmail`, otherwise escalate"), inspect `AgentResult.toolCalls` in a downstream `.process()` step. The list pairs each tool call with its return value or thrown error in invocation order; combine with step-scope `.error()` for fallback routing:

```ts
craft()
  .id("inbox-bot")
  .from(mail({ account: "support" }))
  .to(agent({
    system: "Reply to the customer via replyEmail. If you cannot answer, leave it unanswered.",
    tools: tools(["replyEmail"]),
  }))
  .error((err, ex, forward) => {
    // Agent did not reply via tool; escalate to a human inbox
    return forward("escalate-to-human", ex.body);
  })
  .process((ex) => {
    const r = ex.body as AgentResult;
    const replied = r.toolCalls?.some(
      (c) => c.toolName === "replyEmail" && !c.error,
    );
    if (!replied) throw new Error("Agent finished without sending a reply");
    return r;
  })
```

The context bus events (`route:*:agent:tool:*`) are the live observation channel for the same calls; `toolCalls` on the result is the synchronous post-hoc view a pipeline step can branch on. Use the bus for telemetry / dashboards / TUIs; use `toolCalls` for assertions and routing.

## Typed fn ids (`FnRegistry`)

For compile-time autocomplete of fn ids in the agent `tools: [...]` field (follow-up story), populate the `FnRegistry` marker interface via declaration merging in your project:

```ts
// src/types/routecraft.d.ts
declare module '@routecraft/ai' {
  interface FnRegistry {
    currentTime: true
    sendSlackMessage: true
  }
}
```

When `FnRegistry` is empty, the id type falls back to `string` (no breaking change).

---
