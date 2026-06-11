---
title: AI agents are still single-player. Your organization isn't.
description: The personal-harness wave gave every developer an agent with their own access, their own memory, and their own terminal. That model cannot serve a team. The unit of organizational AI leverage is the governed capability, not the personal agent.
date: 2026-06-14
author: Jaco Botha
authorRole: Founder, DevOptix
version: '0.6.0+'
draft: false
featured: true
tags:
  - ai-agents
  - organizations
  - mcp
  - capabilities
layout: blog-post
---

The current generation of agent harnesses is genuinely impressive, and almost all of it is built on the same quiet assumption: one human, one agent. Your API tokens. Your laptop. Your memory files. Your terminal. The personal harness automates *you*, and for an individual developer that is exactly right.

Then the team sees the demo, and someone asks the question that the whole category has been avoiding: "great, how do we roll this out to forty engineers?"

The honest answer is that you don't. Not because the tools are immature, but because the single-player model is structurally wrong for organizations, in ways that no amount of polish fixes.

## Five walls you hit, in order

**1. Access.** A personal agent runs on your credentials. Whatever you can read, it can read; whatever you can break, it can break, and the argument for never giving an agent raw keys is [a post of its own](/blog/stop-trusting-your-llm-to-behave). At organizational scale the problem compounds: forty agents on forty personal tokens is a surface your security team cannot reason about. Who reviewed what the agent does with that access? What happens to the agent's standing infrastructure when its owner leaves? "Shadow IT, but autonomous" is not a phrase you want in an audit report.

**2. Memory.** What your agent learns about your systems lives on your machine. The colleague two desks over runs the same investigation tomorrow, and their agent re-learns it from scratch. Organizations spent two decades fighting knowledge silos; the personal-harness model rebuilds them and automates the digging of the moat.

**3. Surface.** The personal agent lives where its credentials live: your terminal, your laptop, sometimes your inbox. The moment someone wants to trigger the same automation from Teams during an incident call, or from a phone on a Saturday, the model breaks, because the execution is welded to one person's machine.

**4. Duplication.** Forty engineers wire up the same ticketing, logging, and database tools forty times, forty slightly different ways, with forty copies of the prompt that explains them. None of it is reviewed, none of it is shared, and the best version of each tool is trapped in the dotfiles of whoever wrote it.

**5. Audit.** When something goes wrong, the question is always the same: which agent did what, with whose permission, on whose behalf? A fleet of personal harnesses has no answer. There is no central log, no principal attached to actions, no place where the organization's rules are enforced rather than suggested.

None of these are model problems. GPT-next does not fix them. They are architecture problems, and they all trace back to the same root: in the single-player model, the *agent* is the unit of deployment.

## Multiplayer: the capability is the unit

Flip the model. Instead of deploying agents that carry tools with them, deploy the **capabilities** centrally, and let both humans and agents call them.

A capability in this sense is a small, bounded, typed operation: fetch the logs for this trace id, check this request against the API spec, compare this record across the primary database and the cache. Deployed once, as ordinary infrastructure, with three properties that the personal model cannot offer:

- **Identity at the front door.** A person signs in with the organization's SSO. An agent acts on behalf of an authenticated principal. Either way, the capability knows *who* is asking, and authorization rules decide per principal what is allowed: this team sees these systems, that role may run this query, nobody runs that one without sign-off.
- **Service accounts at the back door.** The capability reaches the database, the log store, the observability stack through credentials the platform owns, scoped to exactly what the capability needs. No personal tokens in the loop, nothing to revoke when someone leaves, and the blast radius of any one capability is the capability's own narrow contract.
- **Any surface.** Because the capability is a deployed service rather than a local process, the same operation is callable from an IDE, from a chat message during the incident call, from a phone, or by an agent chaining it with five others. The consumer changes; the capability, its access rules, and its audit trail do not.

The agents do not disappear in this model. They get *better*, because a team-maintained, reviewed, typed capability beats the private tool collection of any individual. The personal agent becomes a thin client of shared infrastructure, the way a developer's laptop is a thin client of the CI system. We did not scale version control by giving everyone better local folders, and we will not scale agents by giving everyone better personal harnesses.

## What this looks like in practice

A concrete shape, from production at a major European bank: incident triage. Capabilities for pulling an incident's context from the ticket system, fetching logs by trace id, walking a distributed trace to see which services called which, validating an observed request against the API specification, finding the code that emitted a log line, and checking whether a record is in sync between the primary store and its replicas.

Each one is small, deterministic, and read-only. And each one serves three consumers at once: a junior engineer runs them step by step and learns how triage works; a senior runs the one lookup they need in three seconds instead of six browser tabs; an agent chains all of them and arrives at "the caller is sending a field the spec renamed in v2, and here is the code that rejects it" before a human has finished opening Grafana. Same capabilities, same access rules, same audit trail, three very different users.

That suite started as one engineer's personal automation. The point of the multiplayer model is that this is a legitimate starting point: the path from "my script" to "our infrastructure" is a deployment and an identity layer, not a rewrite.

## The uncomfortable summary

Single-player agents are a local maximum. They demo brilliantly, they genuinely help individuals, and they cannot be rolled out, because access, memory, surface, reuse, and audit all assume an organization-shaped answer that the personal model cannot give.

The organizations that get leverage from agents in the next few years will be the ones that treat capabilities as shared, governed infrastructure and let every human and every agent in the building stand on them. The ones that hand out personal harnesses will get forty demos and a security review that never ends.

I build [Routecraft](/docs/introduction), a framework for exactly this capability layer, so discount my bias accordingly; the argument above stands regardless of whose tools you use. If you want the companion piece: [a skills repository is not an automation platform](/blog/beyond-the-skills-repository) covers the maturity path most organizations are actually on. The practical guide to choosing your first capabilities is next in this series.
