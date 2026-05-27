---
title: transform
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
transform<Next>(fn: Transformer<Current, Next> | CallableTransformer<Current, Next>): RouteBuilder<Next>
```

Transform the exchange body using a function. The function receives the body and, as a second read-only argument, the current exchange, so it can derive the new body from context (the principal, headers, correlation id) without dropping to `.process()`. It still returns only the body; to rewrite headers or the principal use `.process()`. The second argument is optional, so a one-argument `(body) => ...` transformer is still valid.

```ts
.transform((body: string) => body.toUpperCase())
.transform(async (user) => await enrichUserData(user))

// Derive the body from the caller via the second argument
.transform((order, ex) => ({ ...order, requestedBy: ex.principal?.subject }))
```

#### Field helpers: `keep` and `mask`

Two transform helpers shape a record (or an array of records) field by field. Both return a transformer, so they drop into `.transform(...)`. Compose them by running `keep` first to remove fields the caller may not see, then `mask` to obfuscate what remains. Neither is a security guarantee on its own; the access control lives in the grants you pass to `keep`.

**`keep(rules, options?)`** keeps fields based on the caller's grants and removes the rest. A grant is a role name (matched against `principal.roles`) or a predicate `(record, principal) => boolean` (so `self` and relationships are predicates; `admin` is just a role name). A rule of `true` keeps a field for any caller. Strict by default: only listed fields survive (a new sensitive field stays hidden until you list it). Pass `{ strict: false }` to instead gate only the listed fields and pass everything else through. It reads the caller from the exchange the transform now provides, and trusts only an authentic principal (one established by a source verifier or `authenticate()`): a self-asserted principal header is treated as missing, so grants fail closed, matching `authorize()`.

```ts
const self = (e: Employee, p) => e.email === p?.email;

.transform(keep({
  id: true,
  email: true,
  yearlyWage: [self, 'hr'],   // own salary, or the hr role
  internalNotes: ['hr'],      // hr only, dropped for everyone else
}))
```

**`mask(rules)`** obfuscates field values and ignores the principal entirely. Use it for values that should not be shown verbatim even to an authorised caller (an e-mail on a public response). Each rule is `(value, record) => newValue`. Dot paths address nested fields.

```ts
.transform(mask({
  email: (v) => maskEmail(String(v)),
  'card.number': (v) => '**** ' + String(v).slice(-4),
}))
```

Both apply to the body when it is a single record and element-wise when it is an array. For a wrapped collection, apply to the inner array: `.transform((b, ex) => ({ ...b, items: keep(rules)(b.items, ex) }))`.
