---
title: 'Routecraft vs n8n: when to automate in code instead of a canvas'
description: n8n made automation visual and self-hostable, and for a lot of teams it is the right call. This comparison is for the moment the canvas starts fighting you, when workflows need version control, tests, refactoring, and type safety, and you start wondering if the automation should just be code.
date: 2026-06-10
author: Jaco Botha
authorRole: Founder, DevOptix
version: '0.6.0+'
draft: true
tags:
  - n8n
  - automation
  - comparison
  - typescript
layout: blog-post
---

n8n deserves its popularity. It made workflow automation visual, self-hostable, and accessible to people who do not write code for a living, with hundreds of prebuilt integrations and a canvas where you can watch data flow through your logic. If your team automates by dragging nodes and your workflows stay reviewable on one screen, you can stop reading: n8n is good at what you are doing.

This post is for the other moment. The one where you are zooming out on a canvas of forty nodes, trying to work out which of three nearly-identical IF branches changed last week, with no diff to read and no test to run. Every team that pushes a visual tool hard enough meets this moment. The question is what you do then.

Routecraft's answer: the automation was a program all along, so write it as one.

I build Routecraft, so weigh my bias accordingly. The trade-offs below are real on both sides.

## The same automation, both ways

Take a small real workflow: receive an invoice over a webhook, validate it, drop the noise, and notify finance.

In n8n that is a Webhook node, an IF node (or a Code node once the condition gets real), and an email node, wired on the canvas, configured in side panels, stored as JSON the editor owns.

In Routecraft it is this file:

```ts
import { craft, http, mail } from '@routecraft/routecraft'
import { z } from 'zod'

const Invoice = z.object({
  vendor: z.string().min(1),
  amountCents: z.number().int().positive(),
  currency: z.string().length(3),
  pdfUrl: z.string().url(),
})
type Invoice = z.infer<typeof Invoice>

export default craft()
  .id('invoice-intake')
  .description('Receive invoices over a webhook and notify finance about the ones that matter.')
  .input({ body: Invoice })
  .from<Invoice>(http({ path: '/invoices', method: 'POST' }))
  .filter((ex) => ex.body.amountCents >= 5_000)
  .transform((invoice) => ({
    to: 'finance@company.com',
    subject: `Invoice from ${invoice.vendor}: ${(invoice.amountCents / 100).toFixed(2)} ${invoice.currency}`,
    text: `Review and approve: ${invoice.pdfUrl}`,
  }))
  .to(mail())
```

Both versions work. The differences are in everything around them.

## What code buys you

**A diff.** This file lives in git. The change that lowered the threshold from 10000 to 5000 cents is a one-line diff with an author, a timestamp, a commit message, and a code review. In n8n, workflow history exists (on paid tiers and recent versions), but a JSON blob of node coordinates is not something a reviewer reads; in practice the change process is "trust whoever edited the canvas".

**A test.** Routecraft capabilities are tested like the functions they are. `@routecraft/testing` gives you a test context, fixtures, and spy adapters, so "invoices under fifty euros are dropped" is an assertion in CI, not a thing you check by clicking Execute Workflow and squinting at node output. When the logic changes, the test fails before production finds out.

**A type system.** The pipeline above is typed end to end: `ex.body.amountCents` autocompletes, and renaming `pdfUrl` breaks the build instead of breaking quietly at 2 a.m. On a canvas, the contract between two nodes is whatever JSON happened to flow last time you tested; the editor cannot tell you which downstream nodes a field rename breaks.

**Refactoring.** When three workflows share logic in n8n, you copy nodes between canvases or extract a subworkflow and manage its interface by convention. In Routecraft, shared logic is a function, or a capability invoked by other capabilities through `direct()` with its input and output types exported. The boring, load-bearing tools of software (extract function, rename symbol, find usages) all work, because it is just TypeScript.

**An ordinary deployment.** A Routecraft project is a process: `craft run`, a Dockerfile on Bun or Node 22+, the same CI/CD pipeline as the rest of your code, env vars for config. There is no workflow database to back up, no editor server to upgrade, no separate promotion process to move a workflow from staging to prod. Promotion is a git merge.

## What the canvas buys you (and what you give up)

Fairness requires the other column, because it is substantial:

- **Integration breadth.** n8n ships hundreds of prebuilt nodes. Routecraft's adapter set today is small and honest: HTTP, cron and timers, files, CSV, JSON, IMAP/SMTP mail, CardDAV, MCP, LLM and agent destinations, browser automation. Anything else is you writing a `fetch` call in a `.transform()`, which is easy but is not a node catalogue. If your automation is mostly "connect SaaS A to SaaS B", n8n's catalogue will beat a code framework on day one, every time.
- **Human-in-the-loop approvals are built in.** The Wait node parks an execution until someone answers, and the messaging nodes ship send-and-wait approval operations with buttons included. Routecraft composes the same pattern from two capabilities and your own store, which is more work up front and buys you any approval channel you like (email, Slack, Telegram, your own dashboard). Edge to n8n on convenience today; the [pattern deep dive](/blog/human-in-the-loop) shows both sides with code.
- **Non-developers can build.** An ops person can ship an n8n workflow without learning TypeScript. Routecraft's entire premise assumes a developer is in the loop.
- **Visual runtime inspection.** Watching an execution light up node by node is a genuinely good debugging experience. Routecraft gives you structured logs, lifecycle events, and optional OpenTelemetry tracing, which is more powerful and less immediate.
- **A hosted option.** n8n Cloud exists; Routecraft is self-hosted only.

