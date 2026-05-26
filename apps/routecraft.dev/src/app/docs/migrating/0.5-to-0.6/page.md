---
title: Migrating from 0.5.x to 0.6.0
---

What changed between Routecraft 0.5.0 and 0.6.0, and how to update. {% .lead %}

The headline change in 0.6.0 is the agent surface: `skills` is removed and replaced by a single unified `blocks` primitive. Every other consumer-visible part of the public API is unchanged.

---

## 1. Agents: `skills` is replaced by `blocks`

`AgentOptions.skills: string[]` and `agentPlugin({ skills })` are removed. They are replaced by a single primitive that covers what skills used to do and unifies it with memory, identity, instructions, and any other system-context contribution: `AgentOptions.blocks: Block[]`.

A block has:

- `name`: identifier, unique within the agent's blocks list. The reserved `_block_load_` prefix is rejected.
- `mode`: `"inject"` to always concatenate the resolved content into the system prompt as `## <name>\n\n<content>`, or `"progressive"` to surface the block as a synthetic loader tool the model invokes on demand. Progressive blocks require a `description`.
- `lifetime` (optional, default `"dispatch"`): `"dispatch"` re-runs the resolver on every dispatch; `"context"` runs it once per `CraftContext` and reuses the result.
- `value`: a static string used verbatim, or a function `(exchange, context, events, client) => string | Promise<string>`. The `client` carries `forward(routeId, payload)`, the same callable route `.error()` handlers receive, so a resolver can delegate to a registered direct route. `events` is reserved (always `[]` today) for a forthcoming exchange-event log.

The big semantic shift: progressive disclosure is now the default for skills. The model sees each skill's name and description in the tool list and loads the body via a tool call only when relevant. This matches Claude Code's actual default. To preserve the legacy "always inject every skill" behaviour, opt into `mode: "inject"`.

### 1.1 Inline `skills` becomes inline `blocks`

**Before (0.5.x):**

```ts
agent({
  model: "anthropic:claude-sonnet-4-6",
  system: "You are an analyst.",
  skills: ["web-search", "cite-sources"],
});
```

**After (0.6.0):**

```ts
agent({
  model: "anthropic:claude-sonnet-4-6",
  system: "You are an analyst.",
  blocks: [
    {
      name: "web-search",
      mode: "inject",
      value: "Always search before answering.",
    },
    {
      name: "cite-sources",
      mode: "inject",
      value: "Always cite your sources.",
    },
  ],
});
```

### 1.2 `agentPlugin({ skills })` and `skills(path)` are removed

`agentPlugin({ skills: { ... } })`, the `skills(path)` markdown loader, the `Skill` / `SkillRegistry` / `RegisteredSkillName` / `SkillOverride` exports, and the `ADAPTER_SKILL_REGISTRY` symbol are all gone. There is no shim.

The new `skillsBlock({ source, mode?, lifetime? })` builder reads the same markdown layout (flat `<name>.md` and nested `<name>/SKILL.md`, with the Claude Code frontmatter the old loader accepted) and returns a `Block[]` you spread into an agent's `blocks` list. **The default `mode` is `"progressive"`** so the model picks which skills to load.

**Before (0.5.x):**

```ts
import { agentPlugin, skills } from "@routecraft/ai";

agentPlugin({
  skills: await skills("./skills"),
});

agent({
  model: "anthropic:claude-sonnet-4-6",
  system: "You are an analyst.",
  skills: ["web-search"],
});
```

**After (0.6.0), progressive disclosure (recommended):**

```ts
import { agent, skillsBlock } from "@routecraft/ai";

agent({
  model: "anthropic:claude-sonnet-4-6",
  system: "You are an analyst.",
  blocks: [...(await skillsBlock({ source: "./skills" }))],
});
```

**After (0.6.0), recovering the legacy "concatenate every skill" behaviour:**

```ts
agent({
  model: "anthropic:claude-sonnet-4-6",
  system: "You are an analyst.",
  blocks: [...(await skillsBlock({ source: "./skills", mode: "inject" }))],
});
```

### 1.3 `agents()` markdown loader: `skills:` frontmatter is rejected

