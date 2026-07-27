---
title: Anatomy of a team agent harness
description: "A chat loop with tools is not a harness. An agent that works for a team needs four primitives most personal harnesses skip entirely: delegation, a learning loop, self-aware capability gaps, and multi-channel presence, plus three platform rules that keep the whole thing governable."
date: 2026-07-23
author: Jaco Botha
authorRole: Founder, DevOptix
draft: false
tags:
  - ai-agents
  - agent-harness
  - organizations
  - memory
related:
  - ai-agents-are-still-single-player
diagram: team-agent-harness
layout: blog-post
---

In [AI agents are still single-player](/blog/ai-agents-are-still-single-player) I argued that the unit of organisational AI leverage is the governed capability, not the personal agent. This post is about the layer that sits on top: when you do host agents for a team or a business, what does the harness itself need to provide?

The popular answer is "a chat loop with tools", because that is what the personal-harness generation ships and it demos wonderfully. But run an agent for a team for a few months (we run one for our own company's back office) and you discover the loop is the easy part. What makes the agent *organisational* is four primitives that most harnesses skip entirely, plus three platform rules around them. None of this requires new model capabilities; all of it is architecture.

{% diagram id="team-agent-harness" /%}

## Primitive 1: delegation that survives the wait

An agent serving a team constantly hits questions it should not answer alone: a judgement call, a missing fact only one person knows, an approval. The personal-harness answer is to print the question in the terminal and block. The team answer has to be asynchronous, and it starts with knowing *who* to ask, which is a skill in its own right: the agent works out who owns the decision, asks that person on the right channel, parks the work with its full context intact, and resumes when the answer arrives, whether that is in forty seconds or on Thursday. Ask the right person, get the answer, carry on.

This sounds like a UX nicety. It is actually the load-bearing wall, because without it every uncertain task either stalls forever or, worse, proceeds on a guess. The pattern goes by human in the loop, and in a team harness it is not a feature you add to one workflow; it is ambient, available to every task the agent runs.

## Primitive 2: a learning loop into shared memory

Every delegation from primitive 1 produces an answer, and every conversation surfaces facts about how your organisation actually works: this client prefers invoices on the first of the month, that service's alerts are noisy on Mondays, the VAT filing needs the second account, a refund is signed off in finance and not support. That last kind is what makes delegation get smarter over time: knowing who to ask is learned once and then reused, so the agent stops relearning the org chart one question at a time. A personal agent stores all of this in its owner's local files, where it dies. A team harness writes it back to **shared memory**, so a question any human answers once is answered for everyone, permanently.

This is the difference between an agent that is *used* and an agent that *accumulates*. After a quarter, the memory is the most valuable artefact the harness owns: institutional knowledge that previously lived in one founder's head or a thousand email threads, now queryable by every task. It is also the clearest case for the harness being team infrastructure rather than personal tooling: memory that matters belongs to the organisation, with access rules, not to whoever happened to chat with the agent.

## Primitive 3: self-aware capability gaps

The most underrated thing an agent can know is what it cannot do. A team harness makes that knowledge productive: when the agent is blocked mid-task because a capability is missing (no read access to the table that would confirm the diagnosis, no connector to the system that holds the answer), it does not shrug into the chat. It **files a ticket**: what it was trying to accomplish, which capability it lacked, why that capability would have changed the outcome, and what it would have concluded with it.

That ticket is written at the moment of failure with the full context loaded, which makes it better than most tickets humans write, and it turns the platform's backlog into an evidence-ranked queue instead of a brainstorm: the capabilities that block the most real work rise to the top on their own. The agent identifies its own gaps; humans review, approve, and grant access; and increasingly the capability itself is drafted by an agent from that very ticket. The boundary that keeps this safe is one sentence: the agent **requests** capabilities, it never grants them.

## Primitive 4: multi-channel presence

A team's members live in email, chat, on their phones, and increasingly inside a frontier assistant they already pay for, Claude, Copilot, Gemini, ChatGPT, not in one terminal. A team agent meets them there: the same agent, the same memory, the same capabilities, reachable from the channel the message arrived on, replying on that same channel. The on-call engineer asks from the incident channel; the office question arrives by email and is answered by email; the founder forwards a supplier invoice from a phone and the agent takes it from there; the analyst who lives in ChatGPT reaches the same capabilities through a connector, from the subscription they already have, with no new app to adopt.

Personal harnesses treat channels as exotic integrations because the agent is welded to its owner's machine. In a team harness, channels are thin entry points to centrally deployed infrastructure, which is what makes "ask the agent from anywhere" boring to implement instead of a roadmap item.

## The three platform rules around them

The primitives describe what the agent can do. Three rules keep the result governable:

**One capability, one policy, many consumers.** Every capability exists once, with an access policy, and the same one is called by a person running it directly, by a server-side automation on a schedule, by an agent mid-task, and by a frontier assistant over a connector. Nothing here has to be an agent, or automated at all: a human clicking a capability and an agent chaining ten of them are just two consumers of the same governed thing. Different agents see different subsets; automations see what their job needs; humans see what their role allows. Default deny. This is what stops "the agent can do X" from quietly meaning "everyone who can reach the agent can do X", and it has to live in the capability layer, not in each agent's prompt.

**Agents are one execution mode, not the platform.** Most of a team's automation should stay deterministic: scheduled jobs, event-driven flows, data pipelines, calling the very same capabilities an agent or a person would. They are cheaper, faster, and more reliable than a model in a loop. Agents earn their place where judgement, natural language, or cross-channel conversation is genuinely required. A harness that makes everything an agent is paying token prices for cron's job.

**Capabilities grow from real demand.** Speculative capability building is how agent projects die. The growth loop is primitive 3: real task, real gap, real ticket, reviewed build. Capabilities arrive with their justification attached, and the portfolio stays shaped by what the team actually needed rather than what looked plausible in a planning session.

## Why this is not "a better chatbot"

Notice what the four primitives have in common: none of them is about intelligence. Delegation, memory write-back, gap tickets, and channel presence are all *plumbing with policy*. That is the thesis of this whole series, applied one layer up: the model provides judgement; the harness provides the structure that makes the judgement safe to act on and the lessons durable. And there is one thing a better model will never provide: accountability. A model cannot answer for a wrong call, so you take the accountability yourself and give the system only the access it needs. A smarter model dropped into a single-player harness is still single-player. A modest model inside this architecture compounds, because every answered question, every filed gap, and every granted capability makes the next task easier for everyone.

## Where to start

None of this needs a big-bang build, and the order is the whole trick. Stand up shared memory and the gap logger first, so every answered question and every blocked task starts accumulating from day one. Add read-only capabilities next, the lookups your team already runs by hand, and let the filed gaps rank what to build after that. Delegation and multi-channel presence layer on once there is something worth reaching from more than one place.

Build memory before capabilities and the agent compounds; build capabilities before governance and you have forty personal setups with extra steps. We run the harness described here for our own back office, and this is the order it grew in: the primitives first, the model last, because the model was never the part that needed building.
