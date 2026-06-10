---
title: 'Human in the loop: n8n vs Routecraft'
description: The approval pattern is where automation meets accountability, pause the flow, ask a person, continue on their answer. n8n has it built in. Routecraft makes you build it. An honest comparison of both, with working code for the Routecraft side.
date: 2026-06-10
author: Jaco Botha
authorRole: Founder, DevOptix
version: '0.6.0+'
draft: true
tags:
  - human-in-the-loop
  - n8n
  - patterns
  - automation
layout: blog-post
---

Human in the loop is the pattern that turns "the automation did something" into "the automation did something a person signed off on". The flow runs until it reaches a decision that matters (a payout, a contract send, a production deploy, an AI-generated reply to a customer), pauses, asks a human, and continues or stops based on the answer.

It is also the pattern that separates automation tools fastest, because pausing is architecturally hard. Something has to remember the half-finished work, possibly for days, survive restarts, and pick the flow back up when the answer arrives.

Up front, because this series is honest about who wins what: **n8n has this built in and it is genuinely good. Routecraft does not have a pause-and-resume primitive today**; you compose the pattern from two capabilities and your own state. This post shows both, and when the manual version is actually the better trade.

This is part of a pattern series comparing common automation shapes across tools; the general comparison lives in [Routecraft vs n8n](/blog/routecraft-vs-n8n).

## The pattern, tool-agnostic

Every human-in-the-loop implementation answers four questions:

1. **Where does the flow stop?** The point past which no side effect happens without approval.
2. **How is the human asked?** Email, Slack, a form, a ticket.
3. **Where does the pending state live?** Whatever holds the half-finished work while the human thinks.
4. **How does the answer resume the flow?** A webhook, a button, a reply.

Keep those four in mind; the two tools answer them very differently.

## How n8n does it

n8n treats waiting as a first-class node. Two mechanisms matter:

- **The Wait node** parks an execution until a fixed time, until a resume webhook is called, or until a form is submitted. The execution state is persisted by n8n itself; a workflow can sleep for a week and resume.
- **Send-and-wait operations** on the messaging nodes (Gmail, Slack, Teams and friends) combine the ask and the wait: send a message with approval buttons or a small form, then block the branch until someone clicks. The approval UI comes for free.

A payout approval in n8n is therefore: Webhook trigger, then a Slack node in "send and wait for approval" mode, then an IF node on the approval result, then the payout call. Four nodes, no state management, no custom endpoints, and the pending execution is visible in the executions list where an operator can inspect it.

That is the strongest version of the canvas argument: the platform owns the hard part (durable paused state), and you configure it.

The trade-offs are the standard n8n ones: the pending state lives inside n8n's database rather than your domain model, the approval flow is as customisable as the node options allow, and the logic around it is canvas-owned (see [the general comparison](/blog/routecraft-vs-n8n) for that discussion).

## How Routecraft does it

Routecraft has no Wait. A capability is a one-way pipeline: source in, destination out, no suspended middle. So the pattern becomes **two capabilities and a store**, which is exactly how you would build it in any web framework:

1. The **request capability** receives the work, saves it as pending, and asks the human.
2. The **decision capability** is an authenticated endpoint the human's answer hits, which loads the pending work and finishes or discards it.

Here it is for the payout example. The store first; an in-memory map for the demo, your database in real life:

```ts
// capabilities/payouts/_lib/pending.ts
export interface Payout {
  beneficiary: string
  amountCents: number
  reason: string
}

const pending = new Map<string, Payout>()

export const store = {
  add(payout: Payout): string {
    const id = crypto.randomUUID()
    pending.set(id, payout)
    return id
  },
  take(id: string): Payout | undefined {
    const payout = pending.get(id)
    pending.delete(id)
    return payout
  },
}
```

The request capability: validate, park, notify.

