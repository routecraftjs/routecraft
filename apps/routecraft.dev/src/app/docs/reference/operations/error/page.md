---
title: error
---

[← All operations](/docs/reference/operations) {% .lead %}

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

#### Step scope (after `.from()`)

`.error()` is dual-mode. Chained AFTER `.from()` it becomes a **wrapper** around the immediately next step instead of a route-level catch-all. On wrapped-step success the pipeline continues unchanged. On wrapped-step failure the handler runs, its return value replaces `exchange.body`, and the pipeline continues with the next step. Subsequent steps see the recovery as if nothing went wrong.

```ts
// Recover from one flaky call, keep processing
craft()
  .id('resilient-pipeline')
  .from(timer({ intervalMs: 60_000 }))
  .transform(prepareRequest)
  .error((err) => ({ fallback: true, reason: String(err) }))
  .to(http({ url: 'https://flaky.api/endpoint' }))
  .to(database())
```

The handler signature is identical in both positions: `(error, exchange, forward) => unknown | Promise<unknown>`.

**Cascade rule.** When a step-scope handler itself throws, the wrapper rethrows. The route-scope handler (when set) catches it; otherwise the default error path fires (`route:*:error`, `context:error`, `exchange:failed`). The route is NOT stopped.

```ts
craft()
  .id('with-safety-net')
  .error((err, ex, forward) => forward('errors.catchall', ex.body))  // route scope
  .from(timer({ intervalMs: 60_000 }))
  .transform(prepareRequest)
  .error((err) => ({ fallback: true }))                              // step scope
  .to(http({ url: 'https://flaky.api/endpoint' }))
  .to(database())
```

The step-scope handler recovers `http` failures silently. If it ever throws, the route-scope handler takes over and forwards to `errors.catchall`.

**Stacking.** Multiple wrappers stack outside-in in declaration order. The first-declared wrapper is the outermost. (Until a second public wrapper ships, this only matters when manually composing wrappers in tests.)

**Scope only the next step.** A wrapper attaches to exactly one step. `.error(h).transform(a).transform(b)` does NOT cover `b` (or `to()` after it); only `a`. Add another `.error(...)` before each step you want to wrap.

For the architectural pattern wrappers follow, see [`.standards/resilience-wrappers.md`](https://github.com/routecraftjs/routecraft/blob/main/.standards/resilience-wrappers.md).

**Note about direct destinations:** Direct destinations with their own routes have their own error handlers. Errors in direct destinations are handled by their route's error handler, not the calling route.
