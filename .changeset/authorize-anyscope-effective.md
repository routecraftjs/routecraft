---
"@routecraft/routecraft": minor
---

`authorize()` gains `anyScope` and `effective` (#680).

Two gaps that both forced routes down to `predicate`, where a refusal costs the recoverable error shape: a failing predicate throws `RC5015`, which carries no `missing.scopes`, so exactly the routes that most need to name what would have worked lose the ability to.

**`anyScope` is the OR.** `scopes` requires every entry; `anyScope` admits a principal holding any ONE of them, for a scope family whose variants are interchangeable at the door (`leave:read`, `leave:read:self`, `leave:read:base`) and narrow further down the pipeline. A refusal throws `RC5038` naming the whole accepted set rather than one entry, because any of them would have opened the door and a consent flow should be able to offer the caller the choice. Given both, `scopes` and `anyScope` compose as an AND of the two conditions. An empty array is refused with `RC2001` when the validator is built: unlike `scopes: []`, which is a requirement of nothing and vacuously satisfied, an accepted set naming nobody admits nobody, and one computed empty (a tenant lookup that missed, an unset environment variable) would otherwise remove a route's only scope gate in silence.

The cause carries `missing.mode` alongside `missing.scopes`: `"all"` when every listed scope was required and absent, `"any"` when the list is the whole accepted set and one entry suffices. Without it a consent flow acting on the documented contract would request every member of an interchangeable family and grant a wider ring than the route ever asked for. The field is optional on `InsufficientAuthority`, so an application that throws that shape itself keeps compiling.

**`effective` reads the actor's scopes too.** `effective: true` satisfies `scopes` and `anyScope` from the subject's ring plus the OUTERMOST actor's, which is how an agent exercises its own standing authority on a caller's behalf: an agent legitimately holds scopes nobody who asks it for something holds, and without this it can never act on anyone's behalf under its own grant.

Three bounds on that flag, each deliberate:

- **The outermost actor only, never the chain.** Prior actors stay audit data (RFC 8693 section 4.1), the rule `actor` already follows. Walking the chain would undo the intersection `delegate()` applies at every hop and let authority accumulate with delegation depth, and accumulating authority fails open where missing authority fails closed. A route raising `maxDelegationDepth` gets deeper delegation but no deeper scope reading.
- **Never applies to `roles`.** A role is what the principal IS; scopes are what a keyring CARRIES, and only keyrings are inheritable.
- **A documented no-op under the default `actor: 'none'`**, which admits no actor for the flag to read. It reads `actor.scopes`, so the actor has to carry some: an actor minted by `delegate()` does, one parsed from a token's RFC 8693 `act` claim does not, since that claim has no scope member. Map your IdP's own shape with `ClaimMappers.actor` for token-borne delegation.

Widening a check this way ADDS the agent's standing scopes to the subject's rather than capping the caller by them: the check reads the union, and `delegate()` does not intersect delegated scopes with the actor's own either. What an agent's grant bounds is the additional authority a caller gains by going through it, which is the control this moves and why the flag is opt-in per route rather than a context-wide default.

Existing routes are unaffected: `effective` defaults to `false`, `anyScope` defaults to absent, and the shared `missingScopes` helper the scope-gated ops tiers depend on keeps its AND semantics over the subject's own ring.
