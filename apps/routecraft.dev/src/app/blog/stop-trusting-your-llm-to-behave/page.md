---
title: Stop trusting your LLM to behave. Enforce it.
description: System prompts are requests, not rules. Human review, LLM judges, and guardrail frameworks all raise the cost of an attack, and none of them is a boundary. Banks did not solve embezzlement by hiring more honest tellers. Give the agent hands, not keys.
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

## What the industry is doing about it

None of this is news to the people building agent products. Prompt injection has topped [OWASP's Top 10 for LLM Applications](https://genai.owasp.org/llmrisk/llm01-prompt-injection/) for two editions running, and a whole layer of defences has grown up around it. It is better work than its critics allow, and worth understanding before anyone dismisses it.

**Human in the loop.** The agent proposes, a person approves, and nothing reaches the world in between. The [Model Context Protocol builds this into the protocol](https://modelcontextprotocol.io/specification/2025-06-18/server/tools): there should always be a human able to deny a tool invocation, and clients should show the user what the tool is about to be called with. It is the oldest control in the book and still the best one for the long tail, because a person can catch the case nobody thought to write a rule for. Its limit is arithmetic. Ask someone to approve four hundred actions a day and by the second week they are clicking yes without reading.

**LLM-as-judge.** A second model grades the first one's work before it goes anywhere. The pattern started in evaluation, where the [MT-Bench work](https://arxiv.org/abs/2306.05685) showed a strong judge model agreeing with human preferences more than 80% of the time, and it spread from there into production. As a gate it answers the questions rules cannot reach. Did the reply stay on topic. Is the tone right for this customer. Did the summary invent a number that appears nowhere in the source.

**Guardrail frameworks.** [NeMo Guardrails](https://github.com/NVIDIA/NeMo-Guardrails) and [Guardrails AI](https://www.guardrailsai.com/docs) turn the scattered checks around a model into declared configuration: input rails, output rails, retrieval rails, and execution rails around tool calls. The value is less in any individual check than in the checks no longer being ad hoc. They become versioned, testable, and reviewable in one place, which is the difference between a policy and a habit.

**Prompt-injection detection.** Classifiers trained on the attack itself rather than on the outcome. Azure's [Prompt Shields](https://learn.microsoft.com/en-us/azure/ai-services/content-safety/concepts/jailbreak-detection) usefully splits the problem in two: user prompt attacks, where the person at the keyboard tries to talk the model out of its instructions, and document attacks, where the instructions are planted in material the model reads. An email. A PDF. A calendar invite. These run cheaply and at volume, which matters when the alternative is a human reading everything.

**Output scanning.** The mirror image, applied on the way out. Secrets, credentials, personal data, links to domains nobody recognises, claims that appear in the answer but in none of the retrieved documents.

Use them. All of them, if the budget stretches. They raise the cost of an attack, and cost is a genuine defence, because most attackers are opportunists and an opportunist stops when the effort exceeds the payoff. They catch mistakes as well as attacks, and mistakes are most of what actually goes wrong on a Tuesday. Best of all, they are the only part of the stack that tells you anything: a classifier that logs an injection attempt is how a team finds out it is being probed at all. Running none of this is not rigour. It is luck.

## Every one of them is a probability

Here is what they share. With the partial exception of the human, every one of them is a model reading text and returning a judgement. Which means every one of them inherits the three properties that disqualified the system prompt in the first place.

**They are probabilistic.** The same input yields different behaviour from run to run and from model version to model version. A check that holds across your entire test set can still fail in production at some nonzero rate, and you do not choose the inputs on which it fails. An attacker does.

**They cannot reliably separate instruction from data.** Everything the model reads arrives in one undifferentiated stream. A classifier inspecting a suspicious email is a model reading the attacker's text, with the attacker's text in its context. That is an odd position to defend from.

**They drift.** The model you tuned your judge prompt against in March is not the model your provider serves in June. Every upgrade silently re-rolls the dice on every behavioural assumption baked into prose.

The vendors say so themselves, in their own documentation, about their own products. Microsoft's page for Prompt Shields ends by noting that it "may not catch all attack vectors or may flag legitimate prompts. Always implement additional validation layers." [OWASP's prevention guidance](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html) is blunter, observing that content filters "can be systematically defeated through sufficient variation attempts" and that the right posture is to treat all of this as one layer among several, never as a substitute for least-privilege tool scopes and human approval on destructive actions. Nobody serious claims otherwise. The overclaim lives in the gap between what the vendor documents and what the team deploying it assumes.

**The judge has a sharper version of the problem**, and we walked into it designing our own agent. One of its pipelines ends by sending information to a named colleague, and the obvious safety measure was a judge at the end: check that what is about to be sent is genuinely relevant to that person, and does not leak something team-wide they should not see. It is an appealing design. It reads like a conscience.

The objection that killed it was one sentence. Do not have the model judge the payload, because the payload is exactly what an attacker controls.

Asking a model "is this content appropriate to send?" makes the judge injectable through the same content it is judging. Whoever can influence the payload can also write, in the same field, the argument for why the payload is fine. The judge is not standing outside the attack. It is inside it.

So judge the envelope, not the letter. Not "does this text look appropriate for Sam", but: who is the recipient, what scopes does the caller hold, which record was requested, and does that record belong to that person. Those are deterministic attributes of the request. Our own system produced them, they are not prose, and no amount of clever writing in the body moves any of them. The letter is untrusted all the way down. The envelope is not.

That generalises past our one pipeline. A model-based defence improves the base rate, sometimes dramatically, and it never changes what is possible. It has to hold every single time. An attacker needs it to fail once. And in the cases that matter, the thing you are asking it to reason about was written by the person trying to get past it. The [research literature](https://simonwillison.net/2025/Jun/13/prompt-injection-design-patterns/) has converged on the same conclusion: once an agent has ingested untrusted input, it must be constrained so that the input cannot trigger a consequential action at all.

## Banks did not hire more honest tellers

Banking met this problem a century early, and did not solve it by improving the people.

Embezzlement did not become rare because tellers grew more honest, or because staff handbooks grew sterner. It became rare because of separation of duties, transaction limits, dual authorisation, reconciliation, and audit trails. A teller who wants to steal still cannot, and not because anybody persuaded them. The second signature does not exist. The limit does not move. The ledger remembers. Those controls hold regardless of intent, which is precisely why you can lean on them: nobody ever has to work out what anyone was thinking.

Screening and training did not disappear, and banks still do both, carefully. They raise the base rate. The structural controls cap what a bad base rate can cost you. Two different jobs, and only one of them is a boundary.

This piece is that argument transposed. Classifiers, judges, and guardrail configuration are the screening, and they deserve the same care a bank puts into hiring. What is missing from most agent deployments is the second signature.

## Hands, not keys

So what is the second signature for an agent? Here is the framing we keep coming back to when we design these systems: give the agent **hands, not keys**.

Handing an agent keys looks like this: an access token with broad permissions, a direct database connection, a command line. The agent can do everything the credential can do, and your safety relies on the model choosing, every single time, to do only the subset you intended.

Handing an agent hands looks like this: a small set of named functions, each accepting only a narrowly defined input, each doing one bounded thing and refusing everything else. The agent can press the buttons you built. It cannot build new buttons.

The difference is where the boundary lives. With keys, the boundary is in the model's behaviour. With hands, the boundary is in your code, and code does not get sweet-talked.

{% diagram id="hands-not-keys" /%}

There is an honest trade-off here. Handing over the keys is quicker to start with: one credential, one afternoon, a working demo. Bounded hands cost more up front, because someone has to design and build every button. But broad access is the expensive path in the long run. It is harder to unpick once it is woven through your operation, and far harder to debug, because when something goes wrong the answer to "what could the agent have done?" is "anything".

## The four gates

Concretely, a bounded capability stacks deterministic layers, each of which runs whether the model cooperates or not. None of the four is exotic. Each is a named practice that predates agents, pointed at a new kind of caller.

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

**Declared intent.** What an operation does to the world is labelled in the capability's own definition: whether it only reads, whether it destroys, whether it is safe to repeat, whether it reaches outside your own systems. This one is written down as a standard. MCP calls them tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), and the calling side can then require a human confirmation for the ones that warrant it. The spec is careful to say that a client must treat those annotations as untrusted when they come from a server it does not trust, which is the right instinct and cuts helpfully here: on your own capabilities, you are the server. The label is set by the author in code, not inferred by the model at runtime. Sending email is the outward-facing kind. It cannot be un-sent, so it is marked as reaching the open world and is never advertised as safe to retry.

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

This sits on top of the previous section, not instead of it. Keep the classifiers and the judges. Put them in front of the gates as filters and behind them as monitoring, where a failure means something got missed rather than something got through. What changes is what happens on the miss. A model is a good way to decide whether a draft reply reads well, and a bad way to decide whether an agent may send it.

The example is Routecraft because that is what we build at [DevOptix](https://devoptix.nl), and we build it because we kept hitting these same failure modes putting real AI use cases into production for customers. The architecture is the point, not the framework: input, policy, identity, declared intent, in code, on every call. You can build the same layers with ordinary validation code and middleware in any stack.

## "But the models are getting better"

They are, and the objection deserves a straight answer. If next year's model is better aligned and harder to fool, does the deterministic layer stop mattering?

No, and the reason has nothing to do with how good the model gets. Alignment improves the base rate; it does not produce a guarantee. A planted instruction sidesteps alignment entirely, because that attack never needed a misaligned model in the first place. Copilot was not misbehaving during EchoLeak. It was following instructions, which is the entire product. The people building the models document the same posture in their own agent guidance, and so does the protocol their tools speak: input, output, and tool guardrails, approval flows that pause before risky work continues, and servers that validate every tool input and enforce access control. The deterministic layer is not a workaround for today's models. It is the part of the system that lets you adopt tomorrow's models without re-auditing their personality.

There is a better use for all that improving capability than trusting it at runtime. Point it at build time instead. Let your developers lean on AI to design and write these bounded capabilities, review the result the way they would review any other code, and only then deploy it. At runtime the agent gets the reviewed, bounded surface and nothing more. The same models you are nervous about handing keys to are very good at helping you build better hands.

Then there is the limit no amount of capability crosses. When an automated decision goes wrong, someone answers for it, and accountability does not transfer to the thing that acted. It stays with whoever chose to deploy it. So take it deliberately, and give the system only the access it needs, because you can only stand behind behaviour you can bound.

That is not only an ethical position. It is why bounded agents ship at all. Teams that wrap agents in enforced capabilities get them into production; teams that hand over keys either get burned or, far more often, get stuck, because a reviewer asked what the agent could do and "anything" was the honest answer. A bounded agent is an approvable agent, because a bounded agent is one somebody can put their name to. Constraints are not the tax on the demo. They are the price of leaving it.

## The boundary is yours

If a behaviour matters, it must be enforced by something that cannot be persuaded. Use the judges and the classifiers, because they will catch things your rules never anticipated and tell you when someone is trying. Just do not mistake them for the boundary. The model plans, drafts, decides, and reasons; that is what it is for. The moment its output touches the world, it should pass through code that checks the input, the policy, and the identity of the caller, and that halts when the answer is no.

Stop trusting your LLM to behave. It was never the model's job to be your security boundary. It is yours.

---

If you want to see the bounded-capability pattern end to end, [your first MCP server in TypeScript](/blog/your-first-mcp-server-in-typescript) builds one from scratch, and the [securing capabilities guide](/docs/advanced/securing-capabilities) covers the identity layer in depth.
