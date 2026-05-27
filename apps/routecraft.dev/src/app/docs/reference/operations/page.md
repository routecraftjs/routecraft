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
| [`error`](#error) | Route + Wrapper | Configure error handling. Before `.from()` it catches every step (route scope); after `.from()` it wraps the next step and the pipeline continues after recovery (step scope). |
| [`authorize`](#authorize) | Route | Route-entry guard: principal must be authenticated and (optionally) have required roles/scopes. Pre-from only. |
| [`from`](#from) | Route | Define the source of data for the capability |
| [`retry`](#retry) | Wrapper | Retry the next operation on failure {% badge color="purple" %}planned{% /badge %} |
| [`throttle`](#throttle) | Wrapper | Rate limit the next operation {% badge color="purple" %}planned{% /badge %} |
| [`cache`](#cache) | Wrapper | Cache and reuse results of the next operation {% badge color="purple" %}planned{% /badge %} |
| [`sample`](#sample) | Flow Control | Take every Nth exchange or time-based sampling {% badge color="purple" %}planned{% /badge %} |
| [`debounce`](#debounce) | Flow Control | Only pass exchanges after a quiet period {% badge color="purple" %}planned{% /badge %} |
| [`timeout`](#timeout) | Wrapper | Cancel the next operation if it exceeds a duration {% badge color="purple" %}planned{% /badge %} |
| [`delay`](#delay) | Wrapper | Add delay before the next operation {% badge color="purple" %}planned{% /badge %} |
| [`onError`](#onError) | Wrapper | Handle errors from the next operation {% badge color="purple" %}planned{% /badge %} |
| [`transform`](#transform) | Transform | Transform the body using a function (the exchange is a read-only second argument); includes the `keep` and `mask` field helpers |
| [`map`](#map) | Transform | Sugar for `transform(mapper(...))`: map fields from source to target object |
| [`process`](#process) | Transform | Process data with full exchange access |
| [`header`](#header) | Transform | Set or override an exchange header |
| [`authenticate`](#authenticate) | Transform | Mint and attach an authenticated principal from verified claims |
| [`enrich`](#enrich) | Transform | Add additional data to current data |
| [`filter`](#filter) | Flow Control | Filter data based on predicate |
| [`validate`](#validate) | Flow Control | Validate data against schema |
| [`schema`](#schema) | Flow Control | Sugar for `validate(schema(...))`: validate against a Standard Schema |
| [`dedupe`](#dedupe) | Flow Control | Suppress duplicate exchanges based on a key {% badge color="purple" %}planned{% /badge %} |
| [`choice`](#choice) | Flow Control | Route to different paths based on conditions |
| [`split`](#split) | Flow Control | Split arrays into individual items |
| [`aggregate`](#aggregate) | Flow Control | Combine multiple items into single result |
| [`multicast`](#multicast) | Flow Control | Send exchange to multiple destinations {% badge color="purple" %}planned{% /badge %} |
| [`loop`](#loop) | Flow Control | Repeat operations while condition is true {% badge color="purple" %}planned{% /badge %} |
| [`tap`](#tap) | Side Effect | Fire-and-forget side effect, does not block the pipeline |
| [`log`](#log) | Side Effect | Sugar for `tap(log())`: log the current exchange at info level |
| [`debug`](#debug) | Side Effect | Sugar for `tap(debug())`: log the current exchange at debug level |
| [`to`](#to) | Side Effect | Send data to a destination adapter and end the pipeline |

## Route operations

Route operations configure the capability itself. `id`, `title`, `description`, `input`, `output`, `tag`, `batch`, and route-scope `error` go before `from()`; if called after an existing route, they are staged for the next `from()`. `from()` defines the source and creates the capability. `error` is dual-mode: when chained AFTER `from()` it becomes a step-scope wrapper around the next step (see the [`error`](#error) section below).

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

### title

```ts
title(value: string): RouteBuilder<Current>
```

Set a human-readable title for the next route. Mirrored into the `direct` / `mcp` registries so discovery consumers (agents, MCP clients, docs) can display it alongside the id. Place before `from()`.

```ts
craft()
  .id('ingest')
  .title('Ingest orders')
  .from(direct())
  .to(saveOrder)
```

### description

```ts
description(value: string): RouteBuilder<Current>
```

Set a human-readable description for the next route. Used by discovery-aware adapters when exposing the route to external consumers such as agents and MCP clients.

```ts
craft()
  .id('ingest')
  .description('Validate and persist an inbound order')
  .from(direct())
  .to(saveOrder)
```

### input

```ts
input(
  schema: StandardSchemaV1 | { body?: StandardSchemaV1; headers?: StandardSchemaV1 },
): RouteBuilder<Current>
```

Declare input validation for the next route. The engine validates the incoming body and headers against these schemas **before any pipeline step runs**; a validation failure emits `exchange:dropped` and the pipeline never sees the message. Accepts either a bundle (`{ body, headers }`) or a bare Standard Schema as a body-only shorthand.

To flow the validated body type through the chain, pass it as a generic on `.from<T>(source)` after the `.input()` call.

```ts
craft()
  .id('ingest')
  .input({ body: OrderSchema, headers: AuthHeaders })
  .from(direct())
  .to(saveOrder)

// Body-only shorthand
craft()
  .id('ingest')
  .input(OrderSchema)
  .from(direct())
  .to(saveOrder)
```

### output

```ts
output(
  schema: StandardSchemaV1 | { body?: StandardSchemaV1; headers?: StandardSchemaV1 },
): RouteBuilder<Current>
```

Declare output validation for the next route. The engine validates the final exchange against these schemas **before the primary destination fires**; a validation failure is routed to the route's error handler (or emits `exchange:failed` when no handler is set). Accepts a bundle (`{ body, headers }`) or a bare Standard Schema as a body-only shorthand.

```ts
craft()
  .id('ingest')
  .input(OrderSchema)
  .output(SavedOrderSchema)
  .from(direct())
  .to(saveOrder)
```

### tag

```ts
tag(value: Tag | Tag[]): RouteBuilder<Current>
```

Tag the next route. Accepts a single tag or an array; multiple `.tag()` calls before `from()` accumulate (deduplicated, insertion order preserved). Empty strings are rejected with `RC2001`.

Tags surface on the `ToolsCatalog` snapshot handed to the builder form of `tools()` in `@routecraft/ai`, so an agent can filter its tool surface programmatically (`tools((catalog) => catalog.routes.filter((r) => r.tags?.includes("read-only")).map((r) => `Direct(${r.id})`))`). The `KnownTag` literals `"read-only"`, `"destructive"`, and `"idempotent"` autocomplete; any other string is also accepted.

```ts
craft()
  .id('list-orders')
  .tag('read-only')
  .from(direct())
  .to(listOrders)

// Multiple tags
craft()
  .id('delete-order')
  .tag(['destructive', 'orders'])
  .from(direct())
  .to(deleteOrder)
```

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

### authorize

```ts
authorize(options?: AuthorizeOptions): RouteBuilder<Current>
```

Declare an authorization requirement on the next route. **Route-only**, same staging convention as `.id`, `.title`, `.description`, `.input`, `.output`, `.tag`, and `.batch`: it writes onto the next-route options. Calling a pipeline op (`.to`, `.transform`, `.process`, ...) while authorizers are staged but no `.from()` has opened the next route throws [`RC2001`](/docs/reference/errors#rc2001) with a message that lists `.authorize` alongside the other staging ops. For a mid-pipeline check use `.validate(authorize({ ... }))` directly.

The check runs at route entry, before any pipeline step. It verifies that the inbound exchange carries an authenticated principal and (optionally) that the principal has every required role and scope. It does NOT issue, mint, or attach any credential: it asserts an existing identity meets the criteria. Multiple `.authorize()` calls stack and AND-combine in declaration order, so a missing role in the first call short-circuits before later predicates run.

`.authorize()` can also act as a route-starter when chaining routes: `craft().from(s1).to(d1).authorize({...}).from(s2).to(d2)` opens route 2 with the authorizer staged, no explicit `.id("next")` required.

For mid-pipeline checks (rare, for example after a `.process()` swaps the principal or inside a `.choice()` branch), use `.validate(authorize({ ... }))` directly with the underlying validator function.

`AuthorizeOptions`:

| Field | Type | Description |
|-------|------|-------------|
| `roles` | `string[]` | Required roles. The principal must carry every listed role. AND-combined. |
| `scopes` | `string[]` | Required scopes. The principal must carry every listed scope. AND-combined. |
| `predicate` | `(p: Principal) => boolean` | Custom check. Runs after the role and scope checks. Return `false` to reject. |

Failure modes:

- **No principal on the exchange:** throws [`RC5012`](/docs/reference/errors#rc5012). The source did not authenticate (no `auth:` configured) and no `.process()` step attached one before the route ran.
- **Missing role or scope:** throws [`RC5015`](/docs/reference/errors#rc5015). The error message lists the missing entries.
- **Predicate returned `false`:** throws [`RC5015`](/docs/reference/errors#rc5015).

Both error codes flow through the route's normal error path: `.error()` handles them like any other validation failure; without `.error()`, `exchange:failed` fires.

```ts
import { craft, mcp } from '@routecraft/routecraft'

// Route-entry guard: authentication at the source boundary,
// authorization declared on the route.
craft()
  .id('delete-user')
  .description('Delete a user by id')
  .authorize({ roles: ['admin'] })
  .from(mcp({ annotations: { destructiveHint: true } }))
  .to(deleteUserDestination)
```

```ts
// Stacked authorizers (AND-combined; first failure short-circuits)
craft()
  .id('billing-admin')
  .authorize({ roles: ['admin'] })
  .authorize({ scopes: ['billing:write'] })
  .from(http({ path: '/admin/billing', method: 'POST' }))
  .to(billingDestination)
```

```ts
// Mid-pipeline check: route mints a principal from an inbound email
// with .authenticate() and authorizes it. authorize() trusts only
// principals minted this way (or attached by a source verifier); a
// plain object written to the principal header is rejected (RC5023).
import { authorize } from '@routecraft/routecraft'

craft()
  .from(mail({ /* ... */ }))
  .authenticate((ex) => ({
    scheme: 'email',
    subject: ex.body.from?.address ?? 'anonymous',
    email: ex.body.from?.address,
    claims: { tenant: deriveTenant(ex.body.from?.address) },
  }))
  .validate(authorize({
    predicate: (p) => p.email?.endsWith('@yourcompany.com') === true,
  }))
  .to(yourDestination)
```

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

### retry {% badge color="purple" %}planned{% /badge %}

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

### throttle {% badge color="purple" %}planned{% /badge %}

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

### timeout {% badge color="purple" %}planned{% /badge %}

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

### delay {% badge color="purple" %}planned{% /badge %}

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

### onError {% badge color="purple" %}planned{% /badge %}

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

### cache {% badge color="purple" %}planned{% /badge %}

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

Transform the exchange body using a function. The function receives the body and, as a second read-only argument, the current exchange, so it can derive the new body from context (the principal, headers, correlation id) without dropping to `.process()`. It still returns only the body; to rewrite headers or the principal use `.process()`. The second argument is optional, so a one-argument `(body) => ...` transformer is still valid.

```ts
.transform((body: string) => body.toUpperCase())
.transform(async (user) => await enrichUserData(user))

// Derive the body from the caller via the second argument
.transform((order, ex) => ({ ...order, requestedBy: ex.principal?.subject }))
```

#### Field helpers: `keep` and `mask`

Two transform helpers shape a record (or an array of records) field by field. Both return a transformer, so they drop into `.transform(...)`. Compose them by running `keep` first to remove fields the caller may not see, then `mask` to obfuscate what remains. Neither is a security guarantee on its own; the access control lives in the grants you pass to `keep`.

**`keep(rules, options?)`** keeps fields based on the caller's grants and removes the rest. A grant is a role name (matched against `principal.roles`) or a predicate `(record, principal) => boolean` (so `self` and relationships are predicates; `admin` is just a role name). A rule of `true` keeps a field for any caller. Strict by default: only listed fields survive (a new sensitive field stays hidden until you list it). Pass `{ strict: false }` to instead gate only the listed fields and pass everything else through. It reads the caller from the exchange the transform now provides, and trusts only an authentic principal (one established by a source verifier or `authenticate()`): a self-asserted principal header is treated as missing, so grants fail closed, matching `authorize()`.

```ts
const self = (e: Employee, p) => e.email === p?.email;

.transform(keep({
  id: true,
  email: true,
  yearlyWage: [self, 'hr'],   // own salary, or the hr role
  internalNotes: ['hr'],      // hr only, dropped for everyone else
}))
```

**`mask(rules)`** obfuscates field values and ignores the principal entirely. Use it for values that should not be shown verbatim even to an authorised caller (an e-mail on a public response). Each rule is `(value, record) => newValue`. Dot paths address nested fields.

```ts
.transform(mask({
  email: (v) => maskEmail(String(v)),
  'card.number': (v) => '**** ' + String(v).slice(-4),
}))
```

Both apply to the body when it is a single record and element-wise when it is an array. For a wrapped collection, apply to the inner array: `.transform((b, ex) => ({ ...b, items: keep(rules)(b.items, ex) }))`.

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

### authenticate

```ts
authenticate(resolver: (exchange: Exchange<Current>) => PrincipalClaims | undefined | Promise<...>): RouteBuilder<Current>
```

Establish the authenticated principal for the exchange. The resolver returns identity claims you have verified yourself (an e-mail sender, a Slack signature, a webhook HMAC); they are minted into a branded, frozen `Principal` and attached to `headers["routecraft.auth.principal"]`. Return `undefined` to leave the caller anonymous. The body is unchanged.

This is the explicit way to establish identity from a source the framework cannot verify on its own. `authorize()` trusts only principals minted this way (or attached by a source verifier such as `jwt()` / `jwks()` / `oauth()`); a plain object written via `.header('routecraft.auth.principal', ...)` or `.process()` is rejected with [`RC5023`](/docs/reference/errors#rc5023). Sugar over the `authenticate()` helper, which you can call directly in tests, custom source adapters, or a `.choice()` branch.

Only `subject` is required; `kind` defaults to `"custom"` and `scheme` to `"custom"`.

```ts
// Mint identity from a verified inbound email, then authorize it
craft()
  .from(mail('INBOX'))
  .filter(verifiedSenders)
  .authenticate((ex) => ({
    scheme: 'email',
    subject: ex.body.sender.address,
    roles: ex.body.sender.address.endsWith('@acme.com') ? ['internal'] : [],
  }))
  .authorize({ roles: ['internal'] })
  .to(dest)

// Return undefined to stay anonymous
.authenticate((ex) => (ex.body.sender ? { subject: ex.body.sender.address } : undefined))
```

### map

```ts
map<Return>(fieldMappings: Record<keyof Return, (src: Current) => Return[keyof Return]>): RouteBuilder<Return>
```

Map fields from the current data to create a new object of a specified type. Sugar for `.transform(mapper({...}))`: a specialized transformer that creates a new object by mapping fields from the source object.

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

**`only(getValue, into?)`**: Returns an aggregator that merges one value from the enrichment result. Omit `into` to spread a plain object onto the body, or use fallbacks: primitive → `body.stdout`, array → `body.array`. Provide `into` to set `body[into]`. Values that are `null` or `undefined` are never merged (exchange unchanged).

**`none()`**: Returns a no-op aggregator that leaves the exchange unchanged, so the enrichment result is ignored. Use it when you only need the destination's side effect (logging, firing an API call) and do not want to merge its return value.

```ts
.enrich(http({ url: "https://api.example.com/ping" }), none())
```

**`replace()`** (experimental): Returns an aggregator that replaces the body with the enrichment result instead of merging it. Use it when the enrichment returns the value you want as the new body.

```ts
.enrich(mail({ folder: "INBOX", unseen: true }), replace())
// body becomes MailMessage[] (the raw enrichment result)
```

**Key difference from `.to()`:**

- `.to()` replaces the body if the destination returns a value (not `undefined`)
- `.enrich()` merges the result into the body by default

Both operations use the same `Destination` adapters - the difference is only in how the result is applied.

## Flow control operations

### filter

```ts
filter(fn: Filter<Current> | CallableFilter<Current>): RouteBuilder<Current>
```

Filter exchanges based on a predicate. The predicate receives the full `Exchange` object, allowing you to filter based on headers, body, or other exchange properties.

Return `true` to keep the exchange, `false` to drop it, or `{ reason: "..." }` to drop with an explanation that is recorded in telemetry and shown in the TUI.

```ts
// Simple boolean filter
.filter((exchange) => exchange.body.isActive)

// Drop with a reason (shown in TUI traces)
.filter((exchange) => {
  if (!exchange.body.name) return { reason: "name is required" };
  if (exchange.body.age < 18) return { reason: "age must be 18 or older" };
  return true;
})

// Async filter
.filter(async (exchange) => await isValidOrder(exchange.body))

// Filter based on headers
.filter((exchange) => exchange.headers['x-priority'] === 'high')
```

{% callout type="note" title="Filter vs Transform" %}
Unlike `.transform()` which receives only the body, `.filter()` receives the full `Exchange` object. This allows filtering based on headers, correlation IDs, or other exchange metadata, not just the message body.
{% /callout %}

### validate

```ts
validate<R = Current>(validator: Validator<Current, R> | CallableValidator<Current, R>): RouteBuilder<R>
```

Validate the exchange body using a Validator adapter or callable function. On success the (possibly coerced) return value replaces the body. On failure the adapter throws and the route error handler (if configured) or the default error path handles it.

For Standard Schema validation, use the `.schema()` sugar or pass the `schema()` factory.

```ts
// Custom validator
.validate((exchange) => {
  if (!exchange.body.email) throw new Error("email required");
  return exchange.body;
})

// Standard Schema via factory
import { schema } from '@routecraft/routecraft'
.validate(schema(z.object({ name: z.string() })))
```

### schema

```ts
schema<S extends StandardSchemaV1>(standardSchema: S): RouteBuilder<StandardSchemaV1.InferOutput<S>>
```

Validate the exchange body against a Standard Schema. Sugar for `.validate(schema(standardSchema))`. On failure throws RC5002 with formatted issue details. The route builder type is narrowed to the schema's output type.

```ts
import { z } from 'zod'

const userSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  age: z.number().min(0)
})

.schema(userSchema)
// Validation failures throw RC5002: "Validation failed: "email": Invalid email; "age": Number must be greater than or equal to 0"
```

### dedupe {% badge color="purple" %}planned{% /badge %}

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

### choice

```ts
choice<Out = Current>(
  fn: (c: ChoiceSubBuilder<Current, Out>) => ChoiceSubBuilder<Current, Out>,
): RouteBuilder<Out>
```

Conditionally route exchanges through one of several branches. Branches are defined via a callback sub-builder, so `when` and `otherwise` are only reachable inside a `choice` block. Predicates are evaluated in registration order; the first match wins. The optional `otherwise` branch catches exchanges that no `when` matched; if omitted and no branch matches, the exchange is dropped with `reason: "unmatched"`.

Matched branches inline their steps before the remaining main-pipeline steps, so the exchange converges back into the main flow after the choice. A branch that ends in `b.halt()` short-circuits: the exchange is dropped with `reason: "halted"` and the main pipeline does not resume for it.

```ts
.from(incomingOrders)
.choice((c) =>
  c
    .when(
      (ex) => ex.body.priority === "urgent",
      (b) => b.transform(prioritize).to(urgentQueue),
    )
    .when(
      (ex) => ex.body.amount > 1000,
      (b) => b.to(reviewQueue),
    )
    .otherwise((b) => b.to(errorSink).halt()),
)
.to(audit); // runs for urgent and review; skipped for otherwise (halted)
```

Branches support the full set of pipeline operations available on the main route: `to()`, `transform()`, `enrich()`, `filter()`, `header()`, `tap()`, `process()`, `validate()`, plus the sugar methods `log()`, `debug()`, `map()`, and `schema()`. The only branch-specific op is `halt()`, which short-circuits convergence. Route-level operations (`id`, `batch`, `error`, `from`, `split`, `aggregate`, `choice`, `build`) are deliberately not exposed inside branches because they either configure the route itself or fan out in ways that break the "branch converges" model.

Branches that change body type via `transform()` / `process()` / `validate()` / `map()` / `schema()` / `enrich()` must converge on the same `Out` type; the callback return type enforces this at compile time.

**Events:**

- `route:<id>:operation:choice:matched` -- `{ branchIndex, branchLabel: "when" | "otherwise" }`
- `route:<id>:operation:choice:unmatched` -- fires when no branch matched and the exchange is dropped.

**Known limitations:**

- Nested `.choice()` inside a branch is not supported.
- Predicates must be synchronous.
- `otherwise()` may only be registered once per choice (throws otherwise).

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

### multicast {% badge color="purple" %}planned{% /badge %}

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


### loop {% badge color="purple" %}planned{% /badge %}

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

### sample {% badge color="purple" %}planned{% /badge %}

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
.id('high-frequency-metrics')
.from(direct())
.sample({ every: 100 }) // Only process 1% of metrics
.to(database({ operation: 'save' }))
```

### debounce {% badge color="purple" %}planned{% /badge %}

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


### log

```ts
log(
  formatter?: (exchange: Exchange<Current>) => unknown,
  options?: { level?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' },
): RouteBuilder<Current>
```

Sugar for `.tap(log(formatter, options))`. Logs the current exchange via the exchange logger and continues the pipeline unchanged. Defaults to `info` level. By default the logger prints `id`, `body`, and `headers`; pass a `formatter` to log a derived value instead.

```ts
// Log id, body, headers at info level
.log()

// Log a derived value
.log((exchange) => ({ id: exchange.id, body: exchange.body }))

// Log at a different level
.log(undefined, { level: 'warn' })
```

Use `.log()` for ad-hoc visibility inside a route. For more control or a non-default destination, use `.tap(log(...))` directly.

### debug

```ts
debug(
  formatter?: (exchange: Exchange<Current>) => unknown,
  options?: Record<string, never>,
): RouteBuilder<Current>
```

Sugar for `.tap(debug(formatter))`. Same shape as `.log()`, but the level is fixed to `debug`. Useful for verbose pipeline tracing that can be silenced via the logger configuration without removing the call.

```ts
// Debug log id, body, headers
.debug()

// Debug log a derived value
.debug((exchange) => ({ correlation: exchange.headers['x-correlation-id'], body: exchange.body }))
```

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
