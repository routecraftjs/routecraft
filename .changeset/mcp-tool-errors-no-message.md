---
"@routecraft/ai": patch
"@routecraft/routecraft": patch
---

A failed local MCP tool call no longer puts the error message on the wire. It used to answer with the RC message and its cause, which carry whatever the route's steps threw: hostnames, file paths, upstream response text, the route id. Any caller who could make a tool fail could read them. The call now answers `isError: true` with the tool name and the error code, such as `Error: Tool "search" failed (RC5001).`, and the message stays in the log and on the `plugin:mcp:tool:failed` event, as before.

**This changes what agents see on a failed call.** It ships as a patch because it closes an information disclosure, the same rule the `http()` source and the ops dispatch door follow. A failure the caller caused on the tool's own route still answers with something an agent can act on:

- An `.input()` refusal (`RC5065`) lists each issue's path and message, at most 20 with the rest counted, without the RC message that named the route.
- An `.authorize()` refusal of the caller answers with a fixed reason: insufficient permissions (`RC5015`, `RC5034`, `RC5035`, `RC5036`), the missing scopes (`RC5038`), an expired credential (`RC5020`), or, on an HTTP mount with a validator that served the call anonymously, that the tool needs an authenticated caller (`RC5012`).
- A result that breaks the tool's declared `.output()` (`RC5002`, `AI2001`) names the failing fields, as the docs promised, without the route id.

Attribution is by where the failure came from, never by code: an input or authorization refusal raised by a route the tool calls through `direct()`, a check of an identity the pipeline swapped in, and the same codes thrown by an adapter all answer with the generic text. The decline text (`AI2002`) is unchanged.

New exports from `@routecraft/routecraft`, for a door of your own: `callerRefusalOf(err, { routeId, principal, credentialCouldHelp? })` classifies a route failure the caller caused (the classification the `http()` source, the ops dispatch door and the MCP server now share), `wireIssues(issues)` bounds schema issues for the wire, and `isOutputValidationFailure(err.cause)` narrows the cause of an `.output()` RC5002 to its `{ invalidOutput: { in, issues, routeId } }` detail.
