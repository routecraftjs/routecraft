---
title: authenticate
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
authenticate(resolver: (exchange: Exchange<Current>) => PrincipalClaims | undefined | Promise<PrincipalClaims | undefined>): RouteBuilder<Current>
```

Establish the authenticated principal for the exchange. The resolver returns identity claims you have verified yourself (an e-mail sender, a Slack signature, a webhook HMAC); they are minted into a branded, frozen `Principal` and attached to `headers["routecraft.auth.principal"]`. Return `undefined` to leave the caller anonymous. The body is unchanged.

This is the explicit way to establish identity from a source the framework cannot verify on its own. `authorize()` trusts only principals minted this way (or attached by a source verifier such as `jwt()` / `jwks()` / `oauth()`); a plain object written via `.header('routecraft.auth.principal', ...)` or `.process()` is rejected with [`RC5023`](/docs/reference/errors#rc5023). Sugar over the `authenticate()` helper, which you can call directly in tests, custom source adapters, or a `.choice()` branch.

Only `subject` is required; `kind` defaults to `"custom"` and `scheme` to `"custom"`.

```ts
// Mint identity from a verified inbound email, then authorize it
craft()
  .from(mail('INBOX'))
  .filter(verifiedSenders)
  .authenticate((ex) => ({
    scheme: 'email',
    subject: ex.body.sender.address,
    roles: ex.body.sender.address.endsWith('@acme.com') ? ['internal'] : [],
  }))
  .authorize({ roles: ['internal'] })
  .to(dest)

// Return undefined to stay anonymous
.authenticate((ex) => (ex.body.sender ? { subject: ex.body.sender.address } : undefined))
```
