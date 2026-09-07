---
"@routecraft/ai": patch
---

What an editor answers a `surface()` call with is checked against the protocol before a route sees it (#746).

The editor is outside the trust boundary, and its answers were handed to route code unparsed. Every answer is now validated against the protocol's own generated JSON Schema for the method, which the SDK ships. A malformed `session/request_permission` answer, or a `selected` outcome naming an option the request never offered, reaches the route as the protocol's `cancelled` outcome, so the turn never proceeds as approved; the instance logs a warning naming the issues. A malformed answer to any other method is the new `AI1018`, with the issues on the error's cause, which the route's `.error()` catches. `surface.notify()` is under the same rule in the other direction: an update a route builds that is not a `session/update` the protocol defines is the new `AI1019` and is never sent. Validation is on for every method and has no option. `zod` is now a runtime dependency of `@routecraft/ai`.
