---
title: 'Guardrails for MCP tools: FastMCP vs Routecraft'
description: Schema, predicate, identity, declared intent. The four guardrail layers every agent-facing tool needs, built in FastMCP and in Routecraft, with an honest look at what each framework enforces and what it leaves to discipline.
date: 2026-06-08
author: Jaco Botha
authorRole: Founder, DevOptix
version: '0.5.0+'
draft: false
tags:
  - guardrails
  - mcp
  - fastmcp
  - patterns
  - ai-agents
related:
  - stop-trusting-your-llm-to-behave
  - routecraft-vs-fastmcp
  - llm-as-a-judge
  - human-in-the-loop
layout: blog-post
---

Your `send_email` MCP tool is one crafted calendar invite away from mailing your customer list to a stranger. Not because the model is malicious, but because the model calling your tool is a probabilistic system whose context window may contain text written by an attacker, and the model does what its context says. The moment an MCP tool does something real (sends, writes, deletes, pays), the interesting question stops being "how do I define a tool" and becomes "what stops the agent from misusing it". The argument for why prompts cannot be the answer is [its own post](/blog/stop-trusting-your-llm-to-behave); this one is practical: the guardrail pattern, implemented twice.

We compare the two TypeScript frameworks you are most likely choosing between for MCP servers: FastMCP and Routecraft. The general comparison is its own post; this is the deep dive on one pattern.

Disclosure up front: I build Routecraft, so calibrate accordingly. The FastMCP claims below are checked against its current documentation as of writing, and where FastMCP covers a layer natively, this post says so.

This post is part of a pattern series; more pattern deep dives are coming.

## The pattern, tool-agnostic

A guarded tool stacks four layers, each deterministic, each running on every call:

1. **Schema.** The input is parsed against a contract before any logic runs. Malformed or oversized input never reaches you.
2. **Predicate.** Business rules as code: this recipient domain, this amount ceiling, this folder and no other. The layer that turns "please only email colleagues" into a fact.
3. **Identity.** Who is the agent acting for, and is that principal allowed this tool? Authentication plus per-tool authorisation.
4. **Declared intent.** The tool tells the client what it is (read-only, destructive, open-world) in metadata the client can act on, for example by requiring user confirmation for destructive calls.

The running example: a `send_company_email` tool that may only mail `@company.com` addresses, only for callers with the `mail:send` scope.

## In FastMCP

FastMCP covers layers 1, 3, and 4 natively; layer 2 is yours:

```ts
import { FastMCP } from 'fastmcp'
import { z } from 'zod'

import { sendMail } from './mailer'
// Your bearer-token check, e.g. jwtVerify from 'jose' against your IdP's JWKS.
import { verifyBearer } from './auth'

const server = new FastMCP({
  name: 'company-mail',
  version: '1.0.0',
  // Layer 3a: authenticate the session
  authenticate: async (request) => {
    const session = await verifyBearer(request.headers.authorization)
    if (!session) throw new Response(null, { status: 401 })
    return session // available as context.session in every tool
  },
})

server.addTool({
  name: 'send_company_email',
  description: 'Send an internal email to a colleague.',
  // Layer 4: declared intent
  annotations: {
    openWorldHint: true,
    destructiveHint: false,
  },
  // Layer 3b: per-tool authorisation, declared
  canAccess: (session) => session?.scopes.includes('mail:send') ?? false,
  // Layer 1: schema
  parameters: z.object({
    to: z.email(),
    subject: z.string().min(1).max(120),
    text: z.string().min(1).max(5_000),
  }),
  execute: async (args) => {
    // Layer 2: predicate, by hand
    if (!args.to.endsWith('@company.com')) {
      throw new Error('recipient outside company domain')
    }
    await sendMail(args)
    return 'sent'
  },
})
```

This works, and at one tool it is perfectly fine. FastMCP declares more of the pattern than it usually gets credit for: schema, annotations, session authentication, and the `canAccess` gate are all framework-level (declared, visible, checked before your code runs), and it ships OAuth providers for the authentication side. The predicate is the odd one out. The business rule that actually bounds the tool, the recipient check, is a **line inside `execute`**. The framework cannot tell a guarded tool from an unguarded one; nothing fails if the next tool's author forgets the domain check or puts it after the send. With thirty tools and five contributors, that layer is a code-review convention.

That is not a flaw in FastMCP so much as a scope decision: it is an MCP server framework, and what happens inside `execute` is your business.

## In Routecraft

Routecraft's position is that all four layers are the framework's business. A capability declares them as pipeline stages, outside the business logic, in a fixed order the runtime enforces:

