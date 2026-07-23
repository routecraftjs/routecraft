---
title: 'Human in the loop: n8n vs Routecraft'
description: The approval pattern is where automation meets accountability. Pause the flow, ask a person, continue on their answer. n8n ships it today as a Wait node with prebuilt approval buttons. Routecraft's answer, a suspend and resume pair in the pipeline with any channel carrying the reply, arrives with 0.7.
date: 2026-06-10
author: Jaco Botha
authorRole: Founder, DevOptix
version: '0.7.0+'
draft: true
tags:
  - human-in-the-loop
  - n8n
  - patterns
  - automation
related:
  - routecraft-vs-n8n
  - llm-as-a-judge
layout: blog-post
---

Human in the loop is the pattern that turns "the automation did something" into "the automation did something a person signed off on". The flow runs until it reaches a decision that matters (a payout, a contract send, a production deploy, an AI-generated reply to a customer), pauses, asks a human, and continues or stops based on the answer.

It is also the pattern that separates automation tools fastest, because pausing is architecturally hard. Something has to remember the half-finished work, possibly for days, survive restarts, and pick the flow back up when the answer arrives.

Only one of the two tools in this comparison ships its answer today. n8n has a Wait node with prebuilt approval messages for the popular chat tools, and it has been in production for years. Routecraft's answer is a `suspend` and `resume` pair in the pipeline DSL, with the ask and the answer free to travel over any channel you can wire, and it arrives with the 0.7 release. It is not in the current runtime. This post is written against 0.7: everywhere it describes the Routecraft side, read "what 0.7 ships", not "what you can install this afternoon". With that caveat in view, the interesting difference is not whether you can pause; it is who owns the approval experience and the pending state.

I build Routecraft, so weigh my bias accordingly. Being upfront about the roadmap is part of that.

This is part of a pattern series comparing common automation shapes across tools; the general comparison lives in the Routecraft vs n8n hub post.

## The pattern, tool-agnostic

Every human-in-the-loop implementation answers four questions:

1. **Where does the flow stop?** The point past which no side effect happens without approval.
2. **How is the human asked?** Email, Slack, a form, a ticket.
3. **Where does the pending state live?** Whatever holds the half-finished work while the human thinks.
4. **How does the answer resume the flow?** A webhook, a button, a reply.

Keep those four in mind; the two tools answer them differently.

## How n8n does it

n8n treats waiting as a first-class node. Two mechanisms matter:

- **The Wait node** parks an execution until a fixed time, until a resume webhook is called, or until a form is submitted. The execution state is persisted by n8n itself; a workflow can sleep for a week and resume.
- **Send-and-wait operations** on the messaging nodes (Gmail, Slack, Teams and friends) combine the ask and the wait: send a message with approval buttons or a small form, then block the branch until someone clicks. The approval UI comes for free.

A payout approval in n8n is therefore: Webhook trigger, then a Slack node in "send and wait for approval" mode, then an IF node on the approval result, then the payout call. Four nodes, no state management, and the pending execution is visible in the executions list where an operator can inspect it.

That is the strongest version of the canvas argument: the platform owns the approval UX end to end, and you configure it. The trade-offs are the standard n8n ones: the pending state lives inside n8n's database rather than your domain model, the approval flow is as customisable as the node options allow, and the logic around it is canvas-owned.

## How Routecraft does it, from 0.7

In Routecraft the pause is a pipeline operation. `.suspend()` checkpoints the exchange and stops scheduling it; `.resume()` revives it from any other route. Everything else in this section (the condition, the notification, the filter on rejection) is grammar that ships today; the suspend and resume pair is the part that does not. The current engine reserves a `suspend` outcome in its step contract and refuses it loudly (`RC5032`) precisely so 0.7 can land the feature without breaking that contract. What follows describes the 0.7 design.

Here is a payout capability, as it looks in 0.7, where amounts of 500 EUR and up need sign-off:

```ts
import { mcp } from '@routecraft/ai'
import { craft, direct, log, when } from '@routecraft/routecraft'
import { z } from 'zod'

const PayoutRequest = z.object({
  beneficiary: z.string().min(1),
  iban: z.string().min(15),
  amountCents: z.number().int().positive(),
  reason: z.string().min(1).max(500),
})
type PayoutRequest = z.infer<typeof PayoutRequest>

const Approval = z.object({
  approved: z.boolean(),
  note: z.string().optional(),
})

export default craft()
  .id('payout')
  .description('Execute a payout. Amounts of 500 EUR and up require approval.')
  .input({ body: PayoutRequest })
  .from<PayoutRequest>(mcp())
  .choice(
    when(
      (ex) => ex.body.amountCents >= 50_000,
      (b) =>
        b
          .tap(direct('notify-approver'))
          .suspend({ expect: Approval, ttl: '72h' })
          .filter((ex) =>
            ex.suspension.result.approved
              ? true
              : { reason: `rejected by ${ex.suspension.resumedBy}` },
          ),
    ),
  )
  .transform((payout) => executePayout(payout))
  .to(log())
```

