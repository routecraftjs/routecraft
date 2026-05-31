---
title: authorize
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
authorize(options?: AuthorizeOptions): RouteBuilder<Current>
```

Declare an authorization requirement on the next route. **Route-only**, same staging convention as `.id`, `.title`, `.description`, `.input`, `.output`, `.tag`, and `.batch`: it writes onto the next-route options. Calling a pipeline op (`.to`, `.transform`, `.process`, ...) while authorizers are staged but no `.from()` has opened the next route throws [`RC2001`](/docs/reference/errors#rc2001) with a message that lists `.authorize` alongside the other staging ops. For a mid-pipeline check use `.validate(authorize({ ... }))` directly.

The check runs at route entry, before any pipeline step. It verifies that the inbound exchange carries an authenticated principal and (optionally) that the principal has every required role and scope. It does NOT issue, mint, or attach any credential: it asserts an existing identity meets the criteria. Multiple `.authorize()` calls stack and AND-combine in declaration order, so a missing role in the first call short-circuits before later predicates run.

`.authorize()` can also act as a route-starter when chaining routes: `craft().from(s1).to(d1).authorize({...}).from(s2).to(d2)` opens route 2 with the authorizer staged, no explicit `.id("next")` required.

For mid-pipeline checks (rare, for example after a `.process()` swaps the principal or inside a `.choice()` branch), use `.validate(authorize({ ... }))` directly with the underlying validator function.

`AuthorizeOptions`:

| Field | Type | Description |
|-------|------|-------------|
| `roles` | `string[]` | Required roles. The principal must carry every listed role. AND-combined. |
| `scopes` | `string[]` | Required scopes. The principal must carry every listed scope. AND-combined. |
| `predicate` | `(p: Principal) => boolean` | Custom check. Runs after the role and scope checks. Return `false` to reject. |

Failure modes:

- **No principal on the exchange:** throws [`RC5012`](/docs/reference/errors#rc5012). The source did not authenticate (no `auth:` configured) and no `.process()` step attached one before the route ran.
- **Missing role or scope:** throws [`RC5015`](/docs/reference/errors#rc5015). The error message lists the missing entries.
- **Predicate returned `false`:** throws [`RC5015`](/docs/reference/errors#rc5015).

Both error codes flow through the route's normal error path: `.error()` handles them like any other validation failure; without `.error()`, `exchange:failed` fires.

```ts
import { craft, mcp } from '@routecraft/routecraft'

// Route-entry guard: authentication at the source boundary,
// authorization declared on the route.
craft()
  .id('delete-user')
  .description('Delete a user by id')
  .authorize({ roles: ['admin'] })
  .from(mcp({ annotations: { destructiveHint: true } }))
  .to(deleteUserDestination)
```

```ts
// Stacked authorizers (AND-combined; first failure short-circuits)
craft()
  .id('billing-admin')
  .authorize({ roles: ['admin'] })
  .authorize({ scopes: ['billing:write'] })
  .from(http({ path: '/admin/billing', method: 'POST' }))
  .to(billingDestination)
```

```ts
// Mid-pipeline check: route mints a principal from an inbound email
// with .authenticate() and authorizes it. authorize() trusts only
// principals minted this way (or attached by a source verifier); a
// plain object written to the principal header is rejected (RC5023).
import { authorize } from '@routecraft/routecraft'

craft()
  .from(mail({ /* ... */ }))
  .authenticate((ex) => ({
    scheme: 'email',
    subject: ex.body.from?.address ?? 'anonymous',
    email: ex.body.from?.address,
    claims: { tenant: deriveTenant(ex.body.from?.address) },
  }))
  .validate(authorize({
    predicate: (p) => p.email?.endsWith('@yourcompany.com') === true,
  }))
  .to(yourDestination)
```
