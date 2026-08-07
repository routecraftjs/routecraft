# 001: Lazy Tool Disclosure

**Status:** draft, unvalidated
**Depends on:** nothing
**Size:** small

---

## Problem

`buildVercelTools` projects every entry of `ResolvedTool[]` into a provider tool definition, complete with its full JSON Schema, on every dispatch. Cost is linear in granted tools and paid on every turn, before the user has said anything.

This lands hardest on the case we are positioned for. We are an MCP server: the pitch is "expose your whole capability catalogue to an agent". A context with 80 capabilities and a handful of MCP servers mounted produces a system prompt where the tool surface dwarfs the instructions. The author's options today are both bad: grant fewer tools than the agent needs, or pay the tokens on every turn of every run.

There is a second, subtler cost. Selection accuracy degrades as the tool list grows, and long schemas crowd out the descriptions that actually drive selection.

## Non-goals

- Tool *search* or ranking. This draft does not filter or reorder the catalogue, it only defers the schema. Semantic tool selection is a separate problem and probably belongs in `tools()` as a selector, not here.
- Changing `tools()` selection semantics. What is granted stays exactly what is granted.
- Anything about MCP protocol-level tool listing. This is about what reaches the model inside a dispatch.

## Design

Split what the model sees into two tiers.

- **Eager**: name, description, and full input schema in the tool definition. Today's behaviour.
- **Lazy**: name and description only, with the schema replaced by a stub. The model calls a synthetic `_tool__describe` tool to retrieve the real schema before invoking.

The model's path becomes: read the catalogue, pick a tool, describe it, call it. Three turns instead of two on first use of a tool, and the describe result stays in the message history so repeat use within a dispatch costs nothing.

The trade is explicit: lazy pays one extra turn per distinct tool actually used, and saves the schema of every tool not used. It wins whenever the granted catalogue is much larger than the working set, which is the case that motivates it.

### DSL

Per agent, because tool-count pressure is a property of the agent's grant:

```ts
.to(agent({
  model: "anthropic:claude-sonnet-4-6",
  system: "...",
  tools: tools([...]),
  toolDisclosure: "auto",
}))
```

`AgentOptions.toolDisclosure?: "eager" | "lazy" | "auto"`, and the same key on `AgentDefaultOptions` so a context can set the house policy once.

- `"eager"` is today's behaviour.
- `"lazy"` always defers.
- `"auto"` defers above a threshold on the resolved tool count.

Default is `"auto"`. This is a behaviour change for existing agents that cross the threshold, which needs a decision (see Open questions).

Per-tool override, for the case where one tool is always used and should not pay the extra turn:

```ts
tools([...], { eager: ["replyEmail"] })
```

### How it works

1. `resolveTools` runs unchanged and produces `ResolvedTool[]`.
2. A new step partitions the array by disclosure, after policy admission so a denied tool is never described.
3. `buildVercelTools` builds eager tools as it does today. For lazy tools it emits the same name and description with a permissive stub schema, and prepends a line to the description telling the model to describe before calling.
4. When any lazy tool exists, a synthetic `_tool__describe` is added, taking `{ name: string }` and returning the tool's JSON Schema plus its description.
5. A lazy tool invoked without a prior describe still validates its input against the real schema. Validation failure feeds back to the model as a tool error, which is the existing self-correction path. **Describe is a hint, not a gate.**

Point 5 is the load-bearing safety property: laziness changes only what the model is *shown*, never what is *enforced*. Guards, `input` validation, and `toolPolicy` admission are untouched.

### Naming

`_tool__describe` follows the existing `_block__load__<name>` convention: `_`-prefixed, `__` separator (`TOOL_NAME_SEPARATOR`), reserved namespace. It is a fixed name rather than per-tool because it takes the tool name as an argument.

## Requirements

**Functional**

- R1. An author can set disclosure per agent and per context, and can force specific tools eager.
- R2. A lazily disclosed tool is callable without a describe call, and validates identically.
- R3. `_tool__describe` returns the same JSON Schema the eager path would have inlined.
- R4. Describing a tool that is not granted returns a tool error naming the mistake, never a schema. It must not be an oracle for the ungranted catalogue.
- R5. `_tool__describe` calls are excluded from `AgentResult.toolCalls` and surface separately, exactly as block loader calls do today via `blocksLoaded`.

**Non-functional**

- R6. Zero behaviour change for an agent whose resolved tool count is below the `auto` threshold.
- R7. Disclosure never widens the tool set. It is a projection of the post-policy array.
- R8. Events: a describe emits on the existing `route:<routeId>:agent:tool:*` family or a sibling, so the extra turn is visible in traces and attributable in cost analysis.
- R9. The chosen mode and the resolved counts appear on the dispatch's telemetry, so an author can see why their agent is paying for an extra turn.

## Open questions

1. **Is `"auto"` the right default, and what is the threshold?** Changing the default alters prompt content for existing agents, which can change model behaviour even when nothing is functionally wrong. `"eager"` as the default is safer and gets no adoption. Leaning `"auto"`, on the basis that the v0 policy makes the whole API unstable and the failure mode is a slower agent, not a broken one. Threshold needs an empirical answer, which needs draft 006.
2. **Is the stub schema an empty object or a permissive record?** An empty object may cause some providers to reject the tool definition. A permissive `Record<string, unknown>` invites the model to guess arguments and skip the describe. Needs provider-by-provider testing.
3. **Should the description carry an argument sketch?** A one-line "takes: to, subject, body" is far cheaper than a schema and might remove most of the describe round trips. It also reintroduces a hand-maintained summary that can drift from the schema, unless it is generated from the schema's top-level keys. Probably worth it if generated.
4. **Does this interact with provider prompt caching?** A stable tool block is cacheable. If lazy disclosure makes the tool block smaller but the describe results push variable content into the message history, the net token win may be smaller than it looks on paper. Worth measuring before claiming a saving.
5. **Should MCP-sourced tools default differently?** An external MCP server's tool count is not under the author's control, which is an argument for defaulting those to lazy regardless of the global threshold.

## Prior art

NOOA's `doc(obj)` lets generated code introspect an unknown object at the moment it needs to, so the prompt stays bounded as the domain grows. Their motivation is factories returning `Any`; ours is catalogue size. Same mechanism, different pressure.

Claude Code's own deferred-tool mechanism is the closer precedent: names are announced, schemas are fetched on demand through a search tool. That it works in production at large tool counts is the main evidence this is a sound trade.

Where we should differ from both: they treat the described interface as the contract. We keep the Standard Schema as the contract and treat disclosure as presentation only. That is what makes R2 possible and keeps this feature out of the security surface entirely.
