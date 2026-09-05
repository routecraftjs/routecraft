---
"@routecraft/ai": patch
---

A failed MCP tool call no longer repeats its own message. An ordinary error thrown inside a route reached the client as `Error: X: X`, because the framework wraps it with its message as the RC message and the error itself as the cause, and the cause was appended regardless; a cause is now appended only when it says something the message does not.
