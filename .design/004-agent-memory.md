# 004: Agent Memory

**Status:** draft, unvalidated
**Depends on:** 002, 003
**Size:** medium

---

## Problem

An agent forgets everything at the end of a dispatch. Every run of a support route re-learns that this customer is on the enterprise plan, prefers email over chat, and has an open billing dispute. The author's only recourse is to load it all up front into the system prompt, which means loading it for every caller whether relevant or not.

The obvious move is a memory subsystem: a store, a retrieval API, a set of memory tools, a lifecycle. Most frameworks have one and it sits beside everything else in the framework, with its own vocabulary.

We should not build that, because we already have the abstraction. A block is a named, addressable, resolvable section of the system prompt. Memory is a named, addressable, resolvable section of the system prompt that persists and that both parties can write. Draft 002 gives it a live view, draft 003 gives it a write path, and this draft gives it a store.

## The framing that makes this cheap

There are four kinds of agent memory. Blocks already carry one of them in production.

| Kind | What it holds | Block shape | Status |
|---|---|---|---|
| Procedural | how to do things | read-only, progressive | **shipped** as `skills()` |
| Working | this run's scratchpad | writable, `"turn"` | draft 003 |
| Episodic | what happened before | resolver over the event log | needs the exchange event log |
| Semantic | facts about this caller | writable, persisted, scoped | this draft |

`skills()` is not a special mechanism. It is a function returning `Blocks`. `memory()` should be its sibling, and then memory is not a subsystem, it is a provider.

## The store is a route

`BlockResolver` already receives a `BlockClient` whose only member is `forward`, and its JSDoc already names the intended use: `client.forward("memory:get", payload)`. The seam exists.

```ts
craft()
  .id("memory:store")
  .from(direct())
  .to(sqlite({ table: "agent_memory" }))
```

Point it at Postgres, a CRM, a vector database, or a document store, and it is still a route built from adapters we already ship. This is the part no other framework can offer, and it is the reason memory belongs to us rather than being a thing we catch up on:

- The store inherits `.error()`, retry, timeout, circuit breaker, tracing, and `.authorize()`.
- It is testable with `testContext` and `mockAdapter` like any other route.
- **It is where policy lives.** A store route can run an LLM judge over a proposed memory, do static content analysis, check it against a deny list, or require a human approval step, because it is code whose responsibility is deciding what gets saved. A block resolver could never do any of that credibly.

That last point is the design's spine, and it resolves the hardest problem in the feature (see Trust below).

### DSL

```ts
import { agent, memory, skills, tools } from "@routecraft/ai";

.to(agent({
  model: "anthropic:claude-sonnet-4-6",
  system: "You are the support agent for ACME.",
  tools: tools([...]),
  blocks: {
    skills: await skills({ source: "./skills" }),
    memory: memory({
      store: Direct("memory:store"),
      scope: (exchange) => exchange.principal?.subject ?? "anonymous",
      recall: "recent",
      limit: 12,
      schema: z.object({
        fact: z.string().max(240),
        category: z.enum(["preference", "account", "history"]),
      }),
    }),
  },
}))
```

`memory()` returns `Blocks`. It expands to a writable, turn-lifetime, inject-mode block whose resolver is a recall call and whose write path is a store call, which is to say it expands entirely into drafts 002 and 003 plus a `forward`.

### The store contract

The store route receives a discriminated operation and returns a result:

```ts
type MemoryOp =
  | { op: "recall"; scope: string; query?: string; limit: number }
  | { op: "remember"; scope: string; entry: unknown }
  | { op: "forget"; scope: string; id: string };
```

`scope` is computed by the framework from the exchange and passed to the store. **The model never supplies it.** It cannot request another caller's memory because it has no way to name one. Cross-tenant isolation is structural rather than prompted, which is the single most important property here and follows directly from memory living in the route instead of on an agent object.

`entry` is whatever the declared `schema` validated. The store decides identity, ordering, and eviction, because those are storage concerns and every backing store answers them differently.

### Recall

- `"recent"`: last N entries for the scope. Correct up to a few dozen entries and needs no infrastructure.
- `"semantic"`: embedding search over the scope, using `packages/ai/src/embedding`. The query comes from the incoming exchange body by default, overridable.
- `"all"`: everything for the scope, with `limit` as a hard cap.

Recall runs in the block resolver, so it happens once per turn under `lifetime: "turn"`. That is probably too often for a network-backed store: see Open questions.

### Write durability

Writes buffer for the dispatch and commit on success. A run that fails at turn 7 does not leave behind beliefs formed at turn 3.

This matches exchange semantics everywhere else in the framework and it is the right default, because a failed run is exactly the run whose conclusions are least trustworthy. `commit: "immediate"` is the escape hatch for long-running agents where losing an hour of accumulated memory to a late failure is worse.

### Trust

