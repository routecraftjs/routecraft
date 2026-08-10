---
"@routecraft/routecraft": minor
---

`jwt()` and `jwks()` now surface their configured `clockToleranceSec` on the returned options, alongside the `issuer` they already surfaced.

A consumer that re-checks a verified principal's `expiresAt` needs to know the skew the verifier allowed. Without it, a token accepted by `jwks({ clockToleranceSec: 30 })` whose `exp` is 10 seconds in the past would be refused by the very layer meant to catch validators that ignore expiry. The field is left absent when the option was not configured, so a consumer can distinguish "not configured" from an explicit zero.

`authorize()` now floors its expiry comparison to whole seconds, matching `jwt()` and jose. Its unfloored comparison put the boundary up to a second ahead of the verifier's, so a token verified in the same second it expired could be rejected a few milliseconds later.

`jwt()`, `authorize()` and the MCP expiry gate now treat the expiry boundary as inclusive: a token whose `exp` equals the current second is expired. This matches `jose` (`exp <= now - tolerance`), which `jwks()` already went through, and RFC 7519 section 4.1.4, which requires the current time to be before `exp`. `jwt()` previously honoured such a token for one further second, so `jwt()` and `jwks()` disagreed by a second at the boundary.