The agent markdown loader (`agents("./agents")`) used to accept a `skills:` frontmatter field. That field is now rejected with `RC5003` "not yet supported" because blocks accept function-form resolvers that YAML cannot express. Set `blocks` on the registered agent in code instead, either via the per-agent `overrides` map handed to `agents()` or via the agent's call site.

**Before (0.5.x):** `agents/researcher.md`

```md
---
name: researcher
description: Researches things
model: anthropic:claude-sonnet-4-6
skills:
  - web-search
  - cite-sources
---
You are a researcher.
```

**After (0.6.0):** drop `skills:` from frontmatter, supply blocks via the overrides map:

```ts
import { skillsBlock } from "@routecraft/ai";

agentPlugin({
  agents: await agents("./agents", {
    researcher: {
      blocks: await skillsBlock({ source: "./skills" }),
    },
  }),
});
```

### 1.4 Resolver-backed blocks (memory, tenant config, identity)

Function-form resolvers receive the live exchange, context, a reserved events list, and a block client. Use `client.forward(routeId, payload)` to delegate to a registered direct route. Use `lifetime: "context"` to evaluate once per `CraftContext` and cache the result across dispatches.

This is the pattern memory adapters will use; it is illustrative, not a shipped builder in 0.6.0.

```ts
import { route, direct, agent } from "@routecraft/routecraft";

route("memory:get")
  .from(direct())
  .process(async (ex) => {
    const principal = (ex.body as { principal: string }).principal;
    ex.body = await loadMemoryFor(principal);
  });

agent({
  model: "anthropic:claude-sonnet-4-6",
  system: "You are Zoe.",
  blocks: [
    {
      name: "memory",
      description: "Long-term notes about the operator.",
      mode: "progressive",
      lifetime: "context",
      value: async (exchange, _context, _events, client) => {
        const principal = exchange.headers["x-principal"] as string;
        const result = await client.forward("memory:get", { principal });
        return result as string;
      },
    },
  ],
});
```

A resolver that needs nothing more than the `CraftContext` can ignore the client and read from the context directly:

```ts
{
  name: "tenant-config",
  mode: "inject",
  lifetime: "context",
  value: (_exchange, context) => {
    const config = context.services.get(TenantConfig);
    return `Tenant: ${config.name}`;
  },
}
```

### 1.5 Loader tool naming reservation

Progressive blocks are exposed to the model as synthetic tools named `_block_load_<blockName>`. Any user tool (fn id, direct route id, or block name) starting with `_block_` is rejected at construction or dispatch time with `RC5026`. Rename the offending tool or block.

### 1.6 `AgentResult`: tool-call partitioning and `blocksLoaded`

Synthetic block-loader invocations no longer appear on `AgentResult.toolCalls`. They surface on a new `AgentResult.blocksLoaded?: AgentBlockLoadSummary[]` so post-dispatch assertions on the agent's user-tool usage stay clean. Each entry carries `blockName`, `toolName` (the `_block_load_<name>` form), `toolCallId`, and either `output` or `error`.

Observability follows the same split: loader calls emit `route:<id>:agent:block:loaded` and `:agent:block:error` instead of the `:agent:tool:*` events.

### 1.7 Defaults merging changes

`agentPlugin({ defaultOptions: { blocks } })` lets a context install shared blocks once. The merge rule differs from how `tools` merges: a per-agent `blocks: [...]` does **not** replace defaults wholesale. Instead, defaults are merged into the final block list by name. A per-agent block whose `name` matches a default replaces only that entry; non-colliding defaults still apply. This matches how identity / memory blocks naturally compose.

### 1.8 New error codes

| Code     | Meaning                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------- |
| `RC5025` | Block resolver threw or returned a non-string. Inject mode aborts the dispatch; progressive mode reports back to the model as a tool error.       |
| `RC5026` | Block name collides with another block, a user tool, or uses the reserved `_block_` prefix.                   |
| `RC5027` | Block misconfigured: missing `name`, invalid `mode`, missing `description` on a progressive block, etc.       |

---

## 2. What is new in 0.6.0

For context, no migration required:

- `skillsBlock({ source, mode?, lifetime? })` and `fromFile(path)` builders alongside the new `Block` shape.
- `agent:block:loaded` / `agent:block:error` context events.
- `AgentResult.blocksLoaded`.
- Three new error codes (RC5025, RC5026, RC5027).
