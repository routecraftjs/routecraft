---
"@routecraft/routecraft": major
---

Fold `.input()` validation into the pre-from filter chain (breaking behaviour change).

Validation now runs at chain position #4 for every source shape: inside the synthetic parse step when the source attaches a parser, and as a standalone synthetic `input` step when it does not. Previously, parser-less sources validated eagerly in the consumer handler, so an `RC5002` bypassed the route-scope `.error()` handler entirely and surfaced as `route:exchange:dropped`. Now `.error()` can observe and recover an input failure exactly like an `authorize` or `parse` rejection, and an unrecovered failure takes the normal error path: `route:step:failed` (operation `"input"`), `route:error`, `context:error`, `route:exchange:failed`, while still rejecting the sender. Migrate observers accordingly: validation failures no longer emit `route:exchange:dropped`, and a cross-route failure (producer `.to(direct(...))` into a validating consumer) now fires `context:error` on both routes, the same accounting as any other consumer-route failure.
