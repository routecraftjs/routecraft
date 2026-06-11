---
title: Which capabilities should your organization build first?
description: Every team that decides to give agents real tools faces the same empty backlog. Six filters for choosing capabilities that compound instead of demo, a trust pyramid for sequencing them, and the two meta-capabilities that make the backlog start writing itself.
date: 2026-06-10
author: Jaco Botha
authorRole: Founder, DevOptix
version: '0.6.0+'
draft: false
tags:
  - ai-agents
  - capabilities
  - automation
  - strategy
layout: blog-post
---

At some point a team decides the agent experiments are over and it is time to build real capabilities: deployed, governed tools that humans and agents share (the argument for that model is [its own post](/blog/ai-agents-are-still-single-player)). Then comes the empty backlog, and with it the default failure mode: building whatever demos best. A chatbot over the wiki. An agent that writes Jira tickets. Something impressive on a Friday and unused by March.

Capability selection is a portfolio decision, and it deserves actual filters. Here are the six I use, followed by how to sequence what passes them.

## The six filters

**1. Read-only first.** Your first capabilities should not write, send, deploy, or delete anything. This is partly risk (a read-only tool cannot be the subject of the postmortem) but mostly *politics in the good sense*: a read-only capability sails through security review, and an early "yes" from security is worth more than any feature. You are not just building tools; you are building the organization's trust in the whole model. Spend that budget carefully.

**2. Frequency times toil.** A task done weekly by thirty people beats a task done quarterly by one, even if the quarterly one is more painful per occurrence. You want capabilities whose usage graph proves the platform's value to whoever funds it. Look at what people actually do every day: look up logs, check why a request failed, find which service owns an endpoint, verify whether data synced.

**3. Fragmented context.** The best capability candidates are tasks that today require six open tabs: the ticket system, the log store, the tracing UI, the API documentation, the repository, a database console. Every tab boundary is friction for a human and a wall for an agent. A capability that collapses one tab boundary is useful; a set that collapses all six is transformative, because now an agent can *chain* them, and chaining is where agents earn their keep.

**4. Dual-use.** Build nothing that only an agent will call, and nothing that only a human will use. The capability that pays for itself serves three consumers with one implementation: the junior who runs it step by step and learns the procedure, the senior who wants one lookup in three seconds, and the agent that chains it with five others. If you cannot name the human who would use it directly, it is probably a feature of some agent rather than a capability, and it will die with that agent.

**5. Deterministic core.** The capability itself should be boring: same input, same output, typed contract, no judgment inside. Fetch the logs. Compare the records. Validate the request against the spec. Judgment (what does this mean, what should we do) stays with the caller, human or model. Capabilities that try to be clever are capabilities you cannot test, and untested tools under an agent are how incidents get *caused* rather than solved.

**6. Access already exists.** Prefer capabilities whose backing systems already have a service-account story, or where one is cheap to create. A capability that requires a six-week data-access negotiation before line one of code is a second-quarter capability, whatever its score on the other filters.

## Sequencing: the trust pyramid

Filters pick the candidates; the pyramid orders them. Climb it in order, and let each layer's track record buy the next one's approval:

1. **Observe.** Read-only lookups: logs, traces, specs, code, record states. Zero blast radius, immediate value, the audit log starts accumulating evidence of safe use.
2. **Advise.** Capabilities that combine observations into an assessment: "the request fails the spec on this field," "the record exists in the primary store but not the cache." Still no side effects, but now visibly *smart*, and this is where agents chaining the observe layer start to shine.
3. **Act with approval.** The first writes, gated by a human sign-off step: draft the reply for review, prepare the fix and wait for a decision. Sensitive judgment stays with a person; the toil does not.
4. **Act.** Bounded autonomous writes, earned last, scoped narrowly, for operations whose worst case the organization has explicitly decided it can absorb.

Most organizations try to enter at layer 3 or 4 because that is where the demos live, then spend a year in review. Entering at layer 1 feels slower, and it is faster in every case I have seen, because the pyramid is really a trust-acquisition schedule wearing an architecture costume.

## A worked example

The pattern in production at a major European bank, the same triage suite introduced in [AI agents are still single-player](/blog/ai-agents-are-still-single-player): incident triage. Score it against the filters. Incidents arrive daily across many teams (frequency times toil: high). Diagnosis today means a ticket system, a log store, a tracing UI, API specs, the repository, and two databases (fragmented context: maximal). Every capability in the suite (ticket context, logs by trace id, trace walking, spec validation, code lookup, datastore sync checks) is a deterministic read (filters 1 and 5: clean pass). Juniors use them to learn triage, seniors to skip tabs, an agent to chain the whole diagnosis (dual-use: the full three consumers). The backing systems all spoke service accounts already (filter 6: pass).

