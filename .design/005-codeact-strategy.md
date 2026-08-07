# 005: Code as Action

**Status:** draft, unvalidated, needs a security review before any implementation
**Depends on:** 002
**Size:** large

---

## Problem

`agent()` runs one loop shape: the model emits tool calls, the runtime executes them, the results go back as messages, repeat until `stopWhen: stepCountIs(maxTurns)`.

That shape costs a full model round trip per action, and it re-sends every prior tool result on every turn. For work that is a loop over data, this is quadratic in a way that has nothing to do with the difficulty of the task:

> Fetch yesterday's orders, fetch the ledger, find the mismatches, post an adjustment for each.

Forty orders means roughly forty-five round trips, each carrying the accumulated results of all the previous ones. The model is not reasoning at each step, it is iterating, and it is paying reasoning prices to do it. Runs like this hit `maxTurns` and die halfway, which is the worst possible outcome because the side effects are half-applied.

NVIDIA's paper on NOOA reports this as the largest single lever on harness performance, which is consistent with what the CodeAct literature has been saying: let the model write code and the turn count collapses.

## Why this fits us better than it fits them

NOOA's sandbox scope is everything visible at module level plus everything public on the agent object, minus what you explicitly hid. That is why they need a whole visibility model (`@hidden`, `Annotated[T, hidden]`, `with hidden:`, per-scope defaults) and why their README has to say that the AST checks are not a containment boundary.

Ours is inverted and already built. `tools()` is a whitelist. `ResolvedTool[]` is the complete, normalised, policy-admitted set of things the model may call, each with a Standard Schema, a guard, and provenance. Nothing else is reachable because nothing else was granted.

So the interesting half of their design (the sandbox scope) is a projection of an array we already have, and the dangerous half (deciding what to hide) does not exist for us. That is a real structural advantage and it is the reason this is worth attempting.

Second advantage: calls out of the sandbox re-enter the same dispatch path as any other tool call, so `toolPolicy` admission, `guard`, input validation, `.authorize()`, and the `route:agent:tool:*` events all still apply. NOOA's REPL calls are invisible to any policy layer because there is no layer to be visible to.

## Non-goals

- Self-modifying agents. The model does not author routes, does not persist code, does not extend its own capability set. See "What we should not take".
- Replacing the tool loop. Codeact is an opt-in alternative for a specific shape of work, not the new default.
- A general-purpose code interpreter. The sandbox exists to compose granted capabilities, not to run arbitrary user workloads.

## Design

### Strategy as an option, not a destination

```ts
.to(agent({
  model: "anthropic:claude-sonnet-4-6",
  system: "Reconcile yesterday's orders against the ledger.",
  strategy: codeact({ maxCells: 8 }),
  tools: tools(["Direct(fetch-orders)", "Direct(fetch-ledger)", "postAdjustment"]),
}))
```

`AgentOptions.strategy?: AgentStrategy`, defaulting to the current behaviour. A new destination per loop shape would leave us with `codeact()`, `reflexion()`, and friends cluttering the DSL forever, and it would make swapping one for another a caller-visible change. Strategy is an execution detail; the contract is `system` plus `tools` plus `output`.

`llm()` stays as it is. It is not "the predict strategy", it is a different destination with a different job.

### What the model sees

Instead of provider tool definitions, the model gets a typed surface generated from the same `ResolvedTool[]`:

```ts
declare const fetchOrders: (input: { date: string }) => Promise<Order[]>
declare const fetchLedger: (input: { date: string }) => Promise<LedgerEntry[]>
declare const postAdjustment: (input: { orderId: string; delta: number }) => Promise<void>

declare function finish<T>(result: T): never
```

Generated from each tool's `input` Standard Schema. Names are the same wire-form names used today (`direct__fetch_orders` and friends), which is ugly in code; a mapping to camelCase identifiers with the wire name in a comment is probably right and needs collision handling.

Two synthetic entry points remain: one to execute a cell, one to finish. `finish()` replaces the "final text" concept and carries the `output` schema when one is declared.

### The loop

1. Resolve tools, apply policy, generate the ambient declarations.
2. Model emits a cell of TypeScript.
3. Cell runs in an isolated worker. Calls to granted capabilities are proxied back to the host and dispatched through the normal path.
4. Result (stdout, return value, or error with stack) goes back as the next turn's input.
5. Repeat until `finish()` or `maxCells`.

REPL state between cells is the canonical `lifetime: "turn"` block from draft 002, which makes it inspectable in traces and assertable in tests rather than being strategy-internal magic.

### Isolation

This is where the draft stops being cheap.

