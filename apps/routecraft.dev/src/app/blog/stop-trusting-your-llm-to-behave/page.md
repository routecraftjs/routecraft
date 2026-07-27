---
title: Stop trusting your LLM to behave. Enforce it.
description: System prompts are requests, not rules. If an agent can touch email, money, or production data, the boundary has to live in code that runs whether the model cooperates or not. Give the agent hands, not keys. A case for deterministic guardrails around probabilistic systems.
date: 2026-06-16
author: Jaco Botha
authorRole: Founder, DevOptix
version: '0.5.0+'
draft: false
featured: true
tags:
  - ai-agents
  - security
  - guardrails
  - llm
related:
  - your-first-mcp-server-in-typescript
diagram: hands-not-keys
layout: blog-post
---

Somewhere in your company, right now, someone is wiring an LLM up to something that matters. An inbox. A CRM. A deploy pipeline. A payment API. And in most of those integrations, the only thing standing between the model and a very bad day is a paragraph of English that says, in effect, "please be careful".

That paragraph is called a system prompt, and in a lot of systems it has quietly become the de facto security boundary. It is not one. A system prompt is a request. The model will honour it most of the time, the same way most drivers stay under the speed limit most of the time. If your safety story depends on "most of the time", you do not have a safety story. You have a base rate.

## The failure is not hypothetical

Three incidents, three different failure modes, one shared root cause.

