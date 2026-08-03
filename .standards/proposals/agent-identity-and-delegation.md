# Proposal: Agent Identity and Delegation

**Status: SUPERSEDED.** This was the design-time document; the feature shipped
(issue #512, PR #513) and the normative content now lives where shipped truth
lives: `.standards/security.md` § 12 for the rules, the `delegate` /
`authorize` operation references for the API, and the 0.5-to-0.6 migration
guide for the breaking changes. This file is retained only as the record of
the research and the decision path (prior art, rejected alternatives, the
consent-layer thinking that moved to application level). **Where this document
and the shipped code differ, the code and the shipped docs win.** Known
divergences: the scope intersection here is three-way
(`subject, grant, actor`); the shipped rule is two-way
(`intersect(subject, ceiling)`, actor scopes deliberately excluded, see the
delegate reference for the rationale). The `.identify()` operation,
channel-confidence grading, and the framework-level grant/ceremony layers
described below were deliberately not built.

**Scope:** How Routecraft represents *who is acting*, *for whom*, and *with what
authority*, across three cases: a human acting directly, an agent acting on
behalf of a human, and an agent acting under its own standing authority.

**Relationship to `.standards/security.md`:** this proposal extends it. § 11
(Agent -> MCP auth boundary) stays correct and is reinforced. The proposed
normative text is drafted in Appendix A; it is deliberately kept out of
`security.md` until this document is approved.

---

## 1. The problem

Routecraft's `Principal` (`packages/routecraft/src/auth/types.ts`) is a flat,
single identity: one `subject`, one set of `roles` and `scopes`. Authenticity is
a `WeakSet` brand applied by a source verifier or an explicit `authenticate()`
mint. `authorize()` checks that one identity.

The plumbing already carries identity end to end: `.authenticate()` mints
mid-pipeline, `freezePrincipal` preserves the brand across the tool boundary
(`packages/ai/src/fn/handler-context.ts:64`), and `dispatchDirect` forwards it to
downstream direct routes (`packages/ai/src/agent/tools/builders.ts:216`).

What the model cannot express is **who is driving**. When an agent calls a
capability on a user's behalf, the downstream route sees a principal
indistinguishable from that user sitting at a keyboard. There is no way to write
"a human may do this, an agent may not", which is the most basic control an
agent platform needs.

A second, sharper problem sits underneath it. The natural way to get identity
onto an exchange from an inbound channel is:

```ts
.authenticate(async (ex) => {
  const user = await directory.lookupByEmail(ex.body.from.address)
  return { subject: user.id, roles: user.roles, scopes: user.scopes }
})
```

This is **identifier-as-credential**, and hardening the channel does not fix it.
Suppose email verification were perfect: DKIM, SPF and DMARC aligned, provably
the user's mailbox, no compromise. The message still only proves *the user sent
a message*. It does not prove *the user authorised an agent to act as them*.
Those are different facts, and no channel verification produces the second one.

The missing ingredient is not stronger identification. It is **consent**.

## 2. Prior art

The industry has converged, and Routecraft should adopt rather than invent.

| Spec | Status | Contribution |
|---|---|---|
| [RFC 8693](https://www.rfc-editor.org/rfc/rfc8693.html) Token Exchange | RFC (stable) | `act` claim, subject vs actor, `may_act`, delegation vs impersonation |
| [RFC 9470](https://www.rfc-editor.org/rfc/rfc9470.html) Step Up Authentication Challenge | RFC (stable) | `insufficient_user_authentication`, `acr_values`, `max_age` |
| [RFC 8628](https://www.rfc-editor.org/rfc/rfc8628.html) Device Authorization Grant | RFC (stable) | Out-of-band approval via `user_code` + `verification_uri` |
| [OpenID CIBA Core 1.0](https://openid.net/specs/openid-client-initiated-backchannel-authentication-core-1_0.html) | Final | Backend-initiated approval: `login_hint`, `binding_message`, `auth_req_id` |
| [draft-ietf-oauth-identity-assertion-authz-grant](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-identity-assertion-authz-grant) (ID-JAG) | WG draft -04 | Cross-domain: SSO assertion as input to token exchange |
| [draft-oauth-ai-agents-on-behalf-of-user](https://www.ietf.org/archive/id/draft-oauth-ai-agents-on-behalf-of-user-02.txt) | draft -02 | `requested_actor` at authorize: the user consents to a *named* agent |
| [draft-mcguinness-oauth-actor-profile](https://datatracker.ietf.org/doc/html/draft-mcguinness-oauth-actor-profile-00) | individual draft -00 | Profiles `act`: required `sub` + `iss`, recommended `sub_profile` |

Two normative rules from RFC 8693 shape the whole design:

- **§ 4.1:** "For the purpose of applying access control policy, the consumer of
  a token MUST only consider the token's top-level claims and the party
  identified as the current actor by the `act` claim. Prior actors identified by
  any nested `act` claims are informational only." Some vendor documentation
  says the opposite; follow the RFC.
- **§ 2.1:** a `subject_token` with no `actor_token` is *impersonation*. Naming
  the actor is what makes it *delegation*. Routecraft supports delegation only.

[WorkOS](https://workos.com/blog/developers-guide-to-ai-agent-authentication-and-authorization)
packages these rather than extending them: agents as first-class principals with
their own credentials, an on-behalf-of mode with scope attenuation, an autonomous
mode, and an intersection check (`agent_permitted && user_permitted`) to prevent
confused-deputy. Their [auth.md](https://workos.com/auth-md) protocol solves a
different problem (agent *registration* at a service) but contributes one idea we
adopt: **pre-claim scopes**, a restricted standing grant that needs no ceremony,
upgraded in place once a user claims it.

### 2.1 What WorkOS does not provide

Established during research, and it constrains the plan:

- **No RFC 8693 token exchange.** WorkOS's own writing on the on-behalf-of draft
  presents it as an emerging standard, not an implemented feature.
- **No native `act` or `may_act`.** Arbitrary nested JSON claims can be emitted
  via [JWT Templates](https://workos.com/docs/authkit/jwt-templates) from
  `user.metadata`, subject to a 3072-byte rendered cap. That is WorkOS *carrying*
  our claim, not WorkOS *deciding* delegation, because there is no exchange
  endpoint at which `may_act` would be enforced.
- **No CIBA.** The backchannel ceremony has to be built.

Consequence: the grant store is authoritative in the application, and Routecraft
enforces it. We keep the `may_act` *shape* for portability to IdPs that do
implement token exchange (Keycloak, Auth0, Ping, Okta), but we do not emit a
`may_act` claim that nothing enforces. A claim that looks like a security control
without being one is worse than no claim.

## 3. Model: three authority sources

The central correction to earlier thinking. Authority does not always derive from
a human, and an autonomous agent is not "delegation with the human missing".

| Source | `subject` | `actor` | Bounded by |
|---|---|---|---|
| **Human direct** | the human | absent | the human's own roles and scopes |
| **Delegated** | the human | the agent | `intersect(human, grant, agent identity)` |
| **Own authority** | the agent | absent | the agent identity's roles and scopes, like an employee's role |

The same agent appears in different fields depending on whether a human is behind
it. That is the trick, and it is what makes one `authorize()` grammar cover all
three.

**The principal is per-action, not per-run.** A single background run may do some
things under the agent's own authority and others under a standing delegation
grant from a user. "Autonomous" and "delegated" are not modes to choose between
at dispatch; they are properties of each capability invocation.

Three orthogonal axes fall out, and keeping them separate is what makes the model
tractable:

| Axis | Field | Answers |
|---|---|---|
| Who is this for | `subject` (+ `roles`) | Whose authority is being exercised |
| What may be done | `scopes` | Which capability, narrowed at every hop |
| Who is driving | `actor` | A human, or which agent |

## 4. `Principal` shape

```ts
type PrincipalProfile = 'user' | 'service' | 'ai_agent' | (string & {})

interface Principal {
  // ... existing fields unchanged

  /**
   * Entity classification, per draft-mcguinness-oauth-actor-profile.
   * Orthogonal to the existing `kind`, which records HOW the principal was
   * authenticated (jwt / jwks / oauth / custom). A human and an agent can both
   * arrive with kind: "jwks".
   *
   * Absent means unclassified, which MUST attract restrictive policy.
   */
  subjectProfile?: PrincipalProfile

  /**
   * RFC 8693 §4.1 `act`. The current actor when this identity is being
   * exercised by a delegate. `subject` remains the party on whose behalf the
   * action is taken. Nests: the OUTERMOST actor is the immediate caller and the
   * only access-control input; nested entries are audit data.
   */
  actor?: Principal

  /**
   * RFC 8693 §4.4 `may_act`. Who is permitted to become this principal's actor.
   * Enforced by delegate(), not by the IdP (see § 2.1).
   */
  mayAct?: ActorMatcher[]

  /**
   * Assurance of the authentication event that produced this principal.
   * Set once at mint, never mutated. See open question OQ-3.
   */
  confidence?: 'weak' | 'strong'

  /** Identifier of the DelegationGrant this principal was minted under. */
  grantId?: string
}
```

### 4.1 Authenticity of a chain

Authenticity is membership in a module-private `WeakSet`
(`packages/routecraft/src/auth/authentic.ts`), and that property must extend to
the chain:

- The brand is applied to the **root** principal only.
- The chain is **built atomically** inside `authenticate()` / `delegate()`. There
  is no API that attaches an `actor` to an existing principal.
- `delegate()` **rejects a non-authentic input**.

Without this, a caller holding a genuine authentic actor could staple it onto a
hand-built subject and defeat the `WeakSet` guarantee.

### 4.2 Narrowing rule

`delegate()` intersects **scopes only**.

> **Superseded:** the shipped implementation intersects only `subject.scopes`
> and the consent ceiling; the actor's own scopes are deliberately excluded.
> See the `delegate` operation reference ("Why the actor's own scopes are not
> intersected") for the adopted rule and rationale.

Roles and scopes live in different namespaces. A user's roles
(`["employee", "finance"]`) and an agent identity's roles
(`["agent", "office-manager"]`) intersect to the empty set, which would break
every role check. Scopes name capabilities in a shared namespace, so intersecting
them is meaningful and is the confused-deputy control.

- `scopes` = `intersect(subject.scopes, grant.scopes, actorIdentity.scopes)`
- `roles` = the subject's roles, unchanged. They describe who the subject is.
- The actor's own roles remain on `actor.roles`, for matching only.

## 5. Establishing identity from a channel

### 5.1 Layer 0: `ChannelAssertion` (identification, never authentication)

Source adapters emit an assertion. The type is deliberately unusable for
authorization: it is not a `Principal` and `authorize()` cannot read it.

```ts
interface ChannelAssertion {
  channel: 'email' | 'slack' | 'whatsapp' | 'sms' | 'webhook' | (string & {})
  /** Channel-namespaced so identifiers cannot collide across channels. */
  identifier: string          // "email:jaco@devoptix.nl" | "slack:T0123/U0456"
  /** Structured, adapter-specific proof. */
  evidence: ChannelEvidence
  /** Derived by the framework from `evidence`. Adapters cannot set it. */
  confidence: 'none' | 'weak' | 'strong'
  receivedAt: number
}
```

Adapters report evidence; the framework grades it. If an adapter could set its
own grade, the grade is worthless.

| Channel | Proves | Grade | May auto-resolve a grant? |
|---|---|---|---|
| Slack / Teams (signed request, `user_id`) | The platform authenticated this human | `strong` | Yes |
| Email, DKIM + SPF + DMARC aligned | The domain authorised this send | `weak` | Pre-claim scopes only |
| SMS / WhatsApp | Number custody (SIM-swap risk) | `weak` | Pre-claim scopes only |
| Bare `From`, unsigned webhook | Nothing | `none` | No |

`confidence` never grants anything. It gates which binding mechanism is
permitted.

### 5.2 Layer 1: `ChannelBinding` (identifier to user)

```ts
interface ChannelBinding {
  identifier: string          // "email:jaco@devoptix.nl"
  subject: string             // "user_01J8Z4KQ"
  issuer: string
  verifiedAt: number
  verifiedVia: 'directory-sync' | 'oidc-session' | 'claim-ceremony'
}
```

**Never inferred from an inbound message.** Either synced from the directory (the
enterprise case: the IdP already knows the user's addresses) or established by
the user in an authenticated session. This single rule is what kills
identifier-as-credential: the mapping must pre-exist and be attributable.

### 5.3 Layer 2: `DelegationGrant` (the consent record)

```ts
interface DelegationGrant {
  id: string
  subject: string                                 // who is delegating
  actor: { subject: string; issuer: string }      // which agent
  scopes: string[]                                // ceiling, narrower than the user's own
  channels?: string[]                             // restrict which channel may trigger it
  minConfidence: 'weak' | 'strong'                // assertion floor
  expiresAt: number
  maxUses?: number
  canRedelegate?: string[]                        // see § 7, default absent
  grantedAt: number
  grantedVia: 'consent-ui' | 'ciba' | 'device-code'
  revokedAt?: number
}
```

This is `may_act` with teeth: not only *who* may act, but with what scopes, from
which channel, for how long, how many times. It is created by an explicit,
authenticated consent action and is never inferred.

A **standing grant** is simply a grant with a long expiry and no channel
restriction. It needs no new concept and is how an agent gets durable, revocable
access to a user's data for background work (§ 8).

Inbound handling becomes a lookup, not a mint:

1. Assertion arrives.
2. Resolve binding to a subject. No binding, stop.
3. Find an unexpired, unrevoked grant matching subject, agent, channel, and the
   confidence floor. No grant, this is not an error: it is the trigger for § 5.4.
4. Mint the delegated principal per § 4.2.

### 5.4 Layer 3: the ceremony

In preference order:

1. **CIBA**, where the IdP supports it. Routecraft POSTs to
   `backchannel_authentication_endpoint` with `login_hint` (the channel
   identifier; the spec permits an email address), the requested `scope`, and a
   `binding_message` naming the concrete action. The user approves at the IdP, in
   a real session, on a device we did not have to secure. Poll `auth_req_id`.
2. **Device authorization grant (RFC 8628)** as fallback: reply on the channel
   with a `user_code` and `verification_uri`. This is what auth.md's User Claimed
   flow does.
3. **Signed one-time link** on the originating channel, for low-value grants
   only. Still stronger than the status quo because the link lands on a page
   requiring an authenticated session; mailbox possession alone is insufficient.

Given § 2.1, option 1 is unavailable on WorkOS today, so the first
implementation targets 3 with 2 as the escalation path, and 1 becomes available
if the IdP is ever changed.

### 5.5 Step-up rather than hard denial

`authorize()` failures split into two classes:

- **Permanent:** failed a role check, wrong subject profile, disallowed actor.
  A ceremony will not help. `RC5015` / `RC5034` / `RC5035`.
- **Recoverable:** the identity is sound, a scope or confidence floor is missing,
  and a grant could plausibly be obtained. Emit a challenge carrying the required
  scope and assurance, in the shape of RFC 9470's
  `insufficient_user_authentication` with `acr_values` / `max_age`.

A recoverable failure inside an interactive dispatch suspends rather than dies,
which lands on the existing durable-agents stub
(`packages/ai/src/agent/suspend.ts:39`):

```ts
throw new SuspendError({ reason: 'awaiting-delegation-consent', resumeChannel: 'ciba' })
```

The agent proceeds under the narrow standing grant and escalates only for the one
action that needs more.

## 6. Enforcement: `authorize()`

```ts
interface ActorMatcher {
  subject?: string | string[]
  issuer?: string
  profile?: PrincipalProfile | PrincipalProfile[]
  roles?: string[]          // ALL must be present on the actor
}

type ActorSpec =
  | 'none'                                  // DEFAULT: reject if any actor present
  | 'any'
  | ActorMatcher
  | Array<'none' | ActorMatcher>            // OR
  | ((actor: Principal | undefined, subject: Principal) => boolean)

interface SubjectMatcher {
  subject?: string | string[]
  issuer?: string
  profile?: PrincipalProfile | PrincipalProfile[]
}

interface AuthorizeOptions {
  // existing
  roles?: string[]
  scopes?: string[]
  predicate?: (p: Principal) => boolean
  clockToleranceSec?: number
  // proposed
  subject?: SubjectMatcher | ((subject: Principal) => boolean)
  actor?: ActorSpec
  maxDelegationDepth?: number               // default 1
  confidence?: 'weak' | 'strong'
}
```

### 6.1 Design decisions

- **`actor: 'none'` is the default.** `.standards/security.md` § 6a requires the
  production-safe behaviour to be the unconfigured default. Every existing
  `.authorize({ roles: ['admin'] })` was written when only humans and service
  accounts existed; defaulting to `'any'` would grant agents access to those
  routes as a side effect of a version bump. This is a breaking change and is
  the correct one under the v0 policy in `.standards/api-stability.md`.
- **Only the immediate actor is matched.** RFC 8693 § 4.1 makes this a MUST.
  Nested actors are audit data.
- **Actor identity is the `(issuer, subject)` pair.** A bare subject matches an
  identically-named agent from any issuer. `issuer` is optional in the type for
  single-IdP deployments; omitting it should be a lint warning in
  `@routecraft/eslint-plugin-routecraft`.
- **No `actor.scopes`.** The delegation intersection already enforces the agent's
  ceiling. A second place to express it invites callers to check `actor.scopes`
  and believe they are done, when the effective scopes are what gate the call.
  Match the actor on identity; gate capability on `scopes`.
- **Agent-ness is structural, not a role.** Roles come from the IdP and are a
  namespace we do not fully control. `actor` and `subjectProfile` are established
  by the framework at the delegation boundary, which is what makes
  `actor: 'none'` an actual guarantee.

### 6.2 Error codes

Next free core codes are RC5034+ (RC5027 is retired to `AI1003`; do not reuse).

| Code | Cause | Client expectation |
|---|---|---|
| `RC5034` | Actor present but not permitted by the `actor` spec | Permanent. This capability is not agent-reachable |
| `RC5035` | Subject not permitted by the `subject` spec | Permanent |
| `RC5036` | Chain deeper than `maxDelegationDepth` | Permanent |
| `RC5037` | `delegate()` refused: `may_act` / grant does not permit this actor | Obtain consent, then retry |
| `RC5038` | Insufficient scope or confidence, recoverable | Run a ceremony (RFC 9470 challenge attached) |

Kept distinct from `RC5015` per `.standards/security.md` § 7: "this capability is
human-only" is a different remediation from "you lack a role".

### 6.3 Scope narrowing: the capability declares, not the route

A recurring question is how a route can request a least-privilege scope subset
before the agent has determined intent. It cannot, and it does not need to.

1. The agent's session runs on the standing grant's ceiling, which contains
   nothing with an external effect: read, search, draft, summarise. No intent is
   required to enter it.
2. **Each capability declares its own required scope, statically.**
   `send-reply` knows it needs `mail:send`. The capability knows; the triggering
   route does not, and the agent must not be asked to guess.
3. Escalation happens at the capability boundary, lazily, at call time, when
   intent is fully concrete.

```ts
craft().id('draft-reply').authorize({ scopes: ['mail:draft'] })
craft().id('send-reply').authorize({ scopes: ['mail:send'], confidence: 'strong' })
```

**Scopes gate the verb; guards gate the object.** `mail:send` does not say to
whom. Parameter-level authorization belongs in `ToolGuard`
(`packages/ai/src/fn/types.ts:98`), which already receives `(input, ctx)` with
`ctx.principal`:

```ts
guard: (input, ctx) => {
  if (!isInternalRecipient(input.to) && !ctx.principal?.scopes?.includes('mail:send:external')) {
    throw new Error('external recipients require explicit approval')
  }
}
```

**Re-minting tokens:** only at trust boundaries. In-process capabilities never
leave the trust zone, so the delegated `Principal` is sufficient. An external hop
(a third-party MCP server, a vendor API) mints a narrow, audience-bound token at
that hop via RFC 8693, which is the natural extension of
`.standards/security.md` § 11.

## 7. Multi-hop delegation

Chain: user -> agent A -> agent B.

Because only the outermost actor is an access-control input, a capability
declaring `actor: { subject: 'agent:a' }` will reject a call whose current actor
is agent B. Two options:

- **Option A, non-transitive grants (recommended default).** The user grants each
  agent separately. Agent A may hand work to agent B only if the user also
  granted agent B. Every agent the user's authority flows through was explicitly
  approved, and the consent UI shows the complete set.
- **Option B, delegable grants.** `DelegationGrant.canRedelegate` lists agents A
  may sub-delegate to. Convenient, but the granting user no longer sees the full
  set of agents that will hold their authority. This is the classic escalation
  chain shape.

Recommendation: A as the default, B as an explicit per-grant opt-in. Scope
intersection applies at every hop either way, so authority can only narrow.

**Returning from a sub-agent is not a delegation step.** When agent B returns,
control returns to agent A's exchange, which still holds its own principal. There
is no chain to pop; the outer frame was never mutated.

**A model reviewing another model is not a security boundary.** If agent A
verifies agent B's work, that is quality control. It must never appear in the
authorization path, or the escalation route becomes an LLM decision.

## 8. Own authority and background work

An agent with a heartbeat has standing authority like an employee has a role. It
is different in kind from the user's authority, not a weakened copy of it.

```ts
agents: {
  zoe: {
    identity: {
      subject: 'agent:zoe',
      subjectProfile: 'ai_agent',
      issuer: 'https://routecraft.example.com',
      roles: ['agent', 'office-manager'],
      scopes: ['memory:read', 'memory:write', 'notes:daily:write', 'task:read', 'task:comment', 'notify:internal'],
      // deliberately absent: mail:send, repo:write, anything scoped to a specific person
    },
  },
}
```

Five rules bound it:

**8.1 Trigger allowlist.** An autonomous principal may be minted only from a
**trusted internal trigger** (cron, timer, internal queue), never from a channel
adapter. Otherwise anyone who can send the system a message can trigger the
agent's standing authority. Proposed enforcement: tag adapters
`trust: 'internal' | 'external'` and have `.authenticate()` throw when it mints an
`ai_agent` subject on a route whose source is external. Enforced by construction,
not by review.

**8.2 Bounded initiative.** An idle agent with tools is a runaway risk in cost and
blast radius. Heartbeat routes set `.throttle()` (already in the pre-from chain)
and `maxTurns` explicitly rather than inheriting defaults, plus a per-run action
budget.

**8.3 No user data without a standing grant.** The agent's own authority covers
shared resources and its own memory. Per-user data requires a `DelegationGrant`
from that user, granted once through the consent UI with a long expiry. When
used, the principal is `subject: <user>, actor: <agent>` even inside a background
run.

**8.4 An autonomous agent cannot escalate. It can only ask.** There is no live
session to run a ceremony into, so a recoverable failure becomes a queued
approval item, not a suspend-and-resume:

```ts
.delegate({ agent: 'zoe', onInsufficientAuthority: 'request' })  // 'request' | 'deny'
```

This is a hard rule, not a default.

**8.5 Self-directed work is declared by the data, not chosen by the model.**

```jsonc
{ "id": "T-419", "assignableTo": ["agent:zoe"], "requiresApproval": false }
```

The agent's find-work query filters on `assignableTo`. The model chooses among
permitted tasks; it never decides whether something is permitted. Same principle
as § 7: model judgement stays out of the authorization path.

## 9. Worked examples

### 9.1 Human, direct

```jsonc
{
  "kind": "jwks", "scheme": "bearer",
  "subject": "user_01J8Z4KQ", "subjectProfile": "user",
  "issuer": "https://idp.example.com",
  "email": "user@example.com",
  "clientId": "some-oauth-client",
  "roles": ["employee", "finance"],
  "scopes": ["invoice:read", "invoice:write", "mail:send"],
  "confidence": "strong",
  "expiresAt": 1785312000
}
```

`clientId` is not an actor. Per draft-mcguinness-oauth-actor-profile, `client_id`
and `azp` identify OAuth clients, not acting parties.

**Known limitation:** a human at a keyboard and a background task holding that
human's token are indistinguishable from the token alone. Only the issuer can
mark the difference, by minting an `act` claim. Where the IdP does not, everything
arriving with a user token is treated as the human. This is a property of the IdP,
not something Routecraft can resolve.

### 9.2 Own authority (background)

```jsonc
{
  "kind": "custom", "scheme": "custom",
  "subject": "agent:zoe", "subjectProfile": "ai_agent",
  "issuer": "https://routecraft.example.com",
  "roles": ["agent", "office-manager"],
  "scopes": ["memory:read", "memory:write", "notes:daily:write"]
}
```

### 9.3 Delegated, pre-claim (no ceremony)

```jsonc
{
  "kind": "delegated", "scheme": "grant",
  "subject": "user_01J8Z4KQ", "subjectProfile": "user",
  "issuer": "https://idp.example.com",
  "roles": ["employee", "finance"],
  "scopes": ["ticket:read", "mail:draft"],
  "confidence": "weak",
  "grantId": "grant_01K2M",
  "expiresAt": 1785315600,
  "actor": {
    "subject": "agent:sla", "subjectProfile": "ai_agent",
    "issuer": "https://routecraft.example.com",
    "roles": ["agent"]
  }
}
```

The user can touch invoices; the agent's grant does not include them, so the
delegated principal cannot. It can draft, not send.

### 9.4 Delegated, after step-up

```jsonc
{
  "kind": "delegated", "scheme": "bearer",
  "subject": "user_01J8Z4KQ", "subjectProfile": "user",
  "roles": ["employee", "finance"],
  "scopes": ["ticket:read", "mail:draft", "mail:send"],
  "confidence": "strong",
  "grantId": "grant_01K2N",
  "claims": { "acr": "urn:mace:incommon:iap:silver", "amr": ["mfa"] },
  "actor": { "subject": "agent:sla", "subjectProfile": "ai_agent", "issuer": "https://routecraft.example.com" }
}
```

### 9.5 Chain

```jsonc
{
  "subject": "user_01J8Z4KQ", "subjectProfile": "user",
  "scopes": ["repo:read", "repo:write"],
  "actor": {
    "subject": "agent:max", "subjectProfile": "ai_agent",      // CURRENT actor
    "issuer": "https://routecraft.example.com",
    "actor": {
      "subject": "agent:zoe", "subjectProfile": "ai_agent",    // prior: AUDIT ONLY
      "issuer": "https://routecraft.example.com"
    }
  }
}
```

### 9.6 Route declarations

```ts
// Human-only destructive op.
craft().id('delete-invoice')
  .authorize({ roles: ['finance'], actor: 'none' })

// Either the user directly, or one named agent for them.
craft().id('send-reply')
  .authorize({
    subject: { profile: 'user' },
    scopes: ['mail:send'],
    confidence: 'strong',
    actor: ['none', { subject: 'agent:sla', issuer: 'https://routecraft.example.com' }],
  })

// Autonomous only.
craft().id('nightly-sweep')
  .authorize({ subject: { profile: 'ai_agent' }, actor: 'none', scopes: ['task:read'] })

// Delegation allowed, one hop only.
craft().id('crm-lookup')
  .authorize({ actor: 'any', maxDelegationDepth: 1, scopes: ['crm:read'] })
```

Stacked `.authorize()` calls AND-combine (`packages/routecraft/src/builder.ts:1102`),
so OR within one axis uses the array form.

### 9.7 End-to-end route

```ts
craft()
  .id('sla-inbox')
  .from(imap({ /* ... */ }))
  .identify(email())                        // -> ChannelAssertion. Cannot authorize.
  .delegate({
    agent: 'sla',
    purpose: (ex) => `Reply to "${ex.body.subject}"`,
    onMissingGrant: 'challenge',            // 'challenge' | 'deny' | 'anonymous'
  })
  .to(agent('sla'))
```

## 10. Open questions

| # | Question | Notes |
|---|---|---|
| OQ-1 | Package split | Types and `authorize()` semantics must be core (a plugin cannot enforce actor rules). Stores and ceremonies are a plugin. Where the first implementation is written is undecided. |
| OQ-2 | `maxDelegationDepth` default: 0 or 1 | `actor: 'none'` already blocks delegation by default, so a depth default of 1 only applies once a route opts in. 0 would make chains opt-in separately. |
| OQ-3 | Does `confidence` belong on `Principal`? | On the principal makes `authorize({ confidence })` trivial but bakes in a staleness claim nothing re-evaluates. Deriving from `claims.acr` / `amr` at check time is more correct and less ergonomic. Leaning: keep on the principal, set once at mint, never mutated. |
| OQ-4 | Does `.authenticate()` survive? | Recommendation: yes, unchanged, as the low-level primitive for sources that genuinely verify identity themselves (signed webhook, mTLS peer). It gains a docs warning pointing at `.identify()` / `.delegate()`. Additive, not a replacement. |
| OQ-5 | Grant storage | Application database recommended over IdP metadata: WorkOS JWT templates cap at 3072 rendered bytes, and grants need revocation, expiry, and per-use accounting. |
| OQ-6 | Is `trust: 'internal' \| 'external'` on adapters in scope | Needed for § 8.1 enforcement by construction. Touches every adapter's metadata. |
| OQ-7 | Migration | `actor: 'none'` default is a breaking change for anyone whose agents currently reach guarded routes. Needs a migration note and possibly a one-release opt-out. |

## 11. Non-goals

- **Building an authorization server.** Consent records, CIBA, revocation and
  audit exist in Entra, Okta, Keycloak and WorkOS. Routecraft ships interfaces,
  IdP adapters, and reference implementations for dev. Shipping a consent UI and
  grant database as the primary path means owning an IdP's security surface.
- **Impersonation.** RFC 8693 § 2.1 distinguishes it from delegation. Routecraft
  supports delegation only; the subject is always retained and the actor is
  always named.
- **Policy on prior actors.** Nested actors are audit data. No API will expose
  them as an authorization input.

---

## Appendix A: proposed `.standards/security.md` § 12

Draft normative text, to be merged only after this proposal is approved.

> ## 12. Agent identity and delegation
>
> - **`subject` is the party on whose behalf an action is taken; `actor` is the
>   party performing it.** Per RFC 8693 § 4.1, `actor` nests, the outermost entry
>   is the current actor, and **only the current actor is an access-control
>   input**. Prior actors are audit data and MUST NOT be exposed as an
>   authorization input.
> - **Routecraft supports delegation, never impersonation.** A minted principal
>   always retains its subject and always names its actor. There is no API that
>   replaces a subject with an agent.
> - **Authenticity is a property of the whole chain.** The `WeakSet` brand is
>   applied to the root only, chains are constructed atomically inside
>   `authenticate()` / `delegate()`, and no API attaches an `actor` to an
>   existing principal. `delegate()` MUST reject a non-authentic input.
> - **Delegation narrows scopes and only scopes.** `scopes` become
>   `intersect(subject, grant, actor identity)`. Roles are not intersected: they
>   live in different namespaces and intersecting them would empty the set.
> - **`actor: 'none'` is the `authorize()` default**, per § 6a. A capability is
>   not agent-reachable unless it says so.
> - **Actor identity is the `(issuer, subject)` pair**, never `subject` alone.
> - **Agent-ness is structural, never a role.** `subjectProfile` and `actor` are
>   set by the framework at trusted boundaries. An absent `subjectProfile` is
>   unclassified and MUST attract restrictive policy.
> - **A channel identifier is not a credential.** An inbound channel assertion
>   establishes identification only. Converting one into authority requires a
>   pre-existing `ChannelBinding` and a `DelegationGrant`. `.authenticate()` MUST
>   NOT be used to mint a user principal from a channel identifier alone.
> - **Autonomous principals may only be minted from internal triggers.** An
>   `ai_agent` subject MUST NOT be minted on a route whose source adapter is
>   externally reachable.
> - **An autonomous agent cannot escalate its own authority.** With no
>   interactive session, a recoverable authorization failure becomes a queued
>   approval request, never an inline elevation.
> - **A model's judgement is never an authorization boundary.** One agent
>   approving another's work is quality control. Enforcement stays in
>   `.authorize()` and tool guards.
> - **Scopes gate the verb; guards gate the object.** Parameter-level
>   authorization belongs in `ToolGuard`, not in the scope string.
