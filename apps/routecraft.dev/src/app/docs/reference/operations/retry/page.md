---
title: retry
titleBadges:
  - text: planned
    color: purple
---

[← All operations](/docs/reference/operations) {% .lead %}

```ts
retry(options?: {
  maxAttempts?: number;
  backoffMs?: number;
  exponential?: boolean;
  retryOn?: (error: Error) => boolean;
}): RouteBuilder<Current>
```

Retry the next operation on failure. The retry logic wraps whatever operation comes next.

```ts
craft()
  .id('resilient-processor')
  .from(source)
  .retry({ maxAttempts: 3, backoffMs: 1000, exponential: true })
  .transform(unreliableTransformation) // This transform will be retried
  .to(destination)
```

**Parameters:**
- `maxAttempts` - Maximum retry attempts (default: 3)
- `backoffMs` - Base delay between retries (default: 1000ms)
- `exponential` - Use exponential backoff (default: false)
- `retryOn` - Predicate to determine if an error should trigger a retry (see default behavior below)

#### Default retry behavior

By default, `retry` checks the error's `retryable` property:

```ts
// Default retryOn logic
(error) => {
  if (error instanceof RoutecraftError && error.retryable === false) {
    return false;
  }
  return true;
}
```

This means:
- Errors with `retryable: false` are **not retried** (e.g., validation errors, timeout errors)
- Errors with `retryable: true` or no `retryable` property **are retried**
- Unknown/third-party errors **are retried** (optimistic default)

See the [errors reference](/docs/reference/errors) for which errors are retryable by default.

Override with a custom predicate when needed:

```ts
// Retry everything, including non-retryable errors
craft()
  .id('retry-all')
  .from(source)
  .retry({ maxAttempts: 3, retryOn: () => true })
  .process(operation)
  .to(destination)

// Retry only timeout errors
craft()
  .id('retry-timeout-only')
  .from(source)
  .retry({ maxAttempts: 3, retryOn: (e) => e.name === 'TimeoutError' })
  .timeout(5000)
  .process(slowOp)
  .to(destination)
```
