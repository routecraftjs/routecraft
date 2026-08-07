# Design Drafts

First-draft system designs for features that are not yet committed to. Each document is a starting point for a dedicated design thread, not a specification and not a standard.

A document here has no authority. When a design is settled it moves into `.standards/` (if it establishes a rule), into the docs site (if it establishes user-facing behaviour), or into a tracking issue (if it establishes a work plan). Nothing in this folder is binding on a reviewer.

Every draft states its own status. Treat "Open questions" as the real content: the questions are what the design thread is for.

---

## Index

| # | Draft | Depends on | Size |
|---|---|---|---|
| [001](./001-agent-tool-disclosure.md) | Lazy tool disclosure | none | small |
| [002](./002-block-turn-lifetime.md) | Per-turn block lifetime | none | small |
| [003](./003-writable-blocks.md) | Writable blocks | 002 | medium |
| [004](./004-agent-memory.md) | Agent memory | 002, 003 | medium |
| [005](./005-codeact-strategy.md) | Code as action | 002 | large |
| [006](./006-eval-harness.md) | Evaluation harness | none | medium |

## Provenance

These drafts came out of a comparison against [NVIDIA-labs OO Agents](https://github.com/NVIDIA-NeMo/labs-OO-Agents) (NOOA), a Python agent harness whose central idea is that an agent is a Python object: fields are state, methods are tools, docstrings are prompts, and a method with an `...` body is implemented at runtime by an LLM.

NOOA solves a different problem than Routecraft does. It is a reasoning runtime; we are an integration framework with a reasoning adapter. The drafts here take the ideas that survive the translation and drop the ones that depend on their object model. Where a draft borrows, it says so under "Prior art", including where our version should differ and why.

## The two extension points these drafts share

Almost everything below is a transformation of one of two existing arrays. This is worth stating once, because it is the reason these features are small.

**`ResolvedTool[]`** (`packages/ai/src/agent/tools/selection.ts`). Every tool an agent can call, whatever its origin (registered fn, `Direct(routeId)` capability, external MCP tool), is normalised into one shape carrying `name`, `description`, `input` schema, `tags`, `guard`, `source` provenance, and `handler`. `buildVercelTools` is currently the only consumer.

- Draft 001 withholds `input` from the prompt until the model asks for it.
- Draft 005 projects the array into a sandbox scope instead of into provider tool definitions.
- Draft 006 asserts against the calls made from it.

**`Blocks`** (`packages/ai/src/block/types.ts`). A tree of named contributions to the system prompt, each either injected every dispatch or exposed as a `_block__load__<name>` tool. `skills()` is currently the only provider.

- Draft 002 adds a resolution lifetime.
- Draft 003 adds a write path.
- Draft 004 adds a provider that reads and writes through a route.

Neither array needs a new concept to carry these features. That is the main argument for this shape of the work: the cost is mostly in the executor and the security review, not in the API surface.

## Shared principles

These hold across the drafts and are not restated in each one.

1. **The framework provides the seam; the route owns the policy.** Where a feature needs judgement (is this memory safe to persist, is this code safe to run, is this recall relevant), the framework's job is to route the decision to user code, not to make it. A store route can run an LLM judge, static analysis, or a schema check. A block resolver cannot.
2. **Capability grants are explicit and framework-enforced.** The model never supplies the key that scopes its own access. This is what we have that an object-attribute model does not, and every draft below leans on it.
3. **Nothing new in the DSL vocabulary.** No new builder keywords. New capability arrives as options on `agent()`, as fields on `BlockBody`, or as a provider function returning `Blocks`.
4. **Observable by default.** Every new behaviour emits typed events per `DEFINITION_OF_DONE.md`, and anything the model did lands on `AgentResult` for post-dispatch assertion.
5. **Safe by construction.** Any new default touching trust boundaries is safe in production without configuration, per `.standards/security.md` §6a. Opt in to power, never opt out of safety.
