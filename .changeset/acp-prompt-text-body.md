---
"@routecraft/ai": minor
---

An editor prompt reaches the agent as its text. The ACP mount sent each turn into the agent's route as a `{ session, message }` body, so an agent with no `user` of its own, which is every agent loaded from `agents/*.md`, handed the model that envelope serialised as JSON, conversation id included, instead of what the person typed. The turn's body is now the prompt text and the conversation rides the `routecraft.acp.session` header. An agent whose own `user` read `ex.body.message` on the ACP route reads `ex.body` instead; a continuation parked with the old body still resolves its conversation.