There is also a licensing difference worth knowing about: n8n is fair-code under the Sustainable Use License, which restricts some commercial uses. Routecraft is Apache-2.0.

## The AI agent angle

Both tools are converging on AI, from opposite directions.

n8n added AI agent nodes: you place an agent on the canvas, wire tools into it, and the workflow hosts the loop. It works, and it inherits the canvas trade-offs above, with the added twist that the most security-sensitive component in the system (what the agent is allowed to do) is configured across node panels.

Routecraft treats agents as a first-class shape on both sides of a capability. `.from(mcp())` exposes any capability as a typed MCP tool that Claude, Cursor, or any MCP client can call, with schema validation, `.authorize()` role checks, and `.filter()` predicates enforced in code on every call. `.to(agent({ model, system, tools }))` makes the capability the agent, with an explicitly bounded tool selection. The guardrails are part of the pipeline, in the diff, under test, like everything else. That matters more with agents than with any previous kind of automation, because the thing calling your workflow is now a probabilistic system that does what its context window tells it; the argument for enforcing boundaries in code is [its own post](/blog/stop-trusting-your-llm-to-behave).

## The same patterns, side by side

Feature lists only get you so far; what decides the choice is how each tool handles the patterns you will actually build. Each deep dive below builds the pattern in both tools, with working code, and calls the winner honestly. More patterns and more framework pairings are coming; this table grows.

| Pattern | In n8n | In Routecraft | Deep dive |
| --- | --- | --- | --- |
| Human in the loop | Built in: Wait node, send-and-wait approvals | Composed: two capabilities plus your own store | [Human in the loop: n8n vs Routecraft](/blog/human-in-the-loop) |
| LLM as a judge | AI nodes wired on the canvas | One `.enrich(llm())` stage plus a `.filter()` gate | [LLM as a judge in TypeScript](/blog/llm-as-a-judge) |
| Agent tool guardrails | Node options plus Code nodes, by convention | Enforced pre-pipeline chain | [Guardrails for MCP tools](/blog/agent-tool-guardrails) |
| Webhook to notification | Webhook, IF, and email nodes | The invoice capability earlier in this post | this post |
| Scheduled jobs | Schedule trigger node | `.from(cron('0 9 * * *'))` | [docs](/docs/introduction) |
| Fan-out over a list | Loop and split nodes | `.split()` and `.aggregate()` | [docs](/docs/introduction) |

## The actual decision

| Feature | n8n | Routecraft |
| --- | --- | --- |
| Open source | ✓ Fair-code (Sustainable Use License) | ✓ Apache-2.0 |
| Self-hostable | ✓ | ✓ |
| Hosted cloud offering | ✓ n8n Cloud | ✗ |
| Visual editor | ✓ | ✗ |
| Code-first authoring | ✗ Code node as escape hatch | ✓ TypeScript DSL |
| Usable by non-developers | ✓ | ✗ |
| Hundreds of prebuilt connectors | ✓ | ✗ small adapter set |
| Native git workflow (diffs, PRs, blame) | ✗ source control on paid tiers | ✓ plain files |
| Unit tests in CI | ✗ manual executions | ✓ `@routecraft/testing` |
| End-to-end type safety | ✗ | ✓ |
| Human-in-the-loop approvals | ✓ built in | ✗ composed by hand |
| AI agent hosting | ✓ agent nodes | ✓ `.to(agent())` |
| Expose tools to agents over MCP | ✓ MCP nodes | ✓ `.from(mcp())` |
| Runs as an ordinary process | ✗ platform plus database | ✓ Bun or Node 22+, Docker |

Pick **n8n** when integration breadth and non-developer authorship are the point: the automations are glue between SaaS products, the people building them live in the browser, and the canvas is an asset rather than a liability.

Pick **Routecraft** when the automations are software: when they need code review, tests, refactoring, type safety, and a deployment story your platform team already understands, and especially when AI agents are involved and the guardrails have to be enforceable rather than configurable.

A heuristic that has served me well: if your first instinct inside the visual tool is to reach for the Code node, the tool is telling you something.

## Try it

The whole getting-started path is one command and ten minutes:

```bash
bunx create-routecraft my-automation
```

[Your first MCP server in TypeScript](/blog/your-first-mcp-server-in-typescript) is the narrative walkthrough, or open the [Routecraft playground in GitHub Codespaces](https://codespaces.new/routecraftjs/craft-playground) and try it without installing anything. Full docs at [routecraft.dev/docs](/docs/introduction).