Reading it against the four questions:

- **Where does the flow stop?** At `.suspend()`. The runtime checkpoints the exchange and schedules nothing; no worker sits blocked, and the route stays live for other payouts. Small payouts never enter the branch at all.
- **How is the human asked?** However you like. `notify-approver` is an ordinary capability that shapes a message containing `ex.suspension.resumeUrl` (available before the suspend runs) and sends it with any destination: `mail()`, a Slack webhook, a Telegram bot, your ops dashboard. Swapping the channel is editing that one capability.
- **Where does the pending state live?** In the checkpoint store the release introduces (SQLite by default, your own database in production), with a TTL. Expiry surfaces through the route's normal `.error()` handling, so an unanswered approval is just another failure mode you already handle.
- **How does the answer resume the flow?** Through any route that ends in `.resume()`. The design includes a stock `POST /resume/:id` endpoint, and that endpoint is nothing special, just `.from(http(...)).resume()`. Which means the answer can arrive from anywhere:

```ts
craft()
  .id('whatsapp-approvals')
  .from(http({ path: '/whatsapp/inbound', method: 'POST' }))
  .resume((ex) => ({
    token: extractToken(ex.body.text),
    result: { approved: /^yes/i.test(ex.body.text), note: ex.body.text },
  }))
  .transform((ack) => replyText(ack))
  .to(whatsappReply())
```

A payout that arrived over MCP, notified the approver by email, and was approved by a WhatsApp reply: three channels, one exchange, and the original route never knows the difference. The approver's identity rides along as `ex.suspension.resumedBy` for the audit trail, and whoever guards the resume ingress (sender verification, `.authorize()`, signed per-approver tokens) is your authorisation policy.

The same machinery is designed to answer the agent case: an MCP tool that suspends would return a pending acknowledgement with the token. Further along the same roadmap sit short interactive asks (an agent's caller filling in a missing field), where declaring the field as elicitable on the input schema (`.input({ body, elicit: ['iban'] })`) would let the live MCP session ask before the pipeline even starts. Neither ships yet; both travel with the durable-agents work that 0.7 opens.

## The verdict

| | n8n | Routecraft (0.7) |
| --- | --- | --- |
| Ships today | Yes | No; arrives with 0.7 |
| Pause and resume | Built in (Wait node) | `.suspend()` / `.resume()` in the pipeline |
| Approval UI | Prebuilt buttons (Slack, Gmail, Teams) | You shape the message; any channel |
| Resume channel | Resume webhook, form | Any route ending in `.resume()` |
| Pending state | Persisted by the platform, in n8n's database | Checkpoint store, SQLite default, your database in production |
| Survives restarts | Yes | Designed to, via the checkpoint store |
| Approval logic in version control | No | Yes, in the route, under test |
| Who may approve | Node configuration | Your guards on the resume ingress, approver recorded for audit |
| Effort to first working approval | Minutes | Unmeasurable until 0.7 ships |

n8n wins on timing outright: its answer is in production today, Routecraft's is a release away. If you need the approval gate this quarter, that alone decides it. And even once 0.7 lands, if your approvers live in Slack or Gmail and the prebuilt buttons are exactly what you want, **n8n keeps the convenience edge**: the approval UX comes off the shelf, and that is genuinely valuable.

Choose Routecraft, once 0.7 lands, when the approval flow is something you want to own: the ask on whichever channel your approvers actually answer (or several at once), pending approvals queryable in your own store, the gate and its rejection logic in the diff and under test in CI, and the approver's identity enforced at an ingress you control. The pattern composes from the same grammar as the rest of your capabilities, which is the point of having capabilities in the first place.

## Try it

```bash
bunx create-routecraft approvals
```

The scaffold gives you the capability grammar everything above composes from; the suspend and resume pair joins it in 0.7. The Routecraft vs n8n hub post covers the general trade-offs, and the [securing capabilities guide](/docs/advanced/securing-capabilities) covers locking down HTTP ingress, which is where your resume endpoint will live. Full docs at [routecraft.dev/docs](/docs/introduction).
