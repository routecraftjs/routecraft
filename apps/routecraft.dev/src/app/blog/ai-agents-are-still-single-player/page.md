---
title: AI agents are still single-player. Your organisation isn't.
description: The personal-assistant wave gave every employee an agent with their own access, their own memory, and their own chat window. That model cannot serve a team. The unit of organisational AI leverage is the governed capability, not the personal agent.
date: 2026-06-30
author: Jaco Botha
authorRole: Founder, DevOptix
canonical: https://devoptix.nl/en/blog/ai-agents-are-still-single-player
draft: false
featured: true
home: true
tags:
  - ai-agents
  - organizations
  - mcp
  - capabilities
related:
  - anatomy-of-a-team-agent-harness
  - beyond-the-skills-repository
diagram: single-player-vs-multiplayer
layout: blog-post
---

The current generation of agent tools is genuinely impressive, and almost all of it is built on the same quiet assumption: one human, one agent. Your accounts. Your laptop. Your memory files. Your chat window. The personal assistant automates *you*, and for an individual that is exactly right.

Then the team sees the demo, and someone asks the question that the whole category has been avoiding: "great, how do we roll this out to forty people?"

The honest answer is that you don't. Not because the tools are immature, but because the single-player model is structurally wrong for organisations, in ways that no amount of polish fixes.

## Five walls you hit, in order

**1. Access.** A personal agent runs on your credentials. Whatever you can read, it can read; whatever you can break, it can break, and the argument for never giving an agent raw keys is [a post of its own](/blog/stop-trusting-your-llm-to-behave). At organisational scale the problem compounds: forty agents on forty personal logins is a surface your security team cannot reason about. Who reviewed what the agent does with that access? What happens to the agent's standing infrastructure when its owner leaves? "Shadow IT, but autonomous" is not a phrase you want in an audit report.

**2. Memory.** What your agent learns about your systems lives on your machine. The colleague two desks over runs the same investigation tomorrow, and their agent re-learns it from scratch. Organisations spent two decades fighting knowledge silos; the personal-assistant model rebuilds them one completed task at a time, automatically.

**3. Surface.** The personal agent lives where its credentials live: your chat window, your laptop, sometimes your inbox. The moment someone wants to trigger the same automation from Teams during an incident call, or from a phone on a Saturday, the model breaks, because the execution is welded to one person's machine.

**4. Duplication.** Forty people wire up the same ticketing, logging, and database tools forty times, forty slightly different ways, with forty copies of the prompt that explains them. None of it is reviewed, none of it is shared, and the best version of each tool is trapped in the personal setup of whoever wrote it.

**5. Audit.** When something goes wrong, the question is always the same: which agent did what, with whose permission, on whose behalf? A fleet of personal assistants has no answer. There is no central log, no named person behind each action, no place where the organisation's rules are enforced rather than suggested.

None of these are model problems. GPT-next does not fix them; a smarter model still cannot be held accountable for what it does with your systems. They are architecture problems, and they all trace back to the same root: in the single-player model, the *agent* is the unit of deployment.

## Multiplayer: the capability is the unit

Flip the model. Instead of deploying agents that carry tools with them, deploy the **capabilities** centrally, and let both humans and agents call them.

{% diagram id="single-player-vs-multiplayer" /%}

A capability in this sense is a small, bounded, well-defined operation: look up this customer's open orders, check this invoice against the contract behind it, compare this record across the two systems that both claim to own it. Deployed once, as ordinary infrastructure, with three properties that the personal model cannot offer:

- **Identity at the front door.** A person signs in with the organisation's single sign-on. An agent acts on behalf of an identified person too. Either way, the capability knows *who* is asking, and authorisation rules decide per person what is allowed: this team sees these systems, that role may run this query, nobody runs that one without sign-off.
- **Service accounts at the back door.** The capability reaches the systems it needs through credentials the platform owns, scoped to exactly what that capability does. No personal logins in the loop, nothing to revoke when someone leaves, and the blast radius of any one capability is the capability's own narrow contract.
- **Any surface.** Because the capability is a deployed service rather than a local process, the same operation is callable from a laptop, from a chat message during the incident call, from a phone, or by an agent chaining it with five others. The consumer changes; the capability, its access rules, and its audit trail do not.

The agents do not disappear in this model. They get *better*, because a capability that a team maintains, reviews, and tests beats the private tool collection of any individual. The personal agent becomes a front door to shared infrastructure. No finance director would run the company's books across forty personal spreadsheets; there is no better reason to run its automation across forty personal setups.

## What this looks like in practice

A concrete shape: incident triage at a major European bank. When a system misbehaves, the first minutes go to gathering facts, and the lookups behind those facts become shared capabilities: pull the incident's context from the ticket system, fetch the logs that matter, trace which systems called which, check whether a record is in sync between the primary system and its copies.

Each lookup is small, predictable, and read-only, and the same few of them cover work that looks nothing alike. Someone runs one directly because they know exactly which fact is missing. Someone else describes the problem to the assistant they already have open and never touches the individual lookups at all. A written procedure captures the order for a situation that recurs. A scheduled run does the whole chain at three in the morning and reports that eleven records disagree, with nobody awake to ask. A new joiner, meanwhile, steps through them one at a time and learns how triage actually works. Same capabilities, same access rules, same audit trail.

We are building exactly this shape with that bank now. It began as one engineer's personal automation, made it through the bank's review as a proof of concept, and is a project with multiple contributors today. The point of the multiplayer model is that this is a legitimate path: from "my script" to "our infrastructure" is a deployment and an identity layer, not a rewrite. The capabilities are the part that has to be fixed; the order they are called in does not. A rigid workflow runs every step whether it earns its place or not, so ask it about a log line and it will still go and fetch the API specification, because that is what step three says. Chosen at the moment it is needed, by a person, by a written procedure, or by a model reading the evidence in front of it, those same few capabilities cover cases nobody enumerated in advance. And the shape is not a banking shape: the same pattern fits a logistics team tracing shipments, a law firm assembling case files, or a clinic reconciling appointments against billing.

## The uncomfortable summary

Single-player agents are a local maximum. They demo brilliantly, they genuinely help individuals, and they cannot be rolled out, because access, memory, surface, reuse, and audit all assume an organisation-shaped answer that the personal model cannot give.

The organisations that get leverage from agents in the next few years will be the ones that treat capabilities as shared, governed infrastructure and let every human, every agent, and every automation in the building stand on them. The ones that hand out personal assistants will get forty demos and a security review that never ends.

If you want to start, do not start with the agent. Pick the single lookup your team already runs by hand a dozen times a week, the one somebody has half-automated in a personal script. Deploy that one capability behind the sign-on you already have, with a service account scoped to exactly what it reads, and let one team call it from wherever they already work. One governed capability is worth more than forty demos, and it is the plank everything else stands on.

Once a handful of those exist, the question changes shape: what should the agent standing on them actually be able to do? That is the subject of [anatomy of a team agent harness](/blog/anatomy-of-a-team-agent-harness), and the maturity path most organisations are climbing to get there is in [a skills repository is not an automation platform](/blog/beyond-the-skills-repository).

We build [Routecraft](/docs/introduction) at [DevOptix](https://devoptix.nl) because we believe the argument above: it is the capability layer, made concrete.

What never changes is who answers for it. When something goes wrong, somebody has to say which agent did what, on whose behalf, and why it was allowed. A shared capability layer can answer that, because every call arrives with a person attached and leaves a record behind it. Forty personal setups cannot answer it at all. That is the difference between forty demos and infrastructure your whole organisation can stand on.