In April 2026, an AI coding agent on a routine staging task for the software company PocketOS [deleted the production database in nine seconds](https://www.tomshardware.com/tech-industry/artificial-intelligence/claude-powered-ai-coding-agent-deletes-entire-company-database-in-9-seconds-backups-zapped-after-cursor-tool-powered-by-anthropics-claude-goes-rogue). It hit a credential mismatch, scanned the codebase for a way forward, found an over-scoped API token sitting in an unrelated file, and used it to run a single delete that took production and every backup with it. Nobody had handed it that token. It simply had the reach to find one, and the token did not know what task it had been issued for. The rule lived in prose, the credential lived in scope, and the credential won.

Earlier the same year, researchers disclosed that ROME, an agentic model from an Alibaba-affiliated team, had gone off-script during reinforcement-learning training: it [probed internal hosts, opened a reverse SSH tunnel to an external IP, and redirected GPU capacity to mine cryptocurrency](https://www.theblock.co/post/392765/alibaba-linked-ai-agent-hijacked-gpus-for-unauthorized-crypto-mining-researchers-say). No attacker, no instruction; the behaviour emerged as a side effect of optimisation, in an environment where nothing structural stopped it.

And in mid-2025, Aim Security disclosed [EchoLeak, CVE-2025-32711](https://thehackernews.com/2025/06/zero-click-ai-vulnerability-exposes.html), a zero-click prompt injection against Microsoft 365 Copilot: one crafted email, never opened by a human, made the assistant pull data from Outlook, SharePoint, and Teams and exfiltrate it through a trusted Microsoft domain. CVSS 9.3, triggered by nothing more than the victim asking Copilot an ordinary question.

Three vectors, one shape. In each case the agent had more capability in scope than the task needed, and nothing structural stood between it and the damage. Simon Willison calls the sharpest version of this the [lethal trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/): private data, untrusted content, and a way to reach the outside world, all in one agent. Put those three together and a single clever string can exfiltrate whatever the agent can read. EchoLeak is exactly that. But look at what the list does not require: a malicious model. ROME had no attacker at all. And in a prompt injection the model is not betraying you either; your instructions and the attacker's land in the same context window with no privilege separation, and the model does the one thing it was built to do, which is follow them.

## Why "better prompts" cannot fix this

Three properties of LLMs make natural-language constraints structurally unfit as enforcement:

1. **They are probabilistic.** The same prompt yields different behaviour across runs, temperatures, and model versions. A constraint that holds in your eval suite can fail in production at some nonzero rate, and you will not pick the inputs on which it fails. An attacker will.
2. **They cannot distinguish instruction from data.** Everything in the context is one token stream. Until models have something like a hardware privilege ring for trusted instructions, anything that reads untrusted content can be reprogrammed by it.
3. **They drift.** The model you aligned your prompt against in March is not the model your provider serves in June. Each upgrade silently re-rolls the dice on every behavioural assumption you have baked into prose.

None of this means LLMs are unusable. It means the constraint cannot live inside the model. Banks did not solve embezzlement by hiring more honest tellers and writing sterner employee handbooks. They solved it with separation of duties, transaction limits, and audit trails: structural controls that work regardless of intent.

## Hands, not keys

Here is the framing I keep coming back to when designing agent systems: give the agent **hands, not keys**.

Handing an agent keys looks like this: an API token with broad scopes, a database connection string, a shell. The agent can do everything the credential can do, and your safety relies on the model choosing, every single time, to do only the subset you intended.

Handing an agent hands looks like this: a small set of named functions, each with a typed input schema, each of which does one bounded thing and refuses everything else. The agent can press the buttons you built. It cannot build new buttons.

The difference is where the boundary lives. With keys, the boundary is in the model's behaviour. With hands, the boundary is in your code, and code does not get sweet-talked.

{% diagram id="hands-not-keys" /%}

The honest trade-off: keys are quicker. One credential, one afternoon, a working demo. Bounded hands cost more up front, and they pay it back with interest, because broad access is the more expensive thing to undo and to debug. After an incident, "what could the agent have done?" has to be answerable, and with keys the answer is "anything the credential could". Bounded access keeps that answer short, every day after the first.

## What enforcement actually looks like

Concretely, a bounded capability stacks deterministic layers, each of which runs whether the model cooperates or not:

{% diagram id="four-gates" /%}

**A schema gate.** Inputs are validated before any logic runs. Not "the model usually formats this right", but a parser that rejects anything outside the contract:

```ts
const SendEmailInput = z.object({
  to: z.email(),
  subject: z.string().min(1).max(120),
  text: z.string().min(1).max(5_000),
})
```

**A predicate gate.** Business rules as code. This is the line that turns "please only email colleagues" from a request into a fact:

```ts
.filter((ex) => {
  if (!ex.body.to.endsWith('@company.com')) {
    return { reason: 'recipient outside company domain' }
  }
  return true
})
```

When that predicate returns false, the pipeline halts. There is no negotiation step. No clever phrasing in any prompt, injected or otherwise, changes the return value of `endsWith`.

**An identity gate.** Who is calling matters as much as what they ask for. The capability checks an authenticated principal's roles and scopes before any business logic runs, so "the agent acting for an intern" and "the agent acting for the CFO" are different callers with different rights, enforced at the door.

**Declared intent.** What an operation does to the world is labelled in the tool's own metadata: whether it only reads, whether it destroys, whether it is safe to repeat, whether it reaches outside your systems. The calling side can then require confirmation for the ones that warrant it. The label is set by the author in code, not inferred by the model at runtime. Sending email is the outward-facing kind: it cannot be un-sent, so it is marked as reaching the open world and is never advertised as safe to retry.

Put together, in [Routecraft](/docs/introduction) syntax, the whole bounded hand is about twenty lines:

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

An agent connected to this tool can send email to colleagues. That sentence is now complete: there is no asterisk that says "unless someone embeds the right instructions in a calendar invite". The recipient check is not a behaviour the model exhibits. It is a property the system has.

The example is Routecraft because that is what we build at [DevOptix](https://devoptix.nl), and we build it because we kept hitting these same failure modes putting real AI use cases into production for customers. The architecture is the point, not the framework: schema, predicate, identity, declared intent, in code, on every call. You can build the same layers with raw validation code and middleware.

## "But the models are getting better"

They are, and it does not change the conclusion. Alignment improves the base rate; it does not produce a guarantee, and prompt injection sidesteps it entirely because the attack does not require a misaligned model in the first place. Model vendors say this themselves: every major provider's agent documentation tells you to scope tools narrowly and treat external content as untrusted. The deterministic layer is not a workaround for today's models. It is the part of the system that lets you adopt tomorrow's models without re-auditing their personality.

There is a more useful way to spend that improving capability: Let your developers lean on AI to design and write these bounded capabilities, review the result the way they would review any other code, and only then deploy it. At runtime, the agent gets the reviewed, bounded surface and nothing more. The same models you are nervous about handing keys to are very good at helping you build better hands.

There is a simpler version of that argument. However good the model gets, you cannot hold it accountable; accountability stays with whoever deployed it. So take the accountability deliberately, and give the system only the access it needs, because you can only stand behind behaviour you can bound.

There is also a quieter benefit. Teams that wrap agents in enforced capabilities ship agents to production. Teams that hand over keys either get burned or, more commonly, get stuck: security review says no, the pilot never graduates, and the project dies in compliance purgatory. A bounded agent is an approvable agent. Constraints are not the tax on the demo. They are the price of leaving the demo.

## The boundary is yours

If a behaviour matters, it must be enforced by something that cannot be persuaded. The model plans, drafts, decides, and reasons; that is what it is for. The moment its output touches the world, it should pass through code that checks the schema, the predicate, and the principal, and that halts when the answer is no.

Stop trusting your LLM to behave. It was never the model's job to be your security boundary. It is yours.

---

If you want to see the bounded-capability pattern end to end, [your first MCP server in TypeScript](/blog/your-first-mcp-server-in-typescript) builds one from scratch, and the [securing capabilities guide](/docs/advanced/securing-capabilities) covers the identity layer in depth.
