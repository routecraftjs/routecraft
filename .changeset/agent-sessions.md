---
"@routecraft/ai": minor
"@routecraft/routecraft": minor
---

Named agent sessions with a durable transcript, an inbox, and interrupt (#716).

**`agent(name, { session })`**, and `session` on the inline form, make an agent remember: every message for one session id continues one transcript, kept in the context's suspension store under `(agent, session)` and loaded, appended and stored back per turn. Absent `session`, nothing changes. The model is told its own session id in a `## Session` system block.

**One turn at a time per session.** A message that arrives while a turn is running goes to the session's durable inbox; its caller is acknowledged with `AgentResult.session.status === "queued"` and the queued messages become the next turn's first user message, in order, as one message with the parts in order. That turn starts on its own at the boundary, and runs on the route: a turn that ends with work outstanding stores its exchange's continuation at the agent step (body and headers, as a `.suspend()` park stores them), and the boundary turn is that continuation revived in process, so the route's steps after the agent run on the boundary turn's reply. **`interrupt: true`**, on either form, cancels the running turn through the existing cancellation path, keeps its partial transcript (including the tool call that was in flight), and starts a turn with what queued plus the interrupting message. A turn a restart cut short is treated the same way at the next turn. The stored record carries a shape version, so a record another release wrote fails as `AI1010` naming the store rather than as a provider refusal one turn later.

**`AgentResult.session`** carries `{ agent, id, status, queued }`. **`FnHandlerContext.session`** hands a tool the session it runs in. A turn runs under the principal of the exchange it runs on; every inbox item records its poster's subject and the delivered message renders it per part as quoted data, and the record keeps the subject that started the session (`startedBy` on the management API). Who may post is the route's `.authorize()`.

**Contributed management resources.** Core's ops plugin gains `registerOpsResource(ctx, { name, description, list, describe })`: a read-only resource another package contributes, served under the introspection tier at `GET /ops/{name}` and `GET /ops/{name}/{segment...}`, with `parsePageQuery`, `takePage` and `decodeCursor` exported so a contributor pages on the route listing's cursor contract; a throw from a contributor is a 500 carrying its code, and `RC5059` a 400. `@routecraft/ai` registers **`agent-sessions`**, which lists every session with its turn state, inbox depth and background calls in flight, filtered by `agent` and paged by `limit` and `after`.

New events: `route:agent:session:queued`, `:interrupted`, `:restored`, `:parked`, `:revived`. New error code `AI1010`. Core exports `parkAside` and `reviveSuspension` as internals for a tier that stores a continuation beside a completing run and revives it itself. The internal one-run module of the agent tier is renamed from `session.ts` to `run.ts` (`AgentCancellationCause` stays exported).
