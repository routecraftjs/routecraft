---
title: 'LLM as a judge in TypeScript: Vercel AI SDK vs Routecraft'
description: A second model scores the first model's output and a gate decides what happens next. The judge call is five lines in any modern SDK; the pattern is everything around it. Built twice, once with the Vercel AI SDK and once as a Routecraft pipeline.
date: 2026-06-10
author: Jaco Botha
authorRole: Founder, DevOptix
version: '0.6.0+'
draft: true
tags:
  - llm-as-a-judge
  - ai-sdk
  - patterns
  - typescript
layout: blog-post
---

LLM as a judge is the pattern where one model evaluates another model's output before that output is allowed to matter. A generator drafts a reply, a summary, a classification; a judge scores it against criteria; a gate decides: ship it, retry it, or send it to a human.

It shows up in two places. In **evals**, judges grade outputs offline to track quality across prompt and model changes. In **production gates**, the judge runs inline, in front of the side effect, deciding right now whether this customer reply is good enough to send. This post is about the second kind, because that is where the pattern stops being a notebook trick and starts being plumbing.

The honest headline: the judge call itself is trivially easy in 2026. The comparison worth writing is what happens around it.

This post is part of a pattern series; siblings cover [human in the loop](/blog/human-in-the-loop) and [guardrails for MCP tools](/blog/agent-tool-guardrails).

## The pattern, tool-agnostic

A production judge gate has four parts:

1. **A verdict schema.** Scores and reasons as structured output, never free text you regex.
2. **A judge prompt.** The criteria, written down, versioned.
3. **A deterministic gate.** Code compares the verdict against a threshold. The judge advises; the gate decides.
4. **A destination for each outcome.** Pass goes out the door; fail goes to retry, a human queue, or the bin, with the verdict logged either way.

## With the Vercel AI SDK

The AI SDK is the natural TypeScript baseline, and `generateObject` makes the judge call genuinely clean:

```ts
import { generateObject } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { z } from 'zod'

const Verdict = z.object({
  score: z.number().min(1).max(10),
  reasons: z.array(z.string()).max(5),
})

export async function judgeReply(draft: string, customerMessage: string) {
  const { object: verdict } = await generateObject({
    model: anthropic('claude-haiku-4-5'),
    schema: Verdict,
    system: [
      'You review draft replies to customer support tickets.',
      'Score 1-10 on: factual grounding in the ticket, tone, and absence of promises we cannot keep.',
      'Be strict. A 8+ means you would send it verbatim.',
    ].join('\n'),
    prompt: `Ticket:\n${customerMessage}\n\nDraft reply:\n${draft}`,
  })
  return verdict
}
```

Typed verdict, schema-enforced output, one dependency. For the gate you write the obvious code:

```ts
const verdict = await judgeReply(draft, ticket.message)
if (verdict.score >= 8) {
  await sendReply(draft)
} else {
  await queueForHuman(draft, verdict)
}
```

This is good code, and if your judge lives inside an existing application, you should write exactly this and stop reading.

What the SDK deliberately does not give you, because it is an SDK and not a runtime: the logging that records every verdict with the input that produced it, the retry behaviour when the judge call itself fails, the test seam that lets CI assert "a draft promising a refund never passes", and a place where the threshold and model live as reviewable configuration rather than constants scattered through application code. You will write all of that, and it is two hundred lines nobody budgets for.

## As a Routecraft pipeline

In Routecraft the judge is a pipeline stage, and the gate is a filter. The pattern's four parts map one-to-one onto operations:

```ts
import { llm } from '@routecraft/ai'
import { craft, direct, mail } from '@routecraft/routecraft'
import { z } from 'zod'

const DraftReply = z.object({
  ticketId: z.string(),
  customerEmail: z.string().email(),
  customerMessage: z.string(),
  reply: z.string().min(1),
})
type DraftReply = z.infer<typeof DraftReply>

const Verdict = z.object({
  score: z.number().min(1).max(10),
  reasons: z.array(z.string()).max(5),
})

export default craft()
  .id('send-judged-reply')
  .description('Judge a drafted support reply and send it only if it passes.')
  .input({ body: DraftReply })
  .from<DraftReply>(direct())
  .enrich(
    llm('anthropic:claude-haiku-4-5-20251001', {
      system: [
        'You review draft replies to customer support tickets.',
        'Score 1-10 on: factual grounding in the ticket, tone, and absence of promises we cannot keep.',
        'Be strict. A 8+ means you would send it verbatim.',
      ].join('\n'),
      user: (ex) =>
        `Ticket:\n${ex.body.customerMessage}\n\nDraft reply:\n${ex.body.reply}`,
      output: Verdict,
    }),
  )
  .filter((ex) => {
    const { score, reasons } = ex.body.output
    if (score < 8) {
      return { reason: `judge scored ${score}: ${reasons.join('; ')}` }
    }
    return true
  })
  .transform((body) => ({
    to: body.customerEmail,
    subject: `Re: ticket ${body.ticketId}`,
    text: body.reply,
  }))
  .to(mail())
```

Reading it against the four parts:

- `.enrich(llm(..., { output: Verdict }))` runs the judge and merges a **typed** verdict into the body; downstream code sees `body.output.score` with autocomplete, because the schema flows through the chain.
- `.filter()` is the deterministic gate. Below threshold, the exchange halts with a recorded reason; the reply physically cannot reach `.to(mail())`. The judge advises, the filter decides, and that separation is enforced by pipeline order rather than discipline.
- Every stage emits structured events (`exchange:dropped` carries the judge's reasons), so "what did the judge say and what did we do about it" is your log stream, not a print statement you remembered to add.
- The whole route is a value you can test: feed it fixture drafts with `@routecraft/testing`, assert that the refund-promising one drops. The judge prompt is in the diff, the threshold is in the diff, the model id is in the diff.

Swapping the judge model is editing one string (`anthropic:...`, `openai:...`, `ollama:...` for a local judge), because providers are registered once in `llmPlugin` and referenced by id.

A fair note in the other direction: Routecraft's `llm()` runs under the same roof as the AI SDK (it builds on it), so raw model capability is identical. You are choosing packaging, not intelligence.

## The verdict

| | Vercel AI SDK | Routecraft |
| --- | --- | --- |
| Judge call with typed verdict | `generateObject` | `.enrich(llm({ output }))` |
| Deterministic gate | Hand-written `if` | `.filter()`, halts the pipeline |
| Verdict logging and drop reasons | You build it | Structured events out of the box |
| Testing the gate in CI | You build the harness | `@routecraft/testing` fixtures |
| Threshold, prompt, model as reviewable config | Scattered constants | One route definition in the diff |
| Fits inside an existing app | Perfectly, it is a function | Heavier, brings a runtime |
| Dependency weight | One package | A framework |

Use the **AI SDK directly** when the judge is a feature of an application you already have: one function, full control, no new runtime.

Use **Routecraft** when the judge is a gate inside an automation that runs on its own: the flow triggers from a webhook or schedule, the verdict needs an audit trail, the gate needs tests, and the same pipeline pattern repeats across more flows than one.

And in either tool: never let the judge be the only gate in front of an irreversible action. A judge is still an LLM, with an LLM's failure modes; the case for deterministic checks alongside it is [its own post](/blog/stop-trusting-your-llm-to-behave).

## Try it

```bash
bunx create-routecraft judged-replies
```

The [llm() adapter reference](/docs/reference/adapters/llm) covers structured output, and the [Routecraft vs n8n](/blog/routecraft-vs-n8n) hub has the wider pattern table. Full docs at [routecraft.dev/docs](/docs/introduction).
