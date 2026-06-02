---
title: Migrating from 0.5.x to 0.6.0
---

What changed between Routecraft 0.5.0 and 0.6.0, and how to update. {% .lead %}

Three consumer-visible changes:

1. **`skills` is replaced by a unified `blocks` record.** Skills, memory, identity, instructions, and any future system-prompt contribution are now one primitive.
2. **Tag selectors on `tools()` are removed.** Programmatic `tools((catalog) => [...])` is the new escape hatch for "give me all read-only tools" style selection.
3. **The `http()` destination option type is renamed.** `HttpOptions<T>` becomes `HttpClientOptions<T>` now that `http()` is a two-sided adapter (the new HTTP source uses `HttpServerOptions`). Type-only change; runtime behaviour and the `http({...})` call sites are unchanged.

Every other consumer-visible part of the public API is unchanged.

---

## 1. Agents: `skills` is replaced by `blocks`

`AgentOptions.skills: string[]` and `agentPlugin({ skills })` are removed. They are replaced by a single primitive that covers what skills used to do and unifies it with memory, identity, instructions, and any other system-context contribution: `AgentOptions.blocks: Blocks` (a `Record<string, BlockBody | false>`).

A block body has:

- `mode`: `"inject"` to always concatenate the resolved content into the system prompt as `## <name>\n\n<content>`, or `"progressive"` to surface the block as a synthetic loader tool the model invokes on demand. Progressive blocks require a `description`.
- `lifetime` (optional, default `"dispatch"`): `"dispatch"` re-runs the resolver on every dispatch; `"context"` runs it once per `CraftContext` and reuses the result.
- `value`: a static string used verbatim, or a function `(exchange, context, events, client) => string | Promise<string>`. The `client` carries `forward(routeId, payload)`, the same callable route `.error()` handlers receive, so a resolver can delegate to a registered direct route. `events` is reserved (always `[]` today) for a forthcoming exchange-event log.

The block's `name` is the record key, not a field on the body. Names starting with the reserved `_block_` prefix are rejected (`RC5026`).

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
  blocks: {
    "web-search": {
      mode: "inject",
      value: "Always search before answering.",
    },
    "cite-sources": {
      mode: "inject",
      value: "Always cite your sources.",
    },
  },
});
```

### 1.2 `agentPlugin({ skills })` is removed; `skills()` returns blocks

`agentPlugin({ skills: { ... } })`, the `Skill` / `SkillRegistry` / `RegisteredSkillName` / `SkillOverride` exports, and the `ADAPTER_SKILL_REGISTRY` symbol are all gone. There is no shim.

`skills({ source, mode?, lifetime? })` keeps the same name as the 0.5 markdown loader but now returns a `Blocks` record you spread into an agent's `blocks: { ... }` map. It reads the same markdown layout (flat `<name>.md` and nested `<name>/SKILL.md`, with the Claude Code frontmatter the old loader accepted). **The default `mode` is `"progressive"`** so the model picks which skills to load.

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
import { agent, skills } from "@routecraft/ai";

agent({
  model: "anthropic:claude-sonnet-4-6",
  system: "You are an analyst.",
  blocks: { ...(await skills({ source: "./skills" })) },
});
```

**After (0.6.0), recovering the legacy "concatenate every skill" behaviour:**

```ts
agent({
  model: "anthropic:claude-sonnet-4-6",
  system: "You are an analyst.",
  blocks: { ...(await skills({ source: "./skills", mode: "inject" })) },
});
```

The function signature changed from `skills(path)` to `skills({ source })`. The return type changed from `Record<name, Skill>` to `Blocks`. Both are visible at the call site.

