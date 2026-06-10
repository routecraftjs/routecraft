---
title: 'Routecraft vs FastMCP: which TypeScript MCP framework should you pick?'
description: FastMCP is the default recommendation for building MCP servers in TypeScript, and it earns that spot. This is an honest comparison from the Routecraft side, where the question is not "how do I build an MCP server" but "how do I build automations that an MCP server happens to expose".
date: 2026-06-10
author: Jaco Botha
authorRole: Founder, DevOptix
version: '0.6.0+'
draft: true
tags:
  - mcp
  - fastmcp
  - comparison
  - typescript
layout: blog-post
---

If you search for "TypeScript MCP framework", FastMCP is the answer you will find, and it is a good answer. It wraps the official MCP SDK in an ergonomic API, handles sessions and transports, and gets you from zero to a working tool in a few minutes.

Routecraft also lets you ship an MCP server in a few minutes, so the two get compared a lot. But they are not really the same kind of thing, and picking between them comes down to one question: **is the MCP server the product, or is it one doorway into the product?**

I build Routecraft, so calibrate accordingly. I will keep the FastMCP claims to what its own docs say it does, and I will tell you when FastMCP is the right pick, because it sometimes is.

## The same tool, twice

Here is a minimal "create a note" tool in FastMCP:

```ts
import { FastMCP } from 'fastmcp'
import { z } from 'zod'

import { store } from './store'

const server = new FastMCP({
  name: 'notebook',
  version: '1.0.0',
})

server.addTool({
  name: 'notes_create',
  description: 'Create a new note with a title and body.',
  parameters: z.object({
    title: z.string().min(1).max(120),
    body: z.string().min(1).max(10_000),
  }),
  execute: async (args) => {
    return JSON.stringify(store.create(args.title, args.body))
  },
})

server.start({ transportType: 'stdio' })
```

And the same tool in Routecraft:

```ts
import { mcp } from '@routecraft/ai'
import { craft } from '@routecraft/routecraft'
import { z } from 'zod'

import { store } from './store'

const CreateNoteInput = z.object({
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(10_000),
})
type CreateNoteInput = z.infer<typeof CreateNoteInput>

export default craft()
  .id('notes_create')
  .description('Create a new note with a title and body.')
  .input({ body: CreateNoteInput })
  .from<CreateNoteInput>(mcp())
  .transform((input) => store.create(input.title, input.body))
```

At this size they are equivalent. Typed input, validated before your code runs, exposed as a tool. If your project never grows past this, you genuinely do not need anything Routecraft adds, and FastMCP's flatter API is arguably nicer for it.

The differences start when the tool stops being a demo.

## Difference 1: the unit of code

In FastMCP, the unit of code is **a tool on a server**. Your logic lives inside `execute`, and `execute` belongs to MCP.

In Routecraft, the unit of code is **a capability**: a pipeline of `source -> operations -> destination` that does not know what triggered it. `mcp()` is one possible source. The exact same capability runs on a schedule by swapping one line:

```ts
// MCP tool: an agent calls it on demand
.from<CreateNoteInput>(mcp())

// Cron job: runs every morning at 9, same pipeline
.from(cron('0 9 * * *'))

// HTTP webhook: your SaaS calls it
.from(http({ path: '/notes', method: 'POST' }))
```

This sounds like a parlour trick until you live the lifecycle. Real automations rarely stay one-shape: the "summarise yesterday's tickets" tool you built for Claude becomes a scheduled report, the webhook handler grows an MCP face so agents can trigger it too. With a capability model that is a one-line change. With a server-and-tools model it is a second codebase, or `execute` functions exported and rewired into a cron runner you now maintain yourself.

## Difference 2: what stands between the agent and your logic

FastMCP gives you an `authenticate` hook and session object, and from there enforcement is yours to write inside each tool.

Routecraft treats the space between the transport and your logic as the interesting part. Every capability passes through a fixed, ordered chain of gates before your code runs:

```ts
export default craft()
  .id('notes_delete')
  .description('Delete a note by id. Destructive.')
  .tag('destructive')
  .authorize({ roles: ['admin'] })
  .input({ body: DeleteNoteInput })
  .from<DeleteNoteInput>(mcp())
  .filter((ex) => ex.body.id.startsWith('note_'))
  .transform((input, exchange) => store.delete(exchange.principal!.subject, input.id))
```

