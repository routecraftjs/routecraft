---
title: delegate
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
delegate(resolver: (exchange: Exchange<Current>) => DelegationClaims | undefined | Promise<DelegationClaims | undefined>): RouteBuilder<Current>
```

Mark the exchange's principal as being exercised by an **actor** (an agent, a service) on the subject's behalf. The resolver returns the actor's identity claims plus the consent-derived scope ceiling; they are minted into a delegated principal and attached to `headers["routecraft.auth.principal"]`. Return `undefined` to leave the exchange untouched, so a caller without a consent record simply never delegates. The body is unchanged.

The distinction this operation establishes is the core of the delegation model (RFC 8693): `subject` stays the party the action is taken **on behalf of**, `actor` becomes the party **performing** it. A route can then distinguish the three cases with one [`authorize()`](/docs/reference/operations/authorize) grammar: a person acting directly (no actor), an agent acting for a person (subject person, actor agent), and an agent acting under its own standing authority (subject agent, no actor).

`DelegationClaims`:

| Field | Type | Description |
|-------|------|-------------|
| `actor` | `PrincipalClaims` | Identity of the acting party. Only `subject` is required; give agents a stable `issuer` and `subjectProfile: 'ai_agent'`. |
| `scopes` | `string[]` | Scope ceiling from your consent mechanism (an OAuth grant, a grant store, static config). |
| `grantId` | `string` | Consent record id, carried on the principal for audit and revocation correlation. |

Delegation semantics (also the contract of the underlying `delegate()` helper, importable for tests and custom steps):

| Field | On delegation |
|-------|---------------|
| `subject`, `roles`, `claims`, `email`, `name` | Pass through unchanged. Roles are subject attributes (RFC 9068): they describe who the action is for. |
| `scopes` | `intersect(subject.scopes, ceiling, actor.scopes)`. Scopes are credential capabilities: they narrow at every hop and can never widen. A ceiling over a scope-less subject grants nothing. |
| `actor` | Set to the new actor. A pre-existing actor nests one level down, expressing the chain; the outermost entry is the current actor. |
| `expiresAt` | The earlier of the subject's and the actor's expiry. |
| Authenticity | The result carries a fresh brand. The input must already be authentic. |

Failure modes:

- **Resolver returns a directive but the exchange is anonymous:** [`RC5012`](/docs/reference/errors#rc-5012). Delegation transforms an existing identity; it never creates one.
- **Subject principal is not authentic:** [`RC5023`](/docs/reference/errors#rc-5023). A chain cannot be built on a self-asserted object.
- **Subject's `mayAct` does not permit this actor:** [`RC5037`](/docs/reference/errors#rc-5037). Matching uses the `(issuer, subject)` pair.

```ts
import { agent } from '@routecraft/ai'
import { craft, mail } from '@routecraft/routecraft'

const zoeIdentity = {
  subject: 'agent:zoe',
  subjectProfile: 'ai_agent',
  issuer: 'https://agents.example.com',
  roles: ['agent'],
}

// Identify the person, then delegate to the agent under a consent record.
craft()
  .id('inbox')
  .from(mail('INBOX'))
  .authenticate(mailPrincipal) // identification: who is this
  .delegate(async (ex) => {
    // authority: what may the agent do for them
    if (!ex.principal) return undefined
    const grant = await grants.find(ex.principal.subject, 'agent:zoe')
    if (!grant) return undefined // no consent: the agent never acquires the identity
    return { actor: zoeIdentity, scopes: grant.scopes, grantId: grant.id }
  })
  .to(agent('zoe'))
```

Downstream capabilities admit or reject the delegation per route:

```ts
craft()
  .id('send-reply')
  .authorize({
    scopes: ['mail:send'],
    actor: ['none', { subject: 'agent:zoe', issuer: 'https://agents.example.com' }],
  })
  .from(direct())
  .to(smtp())
```

For the autonomous case there is nothing to delegate: mint the agent as its own subject with [`.authenticate()`](/docs/reference/operations/authenticate) on an internal trigger (for example `cron()`), and gate capabilities with `authorize({ subject: { profile: 'ai_agent' } })`.
