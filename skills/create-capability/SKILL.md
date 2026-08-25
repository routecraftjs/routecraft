---
name: create-capability
description: Author a new Routecraft capability (workflow, automation, MCP tool, webhook handler, or scheduled job). Use when the user asks to compose adapters into a pipeline.
allowed-tools: Read Glob Grep WebFetch Bash(bun run lint:*) Bash(bun run typecheck:*) Bash(bun run test:*)
---

# Create a Routecraft capability

A capability is the user-facing unit of automation in Routecraft. It is a typed pipeline that starts at a source (`from(...)`), flows through operations (`transform`, `enrich`, `filter`, `validate`, `split`, `aggregate`, `choice`, `process`, `tap`), and lands at one or more destinations (`to`). The codebase calls these "routes" internally because that is what the `craft()` builder returns; in user-facing language and in the docs they are capabilities.

You are writing this capability for the user. Treat the linter (`bun run lint`) as authoritative once you have written the code: if it disagrees, the linter wins.

## When to use this skill

Use this skill when the user asks to:

- Build a workflow, pipeline, or automation
- Expose a tool to AI via MCP
- Handle a webhook, scheduled trigger, or message
- Compose adapters to integrate two or more systems
- Wrap business logic so AI agents can call it

If the user only needs a small utility function with no I/O and no orchestration, that does not need to be a capability. If it crosses systems, has retry semantics, or should be discoverable, it does.

## Step 1: clarify

Confirm answers to these questions before writing. Ask the user only the ones that are not already obvious from context.

1. **What triggers the capability?** A direct call from another capability? An MCP tool invocation? A webhook (HTTP source)? A timer or cron? A mail inbox? A simple in-memory payload (typical for tests)?
2. **What is the body shape on input and output?** Bodies are typed end to end; commit to a Zod or other Standard Schema for `input` and `output` if the user knows what they want
3. **What does the pipeline do?** Linear (one transform, one destination)? Fan-out then fan-in (`split` then `aggregate`)? Branch (`choice`)? Conditional drop (`filter`)? Schema check (`validate`)? Name each behavior as an operation now; whatever you name here must appear in the chain, not inside a `.process()` body (see the rule in Step 3)
4. **Does it need batching?** If the source emits many small messages and the work batches naturally, set `.batch({...})` before `.from(...)`
5. **Does it need resilience?** If failures should retry, time out, or fall back, plan to use the route- or step-scope wrappers (`.error(...)` is built in; others are coming)

## Step 2: pick the closest example

Read [`reference/examples-index.md`](reference/examples-index.md) and pick the row that best matches the answers above. The index maps intent to a public doc page and the closest existing capability on GitHub.

Then, in this order:

1. `WebFetch` the linked doc page (raw markdown variant on `routecraft.dev/raw/docs/...`)
2. `WebFetch` the linked example file on GitHub (use the `raw.githubusercontent.com` URL)
3. If the user is in this monorepo, `Read` `examples/src/<closest>.ts` end to end
4. Only after that, write the new capability

Do not write from memory. Capabilities look small but the operator order, schema placement, and direct-call id linking are easy to get wrong without a reference.

## Step 3: write the capability

The DSL is fluent and mostly self-documenting once you have an example open. Common shape:

```ts
import { craft, simple, http, log } from "@routecraft/routecraft";
import { z } from "zod";

const Input = z.object({ /* ... */ });
type Input = z.infer<typeof Input>;

export default craft()
  .id("my-capability")              // required for direct-call routing
  .title("Human-readable title")    // surfaced in MCP tools and the TUI
  .description("What this does")    // surfaced in MCP tools
  .input({ body: Input })           // typed and validated at the boundary; retypes the chain
  .from(/* source */)               // body is already typed as the Input schema output
  // operations
  .to(/* destination */);
```

### The chain is the logic; `.process()` is the last resort

The route chain is read by people who will never read the step internals: reviewers, operators, non-technical stakeholders, and anyone checking a route an AI wrote. Checking the DSL is cheap; checking imperative logic is not. So every behavior that has an operation must appear *as that operation in the chain*, where it can be seen. The anti-pattern this rule exists to kill:

