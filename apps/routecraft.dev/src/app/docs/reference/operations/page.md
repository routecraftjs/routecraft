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
| [`from`](#from) | Source | Define the source of data for the route |
| [`retry`](#retry) | Wrapper | Retry the next operation on failure |
| [`throttle`](#throttle) | Wrapper | Rate limit the next operation |
| [`sample`](#sample) | Transform | Take every Nth exchange or time-based sampling |
| [`debounce`](#debounce) | Transform | Only pass exchanges after a quiet period |
| [`timeout`](#timeout) | Wrapper | Add timeout to the next operation |
| [`delay`](#delay) | Wrapper | Add delay before the next operation |
| [`onError`](#onError) | Wrapper | Handle errors from the next operation |
| [`transform`](#transform) | Transform | Transform data using a function (body only) |
| [`map`](#map) | Transform | Map fields from source to target object |
| [`process`](#process) | Transform | Process data with full exchange access |
| [`enrich`](#enrich) | Transform | Add additional data to current data |
| [`filter`](#filter) | Flow Control | Filter data based on predicate |
| [`validate`](#validate) | Flow Control | Validate data against schema |
| [`choice`](#choice) | Flow Control | Route to different paths based on conditions |
| [`split`](#split) | Flow Control | Split arrays into individual items |
| [`aggregate`](#aggregate) | Flow Control | Combine multiple items into single result |
| [`multicast`](#multicast) | Flow Control | Send exchange to multiple destinations |
| [`loop`](#loop) | Flow Control | Repeat operations while condition is true |
| [`tap`](#tap) | Side Effect | Execute side effects without changing data |
| [`to`](#to) | Destination | Send data to destination |

### Operation scope and ordering

- **Route operations** (e.g. `id`, `batch`) configure the route itself and apply to the entire route. They configure the **next** route created by `from()`.
  - Place them before `from()`.
  - If called after a route already exists in the chain, they are staged and will apply to the next `from()` (they do not change the current route).

- **Wrapper operations** (e.g. `retry`, `throttle`, `timeout`, `delay`, `onError`) wrap the **next operation only**.
  - Place them immediately before the operation they should affect.
  - Multiple wrappers can be stacked; they will all apply to the next single operation.

## Route operations

Route operations configure the route itself and apply to the entire route. They configure the next route created by `from()`. Place them before `from()`. If called after an existing route, they are staged for the next `from()`.

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
  .to(database({ operation: 'bulkInsert' }))
```

**Options:**
- `size` - Maximum exchanges per batch (default: 100)
- `flushIntervalMs` - Maximum wait time before flushing partial batch (default: 5000ms)

## Wrapper operations

Wrapper operations modify the behavior of the next operation in the chain. They create a wrapper around the subsequent step to add cross-cutting concerns.

### retry

```ts
retry(attempts: number, options?: { backoffMs?: number; exponential?: boolean }): RouteBuilder<Current>
```

Retry the next operation on failure. The retry logic wraps whatever operation comes next.

```ts
craft()
  .id('resilient-processor')
  .from(source)
  .retry(3, { backoffMs: 1000, exponential: true })
  .transform(unreliableTransformation) // This transform will be retried
  .to(destination)
```

**Parameters:**
- `attempts` - Maximum retry attempts
- `backoffMs` - Base delay between retries (default: 1000ms)
- `exponential` - Use exponential backoff (default: false)

### throttle

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

### timeout

```ts
timeout(timeoutMs: number): RouteBuilder<Current>
```

Add a timeout to the next operation. If the operation takes longer than specified, it will be cancelled.

```ts
craft()
  .id('timeout-protected')
  .from(source)
  .timeout(5000)
  .process(slowOperation) // Operation will timeout after 5 seconds
  .to(destination)
```

### delay

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

### onError

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

## Source operations

### from

```ts
from<T>(src: Source<T> | CallableSource<T>): RouteBuilder<T>
```

Define the source of data for the route. This operation creates the route and must come after any route configuration operations.

```ts
// Simple source
.id('timer-route')
.from(timer({ intervalMs: 1000 }))

// HTTP server source
.id('webhook-handler')
.from(httpServer({ port: 3000 }))

// Callable source
.id('data-fetcher')
.from(async () => await fetchData())
```

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

### map

```ts
map<Next>(fieldMappings: Record<keyof Next, (src: Current) => Next[keyof Next]>): RouteBuilder<Next>
```

Map fields from the source object to a target object structure.

```ts
.map({
  fullName: (user) => `${user.firstName} ${user.lastName}`,
  email: (user) => user.emailAddress,
  isActive: (user) => user.status === 'active'
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
enrich<R = Current>(enricher: Enricher<Current, Partial<R>> | CallableEnricher<Current, Partial<R>>, aggregator?: EnrichAggregator<Current, Partial<R>>): RouteBuilder<R>
```

Add additional data to the current exchange body by calling an enricher function.

```ts
.enrich(async (user) => ({
  profile: await fetchUserProfile(user.id),
  permissions: await getUserPermissions(user.id)
}))
```

## Flow control operations

### filter

```ts
filter(fn: Filter<Current> | CallableFilter<Current>): RouteBuilder<Current>
```

Filter exchanges based on a predicate. Only exchanges that return `true` continue through the route.

```ts
.filter((user) => user.isActive)
.filter(async (order) => await isValidOrder(order))
```

### validate

```ts
validate(schema: StandardSchemaV1): RouteBuilder<Current>
```

Validate the exchange body against a schema. Invalid exchanges will cause the route to emit an error event.

```ts
import { z } from 'zod'

const userSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  age: z.number().min(0)
})

.validate(userSchema)
```

### choice

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
split<Item = Current extends Array<infer U> ? U : never>(fn?: Splitter<Current, Item> | CallableSplitter<Current, Item>): RouteBuilder<Item>
```

Split arrays into individual items. Each item becomes a separate exchange.

```ts
// Split array automatically
.split() // [1, 2, 3] becomes three exchanges: 1, 2, 3

// Custom splitting logic
.split((batch) => batch.items)
```

### aggregate

```ts
aggregate<R>(fn: Aggregator<Current, R> | CallableAggregator<Current, R>): RouteBuilder<R>
```

Combine multiple exchanges into a single result. Useful after `split` to recombine processed items.

```ts
.aggregate((items) => ({
  totalCount: items.length,
  processedAt: new Date().toISOString(),
  items
}))
```

### multicast

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


### loop

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

### sample

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
.from(channel('high-frequency-metrics'))
.sample({ every: 100 }) // Only process 1% of metrics
.to(database({ operation: 'save' }))
```

### debounce

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

## Side effect operations

### tap

```ts
tap(fn: Tap<Current> | CallableTap<Current> | RouteBuilder<any>): RouteBuilder<Current>
```

Execute side effects without changing the exchange. Can take a function for simple side effects or a route builder for complex processing pipelines.

```ts
// Simple function-based tapping
.tap(log()) // Built-in logging
.tap((body) => console.log('Processing:', body))
.tap(async (user) => await sendNotification(user))

// Route-based tapping for complex side effects
.tap(craft().transform(formatForAudit).to(auditLog))
.tap(craft().filter(isImportant).to(alertSystem))
```

## Destination operations

### to

```ts
to(dest: Destination<Current> | CallableDestination<Current>): RouteBuilder<Current>
```

Send the exchange to a destination. This is typically the final operation in a route.

```ts
.to(log()) // Log the final result
.to(database.insert()) // Insert into database
.to(async (data) => await sendToWebhook(data))
```