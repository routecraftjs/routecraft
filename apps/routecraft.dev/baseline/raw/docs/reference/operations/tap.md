# tap

[← All operations](/docs/reference/operations)

```ts
tap(target: Destination<Current> | Enricher<Current, unknown> | CallableEnricher<Current, unknown>): RouteBuilder<Current>
```

Execute side effects without changing the exchange. The tap operation is **async fire-and-forget** - it runs in the background and never blocks the main route. A tap accepts a destination (its `send` runs against the snapshot) or an enricher (its `fetch` runs and the result is discarded); when both slots exist, `send` wins. Results are always discarded - a tap observes.

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
- **Results discarded**: A fetch result or a value returned by a function form is thrown away, and receipt headers set through the `SendContext` sink are discarded with the snapshot
- **Error isolation**: Errors in tap are emitted to the route error handler but don't halt the main exchange (already fire-and-forget)
- **Lifecycle aware**: Routes and context wait for all taps to complete during shutdown via `drain()`
- **Perfect for**: Logging, auditing, notifications, analytics, monitoring

**Lifecycle:**
- Routes complete without waiting for taps
- Taps are tracked by the route and waited for during `drain()`
- `context.stop()` automatically calls `context.drain()` to wait for all tap jobs
- Ensures all async work finishes before shutdown completes