```ts
// WRONG: a script wearing a route costume. The chain says nothing;
// all branching, mapping, and even the send hide inside one processor.
craft()
  .id("sync-orders")
  .from(http("/orders"))
  .process(async (ex) => {
    if (ex.body.status === "cancelled") return ex;
    const enriched = await fetchCustomer(ex.body);
    if (enriched.vip) await notifySales(enriched);
    await postToErp(enriched);
    return ex;
  })
  .to(noop());
```

```ts
// RIGHT: the same behavior, visible in the chain.
craft()
  .id("sync-orders")
  .from(http("/orders"))
  .filter((ex) => ex.body.status !== "cancelled")
  .enrich(customerLookup())
  .choice(when((ex) => ex.body.vip, (b) => b.tap(salesNotifier())))
  .to(erp());
```

Concrete rules:

- Branching is `.choice()`, conditional drop is `.filter()`, reshaping is `.transform()`, pulling data in is `.enrich(...)`, side effects are `.tap(...)`, sending is `.to(...)`, fan-out/fan-in is `.split()`/`.aggregate()`, schema checks are `.validate()`/`.input()`. An `if` inside a step body that selects *behavior* is a `.choice()` or `.filter()` that escaped the chain.
- **`.to(noop())` is a red flag.** If the route ends in `noop()` while a step above performs the real send, the destination is hiding; move it into `.to(...)` (or `.tap(...)` if it is fire-and-forget). `noop()` is legitimate only when the route genuinely produces no outbound effect (its value is the reply body or the enrichment itself).
- `.process()` is for the rare step no operation expresses (a multi-field stateful interaction with the exchange). Reaching for it because it is familiar imperative code is the failure mode; if a chain of two operations can say the same thing, write the two operations.
- Before finishing, reread the chain alone and ask: can a reader who opens only `route.ts` say what this capability does, to what, under which conditions, and where results go? If any of those answers lives inside a step body, the chain is not done.

Authoring rules to keep in mind:

- **Keep the DSL readable -- this is the point of the framework**: `route.ts` exists so a reader can follow the *flow* (where data comes from, what happens to it in order, where it lands) without reading the inner workings of every step. A wall of inline logic defeats that. Never inline a large `transform`, `process`, `enrich`, or `filter` body. Extract anything beyond a couple of trivial lines into a named function in a sibling internal file in the capability folder (e.g. `summarise.ts`, `map-order.ts`) and pass the reference: `.transform(toOrderLine)` instead of `.transform((x) => { /* 30 lines */ })`. The named step then reads like a verb in the pipeline. Inline lambdas are fine only when they are short and self-evident
- **Metadata first**: `.id()`, `.title()`, `.description()`, `.input()`, `.output()`, `.error()`, `.batch()` come **before** `.from(...)`. Once you call `.from(...)`, you are in the pipeline and metadata methods no longer apply
- **Typed bodies**: declare `.input({ body: Schema })` before `.from(...)`; the chain is retyped from the schema's inferred output, so no `.from<Input>(...)` generic is needed. An explicit `.from<T>(...)` still overrides the inferred type when you need to
- **No mutation**: pure transforms return new objects via spread. Side effects belong in `.tap(destination)`
- **Choose the right destination operator**:
  - `.to(target)` -- a destination's `send` is void (the body flows through unchanged; receipts land on headers); an enricher's `fetch` result replaces the body
  - `.enrich(enricher)` -- pull data in; the fetched value replaces the body, or pass an aggregator (`only(...)`, `none()`) to merge or ignore it
  - `.tap(target)` -- fire and forget; do not wait, do not change the body, results discarded
- **Split or aggregate** belongs together. After `.split()` you can chain operations on each item; close with `.aggregate()` to fan back in
- **Resilience wrappers** stack outside-in. `.error(handler)` at route scope catches anything that escapes the pipeline; at step scope, attach it to a single step
- **Schemas as the contract**: prefer Standard Schema (`@standard-schema/spec`). Zod and Valibot both work because both implement Standard Schema. Use `@routecraft/routecraft`'s helpers in shared code, not Zod directly

## Project structure: one folder per capability

This is a documented Routecraft standard, not a suggestion. `bunx create-routecraft` scaffolds this shape, and the project-structure page is the source of truth: https://routecraft.dev/raw/docs/introduction/project-structure.md (read it if you are setting up a new project or unsure where a file belongs).

