---
title: resume
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
resume(map?: (exchange: Exchange<Current>) => ResumeRequest | Promise<ResumeRequest>): RouteBuilder<ResumeAcknowledgment>
```

Revive an exchange parked by [`.suspend()`](/docs/reference/operations/suspend) and run its continuation.

```ts
// Preferred: map the ingress exchange to the answer it carries.
craft()
  .id('approval-replies')
  .from(mail('INBOX'))
  .authenticate(mailPrincipal)
  .resume((ex) => ({
    token: tokenFrom(ex.headers['routecraft.mail.subject']),
    result: { approved: /^yes/i.test(ex.body.text ?? '') },
  }))
  .to(log())

// Fallback: the body is already shaped { token, result }.
craft().id('resume-api').from(http({ path: '/resume', method: 'POST' })).resume()
```

`.resume()` addresses an **exchange**, not a route. `direct('x')` names a route and enters it through its source; resume names one parked exchange and re-enters its pipeline partway down. That is what lets a mail-born exchange be continued by a chat-born answer: the original source takes no part in execution two, because sources create exchanges rather than revive them.

Any route ending in `.resume()` is a resume ingress: an HTTP webhook, a mail-reply parser, an ops CLI. There is no special resume transport.

## The boundary

The mapping function owns **shape**: find the token, build the candidate answer. Only the ingress route knows what its transport looks like.

Revival owns **validation**: only the suspension knows the `expect` schema the suspending step declared, so the candidate answer is checked there, against the live schema read back off the route.

| Field | Type | Description |
|-------|------|-------------|
| `token` | `string` | The signed token minted when the exchange parked. |
| `result` | `unknown` | The candidate answer, validated against the suspending step's `expect`. |
| `resumedBy` | `PrincipalRef` | Who answered. Defaults to the ingress exchange's own principal, which is the value worth recording: it was verified live here. Set it explicitly only when the answerer is not the caller. |

## What the ingress route receives

The revived route runs to completion before `.resume()` continues, so the acknowledgment it puts in the body reports how execution two actually ended, and the ingress route can answer the approver's own channel.

```jsonc
{
  "status": "resumed",          // or "duplicate"
  "suspensionId": "3f1c…~0",
  "routeId": "payout",          // the suspended route, not this one
  "outcome": { "status": "completed", "body": { "paid": true }, "at": "…" }
}
```

A duplicate answer (an approver double-clicks, a webhook is redelivered) returns the first one's cached terminal outcome with `status: "duplicate"` and re-runs nothing.

## Authorizing the answerer

The token proves this deployment minted it. It does **not** prove its holder may answer. Authorizing the answerer is this route's job, and this route is where an authenticated principal is actually available:

```ts
craft()
  .id('resume-api')
  .authorize({ roles: ['approver'] })
  .from(http({ path: '/resume', method: 'POST', auth: 'required' }))
  .resume()
  .to(log())
```

A principal that came back from the store with the parked exchange is marked restored and refused by `authorize()` with [`RC5043`](/docs/reference/errors#rc-5043): it is a recorded shape with no live credential behind it. Re-verify after resume, or authorize here.

## Revival failures

Each of these throws in the ingress route, so the answerer gets a typed error, and (where a suspended route is identifiable) additionally re-enters the **suspended** route's error channel, so a route-scope `.error()` can notify the approver and re-ask instead of leaving them at a dead link.

| Code | Cause |
|------|-------|
| [`RC5041`](/docs/reference/errors#rc-5041) | The token is malformed or its signature does not verify. |
| [`RC5046`](/docs/reference/errors#rc-5046) | The token verifies but the store holds no such suspension, or its route is not registered in this context. |
| [`RC5047`](/docs/reference/errors#rc-5047) | The suspension's `ttl` elapsed. |
| [`RC5048`](/docs/reference/errors#rc-5048) | The steps after the suspend point (or the `expect` schema) changed while the exchange was parked, so the stored approval no longer authorizes what would run. Refused before any of those steps execute. |
| [`RC5049`](/docs/reference/errors#rc-5049) | The answer does not satisfy `expect`. The suspension stays resumable, so a corrected answer still works. |
| [`RC5050`](/docs/reference/errors#rc-5050) | The suspension was denied, typically because the run carrying it was cancelled. |

## Related

- [`.suspend()`](/docs/reference/operations/suspend) -- the other half.
- [`.authorize()`](/docs/reference/operations/authorize) -- guarding the ingress.
- [Configuration → suspension](/docs/reference/configuration#suspension) -- the store and the signing secret.