This is the serious risk and it deserves to be stated plainly: **memory is a persistent prompt-injection surface**. A user who gets an instruction into memory has got it into every future system prompt for that scope. Today's injection becomes tomorrow's standing order. This is materially worse than an in-run injection, which dies with the dispatch.

Four mitigations, layered, and the framework only owns two of them:

1. **Schema on writes** (framework). `{ fact: string(max 240), category: enum }` removes most of the payload space. Free-string memory should be possible and should not be the default.
2. **Data-channel rendering** (framework). Recalled entries render as quoted, attributed data, never as instructions, per draft 003 R9. This is the same principle as NOOA's rule against interpolating arguments into docstrings.
3. **Store-route policy** (author). The store decides what is safe to persist, and it has the whole framework available to decide: an LLM judge on the entry, static content analysis, a deny list, an approval route, a human in the loop for a `destructive` category.
4. **Scope isolation** (framework). Blast radius of a successful injection is one scope.

The framework's job is to make (3) natural and unavoidable, not to attempt it. A generic injection classifier in the block layer would be a false promise: it cannot know the domain, and shipping one would encourage authors to skip the layer that can.

This division should be documented as the feature's security model, not buried in a guide.

### Consolidation

Memory grows monotonically and eventually poisons every prompt with stale facts. Consolidation is a capability, not framework code:

```ts
craft()
  .from(cron("0 3 * * *"))
  .to(direct("memory:dump"))
  .to(agent({
    system: "Merge duplicates, drop facts contradicted by newer ones, keep under 50 entries.",
    output: MemoryEntries,
  }))
  .to(direct("memory:replace"))
```

Ship this as an example, not as a built-in. The policy is domain-specific and the author should be able to read it.

## Requirements

**Functional**

- R1. `memory()` returns `Blocks` and composes with other blocks, including defaults from `agentPlugin`.
- R2. Scope is computed by the framework from the exchange and is never model-supplied or model-visible as a parameter.
- R3. Writes are validated against the declared schema before reaching the store.
- R4. Writes buffer and commit on dispatch success by default; `commit: "immediate"` opts out.
- R5. Store failures on recall degrade to an empty memory block with a logged warning, never a failed dispatch. A memory outage must not take down the agent.
- R6. Store failures on commit surface as a dispatch error, because a silent memory loss is worse than a loud one.
- R7. Recalled and written entries appear on `AgentResult` for post-dispatch assertion.

**Non-functional**

- R8. The store is any `Direct(routeId)`. No built-in store in core. A `sqlite` adapter belongs in an adapter package on its own merits, not as a memory dependency.
- R9. `limit` is required, not optional. An unbounded memory block is a prompt-size failure waiting to happen and the API should not make it the easy path.
- R10. Recall and write both emit events with scope, entry count, and duration.
- R11. The security model above is documented as such, including the explicit statement that the framework does not screen memory content.

## Open questions

1. **Recall frequency.** `lifetime: "turn"` re-recalls before every model call, which is 20 store round trips on a default-`maxTurns` run. Options: recall on `"dispatch"` and let writes update a local view for the rest of the run, or add a `recallEvery` control. Leaning "recall once, writes update the local view", which keeps the store call count at one per dispatch plus one per write.
2. **Should `scope` be required?** Defaulting to a constant would make memory global across callers, which is almost never right and is a data-leak default. Requiring it is a small tax that prevents the worst mistake. Leaning required.
3. **Entry identity.** `forget` needs an id, which means recall has to render ids the model can reference, which means ids are in the prompt. Alternative: `forget` by content match, which is fuzzy. Leaning short opaque ids rendered alongside entries.
4. **Does memory belong on `agent()` at all, or in the route?** A `.remember()` operation on the route would put memory in the pipeline where `.error()` and the filter chain can see it. It also means memory is not part of the agent's context, which is the whole point. Staying with blocks, but the alternative deserves a paragraph in the design thread.
5. **Multi-agent shared memory.** Two agents in one context pointing at the same store with the same scope share a memory. That is either the feature or a footgun, depending on whether the entries are agent-attributed. Probably needs an `agent` field on stored entries and a recall filter.
6. **How does this interact with the durable-agents epic?** `SuspendError` is already stubbed for a future where a dispatch persists and resumes. A suspended dispatch's buffered writes need a defined fate, and the answer probably has to come from that epic rather than this one.

## Prior art

NOOA has `nooa-memory` with a `MemoryManager`, plus context blocks the model can manipulate through `self.context`. Their context API is the good idea; their memory package is a conventional store.

Where we differ, and it is the whole pitch: their memory lives on the agent object, so persistence, scoping, and policy are all application concerns solved outside the framework. Ours lives behind a route, so persistence is an adapter, scoping is framework-enforced, and policy is a capability the author writes with tools they already know. "Your agent's long-term memory is an integration" is a sentence only we can say.
