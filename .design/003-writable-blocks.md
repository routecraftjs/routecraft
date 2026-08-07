# 003: Writable Blocks

**Status:** draft, unvalidated
**Depends on:** 002
**Enables:** 004, 005
**Size:** medium

---

## Problem

Blocks are read-only. An author composes them, the framework resolves them, the model consumes them. The model has no way to put anything into its own context except by emitting text that will be summarised away or by calling a tool whose result sits in the message history.

That gap matters once a run is long. At turn 15 of a 20-turn dispatch, everything the model established at turn 3 exists only as raw tool results and its own prose, competing for attention with every intermediate step. There is no structured place to put a conclusion.

The workaround today is a tool whose handler stashes state somewhere the author controls, plus a `"turn"` block (draft 002) that renders it back. That works, and it means every author who wants a scratchpad writes the same three pieces. This draft makes it a property of the block instead.

Standing alone, this is a scratchpad feature. Its real value is as the write primitive that draft 004 turns into memory and draft 005 uses for REPL state.

## Non-goals

- Persistence. Everything here is dispatch-scoped and dies with the run. Durability is draft 004, deliberately, so the write surface can be designed and reviewed before anything survives a process.
- Letting the model create blocks that were not declared. Blocks stay author-declared. The model fills a slot; it does not add one.
- Letting the model change a block's mode, lifetime, or description.

## Design

Mark a declared block writable. The framework exposes write tools for it and renders the current value.

```ts
blocks: {
  findings: {
    mode: "inject",
    lifetime: "turn",
    writable: true,
    description: "Conclusions established so far. Update as you learn.",
    value: "",
  },
}
```

`writable: true` adds two synthetic tools, following the existing `_block__load__<name>` convention:

- `_block__set__<name>` taking `{ value: string }`
- `_block__clear__<name>` taking no arguments

Writes land in a dispatch-scoped store keyed by resolved block name. On the next turn, the block renders the written value instead of calling its resolver.

### Why the declared `value` is still required

The resolver stays the seed and the fallback: it produces the content until the first write. This keeps three things true.

- A writable block behaves exactly like a normal block until the model touches it, so nothing changes for a run where the model never writes.
- The author controls the starting content, including computing it from the exchange.
- Draft 004 gets its hook for free: a memory block's resolver is the recall query, and its write path is the store.

### `lifetime` interaction

Writable only makes sense with `lifetime: "turn"`. With `"dispatch"` the write would not be visible until the next dispatch, which is a confusing no-op inside the run that made it.

Options: default `lifetime` to `"turn"` when `writable` is set, or reject the combination at config time with AI1003. Leaning reject, because an implicit lifetime change is exactly the kind of quiet coupling that is hard to find later. Cost is one more line in every writable block declaration.

### Structured writes

A free-string scratchpad is enough for working memory and wrong for anything that leaves the dispatch. Draft 004 needs constrained writes for injection reasons, so the constraint belongs here where the write path lives.

```ts
blocks: {
  findings: {
    mode: "inject",
    lifetime: "turn",
    writable: {
      schema: z.object({
        claim: z.string().max(240),
        confidence: z.enum(["low", "medium", "high"]),
      }),
      append: true,
    },
    description: "...",
    value: "",
  },
}
```

`writable` becomes `true | WritableSpec`. With a schema, `_block__set__<name>` takes the schema's input shape instead of `{ value: string }`, validated by the same Standard Schema path that validates fn input. With `append: true` the block holds a list and the set tool becomes an add, which is the shape memory wants.

Rendering a structured value needs a `render` on the spec, defaulting to something readable for the common cases.

### Reporting

Writes land on `AgentResult` alongside `blocksLoaded`, as a `blocksWritten` summary: block name, write count, final value or entry count. Excluded from `toolCalls`, exactly as loader calls are today, so post-dispatch assertions on real tool usage stay clean.

This matters more than it looks: it is what makes draft 006 able to assert "the agent recorded a finding before answering".

## Requirements

**Functional**

- R1. Write tools exist only for blocks declared `writable`. Nothing else in the block tree becomes writable by proximity or by group.
- R2. A write is visible in the block's rendered content on the next model turn, and not before.
- R3. With a schema, an invalid write fails validation and returns a tool error the model can correct from, without mutating the block.
- R4. Writes are dispatch-scoped and discarded when the dispatch ends, however it ends.
- R5. `_block__set__` / `_block__clear__` calls are excluded from `AgentResult.toolCalls` and reported on `blocksWritten`.
- R6. Concurrent dispatches of the same route never share write state. Keying is per dispatch, not per route or per block declaration.

**Non-functional**

- R7. The reserved `_block_` prefix is already enforced on author block names. Extend the check to cover the new verbs so an author cannot shadow a write tool.
- R8. Events for writes on the agent event family, with the block name and outcome, so a run's context evolution is reconstructible from the trace alone.
- R9. Written content is rendered in the data channel, never as instructions. A model that writes "ignore previous instructions" into a block must produce a rendered block that reads as quoted data. This is cheap here and load-bearing for 004.
- R10. Written content counts towards nothing implicitly: no automatic truncation, no automatic summarisation. If a block can grow, the author caps it via schema or `append` limits. Silent truncation of a model's own notes is worse than a loud failure.

## Open questions

1. **Reject or coerce the `lifetime` combination?** Leaning reject, as above, but it is a DX tax on the common case.
2. **Should `append: true` cap entries?** A `max` on the spec with a documented eviction rule (drop oldest) is probably right, but eviction policy is exactly what draft 004 wants to own at the store. Maybe no cap here and a required cap there.
3. **Does the model need to read a writable block it has not written?** With `mode: "inject"` it always sees the content, so no. With `mode: "progressive"` a writable block is a load-modify-write cycle, which is more machinery than the value seems to justify. Proposal: `writable` requires `mode: "inject"` in v1.
4. **What happens on a `validate` retry?** Writes made in the rejected turn presumably stand, since the model is being asked to correct its answer, not to forget what it learned. Should be stated explicitly either way.
5. **Is `_block__set__` the right verb when a schema and `append` are set?** It reads as replace and behaves as add. `_block__add__<name>` when `append` is set is more honest and means the tool name varies with config, which is its own small cost.

## Prior art

NOOA exposes `self.context` to the model directly, opt-in per agent via `spec(self, "context", hidden=False)`, and their framing is worth borrowing wholesale: context is a first-class API that the developer and the model manipulate through the same interface. Their model can add, update, and remove blocks as its understanding evolves.

Where we should differ, in both directions:

- They let the model create arbitrary named blocks. We should not, at least not in v1. Author-declared slots keep the prompt's shape reviewable, which is the property that makes a Routecraft route auditable in the first place. The cost is that a genuinely exploratory agent cannot organise its own notes.
- They have no schema on writes, because a Python attribute has no schema. We do, and R9 plus the schema is most of what makes draft 004 defensible.
