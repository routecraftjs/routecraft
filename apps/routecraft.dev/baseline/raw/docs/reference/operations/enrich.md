# enrich

[← All operations](/docs/reference/operations)

```ts
enrich<R>(
  enricher: Enricher<Current, R> | CallableEnricher<Current, R>,
  aggregator?: (original: Exchange<Current>, result: R) => Exchange<...>
): RouteBuilder<...>
```

Enrich the exchange with data pulled in by an enricher (an adapter with a `fetch` slot, or a function that returns a value). With no aggregator the fetched value **replaces** the body; pass an aggregator (`only()`, `none()`, or a custom function) to merge instead.

> **Warning: Replace is the default**
>
> Bare `.enrich(x)` replaces the body with the fetched value. Under the old role model the default merged (spread) the result into the body; that merge behavior is now opt-in via `only()` or a custom aggregator, and the former `replace()` helper is gone because replace is the default.

**Note:** `.to()` and `.tap()` accept the same enrichers: `.to()` replaces the body with the result and takes no aggregator, `.tap()` discards it. Use `.enrich()` when you want control over how the result lands on the body.

**`undefined` vs `null`:** a fetch resolving `undefined` means "no value" and leaves the body unchanged (the inferred body type becomes the union of the previous body and the defined results). Return `null` when a miss should be an observable replacement value, e.g. `(ex) => cache.get(key) ?? null`.

**Default behavior (result replaces the body):**

```ts
// Enrich with inline function - the returned value becomes the body
.enrich(async (exchange) => ({
  profile: await fetchUserProfile(exchange.body.userId),
  permissions: await getUserPermissions(exchange.body.userId)
}))

// Enrich using the http client - the body becomes HttpResult
.enrich(http({
  url: (ex) => `https://api.example.com/users/${ex.body.userId}`
}))

// Enrich using any enricher adapter
.enrich(file({ path: './config.txt' })) // body becomes the file content
```

**Merging with `only(getValue, into?)`:**

```ts
// Merge a single extracted value under a key (body type becomes Current & { userName: ... })
.enrich(http({ url: 'https://api.example.com/user' }), only((r) => r.body?.name, "userName"))

// Omit `into` to spread a plain object onto the body
.enrich(http({ url: 'https://api.example.com/profile' }), only((r) => r.body))
```

`only()` returns an aggregator that merges one value from the enrichment result. Omit `into` to spread a plain object onto the body, or use fallbacks: primitive → `body.stdout`, array → `body.array`. Provide `into` to set `body[into]`. Values that are `null` or `undefined` are never merged (exchange unchanged).

**Ignoring the result with `none()`:**

`none()` returns a no-op aggregator that leaves the exchange unchanged, so the enrichment result is ignored. Use it when you only need the fetch's side effect (warming a cache, pinging an API) while still gating the pipeline on it.

```ts
.enrich(http({ url: "https://api.example.com/ping" }), none())
```

**Custom aggregation:**

A custom aggregator receives the original exchange and the fetched value, and returns the (derived) exchange.

```ts
// Store result under a specific key
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
```

**Key difference from `.to()`:**

- `.to()` with a destination (send) leaves the body unchanged; with an enricher (fetch) it replaces the body. No aggregator.
- `.enrich()` always resolves the fetch slot, and the aggregator decides how the result lands: replace (default), merge (`only()` / custom), or ignore (`none()`).

Enrichment pulls data in. Push-out sends (`mail()`, file writes, `log()`) belong in `.to()` / `.tap()`; passing a send-only destination to `.enrich()` throws `RC5003`.
