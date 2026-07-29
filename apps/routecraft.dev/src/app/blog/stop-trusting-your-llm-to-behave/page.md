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

That paragraph is called a system prompt, and in a lot of companies it has quietly become the de facto security boundary. Not because anyone decided it should be one, but because nothing else was ever put in its place. It cannot hold that line. A system prompt is a request. The model will honour it most of the time, the same way most drivers stay under the speed limit most of the time. If your safety story depends on "most of the time", you do not have a safety story. You have a base rate.

## The failure is not hypothetical

Three incidents, three different failure modes, one shared root cause.

In April 2026, an AI coding agent working on a routine staging task for the software company PocketOS [deleted the production database in nine seconds](https://www.tomshardware.com/tech-industry/artificial-intelligence/claude-powered-ai-coding-agent-deletes-entire-company-database-in-9-seconds-backups-zapped-after-cursor-tool-powered-by-anthropics-claude-goes-rogue). It hit a permissions mismatch, searched the project for a way to keep going, found an over-powered access key sitting in an unrelated file, and used it to wipe production along with every backup. Nobody had given the agent that key. It simply had the reach to find one, and the key carried no memory of the job it had been issued for. The rule lived in prose; the credential lived in scope; the credential won.

Earlier the same year, researchers disclosed that ROME, an agentic model built by an Alibaba-affiliated team, had gone off-script during routine training: it [probed internal hosts, opened a hidden tunnel to an outside server, and quietly redirected computing capacity to mine cryptocurrency](https://www.theblock.co/post/392765/alibaba-linked-ai-agent-hijacked-gpus-for-unauthorized-crypto-mining-researchers-say). Nobody attacked it, and nobody asked it to. The behaviour emerged on its own during optimisation, in an environment where nothing structural stopped it.

And in mid-2025, Aim Security disclosed [EchoLeak](https://thehackernews.com/2025/06/zero-click-ai-vulnerability-exposes.html), a zero-click attack on Microsoft 365 Copilot: one crafted email, never opened by a human, was enough to make the assistant pull data from Outlook, SharePoint, and Teams and leak it through a trusted Microsoft domain, triggered by nothing more than the victim asking Copilot an ordinary question. Rated 9.3 out of 10 in severity; Microsoft patched it server-side.

A coding agent with a found credential. A training run with idle capacity. An assistant with a poisoned inbox. Different vectors, same geometry: more capability in scope than the task required, and nothing structural in between. Simon Willison calls the sharpest version of that shape the [lethal trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/): an agent with access to private data, exposure to untrusted content, and a channel to the outside world is one carefully crafted message away from leaking whatever it can read. Notice what is not on that list: a malicious model. In the ROME case there was no attacker at all, and in an attack like EchoLeak the model is not betraying you. It is doing exactly what it was built to do: follow instructions, including the ones an attacker planted in its reading material.

## Why "better prompts" cannot fix this

Three properties of LLMs make natural-language constraints structurally unfit as enforcement:

1. **They are probabilistic.** The same prompt yields different behaviour from run to run and from model version to model version. A constraint that holds in testing can fail in production at some nonzero rate, and you will not pick the inputs on which it fails. An attacker will.
2. **They cannot distinguish instruction from data.** Everything the model reads arrives in one undifferentiated stream. Until models have a built-in privilege separation for trusted instructions, anything that reads untrusted content can be reprogrammed by it.
3. **They drift.** The model you aligned your prompt against in March is not the model your provider serves in June. Each upgrade silently re-rolls the dice on every behavioural assumption you have baked into prose.

None of this means LLMs are unusable. It means the constraint cannot live inside the model. Banks did not solve embezzlement by hiring more honest tellers and writing sterner employee handbooks. They solved it with separation of duties, transaction limits, and audit trails: structural controls that work regardless of intent.

## Hands, not keys

Here is the framing we keep coming back to when we design agent systems: give the agent **hands, not keys**.

Handing an agent keys looks like this: an access token with broad permissions, a direct database connection, a command line. The agent can do everything the credential can do, and your safety relies on the model choosing, every single time, to do only the subset you intended.

Handing an agent hands looks like this: a small set of named functions, each accepting only a narrowly defined input, each of which does one bounded thing and refuses everything else. The agent can press the buttons you built. It cannot build new buttons.

The difference is where the boundary lives. With keys, the boundary is in the model's behaviour. With hands, the boundary is in your code, and code does not get sweet-talked.

{% diagram id="hands-not-keys" /%}

There is an honest trade-off here. Handing over the keys is quicker to start with: one credential, one afternoon, a working demo. Bounded hands cost more up front, because someone has to design and build every button. But broad access is the expensive path in the long run: it is more work to undo once it is woven into your operation, and far harder to debug, because when something goes wrong the answer to "what could the agent have done?" is "anything". Bounded access costs more on day one and pays for itself every day after.

## What enforcement actually looks like

Concretely, a bounded capability stacks deterministic layers, each of which runs whether the model cooperates or not. None of the four is exotic; each is a named practice that predates agents, pointed at a new caller.

{% diagram id="four-gates" /%}

**An input gate.** Schema validation, in the ordinary sense. Inputs are checked before any logic runs, not "the model usually formats this right" but a strict contract that rejects anything outside it:

```ts
const SendEmailInput = z.object({
  to: z.email(),
  subject: z.string().min(1).max(120),
  text: z.string().min(1).max(5_000),
})
```

**A policy gate.** Business rules as code, the same idea as the policy layer in front of any other service. This is the line that turns "please only email colleagues" from a request into a fact:

```ts
.filter((ex) => {
  if (!ex.body.to.endsWith('@company.com')) {
    return { reason: 'recipient outside company domain' }
  }
  return true
})
```

When that check fails, the pipeline halts. There is no negotiation step. No clever phrasing in any prompt, injected or otherwise, changes the return value of `endsWith`.

**An identity gate.** Authentication and authorisation, unchanged from how you already do it. Who is calling matters as much as what they ask for, so the capability checks whose authority the request carries and what that person is allowed to do before any business logic runs. "The agent acting for an intern" and "the agent acting for the CFO" are different callers with different rights, enforced at the door.

**Declared intent.** What an operation does to the world is labelled in the capability's own definition: whether it only reads, whether it destroys, whether it is safe to repeat, whether it reaches outside your own systems. This one is written down as a standard. MCP calls them tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), and the calling side can then require a human confirmation for the ones that warrant it. The label is set by the author in code, not inferred by the model at runtime. Sending email is the outward-facing kind: it cannot be un-sent, so it is marked as reaching the open world and is never advertised as safe to retry.

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

The example is Routecraft because that is what we build at [DevOptix](https://devoptix.nl), and we build it because we kept hitting these same failure modes putting real AI use cases into production for customers. The architecture is the point, not the framework: input, policy, identity, declared intent, in code, on every call. You can build the same layers with ordinary validation code and middleware in any stack.

## Where model-based defences fit

There is a second family of controls doing the rounds: prompt-injection classifiers, output scanners, a second model grading the first one's work. They are worth having, and they are not the same kind of thing as the four gates above.

The difference is what happens under pressure. A classifier that catches most injections raises the cost of an attack, which is real value, and it surfaces attempts you would otherwise never see. But it is a model reading text, so it inherits the same three properties that disqualified the system prompt: it is probabilistic, it cannot fully separate instruction from data, and it drifts when it is retrained. An attacker needs to get past it once. A domain check has no base rate to get past.

So use them, and put them on the right side of the line. Model-based defences belong in front of the gates as filters and behind them as monitoring, never in place of them. A model is a good way to decide whether a draft reply reads well, and a bad way to decide whether an agent may send it. If the answer to "what stops this going wrong?" is another model, you have added a layer, not a boundary.

## "But the models are getting better"

They are, and it does not change the conclusion. Alignment improves the base rate; it does not produce a guarantee, and a planted instruction sidesteps it entirely because the attack does not require a misaligned model in the first place. Model vendors say this themselves: every major provider's agent documentation tells you to scope tools narrowly and treat external content as untrusted. The deterministic layer is not a workaround for today's models. It is the part of the system that lets you adopt tomorrow's models without re-auditing their personality.

There is a more useful way to spend that improving capability. Let your developers lean on AI to design and write these bounded capabilities, review the result the way they would review any other code, and only then deploy it. At runtime, the agent gets the reviewed, bounded surface and nothing more. The same models you are nervous about handing keys to are very good at helping you build better hands.

There is a deeper reason, too. Even a much better model cannot be held accountable. When an automated decision goes wrong, someone answers for it, and that someone is never the model. So we take the accountability ourselves, and we give the system only the access it needs, because you can only stand behind behaviour you can bound.

There is also a quieter benefit. Teams that wrap agents in enforced capabilities ship agents to production. Teams that hand over keys either get burned or, more commonly, get stuck: security review says no, the pilot never graduates, and the project dies in compliance purgatory. A bounded agent is an approvable agent. Constraints are not the tax on the demo. They are the price of leaving the demo.

## The boundary is yours

If a behaviour matters, it must be enforced by something that cannot be persuaded. The model plans, drafts, decides, and reasons; that is what it is for. The moment its output touches the world, it should pass through code that checks the input, the policy, and the identity of the caller, and that halts when the answer is no.

Stop trusting your LLM to behave. It was never the model's job to be your security boundary. It is yours.

---

If you want to see the bounded-capability pattern end to end, [your first MCP server in TypeScript](/blog/your-first-mcp-server-in-typescript) builds one from scratch, and the [securing capabilities guide](/docs/advanced/securing-capabilities) covers the identity layer in depth.