Spreading flattens every skill into the top-level namespace. To keep them grouped under one addressable key, assign the result to a nested block instead of spreading it (see [1.2b](#1-2b-grouping-skills-under-one-key)).

### 1.2b Grouping skills under one key

A `blocks` value may be a single `BlockBody` (a leaf) or a nested `Blocks` record (a group). Assigning `skills({ source })` to a key, rather than spreading it, keeps every skill under that namespace instead of dissolving them into the top level:

```ts
agent({
  model: "anthropic:claude-sonnet-4-6",
  system: "You are an analyst.",
  blocks: {
    skills: await skills({ source: "./skills" }), // a named group
    tone: { mode: "inject", value: "Be terse." }, // a single block
  },
});
```

Groups flatten depth-first into a single canonical name joined by `__`. A skill `onboarding` under the `skills` group resolves to `skills__onboarding` for its system-prompt heading, its loader tool (`_block_load_skills__onboarding`), and its `AgentResult.blocksLoaded` entry. `__` (not `/`) is used because loader tool names reach the provider unsanitised and must match `^[a-zA-Z0-9_-]{1,64}$`.

Grouping isolates collisions (a skill named `tone` resolves to `skills__tone`, distinct from a top-level `tone` block) and lets you remove or replace the whole collection by its top-level key. Two blocks that flatten to the same name are rejected with `RC5026`. The empty-name and reserved-`_block_`-prefix rules apply at every nesting level. Per-member merge inside a group is not supported in 0.6.0: a per-agent group replaces a default group of the same name wholesale, and `skills: false` removes the whole group.

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
import { agentPlugin, agents, skills } from "@routecraft/ai";

agentPlugin({
  agents: await agents("./agents", {
    researcher: {
      blocks: await skills({ source: "./skills" }),
    },
  }),
});
```

### 1.4 Resolver-backed blocks (memory, tenant config, identity)

Function-form resolvers receive the live exchange, context, a reserved events list, and a block client. Use `client.forward(routeId, payload)` to delegate to a registered direct route. Use `lifetime: "context"` to evaluate once per `CraftContext` and cache the result across dispatches.

This is the pattern memory adapters will use; it is illustrative, not a shipped builder in 0.6.0.

```ts
import { craft, direct } from "@routecraft/routecraft";
import { agent } from "@routecraft/ai";

craft()
  .id("memory:get")
  .from(direct())
  // `.transform(body => body)` is body-in / body-out; the exchange
  // itself is frozen in 0.6 (copy-on-write), so `ex.body = ...` from
  // a `.process()` step would throw. Return the new body instead.
  .transform(async (body) => {
    const { subject } = body as { subject: string };
    return await loadMemoryFor(subject);
  });

agent({
  model: "anthropic:claude-sonnet-4-6",
  system: "You are Zoe.",
  blocks: {
    memory: {
      description: "Long-term notes about the operator.",
      mode: "progressive",
      lifetime: "context",
      value: async (exchange, _context, _events, client) => {
        // Read identity from the typed principal, not from a header.
        // `exchange.principal` is the verified, framework-tracked
        // identity (authenticity, expiry, claims); a string header
        // would bypass those guarantees.
        const subject = exchange.principal?.subject;
        if (!subject) return ""; // anonymous: no memory to inject
        const result = await client.forward("memory:get", { subject });
        return result as string;
      },
    },
  },
});
```

A resolver that needs nothing more than the `CraftContext` can ignore the client and read from the context directly:

```ts
{
  blocks: {
    "tenant-config": {
      mode: "inject",
      lifetime: "context",
      value: (_exchange, context) => {
        const config = context.services.get(TenantConfig);
        return `Tenant: ${config.name}`;
      },
    },
  }
}
```

### 1.5 Loader tool naming reservation

Progressive blocks are exposed to the model as synthetic tools named `_block_load_<blockName>`. Any user tool (fn id, direct route id, or block name) starting with `_block_` is rejected at construction or dispatch time with `RC5026`. Rename the offending tool or block.

### 1.6 `AgentResult`: tool-call partitioning and `blocksLoaded`

Synthetic block-loader invocations no longer appear on `AgentResult.toolCalls`. They surface on a new `AgentResult.blocksLoaded?: AgentBlockLoadSummary[]` so post-dispatch assertions on the agent's user-tool usage stay clean. Each entry carries `blockName`, `toolName` (the `_block_load_<name>` form), `toolCallId`, and either `output` or `error`.

Observability follows the same split: loader calls emit `route:<id>:agent:block:loaded` and `:agent:block:error` instead of the `:agent:tool:*` events.

### 1.7 Defaults merging and removal via `false`

`agentPlugin({ defaultOptions: { blocks } })` lets a context install shared blocks once. The merge rule differs from how `tools` merges: a per-agent `blocks: { ... }` does **not** replace defaults wholesale. Instead, defaults are merged into the final blocks record by name. A per-agent block whose key matches a default replaces only that entry; non-colliding defaults still apply.

To remove a default from a specific agent, set its name to `false`:

```ts
agentPlugin({
  defaultOptions: {
    blocks: {
      "house-style": { mode: "inject", value: "Be terse." },
      safety: { mode: "inject", value: "Refuse harmful requests." },
    },
  },
});

agent({
  model: "anthropic:claude-sonnet-4-6",
  system: "You are a friendly assistant.",
  blocks: {
    // Override "house-style" with a friendlier framing
    "house-style": { mode: "inject", value: "Be warm and helpful." },
    // Drop the "safety" default from this specific agent
    safety: false,
  },
});
```

A `false` for a name absent from defaults is a no-op so adding or removing defaults later cannot silently break an agent's block list.

### 1.8 Multiple `agentPlugin` installs

Two `agentPlugin` installs that each set `defaultOptions.blocks` now merge additively by name (a name set in both installs throws `RC5003`). This matches the per-agent merge semantics and the mental model that blocks are independent contributions. Other `defaultOptions` fields (`model`, `tools`) still throw on any double-set.

### 1.9 New error codes

| Code     | Meaning                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------- |
| `RC5025` | Block resolver threw or returned a non-string. Inject mode aborts the dispatch; progressive mode reports back to the model as a tool error.       |
| `RC5026` | Block name collides with another block, a user tool, or uses the reserved `_block_` prefix.                   |
| `RC5027` | Block misconfigured: invalid `mode`, missing `description` on a progressive block, non-string non-function `value`, etc.       |

---

## 2. Tools: tag selectors removed, function-form added

The `{ tagged }` and `{ tagged, from }` selector variants on `tools()` are gone, along with the `tags` override on `directTool({ tags })`.

**The implicit-extension risk is identical between the deleted tag selector and the new builder form.** In both, a future fn registered with a matching tag silently extends the agent's surface. The deletion does not eliminate the risk; it relocates it. The reason this is still worth doing: a declarative selector embedded in framework config (`{ tagged: "read-only" }`) reads as a static piece of configuration to a reviewer, while a `.filter()` in user code reads as obviously dynamic. The risk surfaces at the call site where a code review can spot it, instead of being implicit in the framework's interpretation of a tag.

For the cases where enumeration is impractical, `tools()` now accepts a builder function that receives a `ToolsCatalog` snapshot:

**Before (0.5.x):**

```ts
agent({
  tools: tools([{ tagged: "read-only" }]),
});
```

**After (0.6.0), explicit (recommended):**

```ts
agent({
  tools: tools(["fetchOrder", "getCustomer", "listOrders"]),
});
```

**After (0.6.0), programmatic escape hatch:**

```ts
agent({
  tools: tools((catalog) =>
    catalog.fns
      .filter((f) => f.tags?.includes("read-only"))
      .map((f) => f.name),
  ),
});
```

The builder receives `{ fns, routes, mcp }`, each a readonly frozen array of `{ name | id | server+tool, description?, tags? }` (entries are deep-frozen so a builder cannot mutate the snapshot). It must return the same `ToolsItem[]` the array form accepts (strings or `{ name, guard?, description? }` objects). Builder errors are wrapped in `RC5003` with the original chained.

### 2.1 `directTool({ tags })` override removed

The `tags` option on `ToolBuilderOverrides` was only meaningful for the now-removed tag selectors. `directTool(routeId, { description, input })` still works for per-binding overrides.

---

## 3. HTTP: option type renamed for the two-sided adapter

`http()` is now a two-sided adapter: the existing destination (`http({ url })`) plus a new source (`http({ path })`) that exposes a route over HTTP. To follow the Server/Client naming convention for two-sided adapters, the destination's option type is renamed:

- `HttpOptions<T>` -> `HttpClientOptions<T>`

The new source side uses `HttpServerOptions`. This is a type-only change. The `http({...})` factory, its overloads, and runtime behaviour are unchanged, so the only update needed is on explicit type imports.

**Before (0.5.x):**

```ts
import { http, type HttpOptions } from "@routecraft/routecraft";

const opts: HttpOptions<MyBody> = {
  method: "POST",
  url: "https://api.example.com/ingest",
};
```

**After (0.6.0):**

```ts
import { http, type HttpClientOptions } from "@routecraft/routecraft";

const opts: HttpClientOptions<MyBody> = {
  method: "POST",
  url: "https://api.example.com/ingest",
};
```

If you never imported `HttpOptions` by name (the common case, since `http({...})` infers its argument type), no change is needed. See the [`http()` adapter reference](/docs/reference/adapters/http) for the new source surface.

---

## 4. What is new in 0.6.0

For context, no migration required:

- **HTTP source adapter.** `http({ path, method? })` exposes a route over HTTP, configured via `defineConfig({ http: { port, host, auth } })`. Bun runtimes bind via `Bun.serve`; Node 22+ uses a `node:http` shim. Global auth (`jwt()` / `jwks()` bearer or `apiKey({...})`), per-route `.authorize()`, built-in `/health`, `/ready`, and `/openapi.json` endpoints. See the [`httpPlugin`](/docs/reference/plugins/httpplugin) reference.
- `skills({ source, mode?, lifetime? })` and `fromFile(path)` builders alongside the new `Blocks` shape.
- Nested block groups: a `blocks` value may be a `BlockBody` leaf or a nested `Blocks` group, flattened by `__` (see [1.2b](#1-2b-grouping-skills-under-one-key)).
- `agent:block:loaded` / `agent:block:error` context events.
- `AgentResult.blocksLoaded`.
- `tools((catalog) => [...])` builder form with `ToolsCatalog` shape.
- New error codes (`RC5018`, `RC5019` for HTTP; `RC5025`, `RC5026`, `RC5027` for agent blocks).