`.authorize()` checks the authenticated principal's roles at route entry. `.input()` rejects malformed payloads with structured errors. `.filter()` is a deterministic predicate that halts the pipeline when it returns false. `.tag('destructive')` becomes the MCP `destructiveHint` annotation automatically, so the client knows to confirm. For HTTP transports, JWT and JWKS verification, an OAuth 2.1 proxy mode, RFC 9728 protected-resource metadata, and principal enrichment are configuration on the plugin rather than code in your tools. The [Clerk walkthrough](/blog/securing-mcp-with-clerk) shows the full flow against a real identity provider.

You can build all of this on FastMCP. You will be building it, though, per project, and auth middleware you write in an afternoon is rarely auth middleware that handles audience validation, key rotation, and token expiry mid-request.

## Difference 3: both directions

Routecraft capabilities also *call* MCP servers: `.to(mcp('github:create_issue'))` invokes a tool on a registered remote server, with the same typed pipeline in front of it. And `.to(agent({ model, system, tools }))` makes the capability itself the agent, with a bounded tool selection. Tools for an agent, or the whole agent, same DSL.

FastMCP is deliberately one-directional: it builds servers. Consuming MCP or hosting an agent loop is out of scope.

## Difference 4: testing and operating

`@routecraft/testing` ships a test context, spy adapters, fixtures, and a spy logger, so a capability is tested by running its pipeline against fixture data with no MCP client in sight. Structured logging (pino), a typed event system (`exchange:started`, `step:failed`, `cache:hit`), and optional OpenTelemetry tracing come with the runtime.

FastMCP's answer to testing is essentially "they are functions, test them as functions", which is true and fine at small scale, and leaves observability to whatever you bolt on.

## Where FastMCP is ahead, honestly

- **Full MCP surface.** FastMCP supports resources and prompts. Routecraft exposes tools only today; if your server's value is resources or prompt templates, FastMCP is the right tool, full stop.
- **Streaming content helpers.** Images, audio, progress reporting and similar MCP content niceties are first-class in FastMCP.
- **Smaller conceptual footprint.** One class, one method per tool. Routecraft asks you to learn a pipeline DSL, and that is only worth it if you use what the pipeline buys you.
- **Maturity of scope.** FastMCP does one thing and the API has settled around it. Routecraft is v0 and the whole public API is still allowed to change between releases ([stability policy](/docs/introduction)).

## The actual decision

| | FastMCP | Routecraft |
|---|---|---|
| Core abstraction | A server with tools | Capabilities with pluggable sources |
| MCP tools | Yes | Yes (`.from(mcp())`) |
| MCP resources and prompts | Yes | Not yet |
| Same logic as cron, webhook, CLI | Manual | One-line source swap |
| Calling other MCP servers | No | `.to(mcp('server:tool'))` |
| Agent loop hosting | No | `.to(agent({ ... }))` |
| Auth | `authenticate` hook | JWT, JWKS, OAuth proxy, RFC 9728, `.authorize()` |
| Validation | Zod parameters | Standard Schema gates plus `.filter()` predicates |
| Testing utilities | Bring your own | `@routecraft/testing` |
| Observability | Bring your own | Structured logs, events, OpenTelemetry hook |
| Runtime | Node | Bun and Node 22+ |
| License | MIT | Apache-2.0 |

Pick **FastMCP** when the MCP server is the deliverable: you want tools, resources, and prompts in front of an agent, with the smallest possible API between you and the spec.

Pick **Routecraft** when the deliverable is the automation and MCP is one of its doors: when the same logic needs to run on a schedule and on demand, when auth and guardrails are requirements rather than nice-to-haves, and when you want the agent to be a destination as well as a caller.

## Try the Routecraft side in ten minutes

The fastest way to form your own opinion is to build the same server twice. [Your first MCP server in TypeScript](/blog/your-first-mcp-server-in-typescript) is the Routecraft half, start to finish, in about ten minutes:

```bash
bunx create-routecraft my-mcp-server
```

Or skip the install entirely with the [Routecraft playground in GitHub Codespaces](https://codespaces.new/routecraftjs/craft-playground). Full docs at [routecraft.dev/docs](/docs/introduction).
