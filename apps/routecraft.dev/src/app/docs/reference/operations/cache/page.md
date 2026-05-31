---
title: cache
titleBadges:
  - text: planned
    color: purple
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
cache(options?: CacheOptions): RouteBuilder<Current>
```

Cache and reuse the result of an expensive operation. When a cached value exists for the derived key, it replaces the body and the wrapped operation is skipped. Only successful executions are cached.

**Mental model:** A wrapper around the next operation. Similar to `retry`, but driven by duplicate input rather than failure.

```ts
// Default: key derived from body hash
craft()
  .id('document-processor')
  .from(source)
  .cache()
  .process(expensiveOperation) // Result is cached per body content
  .to(destination)

// With TTL (key still derived from body)
craft()
  .id('document-processor')
  .from(source)
  .cache({ ttl: 3600000 })
  .process(expensiveOperation) // Cached for 1 hour
  .to(destination)

// Explicit key function for stable identity
craft()
  .id('file-processor')
  .from(fileWatcher())
  .cache({ key: e => e.headers[HeadersKeys.FILE_CONTENT_HASH] as string })
  .process(expensiveOperation) // Result is cached per file content hash
  .to(destination)

// Both key and TTL
craft()
  .id('file-processor')
  .from(fileWatcher())
  .cache({ key: e => e.headers[HeadersKeys.FILE_CONTENT_HASH] as string, ttl: 3600000 })
  .process(expensiveOperation) // Cached for 1 hour per file content hash
  .to(destination)
```

**Options:**
- `key` (optional) - Function to derive the cache key from the exchange. If omitted, a key is derived by hashing the exchange body.
- `ttl` - Time to live in milliseconds. After expiry, the next execution recomputes the value
- `scope` - What to cache: `'body'` (default) or `'exchange'` (body plus selected headers)
