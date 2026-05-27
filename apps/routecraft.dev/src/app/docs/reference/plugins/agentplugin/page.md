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
| `skills` | `string[]` | No | Skill names whose content is appended to the system prompt. Resolved against `agentPlugin({ skills })` |
| `principal` | `boolean \| (principal, exchange) => string` | No | Append a `## Caller` section describing `exchange.principal`. `true` for the built-in block, a function to render it yourself. Inherits `defaultOptions.principal` when omitted; a per-agent value (including `false`) overrides it. See [Telling the agent who the caller is](/docs/reference/adapters#telling-the-agent-who-the-caller-is) |
| `output` | `StandardSchemaV1` | No | Schema for structured output. Validated and parsed onto `AgentResult.output` after dispatch (runtime ships in a follow-up release) |

Agents loaded from markdown via [`agents("./dir")`](/docs/reference/adapters#agent) accept the same fields as frontmatter. `principal` is supported there as a boolean (`principal: true`); the function-renderer form is a closure YAML cannot express, so set it via the per-agent override map (`agents("./dir", { zoe: { principal: (p) => ... } })`) or `agentPlugin({ defaultOptions })`.

**Resolution semantics:**

- `agent("name")` resolves only registered agents. Route-backed agents are called via `.to(direct("route-id"))` and run the full pipeline of the target route; `agent("name")` runs the registered agent's LLM call inline.
- The plugin throws at context init (`RC5003`) on: duplicate ids across installs, empty id key, missing description, malformed model string when present, empty system, or a non-`ToolSelection` `tools` value.
- The agent throws at dispatch (`RC5003`) when neither the agent nor `defaultOptions.model` supplies a model.
- `agent("unknown")` fails at dispatch (`RC5004`) with the list of registered agent ids.

See the [`agent`](/docs/reference/adapters#agent) adapter for usage patterns.

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
        { tagged: 'read-only' },                    // single tag
        { tagged: ['read-only', 'idempotent'] },    // OR-of-tags
      ]),
    },
  },
  defaultOptions: {
    model: 'anthropic:claude-opus-4-7',             // applies to agents that omit `model`
    tools: tools(['CurrentTime', { tagged: 'read-only' }]),
  },
})
```

#### `tools(items)`

Flat array of items. Each item is one of:

- **Bare string**: name lookup. Plain ids resolve against the fn registry; `Direct(<routeId>)` wraps a direct route via `directTool` (the LLM-facing tool name stays `direct_<routeId>`); `MCP(server:tool)` resolves against `MCP_TOOL_REGISTRY` (populated by `defineConfig.mcp` / `mcpPlugin({ clients })`), and `MCP(server)` (or the raw `mcp__server__tool` / `mcp__server` / `mcp__server__*` forms) expands at dispatch time to every tool the named server exposed. The raw `mcp__server__tool` form is the string Claude Code agent files carry, so they resolve unchanged.
- **`{ name, guard?, description? }`**: same name lookup, with optional per-binding overrides. The guard runs after schema validation and before the handler; throwing surfaces back to the LLM as a tool error so the model can self-correct. The `description` override applies only to this binding for fn-style names. MCP references reject `description` (the MCP server is the source of truth for description and schema; do not override).
- **`{ tagged, from?, guard? }`**: selects every fn / route / MCP tool whose tags overlap the requested set (single tag or array; OR semantics across the array). `from?: string` scopes the walk to a single source; today `from: "mcp__<server>"` restricts the selection to one MCP server. Optional guard applies to every match. Tag-zero-match throws RC5003 so a misconfigured selector cannot silently strip every tool from an agent.

MCP tools are auto-tagged at registration from each tool's MCP annotations: `readOnlyHint → "read-only"`, `destructiveHint → "destructive"`, `idempotentHint → "idempotent"`, `openWorldHint → "open-world"`. That means `{ tagged: "read-only" }` matches fns, routes, AND MCP tools out of the box.

Examples:

```ts
agent({
  tools: tools([
    'CurrentTime',                                  // fn
    'Direct(orders/fetch)',                         // direct route
    'MCP(Nuclino:list_teams)',                      // one MCP tool
    'MCP(Stripe)',                                  // all tools from one MCP server
    { tagged: 'read-only' },                        // cross-cutting tag filter
    { tagged: 'destructive', from: 'mcp__Nuclino' }, // tag filter scoped to one MCP server
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

Resolution rules:

- Final list deduplicated by tool name.
- Explicit refs always win over tag-selector matches, regardless of position in the list.
- A `directTool(routeId)` fn-registry wrapper supersedes the same direct route surfaced via the prefix convention.
- `description` is the only override permitted at the use site, and only on the explicit `{ name }` form for fn-style names. Input schema, tags, and any other registration-time fields are not overridable here. Register a separate fn with `directTool(routeId, { input, tags })` if you need a fundamentally different view. MCP refs reject `description` outright.
- The agent does NOT forward `FnHandlerContext.principal` to the MCP server. Principal authenticates the caller into Routecraft; MCP `auth` (configured on the client) authenticates the Routecraft → MCP hop. To thread user-specific data into an MCP call, put it in the tool's input as a regular argument and let the MCP server enforce its own policy. See `.standards/security.md` §11.

#### Builders

| Builder | Use |
|---|---|
| `directTool(routeId, overrides?)` | Adapt a registered direct route as a fn. Pulls description, input schema, and tags from the route's discovery bundle by default; `overrides` can replace any of those. |
| `currentTime()` / `randomUuid()` | Built-in fn factories (read-only / idempotent). Assign each a tool name in your `functions:` config, the same way as `directTool`. |

MCP tools are NOT exposed via a builder. Use the `MCP(server:tool)` / `MCP(server)` grammar (or the raw `mcp__server__tool` form) inside `tools([...])` instead; the registry populated by `defineConfig.mcp` is the source of truth.

#### Tags

Apply with `.tag(value | values[])` on routes and `tags?: Tag[]` on `FnOptions`. Empty strings are rejected; surrounding whitespace is trimmed at storage so exact selectors match.

`KnownTag` (a literal-suggested type) covers the framework's well-known tags:

```ts
type KnownTag = 'read-only' | 'destructive' | 'idempotent';
```

Any user string is also accepted; the `KnownTag` literals just power autocomplete.

#### Context-level `defaultOptions`

Mirrors the `llmPlugin({ defaultOptions })` pattern: a single bag of values applied to any agent that omits the corresponding field.

| Field | Type | Inherited by |
|---|---|---|
| `defaultOptions.model` | `LlmModelId` (string) | Agents that omit `model` |
| `defaultOptions.tools` | `ToolSelection` (from `tools([...])`) | Agents that omit `tools` |
| `defaultOptions.maxTurns` | `number` | Agents that omit `maxTurns` |
| `defaultOptions.principal` | `boolean \| (principal, exchange) => string` | Agents that omit `principal` |

Resolution at dispatch is per-key: instance value > plugin default > (for `model`) throw, (for `tools`) `undefined`. Agents that set the field replace the default entirely (override, not extend).

Two `agentPlugin` installs that each set the same field throw at context init. Two installs that set DIFFERENT fields merge cleanly.

```ts
agentPlugin({
  defaultOptions: {
    model: 'anthropic:claude-opus-4-7',
    tools: tools(['CurrentTime', { tagged: 'read-only' }]),
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