```ts
import { mcp } from '@routecraft/ai'
import { craft, mail } from '@routecraft/routecraft'
import { z } from 'zod'

const SendEmailInput = z.object({
  to: z.email(),
  subject: z.string().min(1).max(120),
  text: z.string().min(1).max(5_000),
})
type SendEmailInput = z.infer<typeof SendEmailInput>

export default craft()
  .id('send_company_email')
  .description('Send an internal email to a colleague.')
  .tag('open-world')
  .authorize({ scopes: ['mail:send'] })
  .input({ body: SendEmailInput })
  .from<SendEmailInput>(mcp())
  .filter((ex) => {
    if (!ex.body.to.endsWith('@company.com')) {
      return { reason: 'recipient outside company domain' }
    }
    return true
  })
  .to(mail())
```

Line by line against the pattern: `.input({ body: SendEmailInput })` is the schema layer, `.filter()` is the predicate, `.authorize({ scopes: ['mail:send'] })` is identity, and `.tag('open-world')` is declared intent. The business logic is the last line.

What the structure buys, concretely:

- **The chain is the review.** `.authorize()` and `.input()` run at route entry, in a fixed pre-pipeline order the framework owns, and the predicate is a visible stage between the source and `.to(mail())`. A reviewer reads "nothing reaches the mailer without passing the domain check" off the chain shape; there is no function body to trace to be sure the check runs before the send.
- **Failures are uniform.** A failed authorisation is `RC5015`, a schema rejection is `RC5002`, a filtered call records its drop reason and emits `exchange:dropped`. Thirty tools fail the same way, which is what makes monitoring them one dashboard instead of thirty string-matched errors.
- **Identity is resolved before your code.** The HTTP transport verifies bearer tokens (JWT, JWKS, or a full OAuth 2.1 proxy) and hydrates a `principal` with roles and scopes; capabilities consume it. The [securing capabilities guide](/docs/advanced/securing-capabilities) shows real setups.
- **Intent stays in sync.** `.tag('open-world')` derives the MCP `openWorldHint` annotation; declare once, and the local tag and the client-visible metadata cannot drift apart.
- **The guardrails are testable as guardrails.** With `@routecraft/testing` you feed the route a fixture with an external recipient and assert the drop, in CI, forever.
- **Operational behaviour is declared in the same place.** `.cache({ ttl })` wraps the same chain, so an agent re-asking an identical question is served from cache without a second backend hit, and the resilience family (`.retry()`, `.timeout()`, `.throttle()`, `.circuitBreaker()`) declares in the same spot, rather than as conventions inside each handler.

The honest other side: this is more machinery. You learn a pipeline DSL to get it, the framework is v0 with a moving API, and if your server has three read-only tools, framework-enforced guardrails are solving a problem you do not have yet. FastMCP also covers MCP surface Routecraft lacks entirely (resources and prompts); if you need those, this pattern alone should not decide the framework.

## The verdict

| Guardrail layer | FastMCP | Routecraft |
| --- | --- | --- |
| Schema validation | Built in (`parameters`) | Built in (`.input()`) |
| Predicate gates | Hand-written inside `execute` | `.filter()` stage, halts with reason |
| Session authentication | Built in (`authenticate` hook, OAuth providers) | Built in (JWT, JWKS, OAuth proxy) |
| Per-tool authorisation | Built in (`canAccess` per tool) | Built in (`.authorize({ roles, scopes })` at route entry) |
| Declared intent (annotations) | Built in, set per tool | Built in, derived from `.tag()` |
| Predicate ordering enforced | No, position inside `execute` is yours | Yes, a declared stage before the destination |
| Uniform failure semantics | Framework layers yes, predicates per-author | Framework error codes and events throughout |
| Cost | Minimal, discipline required | A DSL and a runtime |

Both frameworks can ship this pattern safely, and the gap is narrower than the usual framing suggests: FastMCP declares three of the four layers. The difference concentrates on the predicate, the layer doing the real business enforcement, and on what surrounds every layer: whether failures are uniform, whether intent metadata can drift from the code, whether the guardrails are testable as guardrails. For a handful of tools owned by one careful person, discipline is cheap and FastMCP's simplicity wins. The more tools, contributors, and destructive operations a server accumulates, the more the structural version pays, because it makes the safe shape the only shape that runs.

## Try it

```bash
bunx create-routecraft guarded-tools
```

The [securing capabilities guide](/docs/advanced/securing-capabilities) covers the identity layer end to end. Full docs at [routecraft.dev/docs](/docs/introduction).
