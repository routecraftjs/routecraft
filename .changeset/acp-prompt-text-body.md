---
"@routecraft/ai": minor
---

An editor prompt reaches the agent as its text. The ACP mount sent each turn into the agent's route as a `{ session, message }` body, so an agent with no `user` of its own, which is every agent loaded from `agents/*.md`, handed the model that envelope serialised as JSON, conversation id included, instead of what the person typed. The turn's body is now the prompt text, and the conversation is read off the editor surface the turn already carries (`AGENT_SURFACE_HEADER`), which a parked continuation stores with it. An agent whose own `user` read `ex.body.message` on the ACP route reads `ex.body` instead; a revived turn takes its message from the session inbox and no longer runs that resolver on the parked body. Conversations recorded before this change keep their earlier prompts as they were stored, so loading one replays those as the envelope.
