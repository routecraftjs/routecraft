---
"@routecraft/routecraft": minor
"@routecraft/ai": minor
---

`forward()` now carries the caller's identity and trace (#567).

`Route.buildForward()` built the forwarded exchange with no headers, so a forwarded call arrived anonymous and separately traced. A target declaring `.authorize()` refused it with `RC5012`; a target without one ran with no authority at all. The forwarded call also got a fresh correlation id, breaking the audit chain at the forward boundary.

This affected every caller of `forward()`: route-scope and step-scope `.error()` handlers, `circuitBreaker` fallbacks, and `BlockClient.forward` in `@routecraft/ai`, which is the documented way to back an agent block with a route. A memory or knowledge block resolved that way was either refused by its target or served identically to every caller regardless of who asked.

A `direct()` destination never had the bug because it hands the target its live exchange, headers and all. Forward builds a fresh envelope, so it has to pass the caller's headers explicitly. It now does, which brings the two in-process paths to parity.

Headers travel by reference rather than as a copy. Both authenticity brands (`markAuthentic`, `markRestored`) are identity-keyed `WeakSet` membership, so any copy silently drops them: a copied restored principal would fail `authorize()` with `RC5023` ("self-asserted") instead of the correct `RC5043` ("restored, not verified live"), and re-branding one to compensate would launder an unverified identity into a trusted one. Propagation is unconditional and cannot escalate: it is the same frozen authority the calling route was already running under.

`Route.getForward()` now takes the calling exchange as a required argument. It is `@internal`, and required rather than optional so a new call site cannot silently reintroduce the anonymous forward.

**Engine-owned headers are re-established at every route ingress.** `buildExchange` is the single ingress constructor, so it now mints a fresh `routecraft.id` rather than letting one be inherited. An inherited exchange id collides in every store keyed by it: telemetry spans (`${exchangeId}:${contextId}`), the `exchanges` and `exchange_snapshots` tables, and suspension ids (`${exchangeId}~${sequence}`). The correlation id, not the exchange id, is what links a hop. This corrects the pre-existing `direct()` behaviour too, where the target route previously ran under the caller's exchange id.

**Split hierarchy no longer crosses a route boundary.** `buildExchange` now drops `routecraft.split_hierarchy` at route ingress. A split group can only join within the executor run that created it, so a hierarchy arriving from another route was unjoinable by construction, and actively harmful: `.aggregate()` looks the trailing group id up in the context-wide split-parent store, so it would find the *caller's* parent exchange and delete that entry on completion, corrupting an aggregation still in flight on the calling route. This also closes the same latent hazard on the pre-existing `direct()` path.

Two consequences worth knowing. A target route with a strict `.input({ headers })` schema now sees the caller's headers and may reject a forward that previously passed. And forwarding a principal whose `expiresAt` has passed now surfaces the expiry error rather than `RC5012`, which is the correct failure but a different one.
