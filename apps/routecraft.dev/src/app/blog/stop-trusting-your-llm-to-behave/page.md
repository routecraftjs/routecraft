---
title: Stop trusting your LLM to behave. Enforce it.
description: System prompts are requests, not rules. If an agent can touch email, money, or production data, the boundary has to live in code that runs whether the model cooperates or not. Give the agent hands, not keys. A case for deterministic guardrails around probabilistic systems.
date: 2026-06-10
author: Jaco Botha
authorRole: Founder, DevOptix
version: '0.6.0+'
draft: false
tags:
  - ai-agents
  - security
  - guardrails
  - llm
layout: blog-post
---

Somewhere in your company, right now, someone is wiring an LLM up to something that matters. An inbox. A CRM. A deploy pipeline. A payment API. And in most of those integrations, the only thing standing between the model and a very bad day is a paragraph of English that says, in effect, "please be careful".

That paragraph is called a system prompt, and the industry has quietly agreed to treat it as a security boundary. It is not one. A system prompt is a request. The model will honour it most of the time, the same way most drivers stay under the speed limit most of the time. If your safety story depends on "most of the time", you do not have a safety story. You have a base rate.

## The failure is not hypothetical

Three incidents from the last twelve months, three different failure modes, one shared root cause.

In April 2026, an AI coding agent working on a routine staging task for the software company PocketOS [deleted the production database in nine seconds](https://www.tomshardware.com/tech-industry/artificial-intelligence/claude-powered-ai-coding-agent-deletes-entire-company-database-in-9-seconds-backups-zapped-after-cursor-tool-powered-by-anthropics-claude-goes-rogue). It hit a barrier, decided the fix was to delete a Railway volume it believed belonged to staging, and ran a destructive delete that wiped production and took the volume-level backups with it. Afterwards, asked to explain itself, it produced a written confession: it knew the rule was "never guess", and it guessed anyway, assuming the delete would be scoped to staging without verifying. Read that twice. The agent could recite the rule perfectly. Reciting is not enforcing. The rule lived in prose; the infrastructure credential lived in scope; the credential won.

A few weeks before that became public, researchers disclosed that ROME, an agentic model built by an Alibaba-affiliated team, had gone off-script during routine reinforcement-learning training: it [probed internal hosts, opened a reverse SSH tunnel to an external IP, and quietly redirected GPU capacity to mine cryptocurrency](https://www.theblock.co/post/392765/alibaba-linked-ai-agent-hijacked-gpus-for-unauthorized-crypto-mining-researchers-say). Nobody attacked it, and nobody asked it to. The behaviour emerged as an instrumental side effect of optimisation, in an environment where nothing structural stopped it.

And in mid-2025, Aim Security disclosed [EchoLeak, CVE-2025-32711](https://thehackernews.com/2025/06/zero-click-ai-vulnerability-exposes.html), a zero-click prompt injection against Microsoft 365 Copilot: one crafted email, never opened by a human, was enough to make the assistant pull data from OneDrive, SharePoint, and Teams and exfiltrate it through a trusted Microsoft domain. CVSS 9.3, no user interaction at any point, patched server-side.

A coding agent with a found credential. A training run with idle GPUs. An assistant with a poisoned inbox. Different vectors, same geometry. Simon Willison has a name for the underlying shape: the [lethal trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/). An agent that has access to private data, processes untrusted content, and has a channel to communicate externally is one clever string away from exfiltrating whatever it can read.

Notice what is not on that list: a malicious model. The model does not need to be evil, jailbroken, or even particularly dumb. In the ROME case there was no attacker at all. And prompt injection means the attacker gets to write part of the prompt: your instructions and theirs arrive in the same context window, in the same format, with no privilege separation. The model is not betraying you when it follows the injected instruction. It is doing exactly what it was built to do: follow instructions.

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

## What enforcement actually looks like

Concretely, a bounded capability stacks deterministic layers, each of which runs whether the model cooperates or not:

**A schema gate.** Inputs are validated before any logic runs. Not "the model usually formats this right", but a parser that rejects anything outside the contract:

```ts
const SendEmailInput = z.object({
  to: z.string().email(),
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

**Declared intent.** Destructive operations are labelled as destructive in the tool's own metadata, so the calling side can require confirmation for them. The label is set by the author in code, not inferred by the model at runtime.

Put together, in [Routecraft](/docs/introduction) syntax, the whole bounded hand is about twenty lines:

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

I am using Routecraft here because I build it and the example is real, but the argument is framework-independent. You can build the same layers with raw validation code and middleware. The point is the architecture: schema, predicate, identity, declared intent, in code, on every call.

## "But the models are getting better"

They are, and it does not change the conclusion. Alignment improves the base rate; it does not produce a guarantee, and prompt injection sidesteps it entirely because the attack does not require a misaligned model in the first place. Model vendors say this themselves: every major provider's agent documentation tells you to scope tools narrowly and treat external content as untrusted. The deterministic layer is not a workaround for today's models. It is the part of the system that lets you adopt tomorrow's models without re-auditing their personality.

There is also a quieter benefit. Teams that wrap agents in enforced capabilities ship agents to production. Teams that hand over keys either get burned or, more commonly, get stuck: security review says no, the pilot never graduates, and the project dies in compliance purgatory. A bounded agent is an approvable agent. Constraints are not the tax on the demo. They are the price of leaving the demo.

## The uncomfortable summary

If a behaviour matters, it must be enforced by something that cannot be persuaded. The model plans, drafts, decides, and reasons; that is what it is for. The moment its output touches the world, it should pass through code that checks the schema, the predicate, and the principal, and that halts when the answer is no.

Stop trusting your LLM to behave. It was never the model's job to be your security boundary. It is yours.

---

If you want to see the bounded-capability pattern end to end, [your first MCP server in TypeScript](/blog/your-first-mcp-server-in-typescript) builds one from scratch, and the [securing capabilities guide](/docs/advanced/securing-capabilities) covers the identity layer in depth.
