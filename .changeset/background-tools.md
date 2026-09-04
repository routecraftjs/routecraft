---
"@routecraft/ai": minor
---

Background tools (#717): `directTool(routeId, { background: true })` returns `{ handle, status: "running" }` to the model at once and posts the route's result, or its failure, to the calling agent session's inbox when the route finishes, attributed to the handle. A property of how the agent awaits the route, not of the route, which stays an ordinary `direct()` route. Refused with `RC5003` on an agent dispatched without `session`. The handle rides the dispatched exchange as the `routecraft.agent.background.handle` header (`AgentHeadersKeys`). New events `route:agent:session:background:started`, `:completed`, `:failed`.
