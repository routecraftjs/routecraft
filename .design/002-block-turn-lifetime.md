# 002: Per-Turn Block Lifetime

**Status:** draft, unvalidated
**Depends on:** nothing
**Enables:** 003, 004, 005
**Size:** small

---

## Problem

`resolveBlocks` runs once per dispatch, before the tool loop starts. An inject-mode block's content is therefore frozen for the whole run: with `maxTurns` defaulting to 20, a block resolved at turn 0 is still being sent verbatim at turn 19.

That is correct for the blocks we ship today. `skills()` content does not change mid-run, and tenant config does not either. It is wrong for anything the run itself changes:

- Progress. "You have processed 12 of 40 orders" cannot be expressed, so the model has to reconstruct it from the tool-result history every turn.
- Budget. "You have 4 turns left" is exactly the kind of steering that prevents a run dying at `maxTurns` mid-task, and it is unrepresentable.
- External state that moves during a long run: queue depth, a lock, an approval that landed while the agent was working.
- Anything draft 003 writes. A writable block that only re-resolves next dispatch is not a scratchpad, it is a report.

The result is that authors push run-varying state into tool results, where it is verbose, unstructured, and repeated in full on every turn rather than replaced.

## Non-goals

- Message history compaction or summarisation. Related pressure, different feature.
- Re-resolving progressive blocks. A loader tool already resolves at call time, which is the correct semantics for on-demand content.
- Mutating history. Per-turn resolution rewrites the system prompt for the next request; it does not edit messages already sent.

## Design

Add a third value to `BlockLifetime`.

```ts
export type BlockLifetime = "dispatch" | "context" | "turn";
```

| Lifetime | Resolved | Cached in |
|---|---|---|
| `"context"` | once, first use | the context |
| `"dispatch"` | once per dispatch (default) | the dispatch |
| `"turn"` | before every model call | not cached |

The type already exists and is already optional on `BlockBody`, so the API change is one union member. The work is in the executor.

### DSL

```ts
blocks: {
  progress: {
    mode: "inject",
    lifetime: "turn",
    value: (exchange) => renderProgress(exchange),
  },
}
```

Everything else about blocks is unchanged: naming, grouping and `__` flattening, ordering, the `false` removal sentinel, and defaults merging from `agentPlugin`.

### How it works

Today `resolveBlocks` returns `{ systemAppend, loaderTools }` once, and the session builds one system prompt from it.

The change splits resolution in two:

1. **Once per dispatch**: resolve `"context"` and `"dispatch"` blocks and build loader tools, as today. Produces a stable prefix.
2. **Before each model call**: resolve `"turn"` blocks and build the suffix.

The system prompt becomes `system + stablePrefix + turnSuffix`. Ordering within the combined append must stay by declaration order, not by lifetime, so an author's `blocks` record reads the way it renders. That means the two halves interleave rather than concatenate, and the resolver needs to keep positional slots rather than a flat string.

A `"turn"` resolver failure cannot abort the dispatch the way an inject failure does at turn 0, because by turn 8 there is real work in flight. Proposal: first failure logs and reuses the previous turn's value; a second consecutive failure fails the dispatch with the existing AI1001. Needs a decision (see Open questions).

### Cost and caching

This is the part that needs care. A per-turn suffix means the system prompt changes on every request, which defeats provider prompt caching for everything after the first differing byte. Putting the volatile content in a *suffix* rather than interleaved is what keeps the cacheable prefix intact, so the ordering requirement above is in tension with the caching requirement.

Two candidate resolutions:

- **Ordering wins.** Interleave by declaration, accept the cache loss, and document that a `"turn"` block placed early in the record is expensive. Honest, but it makes a performance cliff depend on record key order, which is a bad property.
- **Caching wins.** Always render `"turn"` blocks as a trailing section regardless of declaration position, and document it. Predictable cost, at the price of the record no longer reading in render order.

Leaning towards caching wins, because the cost is invisible and the ordering surprise is documentable in one sentence. This is the main thing the design thread should settle.

## Requirements

**Functional**

- R1. A `"turn"` block re-resolves before every model call within a dispatch, including corrective turns triggered by `validate`.
- R2. `"dispatch"` and `"context"` semantics are byte-identical to today.
- R3. Rendering position is deterministic and documented.
- R4. A `"turn"` resolver receives the same `(exchange, context, events, client)` signature. The `events` parameter is where per-turn history will surface when the exchange event log lands, which is what makes progress blocks expressible without threading state through the exchange body.
- R5. `skills()` and any other provider rejects `"turn"` unless it can defend it. `skills()` already validates its `lifetime` option and should keep rejecting anything it does not support.

**Non-functional**

- R6. No extra resolution work for an agent with no `"turn"` blocks. The per-turn pass must be skipped entirely, not run over an empty set.
- R7. Resolver duration is on the trace, per turn. A slow per-turn resolver adds latency to every model call and must be attributable.
- R8. Documented cost model: what a `"turn"` block does to prompt caching, in the docs page, not only here.

## Open questions

1. **Ordering versus caching**, as above. Needs a decision before implementation.
2. **Failure policy.** Reuse-then-fail as proposed, or fail immediately and let `.error()` handle it? Reuse-then-fail is friendlier for flaky external state and is a bit magic. Immediate failure is predictable and will kill long runs over transient blips.
3. **Should there be a guard against expensive resolvers?** A `"turn"` block doing a network call adds that latency to every model call, serially. A soft timeout with a logged warning may be worth more than a hard cap.
4. **Does `"turn"` mean anything for progressive blocks?** Currently no, because a loader resolves at call time already. Should setting it be a config error (AI1003) or a silent no-op? Leaning config error, per the house preference for loud rejection over silent acceptance.
5. **Interaction with 005.** A codeact strategy's REPL state is the canonical `"turn"` block. Does that state get modelled as a normal block an author can see and override, or as strategy-internal content outside the `Blocks` tree? Cleaner as a real block, since it makes the sandbox state inspectable and testable.

## Prior art

NOOA's context blocks come in static and dynamic flavours, where a dynamic block holds a Python expression (`Context(expr="self.render_notes()")`) re-evaluated each turn. Same idea, and their framing is the clearer one: this is not a caching policy, it is a statement about whether the content is a value or a view.

Where we differ: their expression closes over the agent object, so "each turn" is unambiguous because there is only one object. Ours closes over an exchange in a route that may run concurrently, so the resolver contract has to be explicit that it may be called many times per exchange and must stay side-effect free. That belongs in the JSDoc for `BlockResolver`.
