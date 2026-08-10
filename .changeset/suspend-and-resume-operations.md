---
"@routecraft/routecraft": minor
---

Executor integration and the `.suspend()` / `.resume()` operations (#550, slice 2 of #417).

The user-visible half of durable suspend and resume, built on slice 1's store, records and signed tokens. A capability can now pause mid-pipeline, wait for an answer that arrives out of band, and continue from the same position without re-running earlier steps.

**`.suspend({ expect, ttl })`** produces the `suspend` outcome #437 reserved. The executor serializes the exchange, computes the continuation hash, writes the suspension, emits `route:exchange:suspended`, and schedules nothing: no worker parks, and the route stays live for every other exchange. `expect` types `ex.suspension.result` for the rest of the branch the way `.input()` types the body.

**Execution one always answers.** A durable suspend cannot hold a caller across the days an approval takes, so the run terminates at the suspend and returns a `Suspended` value: `202` plus `Retry-After` on `http()` (the status carries the discrimination, so the declared 200 body stays the route's own output), the value itself on `direct()` (narrow it with `isSuspended`), an ack rather than a nack on queue-shaped sources, and a log line on `cron()` / `simple()` / file sources. The route's real output flows to its destinations on execution two.

**`.resume(map?)`** addresses an exchange by signed token, never a route by name, so a mail-born exchange can be continued by an HTTP-born answer with the original source taking no part in execution two. It verifies the token, checks the continuation still matches, validates the answer against the suspending step's live `expect`, wins the `markResumed` compare-and-swap, and re-enters at position N+1 with `ex.suspension.result` / `resumedBy` / `resumedAt` populated. A duplicate answer returns the first one's cached terminal outcome without re-running anything. The mapping function owns shape; revival owns validation.

**`ex.suspension`** is readable before the suspend runs, so a notification step can send a working resume link. A `.tap()` snapshot follows its owner rather than its own fresh id, since "notify, then park" is exactly a tap.

**Refusals, at the earliest point each is knowable.** Suspend inside `.split()`, a `.multicast()` path or a `.dispatch()` target is refused at build time with the new `RC5051`; under a step-scope wrapper or alongside route-scope `.cache()` with `RC5003`; a context with a suspendable route and no `suspension` config refuses to start with the new `RC5052`; an exchange that cannot be persisted fails at park time with `RC5042`, not at resume.

**Revival failures are catchable, not dead ends.** Unknown (`RC5046`), expired (`RC5047`), changed continuation (`RC5048`), rejected answer (`RC5049`) and denied (`RC5050`) throw in the ingress route and additionally re-enter the suspended route's error channel, so a route-scope `.error()` can notify the approver and re-ask rather than stranding them at a dead link.

New events `route:exchange:suspended` / `:resumed` / `:expired` on the fixed registry. New optional `suspension` field on the builder state bag, which threads the `expect` type through the chain: a hand-written state bag such as `RouteBuilder<{ body: X }>` now describes a chain only if it carries that field too.

MCP carriage (`structuredContent` plus the derived `oneOf` output schema) is gated on #214 and is not in this slice.
