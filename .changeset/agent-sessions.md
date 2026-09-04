---
"@routecraft/ai": minor
"@routecraft/routecraft": minor
---

Named agent sessions with a durable transcript, an inbox, and interrupt (#716).

**`agent(name, { session })`**, and `session` on the inline form, make an agent remember: every message for one session id continues one transcript, kept in the context's suspension store under `(agent, session)` and loaded, appended and stored back per turn. Absent `session`, nothing changes. The model is told its own session id in a `## Session` system block.

**One turn at a time per session.** A message that arrives while a turn is running goes to the session's durable inbox; its caller is acknowledged with `AgentResult.session.status === "queued"` and the queued messages become the next turn's first user message, in order, as one message with the parts in order. That turn starts on its own at the boundary. **`interrupt: true`** cancels the running turn through the existing cancellation path, keeps its partial transcript (including the tool call that was in flight), and starts a turn with what queued plus the interrupting message. A turn a restart cut short is treated the same way at the next turn.

**`AgentResult.session`** carries `{ agent, id, status, queued }`. **`FnHandlerContext.session`** hands a tool the session it runs in.

**Contributed management resources.** Core's ops plugin gains `registerOpsResource(ctx, { name, description, list, describe })`: a read-only resource another package contributes, served under the introspection tier at `GET /ops/{name}` and `GET /ops/{name}/{segment...}`. `@routecraft/ai` registers **`agent-sessions`**, which lists every session with its turn state, inbox depth and background calls in flight.

New events: `route:agent:session:queued`, `:interrupted`, `:restored`. New error code `AI1010`. The internal one-run module of the agent tier is renamed from `session.ts` to `run.ts` (`AgentCancellationCause` stays exported).
