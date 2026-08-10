---
"@routecraft/routecraft": minor
"@routecraft/ai": minor
---

**Behaviour change.** An MCP tool whose route drops the exchange now returns an error result instead of the caller's own request (#214).

A dropped exchange (a `.filter()` rejecting, a `.choice()` matching no branch, `onParseError: "drop"`, an error handler returning `recovery.drop()`) resolves with the body it came in with. The MCP server was publishing that as the tool's result, `structuredContent` included, so a client received its own arguments back and could not tell them from an answer the tool had computed. `CraftClient.sendDirect` and the route-scope `forward` have always raised `RC5031` for exactly this case; MCP was the one request/reply surface still echoing.

Such a call now comes back as `isError: true` with a message saying the tool declined the request, under the new error code `AI2002`, and never carries the request body back. This applies to every MCP tool, whether or not its route declares `.output()`, because an echoed request is not a result under any schema.

If a route reaches a drop on a path where the caller should receive a value, give it a branch that produces one (an empty list, an explicit not-found shape) or recover with a body in `.error()`. A drop that is genuinely the right answer now says so honestly instead of fabricating a result.

Core exports `isDropped(exchange)` so request/reply source adapters outside core can tell "the route declined" apart from "the route produced this", which is not otherwise reachable: the flag lives on the exchange's internals.
