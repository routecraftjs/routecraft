---
title: dedupe
titleBadges:
  - text: planned
    color: purple
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
```

**Options:**
- `key` (optional) - Function to derive the deduplication key from the exchange. If omitted, a key is derived by hashing the exchange body. See [default key derivation](#default-key-derivation).

**Semantics:**
- Key is reserved immediately (single-flight behavior)
- If the key is already reserved or committed, the exchange is dropped
- Key is committed only after the full route completes successfully
- On failure, the reservation is released or expires

**Purpose:**
- Skip unchanged files
- Prevent duplicate work
- Prevent duplicate side effects

{% callout type="note" title="dedupe vs filter vs cache" %}
`filter` is stateless - each exchange is evaluated independently based on a predicate. `dedupe` is stateful across runs - duplicates are dropped entirely. `cache` is also stateful across runs - duplicates return the cached result instead of being dropped.

Use `dedupe` when duplicates should do nothing. Use `cache` when duplicates should return the same result.
{% /callout %}

**Default key derivation:**

When `dedupe` or `cache` is called without a `keyFn`, a key is derived automatically by hashing the exchange body:

```
key = sha256(encode(body))
```

The key is computed from the body at the moment the operation executes. If the body changes at different points in the route, the derived key will differ.

**Supported body types:**

| Type | Encoding |
|------|----------|
| `Buffer`, `Uint8Array`, `ArrayBuffer` | Hash raw bytes directly |
| `string` | UTF-8 encode, then hash |
| Object or array | Canonicalize (sort keys lexicographically at every level), then hash as JSON |
| Scalars (`string`, `boolean`, `null`, finite `number`) | Hash as JSON |

**Unsupported types (will throw an error):**

- `NaN`, `Infinity`, `-Infinity`
- Functions, symbols, `BigInt`
- `Date` or class instances (unless pre-converted to JSON-safe primitives)
- Circular references
- Streams (must be materialized to bytes/string/JSON first, or provide a `keyFn`)

When the body contains an unsupported type, a `RoutecraftError` is thrown indicating that a `keyFn` is required.

{% callout type="note" title="When to provide a keyFn" %}
Use an explicit `keyFn` when you need stable identity across body changes. For example, if the body is enriched or transformed before `dedupe`/`cache`, but identity should be based on a header set earlier by an adapter.
{% /callout %}
