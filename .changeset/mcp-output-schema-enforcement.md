---
"@routecraft/routecraft": minor
"@routecraft/ai": minor
---

Enforce the `outputSchema` an MCP tool advertises (#214).

A route exposed with `.from(mcp())` that declares `.output({ body })` has that schema advertised as the tool's `outputSchema` in `tools/list`, and spec-compliant clients parse the result's `structuredContent` against it. The MCP server now checks the body it is about to publish and refuses one the schema rejects: the call returns `isError: true` carrying the failing fields (new error code `AI2001`) instead of a result that contradicts what the server promised.

The route pipeline already validated the exchanges it completes, and keeps reporting those violations as `RC5002`. What this adds is a check at the surface that made the promise, for results that reached it without passing through that validation: a tool registered directly in `MCP_LOCAL_TOOL_REGISTRY` today, and a suspension once #550 lands.

A body the route already validated is deliberately not re-checked. Output validation replaces the body with the schema's output value, so re-running the schema would reject what it had just produced: a route declaring `.output({ at: z.string().transform((s) => new Date(s)) })` would fail every call with "expected string, received Date". Core records which schema accepted the body and exposes it as `wasOutputValidated(exchange, schema)`, beside `isDropped`, compared by identity so an exchange validated against one contract does not count as validated against another. Any request/reply adapter enforcing the same schema at its own boundary can avoid the same trap.

Tools whose route declares no `.output()` advertise no schema and are unchanged.

The advertised contract now has one owner: `advertisedOutputArms(entry)` is what `tools/list` publishes and what enforcement accepts, so the two cannot drift.

A run that parks at a `.suspend()` answers with the framework's `Suspended` acknowledgment rather than the route's declared output, and the pipeline skips output validation for it. Enforcement accepts it (via `isSuspended`), so a suspending MCP tool answers with its acknowledgment instead of a validation error. Advertising that second arm as `oneOf: [Output, Suspended]` in `tools/list` is still open: it needs a schema for the acknowledgment and a signal that a route can park, neither of which core exposes yet. Until then a strict client that validates `structuredContent` against the advertised schema will reject a suspension response, exactly as it did before this change.

Core also exports `validateAgainst(schema, value)`, the Standard Schema helper the pipeline validates with, typed to the schema's output and returning the raw `issues` alongside the formatted message, for adapter authors who need a validation failure as data to hand back over the wire rather than as a thrown error.
