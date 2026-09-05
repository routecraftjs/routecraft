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

## 3. Enable it, never own it

The framework's job is to make hard things easy to build. It is not the thing that does them.

The distinction is about where code lives, not about ambition. Routecraft must **enable** a route to drive a remote execution environment. It must never **own** the fleet, the provisioning policy, the quota or the bill. The same sentence holds for browser automation, memory, message delivery and every other capability some vendor already sells: the framework carries the seam, and the seam is measured by how much effort it removes from the person building on it.

Two cases fix the bar.

- **Docker in the built-in sandbox clears it.** Writing a custom isolation adapter from scratch was always possible, and still is. Adding Docker to the shipped sandbox removed a large amount of effort from everyone who builds an agent on the framework. That is the shape a framework addition should have.
- **A helper that saves ten lines does not.** It is defensible in isolation every time, and the accumulation of such helpers is what turns a framework into the thing that does things. The answer to it is an example, a documentation page and a blog post: readers copy it, learn how it is done, and the framework does not carry it.

When a bought service eventually costs more than building would, the answer is a product built and sold beside the framework. It still does not go into a `@routecraft/*` package.

## 4. Protocol, operation, or product

The fast classification test, applied once section 3 is cleared. Everything falls into one of three kinds, and the kind decides the answer before any further reasoning:

- **A protocol** (HTTP, MCP, WebSocket, AMQP, MQTT, SSE, OAuth, a codec). **Build it.** A protocol reaches every system that speaks it, so the work pays off across every integration that will ever exist. This is why protocol-level work outranks everything else in the framework.
- **A cross-cutting operation** (retry, cache, throttle, timeout, circuit breaker, split, dedupe, error handling). **Build it.** Every connector benefits from it, and the framework is the only place it can sit where an author reading a route can see it and change it.
- **A product or a vendor** (a chat platform, a memory store, a mail provider, a search API, a CRM, a sandbox provider). **Connect it.** Somebody sells it, maintains it, and employs people to make it better than we can. Our contribution is the adapter or the MCP pointer, an example, and the routes that compose it.

The default when a thing does not obviously sort: **if it has an HTTP API or an MCP server, the answer is connect.**

A worked non-example. A Telegram connector looks like framework work and is not: Telegram publishes an API, anyone can integrate with it in an afternoon, and building it here buys reach with one vendor's users at the cost of maintaining their surface forever. It is legitimate work, and it is low priority next to any protocol or operation. The same reasoning retires most requests of the form "Routecraft should support X".

## 5. The three questions

Before any addition to a `@routecraft/*` package, in order:

1. **Is this connective tissue, or is it the thing being connected?** Only the first belongs here.
2. **Does it carry an invariant nothing else can carry, or reach a system nothing else reaches?** Convenience over existing primitives is neither. `shell()` passes: isolated subprocess execution is an invariant a composed route cannot express. A memory store fails: `http()` already reaches it, and what to remember is the product's job.
3. **Can an author reading the route see the guardrail and change it?** If the answer is no because the guardrail moved into adapter options, the shape is wrong even when questions 1 and 2 passed. See [package-boundaries section 6.1](./package-boundaries.md#61-build-the-harness-out-of-the-framework-not-into-it).

A no to question 1, or a no to both halves of question 2, ends it. Question 3 governs how a yes gets built.

The questions and the three kinds agree, and are two views of the same rule. When they seem to disagree, the kind is usually being misread: a capability that feels like an operation but names a vendor is a product.

## 6. Where a capability lands

Four homes, in order of preference:

1. **Somebody else's service**, reached with `mcp()` or `http()`. Nothing ships, and nothing is maintained.
2. **The author's own app**, as composed routes. The guardrails are visible and the author owns them. The `craft-harness` template is one such app: a local personal agent, which is its whole job, and not the place a remote or fleet-shaped capability grows.
3. **A route library shared across apps**, published as an ordinary package and included by configuration. Anything a second app or a second customer would otherwise rewrite belongs here rather than in the framework.
4. **A `@routecraft/*` package**, only when all three questions pass and the addition clears the bar in section 3.

Preferring the first is not modesty. A framework that reaches more systems is worth more than one that owns more code.

A design that cannot be split across these four, piece by piece, is not finished.

## 7. Who counts as demand

The bar in section 3 asks how much effort an addition removes, and effort is removed from somebody. That somebody is a named consumer with a concrete need: an app being built on the framework today, or a workshop that has to run next week. It is never a headcount. A young framework has few users, and a headcount test would reject every addition ever made, the Docker sandbox included on the day it was proposed.

So a proposal names its consumer. "Nobody is asking for this" is a valid reason to decline. "Only one app is asking for this" is not, when that app is real and the effort is real.

## 8. Raise it during development, not at review

This is a live check rather than a document to cite afterwards. A contributor or agent building something that fails question 1 or 2 should say so **before writing the code**, name which question fails, and propose the composed-route or third-party shape instead. A feature that arrives at review already built is one that costs a rewrite to place correctly, and the rewrite usually does not happen.

The check is a challenge, not a veto. Whoever holds this standard says "this crosses the line" out loud, every time, and is answered. The consumer may overrule with a stated reason; the overrule stands, the reason is recorded with the change, and what the standard's holder watches is the pattern of overrules rather than the single case. A crossing let through silently is the failure. The crossing itself is not.

Two cases are already on the record, and both began as proposed framework features:

- **WebFetch and WebSearch.** Proposed as built-in agent tools, then as a web content adapter carrying an egress guard. Both framings were rejected. What shipped is two ordinary `http()` client options (#579) with the routes in the `craft-harness` template (#588).
- **The agent tool names themselves.** `WebFetch`, `WebSearch` and `Bash` are Claude Code's names. The agent loader tolerates them so a borrowed `.claude/agents/` tree still boots; the framework provides none of them.

## Related

- [Package Boundaries](./package-boundaries.md) -- which package a thing belongs in, once this standard says it belongs at all
- [Adapter Architecture](./adapter-architecture.md) -- how an adapter that passes these questions is built
