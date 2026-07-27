---
title: A skills repository is not an automation platform
description: Every large organisation is building a central repo of AI skills, prompts, and agent definitions right now. It is the right first step, and it has a ceiling nobody talks about. Skills describe how. They cannot do. A maturity ladder for what comes next.
date: 2026-07-23
author: Jaco Botha
authorRole: Founder, DevOptix
draft: false
tags:
  - ai-agents
  - skills
  - platform-engineering
  - mcp
diagram: maturity-ladder
layout: blog-post
---

Somewhere in your organisation, probably under a catchy internal codename, a team is building a central repository of AI skills: markdown files that teach an LLM your coding standards, your review checklist, your runbooks, your standard operating procedures. Agent definitions next to them. A contribution guide. Maybe a little CLI to install them.

This is a good thing. Sincerely. A shared skills repo beats forty private prompt collections the same way a shared style guide beats forty opinions, and the teams building these repos are usually the first in the building to think seriously about agents at all.

But after the first wave of contributions, the same pattern emerges everywhere: the repo fills up with skills that are *advice*. "Code should look like this." "When you do a code review, check these things." "When the customer orders X, follow these steps." Useful, and weirdly superficial, and the reason is structural, not a lack of effort.

**Skills describe how. They cannot do.** A skill can tell an agent the eight steps of your incident runbook; it cannot fetch the logs. So step three quietly becomes "now run this command yourself", and execution falls back to whoever is at the keyboard. That already assumes they have the tool at all: plenty of people have no CLI for the logs on their machine, and plenty of those who do are holding one over-scoped credential that reads logs and deploys to production with the same key. Either way the repo has centralised the *knowledge* and left the *capability* exactly where it was: scattered, personal, unreviewed, and often far more powerful than the task in front of it needs.

That is the ceiling. You cannot write your way through it with better markdown.

## The ladder

It helps to see the skills repo as one stage in a progression rather than a destination.

If you have read Dan Shapiro's [five levels of AI-assisted software development](https://www.danshapiro.com/blog/2026/01/the-five-levels-from-spicy-autocomplete-to-the-software-factory/), from spicy autocomplete up to the fully autonomous "dark factory", this is a different ladder, and the difference is the point. His levels measure how much of the *coding* a developer hands to the model. These measure how much of your *execution* the organisation actually governs. The two are orthogonal: a team can reach his Level 4, shipping features from specs, and still sit on stage 2 here, because writing code well and running operations safely are separate problems. For a software engineering team the dark factory is a fair place to be heading; for the rest of the organisation, finance, operations, support, the destination is not a factory that writes software. It is a governed capability layer that any person, and any agent, can safely call.

{% diagram id="maturity-ladder" /%}

**Stage 1: the prompt library.** Shared snippets in a wiki. Knowledge centralised, nothing executable, no contract for contributions.

**Stage 2: the skills and agents repo.** Structured, versioned, installable instructions; agent definitions with personas and procedures. This is where most organisations are today. Execution is still local and personal: the code has to be on your machine, the CLI has to be installed, the access is yours.

**Stage 3: local tools.** Skills get hands: MCP servers running on each developer's laptop, so the agent can actually fetch the logs instead of asking you to. A real step up, with the same multiplication problem as stage 2: per-laptop setup, per-person credentials, and nothing for anyone who lives in chat instead of a terminal. The security model is still "whatever the person running it can do", which is precisely the model that does not survive a review (the [single-player problem](/blog/ai-agents-are-still-single-player), at the tool level).

**Stage 4: deployed capabilities.** The tools stop living on laptops and become infrastructure. Each capability (fetch logs by trace id, validate a request against the API spec, check a record across data stores) is deployed centrally with an identity model: the organisation's SSO in front, so every call belongs to an authenticated person; platform-owned service accounts behind, scoped to what each capability needs; authorisation rules deciding per principal who may do what. Because the capability is a service, the surface stops mattering: the same operation works from an IDE, from a chat message in Teams, from a phone during an on-call weekend, and from an agent chaining it with others. No local code, no local CLI, no personal tokens.

**Stage 5: organisational agents.** With governed capabilities in place, agents stop being personal conveniences and become shared workers: a triage agent anyone can invoke, drawing on team memory, leaving an audit trail of which capabilities it called on whose behalf. The skills from stage 2 come back here, and now they have depth, because "follow the runbook" is backed by tools that execute each step.

## The jump that matters is stage 2 to stage 4

**The gap between a skills repo and an automation platform is not an AI problem. It is an identity and deployment problem.**

Nothing about stage 4 requires smarter models. It requires the unglamorous things platform teams already know how to want: single sign-on, service accounts, per-principal authorisation, audit logs, a deployment pipeline. The reason this layer is missing from most AI initiatives is that it does not demo as well as a talking agent, not that it is mysterious. And the organisations best equipped for it, the banks and insurers with strong identity discipline, are oddly the ones most likely to assume they must wait. They are not waiting on technology. The pieces exist today.

What stage 4 buys, concretely:

- A skill that says "check whether the record synced" links to a capability that *checks*, for everyone, from anywhere, under their own permissions.
- The best version of each tool exists once, reviewed and typed, instead of forty times in forty dotfiles.
- Security reviews one capability with one scoped service account, not one engineer's personal token sprawl.
- The person on the incident call types one message in the channel instead of asking "who has the Grafana access and a working local setup?"

The read-only incident-triage suite from [AI agents are still single-player](/blog/ai-agents-are-still-single-player) is stage 4 in the wild: one set of capabilities used at the same time by juniors learning the runbook, seniors skipping six browser tabs, and an agent that chains the lot. The skills repo explains triage; the capabilities perform it; the same access rules govern both.

## How to climb without a big-bang programme

The good news for whoever owns the skills repo: nothing is wasted. Skills remain the knowledge layer at every stage; they just gain hands. The climb can be incremental and honestly quite cheap:

1. Pick one runbook whose steps are all reads (triage and diagnostics are ideal; how to choose is its own post, coming next in this series).
2. Turn its manual steps into deployed capabilities behind your SSO, with one scoped service account each.
3. Point the existing skill at them, so the instructions and the execution finally meet.
4. Let one team use it from chat for a month, then read the audit log together with security. That log is the artefact that unlocks every conversation after it.

Markdown that explains the procedure, plus infrastructure that performs it, governed by the identity layer you already trust. That is the whole platform. The repo you have is the right first stage; the mistake would be mistaking it for the whole climb.
