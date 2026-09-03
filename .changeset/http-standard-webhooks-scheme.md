---
"@routecraft/routecraft": minor
---

`http({ signature })` verifies the Standard Webhooks scheme (#698).

Deliveries signed per [the specification](https://www.standardwebhooks.com/), which Resend, Bird and Svix among others send, now verify declaratively instead of forcing `rawBody: true` and a hand-rolled HMAC in a route step.

```ts
.from(http({
  path: '/hooks/bird',
  method: 'POST',
  signature: {
    scheme: 'standard-webhooks',
    secret: process.env.BIRD_WEBHOOK_SECRET!,
  },
}))
```

The scheme reads the three headers the specification fixes (`webhook-id`, `webhook-timestamp`, `webhook-signature`), signs `<id>.<timestamp>.<raw body>` with the base64-decoded secret, and admits when any space-separated `v1,` entry matches under the existing constant-time comparison, which is what key rotation looks like on the wire. `toleranceSec` bounds replay exactly as it does for Stripe, defaulting to 300 seconds. Verification is checked against the published vector from the specification's own reference implementation, not one this repo invented.

**This scheme takes no `header`.** The specification fixes all three names it reads, so there is nothing to configure but the secret, and renaming only the signature header would have built a route that constructs cleanly and then rejects every delivery. `header` stays required for the other three schemes, and the options type is now a discriminated union on `scheme`, so passing a header here, or omitting one there, is a compile error as well as a construction-time `RC5003`.

**A malformed secret fails at the `http({...})` call site**, not on the first delivery, where it would have looked like the sender's fault. The `whsec_` prefix and base64 padding are both optional, matching the reference implementation. The refusal names the field and the expected shape, never the value, since error causes reach logs.

This covers the symmetric half of the specification. Asymmetric signatures (`v1a`, ed25519) are not verified, and such an entry is skipped like any other unsupported version. Svix's own default headers are `svix-` prefixed rather than `webhook-`, so a delivery from a sender that has not white-labelled them needs the manual escape hatch; the reference page says so.

Redeliveries inside the freshness window are the route's to deduplicate, through the specification's `webhook-id`; the gate does not track delivery ids. A passing signature authenticates the sending system and mints no principal. Both are now written down in `.standards/security.md` beside the defaults themselves.

The three shipped schemes behave exactly as before. Internally, `verifyWebhookSignature` takes the request's header set rather than one pre-read value and dispatches on the scheme before reading anything, because a scheme decides for itself which headers it needs; the replay bound is shared with `"stripe-timestamped"` rather than copied.
