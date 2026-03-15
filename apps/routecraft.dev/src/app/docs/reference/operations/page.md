---
title: Operations
---

DSL operators with signatures and examples. {% .lead %}

```ts
.id('my-route')
.batch()
.from(simple('x'))
.retry(3)
.transform((s) => s + '!')
.throttle({ requestsPerSecond: 10 })
.to(log())
```

## Operations overview

| Operation | Category | Description |
|-----------|----------|-------------|
| [`id`](#id) | Route | Set the unique identifier for the route |
| [`batch`](#batch) | Route | Process exchanges in batches instead of one at a time |
| [`error`](#error) | Route | Configure route-level error handling |
| [`from`](#from) | Route | Define the source of data for the capability |
| [`retry`](#retry) | Wrapper | Retry the next operation on failure {% badge %}wip{% /badge %} |
| [`throttle`](#throttle) | Wrapper | Rate limit the next operation {% badge %}wip{% /badge %} |
| [`cache`](#cache) | Wrapper | Cache and reuse results of the next operation {% badge %}wip{% /badge %} |
| [`sample`](#sample) | Flow Control | Take every Nth exchange or time-based sampling {% badge %}wip{% /badge %} |
| [`debounce`](#debounce) | Flow Control | Only pass exchanges after a quiet period {% badge %}wip{% /badge %} |
| [`timeout`](#timeout) | Wrapper | Cancel the next operation if it exceeds a duration {% badge %}wip{% /badge %} |
| [`delay`](#delay) | Wrapper | Add delay before the next operation {% badge %}wip{% /badge %} |
| [`onError`](#onError) | Wrapper | Handle errors from the next operation {% badge %}wip{% /badge %} |
| [`transform`](#transform) | Transform | Transform data using a function (body only) |
| [`map`](#map) | Transform | Map fields from source to target object |
| [`process`](#process) | Transform | Process data with full exchange access |
| [`header`](#header) | Transform | Set or override an exchange header |
| [`enrich`](#enrich) | Transform | Add additional data to current data |
| [`filter`](#filter) | Flow Control | Filter data based on predicate |
| [`validate`](#validate) | Flow Control | Validate data against schema |
| [`dedupe`](#dedupe) | Flow Control | Suppress duplicate exchanges based on a key {% badge %}wip{% /badge %} |
| [`choice`](#choice) | Flow Control | Route to different paths based on conditions {% badge %}wip{% /badge %} |
| [`split`](#split) | Flow Control | Split arrays into individual items |
| [`aggregate`](#aggregate) | Flow Control | Combine multiple items into single result |
| [`multicast`](#multicast) | Flow Control | Send exchange to multiple destinations {% badge %}wip{% /badge %} |
| [`loop`](#loop) | Flow Control | Repeat operations while condition is true {% badge %}wip{% /badge %} |
| [`tap`](#tap) | Side Effect | Fire-and-forget side effect, does not block the pipeline |
| [`to`](#to) | Side Effect | Send data to a destination adapter and end the pipeline |

## Route operations

Route operations configure the capability itself. `id`, `batch`, and `error` go before `from()` -- if called after an existing route, they are staged for the next `from()`. `from()` defines the source and creates the capability.

### id

```ts
id(routeId: string): RouteBuilder<Current>
```

Set the unique identifier for the next route. Place before `from()`. If called after a route already exists, it is staged and applies to the next `from()` (it does not rename the current route).

```ts
craft()
  .id('data-processor')
  .from(source)
  .to(destination)

// If called after an existing route, id() is staged for the next route
// (does not change the current route)
craft()
  .from(source)
  .id('next-route-id')
  .from(otherSource)
  .to(destination)
```

If no ID is specified, a random UUID will be generated automatically.

### batch

```ts
batch(options?: { size?: number; flushIntervalMs?: number }): RouteBuilder<Current>
```

Process exchanges in batches instead of one at a time. Useful for bulk operations like database inserts or API batch requests.

```ts
craft()
  .id('bulk-processor')
  .batch({ size: 50, flushIntervalMs: 5000 })
  .from(timer({ intervalMs: 1000 }))
  .to(saveToDB)
```

**Options:**
- `size` - Maximum exchanges per batch (default: 100)
- `flushIntervalMs` - Maximum wait time in milliseconds before flushing a partial batch (default: 5000ms)

{% callout type="note" title="Linting: route-level positioning" %}
Use the ESLint rule `@routecraft/routecraft/batch-before-from` to ensure `batch()` is placed **before** `.from()`. See [Linting Rules](/docs/reference/linting#batch-before-from).
{% /callout %}

{% callout type="warning" title="Incompatible with synchronous sources" %}
The `batch()` operation only works with asynchronous message sources like `timer()`. It **cannot** be used with `direct()` sources because direct endpoints are synchronous and blocking -- each sender waits for the consumer to fully process a message before the next can be sent, preventing message accumulation.

If you need to combine multiple messages from split branches, use the `aggregate()` operation instead.
{% /callout %}

### error

```ts
error(handler: (error: unknown, exchange: Exchange, forward: ForwardFn) => unknown | Promise<unknown>): this
```

Define a catch-all error handler for unhandled errors in the route's step pipeline. Must be called before `.from()`. When any step throws an unhandled error, this handler is invoked instead of the default log-and-swallow behavior. The pipeline does not resume after the handler runs; its return value becomes the route's final exchange body.

This is a **route-level configuration**, not a step wrapper. Convention is to place it near the top with other route-level options like `id()` and `batch()`.

The error handler receives:
- `error`: The thrown error (`unknown`, not necessarily a `RoutecraftError`)
- `exchange`: The exchange at the point of failure
- `forward`: A function to delegate to another route via the direct adapter: `(endpoint: RegisteredDirectEndpoint, payload: unknown) => Promise<unknown>`

The error handler can:
- Return nothing to silently handle the error
- Return a value to use as the route's final exchange body
- Call `forward(endpoint, payload)` to delegate to a direct route and return its result
- Rethrow the error to propagate it to the context level

```ts
// Log and swallow
craft()
  .id('with-error-handler')
  .error((error, exchange) => {
    exchange.logger.error(error, 'Step failed');
  })
  .from(source())
  .process(mightFail)
  .to(destination)

// Forward to a fallback route via the direct adapter
craft()
  .id('with-forward')
  .error((error, exchange, forward) => {
    return forward('error-route', { reason: (error as Error).message })
  })
  .from(source())
  .process(mightFail)
  .to(destination)

// Rethrow critical errors to context level
craft()
  .id('rethrow-critical')
  .error((error) => {
    if (error instanceof RoutecraftError && error.code === 'CRITICAL') throw error;
    // Non-critical errors are swallowed
  })
  .from(source())
  .process(mightFail)
  .to(destination)
```

**Error handling levels:**
1. **Route level**: `error()` handler catches all errors in the route (including tap errors via events)
2. **Context level**: Fallback for unhandled errors via `context.on('error', handler)`

**Note about tap errors:** Tap operations emit errors to the route error handler via events. The main exchange continues (tap is fire-and-forget), but the error is observable for logging and monitoring.

**Note about direct destinations:** Direct destinations with their own routes have their own error handlers. Errors in direct destinations are handled by their route's error handler, not the calling route.

### from

```ts
from<T>(src: Source<T> | CallableSource<T>): RouteBuilder<T>
```

Defines the source adapter and creates the capability. Must come after all other route-level operations (`id`, `batch`, `error`).

**Returns:** `RouteBuilder<T>` where `T` is the body type produced by the source.

```ts
.id('timer-route')
.from(timer({ intervalMs: 1000 }))

// Callable source (async function)
.id('data-fetcher')
.from(async () => await fetchData())
```

## Wrapper operations

Wrappers apply to the **next operation only** in outside-in order. See [Operations](/docs/introduction/operations#chaining-wrappers) for chaining semantics.

### retry {% badge %}wip{% /badge %}

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

### throttle {% badge %}wip{% /badge %}

```ts
throttle(options: { requestsPerSecond: number } | { requestsPerMinute: number }): RouteBuilder<Current>
```

Rate limit the next operation to prevent overwhelming downstream systems.

```ts
craft()
  .id('rate-limited-api')
  .from(source)
  .throttle({ requestsPerSecond: 10 })
  .process(apiCall) // API calls will be throttled to 10/second
  .to(destination)
```

### timeout {% badge %}wip{% /badge %}

```ts
timeout(timeoutMs: number): RouteBuilder<Current>
```

Wrap the next operation with a timeout. If the operation does not complete within the specified duration, it will be cancelled and a `TimeoutError` will be thrown.

```ts
craft()
  .id('timeout-protected')
  .from(source)
  .timeout(5000)
  .process(slowOperation) // Throws TimeoutError if slowOperation exceeds 5 seconds
  .to(destination)
```

See [chaining wrappers](#chaining-wrappers) for combining with `retry` or `onError`.

### delay {% badge %}wip{% /badge %}

```ts
delay(delayMs: number): RouteBuilder<Current>
```

Add a fixed delay before executing the next operation. Useful for rate limiting or adding processing delays.

```ts
craft()
  .id('delayed-processor')
  .from(source)
  .delay(1000)
  .process(operation) // Operation will execute after 1 second delay
  .to(destination)
```

### onError {% badge %}wip{% /badge %}

```ts
onError(handler: (error: Error, exchange: Exchange<Current>) => Exchange<Current> | void): RouteBuilder<Current>
```

Handle errors from the next operation. If the next operation fails, the error handler is invoked.

```ts
craft()
  .id('error-resilient')
  .from(source)
  .onError((error, exchange) => {
    logger.warn('Operation failed, using fallback', { error })
    return { ...exchange, body: { fallback: true } }
  })
  .transform(riskyOperation) // Errors from this transform will be handled
  .to(destination)
```

### cache {% badge %}wip{% /badge %}

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
- `key` (optional) - Function to derive the cache key from the exchange. If omitted, a key is derived by hashing the exchange body. See [default key derivation](#default-key-derivation).
- `ttl` - Time to live in milliseconds. After expiry, the next execution recomputes the value
- `scope` - What to cache: `'body'` (default) or `'exchange'` (body plus selected headers)

## Transform operations

### transform

```ts
transform<Next>(fn: Transformer<Current, Next> | CallableTransformer<Current, Next>): RouteBuilder<Next>
```

Transform the exchange body using a function. The function receives only the body and returns the new body.

```ts
.transform((body: string) => body.toUpperCase())
.transform(async (user) => await enrichUserData(user))
```

### header

```ts
header(key: string, valueOrFn: HeaderValue | ((exchange: Exchange<Current>) => HeaderValue | Promise<HeaderValue>)): RouteBuilder<Current>
```

Set or override a header on the exchange. The body remains unchanged.

```ts
// Static header
.header('x-env', 'prod')

// Derived from body
.header('user.id', (exchange) => exchange.body.id)

// Derived from headers
.header('correlation', (exchange) => exchange.headers['x-request-id'])

// Async derived value
.header('request.trace', async (exchange) => await computeTrace(exchange.body))

// Override an existing header later in the chain
.header('x-env', 'staging')
```

### map

```ts
map<Return>(fieldMappings: Record<keyof Return, (src: Current) => Return[keyof Return]>): RouteBuilder<Return>
```

Map fields from the current data to create a new object of a specified type. This is a specialized transformer that creates a new object by mapping fields from the source object.

```ts
// Map from API response to database model
.map<DbUser>({
  id: (apiUser) => apiUser.userId,
  name: (apiUser) => apiUser.fullName,
  email: (apiUser) => apiUser.emailAddress
})

// Transform with computed fields
.map<Summary>({
  fullName: (user) => `${user.firstName} ${user.lastName}`,
  isActive: (user) => user.status === 'active',
  displayEmail: (user) => user.email.toLowerCase()
})

// Map complex nested data
.map<OrderSummary>({
  orderId: (order) => order.id,
  customerName: (order) => order.customer.name,
  totalAmount: (order) => order.items.reduce((sum, item) => sum + item.price, 0),
  itemCount: (order) => order.items.length
})
```

### process

```ts
process<Next = Current>(fn: Processor<Current, Next> | CallableProcessor<Current, Next>): RouteBuilder<Next>
```

Process the exchange with full access to headers, body, and context. Use when you need more control than `transform`.

```ts
.process((exchange) => {
  const userId = exchange.headers.get('user-id')
  return {
    ...exchange.body,
    processedBy: userId,
    timestamp: new Date().toISOString()
  }
})
```

### enrich

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

**`only(getValue, into?)`** — Returns an aggregator that merges one value from the enrichment result. Omit `into` to spread a plain object onto the body, or use fallbacks: string → `body.text`, array → `body.array`. Provide `into` to set `body[into]`. Values that are `null` or `undefined` are never merged (exchange unchanged).

**Key difference from `.to()`:**

- `.to()` replaces the body if the destination returns a value (not `undefined`)
- `.enrich()` merges the result into the body by default

Both operations use the same `Destination` adapters - the difference is only in how the result is applied.

## Flow control operations

### filter

```ts
filter(fn: Filter<Current> | CallableFilter<Current>): RouteBuilder<Current>
```

Filter exchanges based on a predicate. The predicate receives the full `Exchange` object, allowing you to filter based on headers, body, or other exchange properties. Only exchanges that return `true` continue through the route.

```ts
// Filter based on body properties
.filter((exchange) => exchange.body.isActive)
.filter(async (exchange) => await isValidOrder(exchange.body))

// Filter based on headers
.filter((exchange) => exchange.headers['x-priority'] === 'high')
.filter((exchange) => exchange.headers['user-role'] === 'admin')

// Filter based on multiple criteria
.filter((exchange) => 
  exchange.body.status === 'active' && 
  exchange.headers['x-environment'] === 'production'
)
```

{% callout type="note" title="Filter vs Transform" %}
Unlike `.transform()` which receives only the body, `.filter()` receives the full `Exchange` object. This allows filtering based on headers, correlation IDs, or other exchange metadata, not just the message body.
{% /callout %}

### validate

```ts
validate(schema: StandardSchemaV1): RouteBuilder<Current>
```

Validate the exchange body against a schema. Invalid exchanges will cause the capability to emit an error event.

```ts
import { z } from 'zod'

const userSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  age: z.number().min(0)
})

.validate(userSchema)
```

### dedupe {% badge %}wip{% /badge %}

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
  .dedupe({ key: e => e.headers[HeadersKeys.FILE_CONTENT_HASH] as string })
  .process(expensiveProcessing) // Skip files already processed
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

### choice {% badge %}wip{% /badge %}

```ts
choice<T = Current>(routes: Array<{ when: (body: Current) => boolean; then: RouteBuilder<T> }>): RouteBuilder<T>
```

Route exchanges to different processing paths based on conditions. Like a switch statement for data flows.

```ts
.choice([
  {
    when: (order) => order.priority === 'urgent',
    then: craft().transform(priorityProcessing).to(urgentQueue)
  },
  {
    when: (order) => order.amount > 1000,
    then: craft().transform(highValueProcessing).to(reviewQueue)
  },
  {
    when: () => true, // default case
    then: craft().to(standardQueue)
  }
])
```

### split

```ts
split<Item = Current extends Array<infer U> ? U : never>(
  fn?: Splitter<Current, Item> | (exchange: Exchange<Current>) => Exchange<Item>[]
): RouteBuilder<Item>
```

Fan-out into multiple exchanges. Use `.split(adapter | (exchange) => Exchange[])` so splitters can be exchange-aware. Each returned exchange is processed independently.

If no splitter is provided, array bodies are split into one exchange per element; non-array bodies become a single exchange. The framework maintains `routecraft.split_hierarchy` headers for aggregation.

```ts
// Split array automatically
.split() // [1, 2, 3] becomes three exchanges: 1, 2, 3

// Exchange-aware: extract nested array and return exchanges
.split((exchange) =>
  exchange.body.items.map((body) =>
    new DefaultExchange(getExchangeContext(exchange)!, { body, headers: exchange.headers })
  )
)

// Split string by delimiter (return exchanges)
.split((exchange) =>
  exchange.body.split(",").map((body) =>
    new DefaultExchange(getExchangeContext(exchange)!, { body, headers: exchange.headers })
  )
)
```

**Key behaviors:**
- Splitter receives the full exchange and returns an array of exchanges
- Framework overlays `routecraft.split_hierarchy` and assigns new ids
- Each split exchange is processed independently; aggregate to combine results

### aggregate

```ts
aggregate<R>(fn?: Aggregator<Current, R> | CallableAggregator<Current, R>): RouteBuilder<R>
```

Combine multiple exchanges into a single result. Useful after `split` to recombine processed items.

If no aggregator is provided, exchange bodies are automatically collected into an array. **If any body is an array, all arrays are flattened and combined with scalar values into a single flattened array.**

```ts
// Automatically collect bodies into an array
.split()
.process((exchange) => ({ ...exchange, body: exchange.body * 2 }))
.aggregate() // Returns array of processed items: [2, 4, 6]

// Arrays are automatically flattened
// Input: [1, [2, 3], 4, [5, 6]]
// Output: [1, 2, 3, 4, 5, 6] (flattened)

// Mixed arrays and scalars are combined
// Input: [[1, 2], 3, [4, 5]]
// Output: [1, 2, 3, 4, 5] (arrays flattened, scalars added)

// Custom aggregation logic
.aggregate((items) => ({
  totalCount: items.length,
  processedAt: new Date().toISOString(),
  items
}))
```

### multicast {% badge %}wip{% /badge %}

```ts
multicast(destinations: Array<RouteBuilder<any>>): RouteBuilder<Current>
```

Send the same exchange to multiple destinations simultaneously. Each destination receives a copy of the exchange.

```ts
.multicast([
  craft().to(database),
  craft().to(auditLog),
  craft().transform(formatForAnalytics).to(analyticsService)
])
```


### loop {% badge %}wip{% /badge %}

```ts
loop(condition: (body: Current, iteration: number) => boolean, maxIterations?: number): RouteBuilder<Current>
```

Repeat the subsequent operations while the condition remains true. Includes safeguards to prevent infinite loops.

```ts
.loop(
  (data, iteration) => data.hasMore && iteration < 10,
  10 // max iterations safeguard
)
.transform(processPage)
.process(fetchNextPage)
```

### sample {% badge %}wip{% /badge %}

```ts
sample(options: { every?: number; intervalMs?: number }): RouteBuilder<Current>
```

Take every Nth exchange or sample at time intervals. Useful for reducing data volume while maintaining representativeness.

```ts
// Take every 5th exchange
.sample({ every: 5 })

// Sample every 10 seconds (first exchange in each window)
.sample({ intervalMs: 10000 })

// Typical use: Reduce high-frequency data
.id('metrics-sampling')
.from(direct('high-frequency-metrics', {}))
.sample({ every: 100 }) // Only process 1% of metrics
.to(database({ operation: 'save' }))
```

### debounce {% badge %}wip{% /badge %}

```ts
debounce(options: { quietMs: number }): RouteBuilder<Current>
```

Only pass exchanges after a specified quiet period with no new exchanges. Useful for handling bursts of similar events.

```ts
// Wait for 1 second of quiet before processing
.debounce({ quietMs: 1000 })

// Typical use: Batch file system changes
.id('file-watcher')
.from(file({ path: './config', watch: true }))
.debounce({ quietMs: 500 }) // Wait for editing to finish
.process(reloadConfig)
```

## Side effects

### tap

```ts
tap(destination: Destination<Current, unknown> | CallableDestination<Current, unknown>): RouteBuilder<Current>
```

Execute side effects without changing the exchange. The tap operation is **async fire-and-forget** - it runs in the background and never blocks the main route. Return values are ignored.

The tap receives a **deep copy** of the exchange with:
- New exchange ID
- Cloned body and headers
- Correlation ID preserved for traceability back to parent exchange

```ts
// Simple function-based tapping
.tap(log()) // Built-in logging
.tap((exchange) => console.log('Processing:', exchange.body))
.tap(async (exchange) => await sendNotification(exchange.body))

// Multiple taps for different concerns
.tap(analytics())
.tap(monitoring())
.to(primaryDestination)
```

**Key behaviors:**
- **Async fire-and-forget**: Main route continues immediately without waiting
- **Exchange snapshot**: Tap receives a deep copy with new ID and correlation metadata
- **Return values ignored**: Any value returned by the tap destination is discarded
- **Error isolation**: Errors in tap are emitted to the route error handler but don't halt the main exchange (already fire-and-forget)
- **Lifecycle aware**: Routes and context wait for all taps to complete during shutdown via `drain()`
- **Perfect for**: Logging, auditing, notifications, analytics, monitoring

**Lifecycle:**
- Routes complete without waiting for taps
- Taps are tracked by the route and waited for during `drain()`
- `context.stop()` automatically calls `context.drain()` to wait for all tap jobs
- Ensures all async work finishes before shutdown completes


### to

```ts
to<R = void>(
  destination: Destination<Current, R> | CallableDestination<Current, R>
): RouteBuilder<R>
```

Send the exchange to a destination. If the destination returns `undefined`, the exchange continues unchanged. If it returns a value, the exchange body is replaced with that value.

**Destinations returning void (side-effect only):**

```ts
.to(log()) // Log the final result
.to(saveToDB) // Insert into database, returns void
.to(async (exchange) => {
  await sendToWebhook(exchange);
  // No return = undefined = body unchanged
})
```

**Destinations returning data (body replacement):**

When a destination returns a value (not `undefined`), the exchange body is **replaced** with that value.

```ts
// http returns HttpResult - body becomes HttpResult
.to(http({ url: 'https://api.example.com/transform' }))

// Custom adapter returns ID - body becomes the ID
.to(saveToDBReturnID)

// Custom transformation
.to(async (exchange) => {
  const result = await processData(exchange.body);
  return result; // Body replaced with result
})
```

**Chaining .to() calls:**

```ts
// Each .to() can transform the body if it returns a value
.to(async (ex) => ({ ...ex.body, step: 1 }))
.to(async (ex) => ({ ...ex.body, step: 2 }))
// Body accumulates changes from each .to() that returns data

// Mix side-effects and transformations
.to(saveToDB) // Returns void, body unchanged
.to(http({ url: 'https://api.example.com/enrich' })) // Body becomes HttpResult
.to(log()) // Logs the HttpResult
```

**Note:** Unlike `.enrich()`, `.to()` does not merge results. If the destination returns a value, it completely replaces the body.

{% callout type="warning" title="Multiple .to() per route not recommended" %}
While technically possible, using multiple `.to()` operations in a single route is not advised. We recommend one `.to()` per route for clarity. Consider using `.enrich()` for intermediate data fetching or `.tap()` for side effects.

An ESLint rule `@routecraft/routecraft/single-to-per-route` is available to warn when multiple `.to()` operations are used.
{% /callout %}
