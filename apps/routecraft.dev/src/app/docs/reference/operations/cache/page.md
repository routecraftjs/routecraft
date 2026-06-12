---
title: cache
titleBadges:
  - text: experimental
    color: green
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
cache(options?: CacheOptions): RouteBuilder<Current>
```

Cache and reuse the result of an expensive operation. When a cached value exists for the derived key, the body is replaced with the cached value and the wrapped operation is skipped. Only successful executions are cached; errors and dropped exchanges leave the cache untouched.

**Mental model:** Dual-mode. After `.from()` it wraps the immediately-next step. Before `.from()` it caches the entire route's terminal output keyed by the source message; on a hit the whole pipeline is skipped and the cached body is returned to the source.

```ts
// Default: key derived from body hash, process-wide in-memory provider
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
  .cache({ key: e => e.headers[FileHeaders.PATH] as string })
  // Cached per file path: an in-place edit of the same file reuses the
  // cached result until the TTL expires. Omit `key` to hash the body
  // (the file contents) instead, so edits produce a fresh key.
  .process(expensiveOperation)
  .to(destination)

// Custom provider (e.g. an isolated in-memory store, or future Redis)
import { MemoryCacheProvider } from '@routecraft/routecraft'

const provider = new MemoryCacheProvider({ max: 10_000, ttl: 60_000 })

craft()
  .id('file-processor')
  .from(fileWatcher())
  .cache({ provider, key: e => e.headers[FileHeaders.PATH] as string })
  .process(expensiveOperation)
  .to(destination)
```

**Options:**
- `key` (optional) - Function to derive the cache key from the exchange. If omitted, a key is derived by SHA-256 hashing `JSON.stringify(body)`. Supply an explicit `key` when the body is not JSON-serialisable or when a stable identity lives in headers.
- `ttl` (optional) - Time to live in milliseconds. After expiry, the next execution recomputes the value. When omitted, the provider's default expiry applies (the bundled in-memory provider keeps entries until LRU eviction).
- `provider` (optional) - A `CacheProvider` implementation. Defaults to a process-wide `MemoryCacheProvider` backed by `lru-cache`. Pass a custom provider to plug in Redis, multi-tier, or file-backed stores.

**Concurrency:** When multiple exchanges race against the same key, the provider's `getOrCompute` is responsible for deduplication. The bundled `MemoryCacheProvider` runs the wrapped step at most once per key per TTL window; concurrent waiters share the result.

**Caching semantics:**
- Only successful executions are cached. A wrapped step that throws propagates the error and writes nothing.
- `null` is a valid cached value; `undefined` is treated as "no value" and is never cached (the step recomputes next time).
- A cache hit replaces the body but does NOT replay the wrapped step's side effects (header writes, etc.); those only happen on a miss when the step actually runs.

**Ordering with `.error()`:** Place `.error()` OUTSIDE the cache (`.error(h).cache().to(d)`) so failures are handled without caching the fallback. Putting it inside (`.cache().error(h).to(d)`) caches the handler's recovery value, making a fallback the permanent answer for that key.

**Performance:** The default key hashes a JSON serialisation of the body on every exchange. For hot paths or large bodies, supply a `key` that returns a stable identifier already to hand (an id field, a content hash in a header) to avoid re-serialising and re-hashing.

**Custom providers:** Implement `CacheProvider` (`get`, `set`, `delete`, `has`, `getOrCompute`) and pass an instance via `cache({ provider })`. A future release will allow a global default to be set on `CraftConfig`.

## Route scope

Place `.cache()` BEFORE `.from()` to cache the entire route's terminal output (the body returned to the source) keyed by the source-emitted message.

```ts
craft()
  .id('weather')
  .cache({ ttl: 60_000 })
  .from(direct())
  .enrich(weatherApi)
  .transform(formatForecast)
  .to(noop())
```

On a hit, **the whole pipeline is skipped** (no `.enrich`, no `.transform`, no `.to`) and the cached body is returned to the caller as the route's result. On a miss, the pipeline runs and the terminal body is stored for next time. An additional `route:<id>:exchange:restored` event fires alongside `cache:hit` so dashboards can count restores separately.

**Side effects do not replay on a hit.** This is a much larger surface than step-scope: every `.to()`, `.tap()`, and `.header()` in the route is bypassed. If the route has destinations whose side effects must run on every input, use step-scope `.cache()` to wrap the expensive step instead.

**Routes with an unbalanced `.split()` are rejected at build time** with `RC5003`. A bare split produces multiple terminal exchanges with no single "result" to cache. A `.split()` balanced by a matching `.aggregate()` folds the children back into one terminal body and is fully supported: the aggregated value is what gets cached. Use step-scope `.cache()` to wrap the expensive step when you do want a fire-and-forget split.

**`.cache()` slots into the framework's pre-from filter chain at a fixed position.** Auth runs first (unauthenticated callers never see cached responses); parse and `.input()` validation run before the cache check (so stale-schema entries can't slip through); the cache hit-check sits just above the user pipeline; the cache write sits just below. See [Filter Chain](/docs/advanced/filter-chain) for the full chain, including reserved slots for `.throttle()`, `.circuitBreaker()`, `.retry()`, `.timeout()`.

**Cache key partitions the *data*, not the authorization.** Pick the key based on what the cached response represents:

```ts
// Shared role-gated data: every authorized caller sees the same list.
// Default body-hash key is correct.
craft()
  .id('list-employees')
  .authorize({ roles: ['hr'] })
  .cache({ ttl: 60_000 })
  .from(http({ path: '/employees' }))
  .enrich(loadEmployees)
  .to(noop())

// Per-user data: include the user identity in the key.
craft()
  .id('get-my-leave')
  .authorize()
  .cache({ ttl: 60_000, key: e => `leave:${e.principal?.subject}` })
  .from(http({ path: '/me/leave' }))
  .enrich(loadLeaveForUser)
  .to(noop())
```

This is the same pattern any application-level cache follows: the key reflects the data's identity, not the caller's permissions.

**Stampede protection:** route scope does NOT dedupe concurrent same-key callers in this release. Each concurrent caller runs the pipeline once before the cache is populated. Use step-scope `.cache()` around the expensive step if stampede dedupe matters.

**Failure mode:** provider read failures throw `RC5028` (retryable). Key derivation failures throw `RC5029` (not retryable). Provider write failures emit `cache:failed phase:"set"` but do NOT fail the exchange (the result was already computed and returned).
