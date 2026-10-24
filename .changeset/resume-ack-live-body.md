---
"@routecraft/routecraft": patch
"@routecraft/ai": patch
---

A resume acknowledgment's `continuation.body` is the terminal body as the deferred route left it: a `Date` is a `Date` and bytes are the `Buffer` or `Uint8Array` they were, on the first acknowledgment and on a duplicate's cached one alike, and an agent's background call settled from a stored outcome at boot reads the same. Until now the acknowledgment carried the store's encoded form, so a `Date` reached the ingress route as the serializer's envelope object, and because the store encodes on write, that already-encoded body was refused as a forged envelope and never cached: a duplicate resume then reported the result as unrecorded. A `DeferralStore` of your own writes `encodeOutcome(continuation)` on `recordContinuation`, now exported for that.
