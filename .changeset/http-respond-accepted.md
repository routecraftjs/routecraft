---
"@routecraft/routecraft": minor
---

`http({ respond: "accepted" })` acknowledges a webhook before the pipeline runs (#710).

An `http()` source answers the caller with the pipeline's result, which is right for an API and wrong for a webhook whose work outlasts the sender's patience. Bird treats anything past a few seconds as a failed delivery and redelivers under the same `webhook-id` for about 27 hours, Stripe and Svix behave the same way, and the Standard Webhooks specification says to acknowledge before processing. Route authors were working around this with two routes and a `direct()` hand-off, which exists only because the framework had no way to answer early.

```ts
.from(http({
  path: '/hooks/bird',
  method: 'POST',
  signature: { scheme: 'standard-webhooks', secret },
  respond: 'accepted',
}))
```

`respond: "result"` is the default and is exactly today's behaviour. `respond: "accepted"` runs every pre-handler gate first (path and method matching, the body size limit, body parsing, signature verification, and the mount's credential check where it has one) and, once they all pass, answers `202` with an empty body and runs the pipeline detached. Rejections are unchanged, so a bad signature is still a 401 and the sender still sees it.

**Failures move to the error channel.** The response is gone by the time the pipeline runs, so a detached failure reaches the route's `.error()` handler and the ordinary error events (`route:error`, `context:error`, `route:exchange:failed`) and nowhere else. Give a route that acknowledges early an `.error()` handler.

**Shutdown still waits.** A detached run is the route's in-flight work from the moment it starts, and the context drains that work before any listener closes, under the same shutdown deadline as everything else. The pipeline is started before the 202 is written, which is what puts it inside that drain.

**Backpressure is the route's, as before.** One detached pipeline per delivery is unbounded by construction; `.throttle()` and `.concurrency()` before `.from()` bound it, with no new mechanism.

**OpenAPI reflects the answer.** A route that acknowledges early advertises `202` in `/openapi.json` instead of `200` and `204`, which it can no longer send, and keeps the rejection codes its gates still produce.

Not included, by design: no retry, replay, or persistence of a detached delivery. One lost to a crash is the sender's redelivery to make, which is what deduplicating on `webhook-id` in the route is for.
