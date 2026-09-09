---
"@routecraft/routecraft": minor
---

Executor integration and the `.defer()` / `.resume()` operations (#550, slice 2 of #417).

The user-visible half of durable defer and resume, built on slice 1's store, records and signed tokens. A capability can now pause mid-pipeline, wait for an answer that arrives out of band, and continue from the same position without re-running earlier steps.

**`.defer({ schema, ttl })`** produces the `defer` outcome #437 reserved. The executor serializes the exchange, computes the continuation hash, writes the deferral, emits `route:exchange:deferred`, and schedules nothing: no worker defers, and the route stays live for every other exchange. `schema` types `ex.deferral.result` for the rest of the branch the way `.input()` types the body, and is optional: a site that declares none types the result as `unknown` and validates nothing.

**Execution one always answers.** A durable defer cannot hold a caller across the days an approval takes, so the run terminates at the defer and returns a `Deferred` value: `202` plus `Retry-After` on `http()` (the status carries the discrimination, so the declared 200 body stays the route's own output), the value itself on `direct()` (narrow it with `isDeferred`), an ack rather than a nack on queue-shaped sources, and a log line on `cron()` / `simple()` / file sources. The route's real output flows to its destinations on execution two.

**`.resume(map?)`** addresses an exchange by signed token, never a route by name, so a mail-born exchange can be continued by an HTTP-born answer with the original source taking no part in execution two. It verifies the token, checks the continuation still matches, validates the answer against the deferring step's live `schema`, wins the `markResumed` compare-and-swap, and re-enters at position N+1 with `ex.deferral.result` / `resumedBy` / `resumedAt` populated. A duplicate answer returns the first one's cached continuation result without re-running anything. The mapping function owns shape; revival owns validation.

**`ex.deferral`** is readable before the defer runs, so a notification step can send a working resume link. A `.tap()` snapshot follows its owner rather than its own fresh id, since "notify, then deferral" is exactly a tap.

**Refusals, at the earliest point each is knowable.** Defer inside `.split()`, a `.multicast()` path or a `.dispatch()` target is refused at build time with the new `RC5051`; under a step-scope wrapper or alongside route-scope `.cache()` with `RC5003`; a context with a deferrable route and no `deferral` config refuses to start with the new `RC5052`; an exchange that cannot be persisted fails at deferral time with `RC5042`, not at resume.

**Revival failures are catchable, not dead ends.** Unknown (`RC5046`), expired (`RC5047`), changed continuation (`RC5048`), rejected answer (`RC5049`) and denied (`RC5050`) all throw in the resume ingress route. The three that leave an approver stranded (`RC5047`, `RC5048`, `RC5050`) additionally re-enter the deferred route's error channel, so a route-scope `.error()` there can notify and re-ask. `RC5049` stays in the ingress: a malformed answer is a per-request input error, the deferral stays resumable, and routing it through the deferred route would let any token holder drive that route's re-ask path with junk.

New events `route:exchange:deferred` / `:resumed` / `:expired` on the fixed registry. New optional `deferral` field on the builder state bag, which threads the `schema` type through the chain: a hand-written state bag such as `RouteBuilder<{ body: X }>` now describes a chain only if it carries that field too.

`SerializedOutcome` gains a `deferred` status, for the two-stage-approval case where the continuation reaches another `.defer()`: recording that as `completed` would publish a false receipt and hand the first approver the second one's resume token.

MCP carriage (`structuredContent` plus the derived `oneOf` output schema) is gated on #214 and is not in this slice.
