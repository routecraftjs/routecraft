---
title: dedupe
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
dedupe(options?: DedupeOptions): RouteBuilder<Current>
```

Suppress duplicate exchanges based on a key. Duplicate exchanges do not continue downstream - no result is returned and no side effects occur.

**Mental model:** A persistent, stateful filter. Similar to `filter`, but maintains state across runs to track which keys have been processed.

```ts
// Default: key derived from body hash
craft()
  .id('event-processor')
  .from(eventSource())
  .dedupe() // Skip duplicate events based on body content
  .process(handleEvent)
  .to(destination)

// Explicit key function for stable identity
craft()
  .id('file-processor')
  .from(fileWatcher())
  .dedupe({ key: e => e.headers[FileHeaders.PATH] as string })
  // Process each path at most once. An in-place edit of a seen path is
  // also skipped; omit `key` to dedupe on the body (file contents) when
  // changed content should be reprocessed.
  .process(expensiveProcessing)
  .to(destination)

// Bound memory on a long-running route with a TTL
craft()
  .id('idempotent-consumer')
  .from(queue())
  .dedupe({ key: e => e.body.eventId, ttl: 3_600_000 }) // remember keys for 1h
  .process(handleEvent)
  .to(destination)
```

**Options:**
- `key` (optional) - Function to derive the deduplication key from the exchange. If omitted, a key is derived by hashing the exchange body. See [default key derivation](#default-key-derivation).
- `ttl` (optional) - Time to live in milliseconds for a committed key. After expiry, the next exchange with that key is treated as new and passes again. When omitted, committed keys are retained until LRU eviction at `maxKeys`. This is the memory bound for long-running routes.
- `maxKeys` (optional) - Maximum number of committed keys retained per route (an LRU). Default `10_000`. Keeps memory bounded even without a `ttl`; the least-recently-committed key is evicted, and its next occurrence passes as new.

**Semantics:**
- Key is reserved immediately on entry (single-flight: a second exchange with the same key that arrives while the first is still in flight is dropped).
- If the key is already reserved or committed, the exchange is dropped.
- The reservation is committed when the exchange finishes the route (`route:exchange:completed` or `:dropped`), so future occurrences are recognised as duplicates.
- On failure (`route:exchange:failed`), the reservation is released, so an errored input is not permanently suppressed and a re-send may try again.

**Events:**
- `route:operation:dedupe:pass` - emitted when an unseen key is reserved, with the derived `key`.
- `route:operation:dedupe:duplicate` - emitted when a duplicate is suppressed, with the `key`. A `route:exchange:dropped` event (reason `"duplicate"`) also fires.

**Purpose:**
- Skip unchanged files
- Prevent duplicate work
- Prevent duplicate side effects

{% callout type="note" title="dedupe vs filter vs cache" %}
`filter` is stateless - each exchange is evaluated independently based on a predicate. `dedupe` is stateful across runs - duplicates are dropped entirely. `cache` is also stateful across runs - duplicates return the cached result instead of being dropped.

Use `dedupe` when duplicates should do nothing. Use `cache` when duplicates should return the same result.
{% /callout %}

{% callout type="note" title="Per-instance state in 0.6.0" %}
Dedupe state is in-memory and scoped to a single route instance. Across multiple instances of the same route (for example, several processes consuming the same queue), each instance dedupes independently. Cross-instance idempotency, via a shared store provider, is a planned addition.
{% /callout %}

**Default key derivation:**

When `dedupe` or `cache` is called without a `key` function, a key is derived automatically by SHA-256 hashing the JSON serialisation of the body:

```
key = sha256(JSON.stringify(body))
```

The key is computed from the body at the moment the operation executes. If the body changes at different points in the route, the derived key will differ. Object key order is preserved by `JSON.stringify`, so two objects with the same entries in a different order hash differently; supply an explicit `key` when a stable identity must survive key reordering.

**Unsupported bodies (throw an error):**

The default key fails on bodies that are not JSON-serialisable:

- Functions, symbols, or a top-level `undefined`
- `BigInt`
- Circular references

When the body is not serialisable, a `RoutecraftError` (`RC5033` for `dedupe`, `RC5029` for `cache`) is thrown, indicating that a `key` function is required.

{% callout type="note" title="When to provide a key function" %}
Use an explicit `key` when you need stable identity across body changes. For example, if the body is enriched or transformed before `dedupe` / `cache`, but identity should be based on a header set earlier by an adapter. A `key` that returns an identifier already to hand (an id field, a content hash in a header) also avoids re-serialising and re-hashing the body on every exchange.
{% /callout %}
