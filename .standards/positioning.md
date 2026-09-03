# Positioning

What Routecraft is for, and what it is not. This is the first test any addition faces, and it runs before the placement question in [package-boundaries](./package-boundaries.md).

---

## 1. Routecraft connects, and does not compete with what it connects

Routecraft is the connective layer. Its job is to move work between things that already exist: agents, MCP servers, HTTP APIs, message brokers, mail, files and the systems a business already runs. The value is in the connection, and in what the route makes visible around it. It is never in reimplementing the thing on either end.

That reaches past the traditional integration case. Wiring a legacy system to a REST endpoint is one use, and the least interesting one. What this framework is built for is connecting agents: an agent reaching a capability, a capability reaching a model, an MCP server exposing a route, a harness composing all three with the guardrails written where a reader can see them. Routecraft is where those meet.

## 2. A product feature is not a framework feature

When a capable product or library already does a job, Routecraft's contribution is the adapter, an example, and the routes that compose it. Building the job itself inside the framework is a defect, whatever the quality of the code.

The reason is not purity. Anything rebuilt here is a worse version of the product it copies, and it is a version we then maintain forever, against a competitor whose whole company works on it. This holds for storage, search and retrieval, memory, browser rendering, message delivery, scheduling at scale, and anything else with a market.

The practical form of the rule: **if a capability could plausibly be bought, rented, or installed as its own product, it does not belong inside a `@routecraft/*` package.** It belongs behind `mcp()`, behind `http()`, or behind an adapter that wraps somebody else's client.

## 3. The three questions

Before any addition to a `@routecraft/*` package, in order:

1. **Is this connective tissue, or is it the thing being connected?** Only the first belongs here.
2. **Does it carry an invariant nothing else can carry, or reach a system nothing else reaches?** Convenience over existing primitives is neither. `shell()` passes: isolated subprocess execution is an invariant a composed route cannot express. A memory store fails: `http()` already reaches it, and what to remember is the product's job.
3. **Can an author reading the route see the guardrail and change it?** If the answer is no because the guardrail moved into adapter options, the shape is wrong even when questions 1 and 2 passed. See [package-boundaries section 6.1](./package-boundaries.md#61-build-the-harness-out-of-the-framework-not-into-it).

A no to question 1, or a no to both halves of question 2, ends it. Question 3 governs how a yes gets built.

## 4. Where a capability lands

Three homes, in order of preference:

1. **Somebody else's service**, reached with `mcp()` or `http()`. Nothing ships, and nothing is maintained.
2. **The `craft-harness` template, or the author's own app**, as composed routes. The guardrails are visible and the author owns them.
3. **A `@routecraft/*` package**, only when all three questions pass.

Preferring the first is not modesty. A framework that reaches more systems is worth more than one that owns more code.

## 5. Raise it during development, not at review

This is a live check rather than a document to cite afterwards. A contributor or agent building something that fails question 1 or 2 should say so **before writing the code**, name which question fails, and propose the composed-route or third-party shape instead. A feature that arrives at review already built is one that costs a rewrite to place correctly, and the rewrite usually does not happen.

Two cases are already on the record, and both began as proposed framework features:

- **WebFetch and WebSearch.** Proposed as built-in agent tools, then as a web content adapter carrying an egress guard. Both framings were rejected. What shipped is two ordinary `http()` client options (#579) with the routes in the `craft-harness` template (#588).
- **The agent tool names themselves.** `WebFetch`, `WebSearch` and `Bash` are Claude Code's names. The agent loader tolerates them so a borrowed `.claude/agents/` tree still boots; the framework provides none of them.

## Related

- [Package Boundaries](./package-boundaries.md) -- which package a thing belongs in, once this standard says it belongs at all
- [Adapter Architecture](./adapter-architecture.md) -- how an adapter that passes these questions is built
