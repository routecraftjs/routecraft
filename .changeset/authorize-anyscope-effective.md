---
"@routecraft/routecraft": minor
---

`authorize()` gains `anyScope` and `effective` (#680).

Two gaps that both forced routes down to `predicate`, where a refusal costs the recoverable error shape: a failing predicate throws `RC5015`, which carries no `missing.scopes`, so exactly the routes that most need to name what would have worked lose the ability to.

**`anyScope` is the OR.** `scopes` requires every entry; `anyScope` admits a principal holding any ONE of them, for a scope family whose variants are interchangeable at the door (`leave:read`, `leave:read:self`, `leave:read:base`) and narrow further down the pipeline. A refusal throws `RC5038` naming the whole accepted set rather than one entry, because any of them would have opened the door and a consent flow should be able to offer the caller the choice. Given both, `scopes` and `anyScope` compose as an AND of the two conditions. An empty array is no check, exactly as `scopes: []` is.

**`effective` reads the actor's scopes too.** `effective: true` satisfies `scopes` and `anyScope` from the subject's ring plus the OUTERMOST actor's, which is how an agent exercises its own standing authority on a caller's behalf: an agent legitimately holds scopes nobody who asks it for something holds, and without this it can never act on anyone's behalf under its own grant.

Three bounds on that flag, each deliberate:

- **The outermost actor only, never the chain.** Prior actors stay audit data (RFC 8693 section 4.1), the rule `actor` already follows. Walking the chain would undo the intersection `delegate()` applies at every hop and let authority accumulate with delegation depth, and accumulating authority fails open where missing authority fails closed. A route raising `maxDelegationDepth` gets deeper delegation but no deeper scope reading.
- **Never applies to `roles`.** A role is what the principal IS; scopes are what a keyring CARRIES, and only keyrings are inheritable.
- **A documented no-op under the default `actor: 'none'`**, which admits no actor for the flag to read.

Widening a check this way makes the agent's standing scopes the ceiling of what any caller can reach through that agent. That is the intended consequence and it moves where the control lives, which is why the flag is opt-in per route rather than a context-wide default.

Existing routes are unaffected: `effective` defaults to `false`, `anyScope` defaults to absent, and the shared `missingScopes` helper the scope-gated ops tiers depend on keeps its AND semantics over the subject's own ring.
