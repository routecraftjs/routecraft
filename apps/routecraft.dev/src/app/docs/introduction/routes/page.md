---
title: Routes
---

Build focused data processing pipelines with a fluent DSL. {% .lead %}

## What are routes?

Routes are isolated data processing pipelines that flow from a **source** through **processing steps** to one or more **destinations**, with the final exchange returned to the source. Each route has a single responsibility and runs independently from other routes.

```ts
import { craft, http, log } from '@routecraftjs/routecraft'

export default craft()
  .id('user-processor')
  .from(http({ path: '/users', method: 'POST' }))
  .process(request => ({
    id: Date.now(),
    name: request.name,
    email: request.email
  }))
  .tap(log())
```

## Route anatomy

Every route consists of three main parts:

### 1. Route configuration
Configure the route before defining data flow:

```ts
craft()
  .id('data-pipeline')           // Unique identifier
  .batch({ size: 100 })          // Batch processing (optional)
```

### 2. Source definition
Define where data comes from:

```ts
  .from(timer({ intervalMs: 5000 }))  // Timer source
  .from(http({ path: '/webhook', method: 'POST' })) // HTTP endpoint
  .from(direct('jobs'))              // Channel source
```

### 3. Processing pipeline
Transform, filter, and route data:

```ts
  .filter(row => row.status === 'active')  // Filter items
  .transform(row => ({ name: row.name }))  // Transform data
  .sample({ every: 10 })                  // Sample data
  .tap(log())                             // Side effects
  .to(fetch({ url: 'https://api.com' }))  // Final output
```

## Route lifecycle

Routes follow a predictable lifecycle within a context:

1. **Registration** - Route definitions are added to context
2. **Validation** - Routes are checked for valid configuration
3. **Starting** - Sources begin producing data
4. **Processing** - Exchanges flow through the pipeline
5. **Response** - Final exchange is returned to the source
6. **Stopping** - Sources are shut down gracefully

## Exchange flow pattern

The key to understanding RouteCraft routes is the **exchange flow pattern**: data flows from source → processing → destinations → back to source.

```
Source → Operations → Destination
```

This pattern is especially important for **request-response** sources like HTTP servers, where the final exchange becomes the response sent back to the client.

### Source types and final exchange handling

Different source types handle the final exchange differently:

**HTTP routes (pathful)**: Accept requests at a `path` and `method`. The final exchange body becomes the HTTP response.
– `http({ path, method })`

**Pathless routes**: Triggered by timers, channels, watchers, or jobs. They do not return a response to a caller.
– `timer()` – scheduled jobs
– `direct(name)` – inter-route messaging
– file watchers, queues, or custom sources

**Subscription Sources** (long-running connections):
- `queue()` - Maintains connection to message queue until shutdown
- `websocket()` - Keeps connection open until client disconnects
- Custom streaming sources

```ts
// HTTP route: final exchange becomes response
craft()
  .id('api-endpoint')
  .from(http({ path: '/users', method: 'GET' }))
  .process(() => ({ users: [...] }))

// Timer route: scheduled job, no response
craft()
  .id('periodic-task')
  .from(timer({ intervalMs: 60000 }))
  .process(processData)
  .to(log())

// Channel route: message-driven, runs until shutdown
craft()
  .id('message-processor')
  .from(direct('tasks'))
  .process(async (task) => await processTask(task))
  .to(log())
```

### Route execution patterns

Understanding how different sources behave is crucial for route design:

**One-Shot Execution** (process once and complete):
- `simple()` with static data
- Custom sources that produce finite data

**Request-Driven Execution** (process per request):
- `http()` server endpoints

**Scheduled Execution** (process on schedule):
- `timer()` with intervals or exact times
- Custom time-based triggers

**Continuous Execution** (process until shutdown):
- `direct()` consumers
- WebSocket or queue consumers (custom adapters)

```ts
// One-shot: Processes once then stops
craft()
  .id('data-import')
  .from(simple(['item1', 'item2', 'item3']))
  .transform(item => ({ name: item }))
  .to(json({ path: './output.json' }))
  // Completes after processing all 3 items

// Continuous: Runs until manually stopped
craft()
  .id('live-updates')
  .from(timer({ intervalMs: 5000 }))
  .process(() => ({ timestamp: Date.now() }))
  .to(json({ path: './metrics.json', mode: 'append' }))
  // Keeps running every 5 seconds until context stops
```

```ts
const ctx = context()
  .routes([userRoute, orderRoute, notificationRoute])
  .build()

// Start all routes
await ctx.start()

// Routes are now processing data...

// Stop all routes gracefully
await ctx.stop()
```

## Route patterns

RouteCraft supports several common integration patterns:

- **Data transformation** - ETL pipelines that transform data formats
- **HTTP APIs** - Request-response endpoints with validation and processing  
- **Scheduled jobs** - Time-based automation and reporting
- **Event processing** - Message routing based on content or conditions
- **Batch processing** - High-throughput bulk operations

For complete working examples of these patterns, see:

- [File to HTTP](/docs/examples/api-sync) - Read CSV file and send rows to API
- [Sample Metrics](/docs/examples/metrics-collector) - Collect metrics with sampling to reduce storage
- [Webhook Router](/docs/examples/webhook-processor) - Route webhook events to different destinations
- [HTTP Server](/docs/examples/http-api) - Simple REST API endpoint
- [Batch Processing](/docs/examples/batch-processing) - Process items in groups for efficiency

## Best practices

### Route organization
- **One concern per route** - Keep routes focused on a single responsibility
- **Meaningful IDs** - Use descriptive route identifiers like `user-processor` or `daily-report`
- **File naming** - Use `.route.ts` suffix for route files

```ts
// ✅ Good: Focused responsibility
src/routes/user-registration.route.ts
src/routes/order-fulfillment.route.ts
src/routes/email-notifications.route.ts

// ❌ Bad: Mixed responsibilities
src/routes/everything.route.ts
```

### Error handling
- **Validate early** - Use `.validate()` to catch invalid data at the source
- **Handle failures gracefully** - Use `.onError()` for error recovery
- **Monitor with events** - Subscribe to error events for alerting

```ts
craft()
  .id('resilient-processor')
  .from(source)
  .validate(inputSchema)        // Validate early
  .onError(handleError)         // Handle errors
  .retry(3)                     // Retry failures
  .transform(processData)
  .to(destination)
```

### Performance considerations
- **Use batch processing** - For high-throughput scenarios
- **Implement backpressure** - Don't overwhelm downstream systems
- **Monitor resource usage** - Track memory and CPU usage

```ts
// High-throughput route
craft()
  .id('high-volume-processor')
  .batch({ size: 100 })
  .from(queue({ name: 'high-volume-queue' }))
  .throttle({ requestsPerSecond: 50 })
  .transform(processItems)
  .to(destination)
```

### Inter-route communication
- **Use channels** - For decoupled communication between routes
- **Avoid shared state** - Keep routes independent
- **Design for failure** - Routes should work even if others fail

```ts
// Producer route
craft()
  .id('data-producer')
  .from(source)
  .transform(processData)
  .to(direct('processed-data'))

// Consumer route
craft()
  .id('data-consumer')
  .from(direct('processed-data'))
  .transform(enrichData)
  .to(destination)
```

## Testing routes

Routes are designed to be easily testable with standard testing frameworks. Use the `spy()` adapter to record interactions and assert behavior throughout your route pipeline.