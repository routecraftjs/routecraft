---
"@routecraft/ai": patch
---

A message sent to an agent from the editor while a turn is running is answered under that message (#750).

A prompt that arrived mid-turn was queued and its request returned `end_turn` at once with nothing under it; the reply came later on a turn belonging to a different request, so the editor showed every answer one message behind, and after the first queued message nothing arrived until another was sent. Now the request for a queued message stays open until the turn that consumes it has streamed its reply, then returns `end_turn`. Several messages sent while the agent is busy are consumed by one turn, answered in one reply, and every one of their requests returns after it, in the order they were sent. A prompt returns `end_turn` only for a reply; one this instance cannot answer (queued during shutdown, or consumed by another instance sharing the store) returns `cancelled` rather than reporting a turn that showed nothing. `session/cancel` still interrupts the running turn alone, and a message sent while it ran is answered by the next turn.

Underneath: a turn's tool-call events (`route:agent:tool:invoked`, `:result`, `:error`, `:refused`) now name the conversation as `session` when the agent was dispatched with one, and a session turn with a delta listener hands the listener its whole reply before the turn ends, so a provider that does not stream still reaches the listener rather than only the result.
