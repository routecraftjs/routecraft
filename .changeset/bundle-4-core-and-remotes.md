---
"@routecraft/routecraft": minor
"@routecraft/cli": minor
---

A capability now lives exactly as long as the route that answers it. The direct source registered one when its route subscribed and nothing removed it at stop, so a stopped route stayed on the agent tool surface, was reported `dispatchable` by the ops listing, and failed `RC5004` on the dispatch that followed. Registration returns an identity-bound disposer, so a remote route that has taken a shadowed endpoint is never erased by the local route's late cleanup, and a subscription that is already aborted registers nothing. A dispatch to a stopped or disabled route is refused naming that state rather than advising a `.from(direct())` it already has.

A dispatch to another instance can no longer be re-sent by the runtime underneath the client. Below Bun 1.3.14, `fetch` re-sends a request on a fresh connection when a reused keep-alive socket closes before any response byte arrives, and `POST /ops/routes/{id}/exchanges` is not idempotent, so a dispatch whose connection dropped mid-flight ran the route twice while the caller saw one attempt and one failure. Non-idempotent calls now take a connection of their own, and only where the runtime behaves that way: reads keep the pool, and Bun 1.3.14 and later and Node on every version pay nothing.

`GET /ops/deferrals` reports what an instance is waiting on, with `craft ops deferrals` reading the same thing from a terminal. One row per deferral: the route, the state, what it waits for, whether a delivery claim is outstanding, when it was deferred and when it comes due, and the outcome of a settled one. Never the resume token and never the stored exchange. Waiting by default, filterable by `state` and `route`, and paged oldest first.

**Breaking:** `DeferralStore` gains a required `list()` member. Both shipped backends implement it and satisfy one contract suite; a store of your own stops compiling until it does, and a store that reaches a running instance without it is refused with `RC5065` naming the member rather than answering an empty page.
