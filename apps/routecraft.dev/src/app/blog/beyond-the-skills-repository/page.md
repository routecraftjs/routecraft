---
title: A skills repository is not an automation platform
description: Every large organization is building a central repo of AI skills, prompts, and agent definitions right now. It is the right first step, and it has a ceiling nobody talks about. Skills describe how. They cannot do. A maturity ladder for what comes next.
date: 2026-06-10
author: Jaco Botha
authorRole: Founder, DevOptix
version: '0.6.0+'
draft: false
tags:
  - ai-agents
  - skills
  - platform-engineering
  - mcp
layout: blog-post
---

Somewhere in your organization, probably under a catchy internal codename, a team is building a central repository of AI skills: markdown files that teach an LLM your coding standards, your review checklist, your runbooks, your standard operating procedures. Agent definitions next to them. A contribution guide. Maybe a little CLI to install them.

This is a good thing. Sincerely. A shared skills repo beats forty private prompt collections the same way a shared style guide beats forty opinions, and the teams building these repos are usually the first in the building to think seriously about agents at all.

But after the first wave of contributions, the same pattern emerges everywhere: the repo fills up with skills that are *advice*. "Code should look like this." "When you do a code review, check these things." "When the customer orders X, follow these steps." Useful, and weirdly superficial, and the reason is structural, not a lack of effort.

**Skills describe how. They cannot do.** A skill can tell an agent the eight steps of your incident runbook; it cannot fetch the logs. So step three of every runbook quietly becomes "now run this command yourself," and execution falls back to whoever is at the keyboard, with their laptop, their local CLI, their personal access. The repo centralizes the *knowledge* and leaves the *capability* exactly where it was: scattered, personal, unreviewed.

That is the ceiling. You cannot write your way through it with better markdown.

## The ladder

It helps to see the skills repo as one rung on a ladder rather than a destination:

**Rung 1: the prompt library.** Shared snippets in a wiki. Knowledge centralized, nothing executable, no contract for contributions.

**Rung 2: the skills and agents repo.** Structured, versioned, installable instructions; agent definitions with personas and procedures. This is where most organizations are today. Execution is still local and personal: the code has to be on your machine, the CLI has to be installed, the access is yours.

**Rung 3: local tools.** Skills get hands: MCP servers running on each developer's laptop, so the agent can actually fetch the logs instead of asking you to. A real step up, with the same multiplication problem as rung 2: per-laptop setup, per-person credentials, and nothing for anyone who lives in chat instead of a terminal. The security model is still "whatever the person running it can do," which is precisely the model that does not survive a review (the [single-player problem](/blog/ai-agents-are-still-single-player), at the tool level).

**Rung 4: deployed capabilities.** The tools stop living on laptops and become infrastructure. Each capability (fetch logs by trace id, validate a request against the API spec, check a record across data stores) is deployed centrally with an identity model: the organization's SSO in front, so every call belongs to an authenticated person; platform-owned service accounts behind, scoped to what each capability needs; authorization rules deciding per principal who may do what. Because the capability is a service, the surface stops mattering: the same operation works from an IDE, from a chat message in Teams, from a phone during an on-call weekend, and from an agent chaining it with others. No local code, no local CLI, no personal tokens.

**Rung 5: organizational agents.** With governed capabilities in place, agents stop being personal conveniences and become shared workers: a triage agent anyone can invoke, drawing on team memory, leaving an audit trail of which capabilities it called on whose behalf. The skills from rung 2 come back here, and now they have depth, because "follow the runbook" is backed by tools that execute each step.

## The jump that matters is 2 to 4

Here is the claim I would put on a slide: **the gap between a skills repo and an automation platform is not an AI problem. It is an identity and deployment problem.**

Nothing about rung 4 requires smarter models. It requires the unglamorous things platform teams already know how to want: single sign-on, service accounts, per-principal authorization, audit logs, a deployment pipeline. The reason this layer is missing from most AI initiatives is that it does not demo as well as a talking agent, not that it is mysterious. And the organizations best equipped for it, the banks and insurers with strong identity discipline, are oddly the ones most likely to assume they must wait. They are not waiting on technology. The pieces exist today.

What rung 4 buys, concretely:

- A skill that says "check whether the record synced" links to a capability that *checks*, for everyone, from anywhere, under their own permissions.
- The best version of each tool exists once, reviewed and typed, instead of forty times in forty dotfiles.
- Security reviews one capability with one scoped service account, not one engineer's personal token sprawl.
- The person on the incident call types one message in the channel instead of asking "who has the Grafana access and a working local setup?"

A worked example of what lives on rung 4 is the bank's read-only incident-triage suite described in [AI agents are still single-player](/blog/ai-agents-are-still-single-player), used simultaneously by juniors learning the runbook, seniors skipping six browser tabs, and an agent that chains the lot. The skills repo explains triage; the capabilities perform it; the same access rules govern both.

## How to climb without a big-bang program

The good news for whoever owns the skills repo: nothing is wasted. Skills remain the knowledge layer at every rung; they just gain hands. The climb can be incremental and honestly quite cheap:

1. Pick one runbook whose steps are all reads (triage and diagnostics are ideal; [how to choose is its own post](/blog/which-capabilities-first)).
2. Turn its manual steps into deployed capabilities behind your SSO, with one scoped service account each.
3. Point the existing skill at them, so the instructions and the execution finally meet.
4. Let one team use it from chat for a month, then read the audit log together with security. That log is the artifact that unlocks every conversation after it.

Markdown that explains the procedure, plus infrastructure that performs it, governed by the identity layer you already trust. That is the whole platform. The repo you have is the right first rung; the mistake would be mistaking it for the ladder.

For the architectural argument behind rung 4, see [AI agents are still single-player](/blog/ai-agents-are-still-single-player). I build [Routecraft](/docs/introduction), a TypeScript framework for exactly this capability layer, so weigh the bias; the ladder stands on its own.
