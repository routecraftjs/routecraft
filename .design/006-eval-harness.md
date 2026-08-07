# 006: Evaluation Harness

**Status:** draft, unvalidated
**Depends on:** nothing
**Size:** medium

---

## Problem

We have no way to answer "did that change make the agent better or worse". Not a hard way, not an approximate way, none.

Concretely, we cannot currently answer any of these:

- Does rewording a tool `description` improve selection accuracy, or did it just feel better?
- Does an agent with 40 granted tools still pick the right one, and at what count does it stop?
- Does draft 001's lazy disclosure hurt selection? By how much?
- Does draft 004's recall surface the relevant memory, or noise?
- Which models can actually drive a given capability set, so we can tell users what to run?

Every one of those is a question about model behaviour against our surfaces, and every one is currently answered by someone trying it once and forming an impression.

This is also a credibility gap. NVIDIA ships a benchmark package, an eval pipeline, and a paper with numbers. Our AI story is "it works", asserted. Theirs is measured. For a framework whose pitch is production reliability, that asymmetry is the wrong way round.

The other drafts make this worse rather than better. 001 needs a threshold, 004 needs a recall strategy, 005 needs proof that models write our declaration surface competently. All three are empirical questions and none can be answered by inspection.

## What makes this cheap

The assertion primitives already exist and were built for other reasons.

- `AgentResult.toolCalls`: every tool the agent called, with input, output, and error, in order.
- `AgentResult.blocksLoaded`: which progressive blocks it chose to load.
- `AgentResult.usage`: tokens.
- `AgentOptions.validate`: a per-run hook that already sees the result.
- `packages/testing`: `testContext`, `mockAdapter`, `spyLogger`, `testFn`.

An eval is a testContext, a route, a set of inputs, and assertions over `AgentResult`. Most of the work is a runner, a reporter, and a way to hold non-determinism honestly. Drafts 003 and 004 add `blocksWritten` and memory reporting, which extends the same pattern without changing it.

## Non-goals

- Benchmarking models against each other in general. We measure our surfaces, not model capability. If GPT-5-mini scores badly on our routes, the finding is about our routes.
- Replacing unit tests. Evals are non-deterministic, slow, and cost money. They answer a different question and they do not gate every PR.
- Scoring output quality with a rubric. Start with mechanically checkable behaviour: which tools, in what order, with what arguments. LLM-as-judge is a later question and a much harder one to keep honest.

## Design

### DSL

An eval suite is a file, like a route is a file:

```ts
import { evalSuite } from "@routecraft/testing";

export default evalSuite({
  route: "./routes/support.ts",
  models: [
    "anthropic:claude-sonnet-4-6",
    "openai:gpt-5-mini",
    "ollama:qwen3",
  ],
  runs: 3,
  cases: [
    {
      name: "refund request routes to the refund tool",
      input: { subject: "refund please", body: "order 1234 arrived broken" },
      expect: {
        calls: ["lookupOrder", "issueRefund"],
        neverCalls: ["deleteRecord"],
        loads: ["skills__refunds"],
      },
    },
    {
      name: "abusive message escalates instead of replying",
      input: { subject: "...", body: "..." },
      expect: {
        calls: ["escalate"],
        neverCalls: ["replyEmail"],
      },
    },
  ],
});
```

```bash
craft eval ./evals
craft eval ./evals --model anthropic:claude-sonnet-4-6 --runs 10
```

The `models` array is the point. The same suite run across a cheap local model and a frontier model tells an author what their capability set actually requires, which is a question every Routecraft user has and none can currently answer.

### Assertions

Start narrow and mechanical:

| Assertion | Checks |
|---|---|
| `calls` | these tools were called, in this order, all succeeding |
| `callsAnyOrder` | these were called, order irrelevant |
| `neverCalls` | these were not called |
| `loads` | these progressive blocks were loaded |
| `output` | the structured output matches a schema or predicate |
| `maxTurns` / `maxTokens` | budget ceilings |
| `custom` | a predicate over the full `AgentResult` |

`neverCalls` is the safety assertion and probably the most valuable one in the set: "under no phrasing does this agent call the destructive tool". That is a claim worth being able to make, and it is exactly the kind of thing that regresses silently when a prompt is reworded.

### Non-determinism

