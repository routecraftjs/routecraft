---
"@routecraft/routecraft": minor
---

Delegation-aware `Principal` and `authorize()`: distinguish a user acting directly, an agent (or any party) acting on a user's behalf, and an agent acting under its own authority.

`Principal` gains `actor` (RFC 8693 `act`, nested, outermost-only policy input), `subjectProfile` (`user` / `service` / `ai_agent`), `mayAct` (RFC 8693 `may_act`, enforced in-process), and `grantId`. A new `delegate()` helper and `.delegate()` operation mint delegated principals: subject and roles pass through, scopes become `intersect(subject, consent ceiling)`, chains nest, expiry takes the minimum, and authenticity covers the whole chain. `authorize()` gains `subject`, `actor`, and `maxDelegationDepth` matchers; `jwt()`/`jwks()` parse `act` / `may_act` / `sub_profile` and gain a `ClaimMappers.roles` mapper, failing closed on unparseable delegation claims. New error codes RC5034-RC5038.

BREAKING: `authorize()` defaults to `actor: 'none'`, so principals carrying an actor (minted by `delegate()` or parsed from a token's `act` claim, including Clerk impersonation sessions) are rejected until a route declares its permitted actors. `.delegate()` fails closed when the resolver returns `undefined`: the subject's direct principal is stripped by default (the exchange continues anonymous) instead of passing through with full authority; pass `{ otherwise: 'keep' }` for continuations that serve the caller directly. The strip skips anonymous exchanges, delegated principals, and `ai_agent` subjects. A missing scope now raises RC5038 (recoverable, with `missing.scopes` on the cause) instead of RC5015; role and predicate failures keep RC5015. See the 0.5-to-0.6 migration guide.