Result: an agent that takes an incident id and comes back with "the caller sends a field the spec renamed, here is the rejecting code" or "the record never reached the cache, it is a sync issue," entirely from layer 1 and 2 capabilities. Nothing in the suite can write, which is exactly why it was allowed to exist, and its usage is the argument for building layer 3.

The general lesson from that example: **diagnostic workflows are the ideal first portfolio** in almost any organization. Support triage, data-quality investigation, release verification, onboarding "how does X work here" archaeology: all read-heavy, all high-frequency, all tab-fragmented, all dual-use.

## The backlog that writes itself

Everything above assumes a human curates the list, and there is a move that makes the curation largely unnecessary after the first quarter. It comes from the first two capabilities I built on our own internal agent platform, and neither of them does any business work at all.

**A shared memory.** When a human answers an agent's question, the answer is kept. When a task surfaces a fact about how your organization actually works, the fact is kept. Without this, the platform asks the same questions forever and every lesson dies with the session; with it, every answered question is answered for the last time. Memory is also the capability that most obviously must be *shared* infrastructure rather than personal: what one person's agent learns, everyone's agent knows ([the single-player problem](/blog/ai-agents-are-still-single-player), applied to knowledge).

**A gap logger.** A capability the agent calls when it cannot proceed: it files a task in whatever tracker you already use, recording what it was trying to accomplish, which capability it was missing, why it believes that capability would have changed the outcome, and what it would have concluded with it. The crucial property is *when* this happens: at the exact moment of failure, with the full context loaded, which is precisely the moment a human would write the vaguest possible ticket ("we should probably have DB access?") if they wrote one at all.

Watch what this does to the selection problem. In the triage example: the agent walks the trace, suspects a data-sync issue, and discovers it has no capability to read the relevant table. It logs the gap: "Incident 4711: I could have confirmed or excluded a sync failure between the primary store and the cache if I could read table X; without it, diagnosis stops at a hypothesis." Three incidents later the same gap has three tickets referencing real cases. Your backlog is no longer a brainstorm; it is an evidence-ranked queue where every candidate arrives with the requests that exposed it, the reasoning, and a recurrence count. The six filters stop being a generation tool and become a review step.

And the loop closes tighter than you might expect: the gap ticket is detailed enough to be a *spec*, so the capability itself is usually drafted by an agent. Routecraft ships agent-readable authoring skills for exactly this; in practice I rarely write capabilities by hand anymore. The agent identifies the gap, the agent drafts the capability from the ticket, and the humans do the two things that must stay human: review the code, and grant (or refuse) the access. The trust pyramid still gates what the new capability may touch.

One boundary to keep crisp, because it is the difference between a self-improving platform and a self-escalating one: **the gap logger requests capabilities; it never grants them.** It writes tickets. Approval, access policy, and code review remain with people, which is the same principle that governs everything else here: agents propose, principals decide.

## Anti-patterns, briefly

- **The chatbot first.** A conversational interface over documents exercises none of the muscles (identity, deployment, authorization, audit) you actually need to build, and its novelty curve does your platform's reputation no favors.
- **The write-access flagship.** Starting with "the agent files the change request" maximizes review friction at the moment you have zero track record.
- **The biggest problem first.** Your hardest workflow has the most stakeholders, the messiest systems, and the least tolerance for iteration. Build your tenth capability there, not your first.
- **The agent-only tool.** If no human would call it, you will not find out it is broken until the agent does something strange with it.

## A first quarter that works

Weeks 1 to 2: pick one diagnostic workflow with the filters above, list the six lookups it needs. Weeks 3 to 6: ship them as deployed, SSO-fronted, read-only capabilities with one scoped service account each ([what that layer is, and why a skills repo is not it](/blog/beyond-the-skills-repository)), plus the gap logger and the shared memory alongside them. Weeks 7 to 10: give them to one team, in chat and in the IDE, plus an agent definition that chains them. Weeks 11 to 13: review the audit log with security, present the usage graph, and let those two artifacts, together with the gap queue the agent has been filing, pick the next quarter's portfolio.

That is the whole method: filter for compounding, sequence for trust, prove with the log. I build [Routecraft](/docs/introduction), a TypeScript framework for this capability layer, so calibrate for bias; the filters work whatever you build on.