The hard part. A single run proves nothing and a green suite that flakes is worse than no suite.

- `runs: N` per case, reporting a pass rate rather than a boolean.
- A threshold per suite or per case (`passRate: 0.9`), so "9 of 10" is a stated expectation rather than a flake.
- A stable seed where the provider supports it, acknowledged as partial.
- The report is the artefact. A single pass/fail hides everything interesting.

### Side effects

Evals run real routes. A support route that emails people must not email people during an eval.

`mockAdapter` already exists for this and the harness should make it the default posture: tools are mocked unless explicitly marked live, with fixture responses per case. An eval that reaches the network should require saying so. Getting this wrong once, loudly, is how a feature like this loses trust permanently.

### Reporting

Console table for local use. Machine-readable JSON for CI. Comparison against a stored baseline, so the useful output is a delta rather than an absolute:

```
support.ts                    sonnet-4-6    gpt-5-mini    qwen3
refund routes correctly       10/10         9/10          4/10
abuse escalates               10/10         10/10         7/10
never deletes                 10/10         10/10         10/10
avg turns                     3.2           4.1           7.8
```

### CI

Not on every PR. Cost and flakiness both argue against it, and a gate people learn to ignore is worse than no gate.

Proposal: a cheap-model subset nightly, the full matrix on release, and a manual trigger when a PR touches prompt-adjacent surfaces (tool descriptions, block rendering, the agent system prompt). The `neverCalls` safety subset is the one candidate for a real per-PR gate, since it is the cheapest and the highest consequence.

## Requirements

**Functional**

- R1. A suite runs a real route through a real context against N models with M runs per case.
- R2. Assertions read `AgentResult` and nothing private. If an eval needs something the result does not carry, that is a gap in `AgentResult`, not a reason for a back door.
- R3. Tools are mocked by default with per-case fixtures. Live calls are explicit.
- R4. Output is a per-case pass rate, not a boolean.
- R5. Results serialise to JSON, and a run can be compared to a stored baseline.
- R6. A missing provider credential skips that model with a clear message rather than failing the suite.

**Non-functional**

- R7. Lives in `@routecraft/testing`, with the `eval` command in `@routecraft/cli`. No new package.
- R8. Cost is reported per run: tokens and, where known, money. An author must be able to see what a suite costs before running the matrix.
- R9. Deterministic parts of a run (which fixtures, which prompts, which tool set) are captured with the results so a surprising outcome is diagnosable without a rerun.
- R10. The harness does not fail a run because a model was merely slow. Timeouts are reported distinctly from assertion failures.

## Open questions

1. **Does `evalSuite` belong in `@routecraft/testing` or its own package?** Testing is a dependency of user test suites and should stay small; an eval runner brings a reporter, a baseline store, and model fan-out. Check against `.standards/package-boundaries.md`.
2. **How are fixtures authored?** Inline per case is verbose but readable and local. A fixture directory is cleaner and adds indirection. Inline probably wins for a first version.
3. **Is `calls` ordered by default?** Ordered is stricter and will produce false failures when a model legitimately reorders independent calls. Unordered is laxer and misses real regressions. Leaning unordered by default with `callsInOrder` for when order matters.
4. **What is the baseline story?** A checked-in JSON per suite is simple and will produce noisy diffs on every run. A stored artefact is cleaner and adds infrastructure. Probably checked-in with rounded numbers.
5. **Do we publish our own numbers?** Running this against our example capabilities and publishing the matrix would be a strong signal, and it commits us to keeping it green and to explaining every regression in public. Worth doing, worth deciding deliberately.
6. **LLM-as-judge for output quality.** Deferred, but the harness should not be shaped in a way that makes it impossible to add later. A `custom` predicate that happens to call a model is the natural seam.

## Prior art

NOOA ships `nooa-bench` with a `BenchAgent` and a Harbor runner, plus a separate `eval_pipeline`, and reports SWE-bench Verified and Terminal-Bench 2.0 results in their paper. They are measuring harness capability against standard benchmarks, which is the right instrument for a reasoning runtime.

Ours should measure something different and more useful to our users: not "how capable is this agent" but "does this capability set work, on which models, and did that change break it". Those are the questions a Routecraft author actually has, and no existing benchmark answers them because no existing benchmark knows about their tools.
