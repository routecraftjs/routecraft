---
title: enrich
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
enrich<R = Current>(
  destination: Destination<Current, Partial<R>> | CallableDestination<Current, Partial<R>>,
  aggregator?: (original: Exchange<Current>, result: Partial<R>) => Exchange<R>
): RouteBuilder<R>
```

Enrich the exchange with additional data from a destination adapter. Uses the same adapters as `.to()` but with a merge-by-default aggregator that combines the result with the original body.

**Note:** `.to()` ignores results by default or replaces the body if a value is returned. Use `.enrich()` when you want to merge data into the body.

**Default behavior (merge result into body):**

```ts
// Enrich with inline function
.enrich(async (exchange) => ({
  profile: await fetchUserProfile(exchange.body.userId),
  permissions: await getUserPermissions(exchange.body.userId)
}))

// Enrich using http adapter
.enrich(http({ 
  url: (ex) => `https://api.example.com/users/${ex.body.userId}` 
}))

// Enrich using any destination adapter
.enrich(lookupUser)
```

**Custom aggregation:**

```ts
// Store result under specific key
.enrich(
  http({ url: 'https://api.example.com/profile' }),
  (original, result) => ({
    ...original,
    body: { ...original.body, profileData: result.body }
  })
)

// Only extract specific fields
.enrich(
  http({ url: 'https://api.example.com/user' }),
  (original, result) => ({
    ...original,
    body: { ...original.body, userName: result.body.name }
  })
)

// Use only(getValue, into?) to merge a single extracted value without writing a custom aggregator
.enrich(http({ url: 'https://api.example.com/user' }), only((r) => r.body?.name, "userName"))
```

**`only(getValue, into?)`**: Returns an aggregator that merges one value from the enrichment result. Omit `into` to spread a plain object onto the body, or use fallbacks: primitive → `body.stdout`, array → `body.array`. Provide `into` to set `body[into]`. Values that are `null` or `undefined` are never merged (exchange unchanged).

**`none()`**: Returns a no-op aggregator that leaves the exchange unchanged, so the enrichment result is ignored. Use it when you only need the destination's side effect (logging, firing an API call) and do not want to merge its return value.

```ts
.enrich(http({ url: "https://api.example.com/ping" }), none())
```

**`replace()`** (experimental): Returns an aggregator that replaces the body with the enrichment result instead of merging it. Use it when the enrichment returns the value you want as the new body.

```ts
.enrich(mail({ folder: "INBOX", unseen: true }), replace())
// body becomes MailMessage[] (the raw enrichment result)
```

**Key difference from `.to()`:**

- `.to()` replaces the body if the destination returns a value (not `undefined`)
- `.enrich()` merges the result into the body by default

Both operations use the same `Destination` adapters - the difference is only in how the result is applied.
