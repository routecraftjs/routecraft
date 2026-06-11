---
title: 'Guardrails for MCP tools: FastMCP vs Routecraft'
description: Schema, predicate, identity, declared intent. The four guardrail layers every agent-facing tool needs, built in FastMCP and in Routecraft, with an honest look at what each framework enforces and what it leaves to discipline.
date: 2026-06-10
author: Jaco Botha
authorRole: Founder, DevOptix
version: '0.6.0+'
draft: false
tags:
  - guardrails
  - mcp
  - fastmcp
  - patterns
  - ai-agents
layout: blog-post
---

Your `send_email` MCP tool is one crafted calendar invite away from mailing your customer list to a stranger. Not because the model is malicious, but because the model calling your tool is a probabilistic system whose context window may contain text written by an attacker, and the model does what its context says. The moment an MCP tool does something real (sends, writes, deletes, pays), the interesting question stops being "how do I define a tool" and becomes "what stops the agent from misusing it". The argument for why prompts cannot be the answer is [its own post](/blog/stop-trusting-your-llm-to-behave); this one is practical: the guardrail pattern, implemented twice.

We compare the two TypeScript frameworks you are most likely choosing between for MCP servers: FastMCP and Routecraft. The general comparison lives in [Routecraft vs FastMCP](/blog/routecraft-vs-fastmcp); this is the deep dive on one pattern.

This post is part of a pattern series; more pattern deep dives are coming.

## The pattern, tool-agnostic

A guarded tool stacks four layers, each deterministic, each running on every call:

1. **Schema.** The input is parsed against a contract before any logic runs. Malformed or oversized input never reaches you.
2. **Predicate.** Business rules as code: this recipient domain, this amount ceiling, this folder and no other. The layer that turns "please only email colleagues" into a fact.
3. **Identity.** Who is the agent acting for, and is that principal allowed this tool? Authentication plus per-tool authorization.
4. **Declared intent.** The tool tells the client what it is (read-only, destructive, open-world) in metadata the client can act on, for example by requiring user confirmation for destructive calls.

The running example: a `send_company_email` tool that may only mail `@company.com` addresses, only for callers with the `mail:send` scope.

## In FastMCP

FastMCP covers layer 1 natively and gives you hooks for the rest:

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
  // Layer 1: schema
  parameters: z.object({
    to: z.string().email(),
    subject: z.string().min(1).max(120),
    text: z.string().min(1).max(5_000),
  }),
  execute: async (args, context) => {
    // Layer 3b: per-tool authorization, by hand
    if (!context.session?.scopes.includes('mail:send')) {
      throw new Error('missing scope: mail:send')
    }
    // Layer 2: predicate, by hand
    if (!args.to.endsWith('@company.com')) {
      throw new Error('recipient outside company domain')
    }
    await sendMail(args)
    return 'sent'
  },
})
```

This works, and at one tool it is perfectly fine. Note where each layer lives, though: schema and annotations are framework-level (declared, visible, uniform), while the predicate and the authorization check are **lines inside `execute`**. The framework cannot tell a guarded tool from an unguarded one; nothing fails if the next tool's author forgets the scope check or puts it after the side effect. With thirty tools and five contributors, the guardrails are a code-review convention.

That is not a flaw in FastMCP so much as a scope decision: it is an MCP server framework, and what happens inside `execute` is your business.

## In Routecraft

Routecraft's position is that the four layers are the framework's business. A capability declares them as pipeline stages, outside the business logic, in a fixed order the runtime enforces:

```ts
import { mcp } from '@routecraft/ai'
import { craft, mail } from '@routecraft/routecraft'
import { z } from 'zod'

const SendEmailInput = z.object({
  to: z.string().email(),
  subject: z.string().min(1).max(120),
  text: z.string().min(1).max(5_000),
})
type SendEmailInput = z.infer<typeof SendEmailInput>

export default craft()
  .id('send_company_email')
  .description('Send an internal email to a colleague.')
  .tag('open-world') // Layer 4: declared intent
  .authorize({ scopes: ['mail:send'] }) // Layer 3: identity
  .input({ body: SendEmailInput }) // Layer 1: schema
  .from<SendEmailInput>(mcp())
  .filter((ex) => {
    // Layer 2: predicate
    if (!ex.body.to.endsWith('@company.com')) {
      return { reason: 'recipient outside company domain' }
    }
    return true
  })
  .to(mail())
```

What the structure buys, concretely:

- **Order is enforced, not conventional.** `.authorize()` and `.input()` run at route entry, before any pipeline step, always. A contributor cannot accidentally put the scope check after the send, because the chain position is fixed by the framework, not by where a line sits inside a function.
- **Failures are uniform.** A failed authorization is `RC5015`, a schema rejection is a structured validation error, a filtered call records its drop reason and emits `exchange:dropped`. Thirty tools fail the same way, which is what makes monitoring them one dashboard instead of thirty string-matched errors.
- **Identity is resolved before your code.** The HTTP transport verifies bearer tokens (JWT, JWKS, or a full OAuth proxy) and hydrates a `principal` with roles and scopes; capabilities consume it. The [securing capabilities guide](/docs/advanced/securing-capabilities) shows real setups.
- **Intent stays in sync.** `.tag('open-world')` derives the MCP `openWorldHint` annotation; declare once, and the local tag and the client-visible metadata cannot drift apart.
- **The guardrails are testable as guardrails.** With `@routecraft/testing` you feed the route a fixture with an external recipient and assert the drop, in CI, forever.
- **Operational behaviour is declared in the same place.** `.cache({ ttl })` wraps the same chain, so an agent re-asking an identical question is served from cache without a second backend hit, and the wider resilience family (`.timeout()`, `.circuitBreaker()`, `.throttle()`) lands in the same declared spot through the 0.6 line, rather than as conventions inside each handler.

The honest other side: this is more machinery. You learn a pipeline DSL to get it, the framework is v0 with a moving API, and if your server has three read-only tools, framework-enforced guardrails are solving a problem you do not have yet. FastMCP also covers MCP surface Routecraft lacks entirely (resources and prompts); if you need those, this pattern alone should not decide the framework.

## The verdict

| Guardrail layer | FastMCP | Routecraft |
| --- | --- | --- |
| Schema validation | Built in (`parameters`) | Built in (`.input()`) |
| Predicate gates | Hand-written inside `execute` | `.filter()` stage, halts with reason |
| Session authentication | Built in (`authenticate` hook) | Built in (JWT, JWKS, OAuth proxy) |
| Per-tool authorization | Hand-written inside `execute` | `.authorize({ roles, scopes })` at route entry |
| Declared intent (annotations) | Built in, set per tool | Built in, derived from `.tag()` |
| Ordering enforced by framework | No | Yes, fixed pre-pipeline chain |
| Uniform failure semantics | Per-author | Framework error codes and events |
| Cost | Minimal, discipline required | A DSL and a runtime |

Both frameworks can ship this pattern safely. The difference is whether the guardrails are **enforced structure or maintained discipline**. For a handful of tools owned by one careful person, discipline is cheap and FastMCP's simplicity wins. The more tools, contributors, and destructive operations a server accumulates, the more the structural version pays, because it makes the safe shape the only shape that compiles and runs.

## Try it

```bash
bunx create-routecraft guarded-tools
```

The [securing capabilities guide](/docs/advanced/securing-capabilities) covers the identity layer end to end, and [Routecraft vs FastMCP](/blog/routecraft-vs-fastmcp) has the general comparison. Full docs at [routecraft.dev/docs](/docs/introduction).