```ts
// capabilities/payouts/request/route.ts
import { craft, http, mail } from '@routecraft/routecraft'
import { z } from 'zod'

import { store } from '../_lib/pending'

const PayoutRequest = z.object({
  beneficiary: z.string().min(1),
  amountCents: z.number().int().positive(),
  reason: z.string().min(1).max(500),
})
type PayoutRequest = z.infer<typeof PayoutRequest>

export default craft()
  .id('payout-request')
  .description('Receive a payout request, park it, and ask an approver.')
  .input({ body: PayoutRequest })
  .from<PayoutRequest>(http({ path: '/payouts', method: 'POST' }))
  .transform((payout) => {
    const id = store.add(payout)
    return {
      to: 'approver@company.com',
      subject: `Approve payout: ${(payout.amountCents / 100).toFixed(2)} EUR to ${payout.beneficiary}`,
      text: [
        payout.reason,
        '',
        `Approve or reject: https://ops.example.com/approvals/${id}`,
      ].join('\n'),
    }
  })
  .to(mail())
```

And the decision capability, which your approval page (or a Slack action, or a signed email link) posts to:

```ts
// capabilities/payouts/decide/route.ts
import { craft, http, log } from '@routecraft/routecraft'
import { z } from 'zod'

import { store } from '../_lib/pending'
import { executePayout } from '../_lib/execute'

const Decision = z.object({
  id: z.string().uuid(),
  approved: z.boolean(),
})
type Decision = z.infer<typeof Decision>

export default craft()
  .id('payout-decide')
  .description('Apply an approver decision to a pending payout.')
  .input({ body: Decision })
  .from<Decision>(http({ path: '/approvals', method: 'POST' }))
  .transform(async (decision) => {
    const payout = store.take(decision.id)
    if (!payout) return { status: 'unknown-or-expired', id: decision.id }
    if (!decision.approved) return { status: 'rejected', id: decision.id }
    await executePayout(payout)
    return { status: 'executed', id: decision.id }
  })
  .to(log())
```

Two things the snippet does not show, deliberately, because they are your decisions rather than the framework's:

- **The decision endpoint must be authenticated.** Anyone who can POST to `/approvals` is an approver. In production that endpoint sits behind your auth (see [securing capabilities](/docs/advanced/securing-capabilities)); the approval link should be a signed, single-use token rather than a bare UUID.
- **The pending store must survive restarts.** The in-memory map is demo-ware; n8n gives you durable pending state for free, and in Routecraft that durability is explicitly your database's job.

One more honest note for the agent crowd: the MCP spec has an elicitation mechanism for a tool asking the calling user a question mid-flight. Routecraft does not support elicitation yet, so for MCP tools the two-capability shape above is also the answer there.

## The verdict

| | n8n | Routecraft |
| --- | --- | --- |
| Pause and resume | Built in (Wait node) | Not available, compose two capabilities |
| Approval UI | Built in (send-and-wait on Slack, Gmail, Teams) | You send the message, you host the decision endpoint |
| Pending state | Persisted by the platform | Your store, your schema |
| Survives restarts | Yes, out of the box | Yes, if your store does |
| Auditability | Executions list | Your domain model, your audit table |
| Approval logic in version control | No | Yes, both capabilities are code under test |
| Effort to first working approval | Minutes | An hour or two |

If human-in-the-loop approvals are the core of your automation and you want them today with minimal engineering, **n8n is the better tool for this pattern**. No hedging.

Choose the Routecraft shape when the surrounding system is already code and you want the approval to be a first-class part of it: pending approvals as rows in your own database (queryable, reportable, migratable), decision endpoints with your real authentication and roles, and the entire flow unit-tested in CI like everything else. The hour it costs buys you ownership of the four questions at the top of this post instead of renting the answers.

## Try it

```bash
bunx create-routecraft approvals
```

The [Routecraft vs n8n](/blog/routecraft-vs-n8n) hub covers the general trade-offs, and the [securing capabilities guide](/docs/advanced/securing-capabilities) covers locking down the decision endpoint. Full docs at [routecraft.dev/docs](/docs/introduction).
