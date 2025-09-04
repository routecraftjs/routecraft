---
title: Errors
---

Error policy, codes, and docsUrl contract. {% .lead %}

Codes live in `packages/routecraft/src/error.ts` as `ErrorCode`.

docsUrl contract: every thrown `RouteCraftError` should include a `docs` URL pointing to an anchor explaining the fix.

## Error format

All RouteCraft errors follow this format:

```
[ERROR_CODE] Error message
Suggestion: How to fix the issue
Docs: https://routecraft.dev/docs/reference/errors#anchor
Caused by: Original error (if any)
```

## Route definition errors

### INVALID_ROUTE_DEFINITION {#invalid-route-definition}

Thrown when a route has no source adapter configured.

**Fix:** Ensure every route has a valid source by calling `.from(adapter)`.

```ts
// ❌ Bad: No source defined
craft().id('my-route').to(log())

// ✅ Good: Source defined
craft().id('my-route').from(timer()).to(log())
```

### DUPLICATE_ROUTE_DEFINITION {#duplicate-route-definition}

Thrown when multiple routes have the same ID within a context.

**Fix:** Ensure all route IDs are unique across your application.

```ts
// ❌ Bad: Duplicate IDs
craft().id('processor').from(source1).to(dest1)
craft().id('processor').from(source2).to(dest2)

// ✅ Good: Unique IDs
craft().id('user-processor').from(source1).to(dest1)
craft().id('order-processor').from(source2).to(dest2)
```

### MISSING_FROM_DEFINITION {#missing-from-definition}

Thrown when route operations are called before defining a source.

**Fix:** Call `.from(adapter)` before adding processing steps.

```ts
// ❌ Bad: Transform before source
craft().transform(x => x).from(timer())

// ✅ Good: Source first
craft().from(timer()).transform(x => x)
```

### INVALID_OPERATION_TYPE {#invalid-operation-type}

Thrown when an operation receives invalid input data.

**Fix:** Ensure data types match operation requirements (e.g., arrays for split operation).

```ts
// ❌ Bad: Non-array passed to split()
craft().from(simple('string')).split().to(log())

// ✅ Good: Array passed to split()
craft().from(simple(['a', 'b', 'c'])).split().to(log())
```

## Runtime operation errors

### SOURCE_ERROR {#source-error}

Thrown when a source adapter fails during subscription or message production.

**Fix:** Check source adapter configuration and ensure external dependencies (databases, APIs, files) are accessible.

```ts
// Common causes:
// - File not found for file() adapter
// - Network issues for http() adapter
// - Invalid connection strings for database adapters
```

### PROCESSING_ERROR {#processing-error}

Thrown when a processor adapter fails during exchange processing.

**Fix:** Check processor logic and ensure input data is valid.

### DESTINATION_ERROR {#destination-error}

Thrown when a destination adapter fails to send data.

**Fix:** Verify destination configuration and connectivity.

```ts
// Common causes:
// - Permission issues writing files
// - Network problems sending HTTP requests
// - Database connection failures
```

### SPLITTING_ERROR {#splitting-error}

Thrown when split operations fail to process exchanges.

**Fix:** Ensure split function handles input data correctly and returns valid arrays.

```ts
// ❌ Bad: Split function throws
.split((data) => data.invalidProperty.split(','))

// ✅ Good: Safe split function
.split((data) => data?.items || [])
```

### AGGREGATION_ERROR {#aggregation-error}

Thrown when aggregate operations fail to combine exchanges.

**Fix:** Check aggregation logic and ensure it can handle the expected data types.

### TRANSFORMING_ERROR {#transforming-error}

Thrown when transform operations fail to process exchanges.

**Fix:** Ensure transform functions handle all possible input values gracefully.

```ts
// ❌ Bad: Transform assumes structure
.transform((data) => data.user.name.toUpperCase())

// ✅ Good: Safe transform
.transform((data) => data?.user?.name?.toUpperCase() || 'Unknown')
```

### TAPPING_ERROR {#tapping-error}

Thrown when tap operations (side effects) fail.

**Fix:** Ensure tap functions don't throw errors that would interrupt the main flow.

```ts
// ✅ Good: Error handling in tap
.tap(async (data) => {
  try {
    await sendNotification(data)
  } catch (error) {
    logger.warn('Notification failed', { error })
  }
})
```

### FILTER_ERROR {#filter-error}

Thrown when filter predicate functions fail.

**Fix:** Ensure filter functions handle all input types and return boolean values.

```ts
// ❌ Bad: Filter can throw
.filter((data) => data.status === 'active')

// ✅ Good: Safe filter
.filter((data) => data?.status === 'active')
```

### VALIDATE_ERROR {#validate-error}

Thrown when validation schemas fail or validation functions throw errors.

**Fix:** Ensure validation schemas match your data structure and handle validation failures gracefully.

```ts
import { z } from 'zod'

// ✅ Good: Proper schema definition
const userSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  age: z.number().min(0).optional()
})

.validate(userSchema)
```

## Runtime and lifecycle errors

### ROUTE_COULD_NOT_START {#route-could-not-start}

Thrown when a route fails to start, typically due to being aborted before startup.

**Fix:** Ensure routes are not aborted before starting them.

```ts
// ❌ Bad: Route aborted before start
const ctx = context().routes(myRoute).build()
await ctx.stop() // This aborts routes
await ctx.start() // This will throw ROUTE_COULD_NOT_START

// ✅ Good: Clean startup
const ctx = context().routes(myRoute).build()
await ctx.start()
```

### CONTEXT_COULD_NOT_START {#context-could-not-start}

Thrown when the context fails to start due to configuration or route issues.

**Fix:** Check context configuration and ensure all routes are valid before starting.

```ts
// Common causes:
// - Invalid route definitions
// - Duplicate route IDs
// - Missing route sources
// - Resource conflicts (e.g., port already in use)
```

### UNKNOWN_ERROR {#unknown-error}

Fallback error code for unexpected errors that don't match specific error types.

**Fix:** Check the underlying error details and stack trace to identify the root cause.

```ts
// This error includes the original error as 'cause'
// Check error.cause for the underlying issue
```
