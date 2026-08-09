---
"@routecraft/routecraft": minor
---

`jwt()` and `jwks()` now surface their configured `clockToleranceSec` on the returned options, alongside the `issuer` they already surfaced.

A consumer that re-checks a verified principal's `expiresAt` needs to know the skew the verifier allowed. Without it, a token accepted by `jwks({ clockToleranceSec: 30 })` whose `exp` is 10 seconds in the past would be refused by the very layer meant to catch validators that ignore expiry. The field is left absent when the option was not configured, so a consumer can distinguish "not configured" from an explicit zero.