Each capability is its own folder under `capabilities/`, grouped by domain:

```text
capabilities/
  <domain>/
    <id>/
      route.ts        # public surface AND the readable main flow (default export + input/output types)
      route.test.ts   # colocated test (see Step 4)
      README.md       # short description; mermaid + integrations table for complex ones
      <internal>.ts   # mappers, transforms, helpers; never imported from outside this folder
```

Rules:

- **`route.ts` is the readable main flow.** It is both the public surface and the file a human reads to understand what the capability does. Keep it to the DSL chain plus its schemas: a reader should follow the flow top to bottom without paging through transform internals. The heavy logic lives in the sibling internal files and is pulled in by name (see the readability rule in Step 3). If `route.ts` is becoming hard to scan, that is the signal to extract, not to add a comment.
- `route.ts` is the only file other capabilities may import. Re-export the capability's input/output types from it so callers depend on the contract, not the internals.
- Internal files (`summarise.ts`, `map-order.ts`, `__fixtures__`, ...) hold the implementation detail of each step. They are private to the folder; never import them from another capability.
- Reuse capability *behavior* through `direct('<id>')` plus the types re-exported from the callee's `route.ts`. Never reach into another capability's internal files.
- Reuse *pure helpers* (validate an amount, parse a date, a shared domain type) through a top-level `shared/` folder next to `capabilities/`. Any capability may import from `shared/`; keep it pure (validators, parsers, formatters, types), with no side effects and no imports back into a capability's internals. This is the single-project answer, so a one-app repo never needs workspace tooling just to share a date parser. Once the repo grows into multiple apps under `apps/`, shared helpers graduate from `shared/` to a workspace package each app depends on.
- A single-file capability (`capabilities/<id>.ts`) is acceptable shorthand for a trivial, internal-free capability, but the folder shape is the default the scaffolder produces.

## Step 4: write tests

In a project that follows the folder-per-capability layout, colocate the test as `route.test.ts` next to `route.ts`. When contributing inside this monorepo's packages, tests instead live in the package's `test/` directory (`packages/<pkg>/test/<name>.test.ts`). Every test must have JSDoc with `@case`, `@preconditions`, `@expectedResult`. Use `@routecraft/testing` and follow the canonical lifecycle:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { testContext, type TestContext } from "@routecraft/testing";
import myCapability from "../src/my-capability";

describe("my-capability", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
  });

  /**
   * @case happy path
   * @preconditions a valid input body
   * @expectedResult the capability completes without errors
   */
  it("transforms the body and sends to destination", async () => {
    t = await testContext().routes([myCapability]).build();
    await t.test();
    expect(t.errors).toHaveLength(0);
  });
});
```

Errors thrown inside handlers are caught at the boundary and surfaced on `t.errors`; do not expect `t.test()` to reject. Full test pattern: https://routecraft.dev/raw/docs/introduction/testing.md

## Step 5: verify

Run, in this order, until each is clean:

```bash
bun run typecheck
bun run lint
bun run test
```

Use `bun run <script>` (not `bun <script>`) so Bun invokes the package.json script rather than its built-in test runner. If `bun run lint` complains, fix the capability rather than silencing the rule. The linter encodes Routecraft's authoring rules. If it does not catch something the user expected it to catch, that is a follow-up for the lint package.

## Useful URLs

- Project structure (folder-per-capability standard): https://routecraft.dev/raw/docs/introduction/project-structure.md
- Capabilities introduction: https://routecraft.dev/raw/docs/introduction/capabilities.md
- Operations introduction: https://routecraft.dev/raw/docs/introduction/operations.md
- Operations reference: https://routecraft.dev/raw/docs/reference/operations.md
- Exchange model: https://routecraft.dev/raw/docs/introduction/exchange.md
- Composing capabilities: https://routecraft.dev/raw/docs/advanced/composing-capabilities.md
- Error handling: https://routecraft.dev/raw/docs/advanced/error-handling.md
- Worked example (file to HTTP): https://routecraft.dev/raw/docs/examples/api-sync.md
- All Routecraft AI-friendly docs index: https://routecraft.dev/llms.txt