Proposal: a Bun `Worker` with no filesystem access, no network, no `process`, a wall-clock timeout, and a memory cap. Capability calls cross the boundary by `postMessage` and are dispatched on the host, so the worker holds no credentials, no context, no store. Static validation of the emitted code before execution is worth having as a fast-fail for obvious mistakes.

The honest framing, which should appear in our docs the way it appears in NVIDIA's README: **static validation is not a containment boundary.** A worker is a resource boundary and a capability boundary, not a security boundary against determined escape. Anyone running codeact against untrusted input should be running the whole context in a container.

What is genuinely different for us is that the worker has nothing worth escaping *to*: no credentials in scope, no filesystem, and every side effect it can reach is one we explicitly granted and can revoke. The blast radius is the tool grant, which the author already wrote down. That is a much better story than "the model can see every module-level name", but it is not a containment guarantee and we must not sell it as one.

### Defaults

Off. `strategy` omitted means today's tool loop. Enabling codeact is an explicit act by an author who has read what it does, per `.standards/security.md` §6a.

## Requirements

**Functional**

- R1. Only granted, policy-admitted tools are reachable from a cell. The generated surface is a projection of the post-policy `ResolvedTool[]`.
- R2. Every capability call from a cell goes through the same validation, guard, and dispatch path as a tool call today, and emits the same events.
- R3. `AgentResult.toolCalls` is populated from cell-originated calls, so post-dispatch assertions work identically under either strategy.
- R4. A cell that throws returns the error to the model for self-correction. A cell that exceeds its budget terminates the worker and reports it.
- R5. `output` schema, `validate`, `blocks`, `principal`, and `onDelta` all behave the same under codeact. Strategy must not silently drop agent features.
- R6. A route using codeact is still statically readable: the capability grant is in the source, even though the composition is not.

**Non-functional**

- R7. Worker has no ambient filesystem, network, environment, or process access.
- R8. Wall-clock, memory, and cell-count budgets are enforced and configurable, with safe defaults.
- R9. Cell source is captured on the trace. Reproducing a run means reading what it actually executed, and without this the strategy is undebuggable.
- R10. No credentials cross the worker boundary in either direction.
- R11. Documented threat model that says plainly what the worker does and does not protect against.

## Open questions

1. **Is TypeScript the right cell language, or JavaScript?** TS gives the model types to reason against, and needs a transpile step per cell. JS is simpler and throws away the main advantage of generating declarations. Leaning TS with a fast transform, but the latency per cell needs measuring.
2. **Do models write our declaration surface well?** The whole design assumes they do. This is an empirical question and it is the first thing to test, before any isolation work. Draft 006 is the instrument.
3. **What is the state model between cells?** Full REPL continuity (variables persist) is what makes codeact powerful and makes the worker stateful and harder to bound. Stateless cells are simpler and force the model to re-fetch. Leaning stateful with an explicit size cap on retained state.
4. **How does this interact with `maxTurns`?** A cell is not a turn in the same sense. Probably needs its own `maxCells` budget rather than overloading the existing one, which is what the DSL sketch above assumes.
5. **Streaming.** `onDelta` streaming a cell of code to a UI is of limited value, but killing streaming under codeact is a silent feature regression. Needs a decision.
6. **Node compatibility.** `Worker` semantics differ between Bun and Node, and the core library targets both. Either the strategy is Bun-only (acceptable, the CLI already is) or the isolation layer is abstracted, which is more work and probably weaker.
7. **Does this belong in `@routecraft/ai` or its own package?** It pulls in a transform step and an isolation layer, neither of which every AI user needs. `.standards/package-boundaries.md` has a bounded-package-count position that this should be checked against.

## What we should not take

NOOA lets the model define new generation methods mid-run and persist them into a skill library, so an agent extends itself across runs. It is the most impressive thing in their framework and we should not copy it.

A Routecraft route being a static, readable, lintable, diffable graph is the property we sell. An agent that rewrites its own capabilities destroys it: two runs of the same route no longer mean the same thing, and no reviewer can say what the system does. If we ever want this, the shape is "the agent generates a route file and opens a pull request", where a human remains in the loop and the artefact is reviewable. Never hot-load.

Worth stating in the design thread as a boundary, because the pull towards it is strong once codeact exists: the model is already writing code, and letting it keep the good bits is only a small step away in implementation and an enormous one in what the framework promises.

## Prior art

NOOA's `CodeActStrategy` is the direct reference, with `execute_python()` and `return_result()` as the two entry points, a Jupyter-style REPL, per-method strategy selection, AST validation plus module deny-lists, and OpenShell for real isolation. Their `@strategy` decorator is the model for making strategy a swappable per-call concern rather than part of the contract.

The broader CodeAct line (executable code as the action space, rather than JSON tool calls) predates them and is where the turn-count evidence comes from.
