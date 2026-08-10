---
"@routecraft/routecraft": minor
"@routecraft/ai": minor
---

Enforce the `outputSchema` an MCP tool advertises (#214).

A route exposed with `.from(mcp())` that declares `.output({ body })` has that schema advertised as the tool's `outputSchema` in `tools/list`, and spec-compliant clients parse the result's `structuredContent` against it. The MCP server now checks the body it is about to publish and refuses one the schema rejects: the call returns `isError: true` carrying the failing fields (new error code `AI2001`) instead of a result that contradicts what the server promised.

The route pipeline already validated the exchanges it completes. What this adds is the guarantee at the surface that made the promise, rather than in a module upstream of it whose coverage the server cannot see. The drop path that motivated this, where the request body resolved untouched and was published as the result, is closed separately by declining dropped calls outright.

The check is a gate rather than a second parse: the validated value is discarded, so a coercing schema cannot apply its coercions twice. Tools whose route declares no `.output()` advertise no schema and are unchanged.

Core exports `validateAgainst(schema, value)`, the Standard Schema helper the pipeline validates with, for adapter authors who need a validation failure as a message to hand back over the wire rather than as a thrown error.

Not included: a route with a reachable durable `.suspend()` will advertise `oneOf: [Output, Suspended]` once #550 lands, and a suspension is then a conforming result rather than a violation. That arm joins the check when the derived union exists.
