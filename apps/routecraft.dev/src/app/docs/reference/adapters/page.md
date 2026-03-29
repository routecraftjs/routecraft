---
title: Adapters
---

Full catalog of adapters with signatures and options. {% .lead %}

## Adapter overview

| Adapter | Category | Description | Types |
|---------|----------|-------------|-------|
| [`simple`](#simple) | Core | Static or dynamic data sources | `Source` |
| [`log`](#log) | Core | Console logging for debugging | `Destination` |
| [`timer`](#timer) | Core | Scheduled/recurring execution | `Source` |
| [`cron`](#cron) | Core | Cron-scheduled execution with timezone support | `Source` |
| [`direct`](#direct) | Core | Synchronous inter-route communication | `Source`, `Destination` |
| [`http`](#http) | Core | Outbound HTTP client requests (inbound/server support planned) | `Destination` |
| [`cli`](#cli) | Core | Expose routes as typed CLI commands with auto-generated help | `Source`, `Destination` |
| [`noop`](#noop) | Test | No-operation placeholder | `Destination` |
| [`pseudo`](#pseudo) | Test | Typed placeholder for docs/examples | `Source`, `Destination`, `Processor` |
| [`spy`](#spy) | Test | Records exchanges for assertions | `Destination`, `Processor` |
| [`file`](#file) | File | Read/write text files | `Source`, `Destination` |
| [`json`](#json) | File | JSON file handling with parsing | `Source`, `Destination`, `Transformer` |
| [`csv`](#csv) | File | CSV file processing | `Source`, `Destination` |
| [`jsonl`](#jsonl) | File | JSON Lines file processing | `Source`, `Destination` |
| [`html`](#html) | File | HTML parsing and file handling | `Source`, `Destination`, `Transformer` |
| [`mail`](#mail) | Messaging | Read email via IMAP or send via SMTP | `Source`, `Destination` |
| [`agentBrowser`](#agentbrowser) | Browser | Automate a browser session (navigate, click, snapshot, etc.) | `Destination` |
| [`mcp`](#mcp) | AI | Expose capabilities as MCP tools or call remote MCP servers | `Source`, `Destination` |
| [`llm`](#llm) | AI | Call a language model and get text or structured output | `Destination` |
| [`embedding`](#embedding) | AI | Generate vector embeddings from text | `Destination` |

## Core adapters

### simple

```ts
simple<T>(producer: (() => T | Promise<T>) | T): Source<T>
```

Create a static or dynamic data source. When the producer returns an **array**, each element becomes a separate exchange processed independently through the pipeline.

```ts
// Static value
.id('hello-route')
.from(simple('Hello, World!'))

// Array of values (each becomes a separate exchange)
.id('items-route')
.from(simple(['item1', 'item2', 'item3']))

// Dynamic function
.id('api-route')
.from(simple(async () => {
  const response = await fetch('https://api.example.com/data')
  return response.json()
}))

// With custom ID
.id('data-loader')
.from(simple(() => loadData()))
```

**Use cases:** Testing, static data, API polling, file reading

### log

```ts
log<T>(formatter?: (exchange: Exchange<T>) => unknown, options?: LogOptions): Destination<T, void>
```

Log messages to the console. Can be used as a destination with `.to()` or for side effects with `.tap()`.

```ts
// Log final result (default: logs exchange ID, body, and headers at info level)
.to(log())

// Log intermediate data without changing flow
.tap(log())

// Log with custom formatter function
.tap(log((ex) => `Exchange with id: ${ex.id}`))
.tap(log((ex) => `Body: ${JSON.stringify(ex.body)}`))
.tap(log((ex) => `Exchange with uuid: ${ex.headers.uuid}`))

// Log at different levels
.tap(log(undefined, { level: 'debug' }))
.tap(log((ex) => ex.body, { level: 'warn' }))
.tap(log((ex) => ex.body, { level: 'error' }))

// For debug logging, use the convenience helper
.tap(debug())
.tap(debug((ex) => ex.body))
```

**Log Levels:**
- `trace` - Most verbose
- `debug` - Development/debugging (use `debug()` helper)
- `info` - Default level
- `warn` - Warnings
- `error` - Errors
- `fatal` - Critical failures

**Output format:** 
- Without formatter: Logs exchange ID, body, and headers in a clean format
- With formatter: Logs the value returned by the formatter function

### debug

```ts
debug<T>(formatter?: (exchange: Exchange<T>) => unknown): Destination<T, void>
```

Convenience helper for debug-level logging. Equivalent to `log(formatter, { level: 'debug' })`.

```ts
// Log at debug level (default format)
.tap(debug())

// Log with custom formatter at debug level
.tap(debug((ex) => `Debug: ${JSON.stringify(ex.body)}`))
.tap(debug((ex) => ({ id: ex.id, bodySize: JSON.stringify(ex.body).length })))

// Use throughout development workflow
craft().from(source).tap(debug((ex) => `Input: ${ex.body}`)).transform(processData).tap(debug((ex) => `Processed: ${ex.body}`)).to(destination)
```

**Use cases:** Development debugging, verbose logging during troubleshooting

### timer

```ts
timer(options?: TimerOptions): Source<undefined>
```

Trigger routes at regular intervals or specific times. Produces `undefined` as the message body.

```ts
// Simple interval (every second)
.id('ticker')
.from(timer({ intervalMs: 1000 }))

// Limited runs (10 times, then stop)
.id('batch-job')
.from(timer({ intervalMs: 5000, repeatCount: 10 }))

// Start with delay
.id('delayed-start')
.from(timer({ intervalMs: 1000, delayMs: 5000 }))

// Daily at specific time
.id('daily-report')
.from(timer({ exactTime: '09:30:00' }))

// Fixed rate (ignore execution time)
.id('heartbeat')
.from(timer({ intervalMs: 1000, fixedRate: true }))

// Add random jitter to prevent synchronized execution
.id('distributed-task')
.from(timer({ intervalMs: 1000, jitterMs: 200 }))
```

Options:

| Field | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `intervalMs` | `number` | `1000` | No | Time between executions in milliseconds |
| `delayMs` | `number` | `0` | No | Delay before first execution in milliseconds |
| `repeatCount` | `number` | `Infinity` | No | Number of executions before stopping |
| `fixedRate` | `boolean` | `false` | No | Execute at exact intervals ignoring processing time |
| `exactTime` | `string` | — | No | Execute daily at time of day `HH:mm:ss` (fires once/day) |
| `timePattern` | `string` | — | No | Custom date format for execution times |
| `jitterMs` | `number` | `0` | No | Random jitter added to each scheduled run |

**Headers added:** Timer metadata including fired time, counter, period, and next run time

### cron
```ts
cron(expression: string, options?: CronOptions): Source<undefined>
```

Trigger routes on a cron schedule with timezone support. Produces `undefined` as the message body. More expressive than `timer()` for complex recurring schedules.

Supports standard 5-field cron (minute granularity), extended 6-field (second granularity), and nicknames (`@daily`, `@weekly`, `@hourly`, `@monthly`, `@yearly`, `@annually`, `@midnight`).

```ts
// Every 5 minutes
.id('poller')
.from(cron('*/5 * * * *'))

// Weekdays at 9am Eastern
.id('morning-report')
.from(cron('0 9 * * 1-5', { timezone: 'America/New_York' }))

// Daily at midnight (nickname)
.id('nightly-cleanup')
.from(cron('@daily'))

// Every 30 seconds (6-field)
.id('health-check')
.from(cron('*/30 * * * * *'))

// First day of month, limited to 12 fires
.id('monthly-report')
.from(cron('@monthly', { maxFires: 12, name: 'monthly-report' }))

// With jitter to prevent thundering herd
.id('distributed-poll')
.from(cron('*/5 * * * *', { jitterMs: 5000 }))

// Run only during Q1 2026
.id('q1-campaign')
.from(cron('@daily', { startAt: '2026-01-01', stopAt: '2026-04-01' }))
```

Options:

| Field | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `timezone` | `string` | System local | No | IANA timezone (e.g., `"America/New_York"`, `"UTC"`) |
| `maxFires` | `number` | `Infinity` | No | Maximum number of fires before stopping (delegated to croner's `maxRuns`) |
| `jitterMs` | `number` | `0` | No | Random delay in milliseconds added to each fire |
| `name` | `string` | -- | No | Human-readable job name for observability |
| `protect` | `boolean` | `true` | No | Prevents overlapping handler execution when the previous run is still in progress |
| `startAt` | `Date \| string` | -- | No | Date or ISO 8601 string at which the cron job should start running |
| `stopAt` | `Date \| string` | -- | No | Date or ISO 8601 string at which the cron job should stop running |

**Cron expression format:**

| Format | Example | Description |
| --- | --- | --- |
| 5-field | `*/5 * * * *` | minute, hour, day-of-month, month, day-of-week |
| 6-field | `*/30 * * * * *` | second, minute, hour, day-of-month, month, day-of-week |
| Nickname | `@daily` | Predefined schedule |

**Supported nicknames:** `@yearly` / `@annually`, `@monthly`, `@weekly`, `@daily` / `@midnight`, `@hourly`

**Headers added:** Cron metadata including expression, fired time, counter, next run, timezone, and name (via `routecraft.cron.*` headers)

### direct

```ts
direct<T>(endpoint: string | ((exchange: Exchange<T>) => string), options?: Partial<DirectOptions>): DirectAdapter<T>
```

Enable synchronous inter-route communication with single consumer semantics. Perfect for composable route architectures where you need request-response patterns. Supports dynamic endpoint names based on exchange data for destinations.

```ts
// Producer route that sends to direct endpoint
craft()
  .id('data-producer')
  .from(source)
  .transform(processData)
  .to(direct('processed-data'))

// Consumer route that receives from direct endpoint
craft()
  .id('data-consumer')
  .from(direct('processed-data', {}))
  .process(businessLogic)
  .to(destination)

// Planned: inbound HTTP API with direct routing
craft()
  .id('api-endpoint')
  .from(http({ path: '/api/orders', method: 'POST' })) // Planned HTTP source API
  .to(direct('order-processing')) // Synchronous call

craft()
  .id('order-processor')
  .from(direct('order-processing', {}))
  .process(validateOrder)
  .process(saveOrder)
  .transform(() => ({ status: 'created', orderId: '12345' }))
  // Planned response flow goes back to the HTTP client automatically

// Dynamic endpoint based on message content
craft()
  .id('dynamic-router')
  .from(source)
  .to(direct((ex) => `handler-${ex.body.type}`))

// Route messages to different handlers based on priority
craft()
  .id('priority-router')
  .from(source)
  .to(direct((ex) => {
    const priority = ex.headers['priority'] || 'normal';
    return `processing-${priority}`;
  }))

// Consumer routes (static endpoints required)
craft()
  .id('high-priority-handler')
  .from(direct('processing-high', {}))
  .to(urgentProcessor)

craft()
  .id('normal-priority-handler')
  .from(direct('processing-normal', {}))
  .to(standardProcessor)
```

**Options:**
- `channelType` - Custom direct channel implementation (default: in-memory)
- `schema` - Body validation schema (StandardSchema compatible: Zod, Valibot, ArkType)
- `headerSchema` - Header validation schemas (can be optional/required)
- `description` - Human-readable description for route discovery
- `keywords` - Keywords for route categorization

**Key characteristics:**
- **Synchronous**: Calling route waits for response from consuming route
- **Single consumer**: Only one route can consume from each endpoint (last one wins)
- **Request-response**: Perfect for HTTP APIs and composable route architectures
- **Automatic endpoint name sanitization**: Special chars become dashes
- **Dynamic routing**: Endpoint names can be determined at runtime using exchange data (destination only)
- **Static sources**: Source endpoints (`.from()`) must use static strings; dynamic functions only work with `.to()` and `.tap()`

**Perfect for:**
- Breaking large routes into smaller, composable pieces
- HTTP request-response patterns
- Synchronous business logic orchestration
- Testing individual route segments in isolation

**Limitations:**
- **Not compatible with `batch()`**: Because `direct()` is synchronous and blocking, each sender waits for the consumer route to fully process the message before the next message can be sent. This prevents the batch consumer from accumulating multiple messages. If you need to batch messages from multiple sources or split branches, use the `aggregate()` operation instead.

#### Schema Validation

Direct routes support StandardSchema validation for type safety. Behavior depends on your schema library.

**No Schema (Default)**

Without a schema, all data passes through unchanged:

```ts
craft()
  .from(direct('user-processor', {}))  // No schema - all data passes through
  .process(processUser)
```

**Zod 4 Object Types**

Zod 4 uses different object constructors to control extra field handling:

| Constructor | Extra fields | Use case |
|-------------|--------------|----------|
| `z.object()` | Stripped (default) | Strict contracts, clean data |
| `z.looseObject()` | Preserved | Flexible schemas, passthrough |
| `z.strictObject()` | Error (RC5002) | Reject unexpected fields |

```ts
import { z } from 'zod'

// z.object() - strips extra fields (default behavior)
const strictSchema = z.object({
  userId: z.string().uuid(),
  action: z.enum(['create', 'update', 'delete'])
})

craft()
  .from(direct('user-processor', { schema: strictSchema }))
  .process(processUser)

// Passes: { userId: '...', action: 'create' }
// Passes: { userId: '...', action: 'create', extra: 'field' }
//    Extra fields silently removed from result
// RC5002: { userId: '...', missing: 'action' }
```

```ts
// z.looseObject() - preserves extra fields
const looseSchema = z.looseObject({
  userId: z.string().uuid(),
  action: z.enum(['create', 'update'])
})

craft()
  .from(direct('user-processor', { schema: looseSchema }))
  .process(processUser)

// Passes: { userId: '...', action: 'create', extra: 'field' }
//    All fields preserved including extra
```

```ts
// z.strictObject() - rejects extra fields with error
const veryStrictSchema = z.strictObject({
  userId: z.string().uuid(),
  action: z.enum(['create', 'update'])
})

craft()
  .from(direct('user-processor', { schema: veryStrictSchema }))
  .process(processUser)

// Passes: { userId: '...', action: 'create' }
// RC5002: { userId: '...', action: 'create', extra: 'field' }
```

**Header Validation**

Without `headerSchema`, all headers pass through unchanged. When specified, the same Zod 4 rules apply:

```ts
// No headerSchema - all headers pass through unchanged
craft()
  .from(direct('api-handler', {
    schema: z.object({ id: z.string() })
    // headerSchema not specified - all headers preserved
  }))
  .process(handleRequest)

// z.looseObject() - validate required headers, keep extras
craft()
  .from(direct('api-handler', {
    headerSchema: z.looseObject({
      'x-tenant-id': z.string().uuid(),
      'x-trace-id': z.string().optional(),
    })
  }))
  .process(handleRequest)

// Passes: { 'x-tenant-id': '...', 'x-other': '...' } (validates x-tenant-id, keeps x-other)

// z.object() - validate and strip extra headers
craft()
  .from(direct('api-handler', {
    headerSchema: z.object({
      'x-tenant-id': z.string().uuid(),
    })
  }))
  .process(handleRequest)

// Passes: { 'x-tenant-id': '...', 'x-other': '...' } (x-other stripped from result)
```

**Schema Coercion**

Validated values are used (schemas can transform data):

```ts
const schema = z.object({
  userId: z.string(),
  createdAt: z.coerce.date()  // Transforms string to Date
})

craft()
  .from(direct('processor', { schema }))
  .process((data) => {
    // data.createdAt is Date, not string
    console.log(data.createdAt.getFullYear())
  })
```

**Validation occurs on consumer side only.** Producers send data unchanged; consumers validate on receive.

#### Route Registry

All direct routes are registered and can be queried. Routes with descriptions and keywords are more discoverable:

```ts
import { DirectAdapter } from '@routecraft/routecraft'

craft()
  .from(direct('fetch-content', {
    description: 'Fetch and summarize web content from URL',
    schema: z.object({ url: z.string().url() }),
    keywords: ['fetch', 'web', 'scrape']
  }))
  .process(fetchAndSummarize)

// Later, query discoverable routes from context
const ctx = await new ContextBuilder().routes(...).build()
await ctx.start()

const registry = ctx.getStore(DirectAdapter.ADAPTER_DIRECT_REGISTRY)
const routes = registry ? Array.from(registry.values()) : []
// [{ endpoint: 'fetch-content', description: '...', schema, keywords }]
```

Useful for runtime introspection, documentation generation, and building dynamic routing systems.

### http
```ts
http<T, R>(options: HttpOptions<T>): Destination<T, HttpResult<R>>
```

Make HTTP requests. Returns a `Destination` adapter that works with both `.to()` and `.enrich()`.

**Current support:** Routecraft currently exports `http()` only as an outbound/client adapter for making HTTP requests.

**Planned inbound support:** Routecraft does **not** yet ship an inbound HTTP source/server adapter. The planned design is shown in [Planned inbound/server HTTP support](#planned-inboundserver-http-support) below and may change before implementation.

**With `.enrich()` (merge result into body):**

```ts
// Static GET request - result merged into body
.enrich(http({ 
  method: 'GET',
  url: 'https://api.example.com/users'
}))

// Dynamic URL based on exchange data
.enrich(http({ 
  method: 'GET',
  url: (exchange) => `https://api.example.com/users/${exchange.body.userId}`
}))

// Custom aggregator to control merge behavior
.enrich(
  http({ url: 'https://api.example.com/profile' }),
  (original, result) => ({
    ...original,
    body: { ...original.body, profileData: result.body }
  })
)
```

**With `.to()` (side-effect or body replacement):**

`.to(http(...))` always invokes the `http()` adapter. When the adapter returns an `HttpResult`, `.to()` replaces the exchange body with that result. The first example below is a fire-and-forget pattern in intent only (the code does not read the response), but at runtime the body is still replaced by the `HttpResult`. To merge or preserve the original exchange body, use `.enrich()` with an aggregator instead of `.to(http(...))`.

```ts
// Fire-and-forget intent (code does not read the response); body is still replaced by HttpResult at runtime
.to(http({
  method: 'POST',
  url: 'https://api.example.com/webhook',
  body: (exchange) => exchange.body
}))

// http() returns HttpResult; .to() replaces exchange body with it
.to(http({ 
  method: 'GET',
  url: 'https://api.example.com/transform' 
}))
// Body is now the HttpResult (status, headers, body). Use .enrich() with an aggregator to merge or preserve the original body.

// With query parameters
.enrich(http({
  url: 'https://api.example.com/search',
  query: (exchange) => ({ q: exchange.body.searchTerm, limit: 10 })
}))
```

Options:

| Field | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `method` | `HttpMethod` | `'GET'` | No | HTTP method to use |
| `url` | `string \| (exchange) => string` | — | Yes | Target URL (string or derived from exchange) |
| `headers` | `Record<string,string> \| (exchange) => Record<string,string>` | `{}` | No | Request headers |
| `query` | `Record<string,string|number|boolean> \| (exchange) => Query` | `{}` | No | Query parameters appended to URL |
| `body` | `unknown \| (exchange) => unknown` | — | No | Request body (JSON serialized when not string/binary) |
| `throwOnHttpError` | `boolean` | `true` | No | Throw when response is non-2xx |
| `timeoutMs` | `number` | — | No | Request timeout in milliseconds |

**Returns:** `HttpResult` object with `status`, `headers`, `body`, and `url`

#### Planned inbound/server HTTP support {% badge color="purple" %}planned{% /badge %}

Tentative source signature: `http({ path, method, ...options })`.

```ts
// Simple webhook endpoint
.id('webhook-receiver')
.from(http({ path: '/webhook', method: 'POST' }))

// Multiple methods on same path
.id('data-api')
.from(http({ path: '/api/data', method: ['GET', 'POST', 'PUT'] }))
```

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `path` | `string` | `'/'` | No | URL path to mount |
| `method` | `HttpMethod \| HttpMethod[]` | `'POST'` | No | Accepted HTTP methods |

Exchange body: `{ method, url, headers, body, query, params }`.
The final exchange becomes the HTTP response; no explicit `.to()` step is required.

Response behavior:

- The final exchange is returned to the HTTP client. If the final body is an object with optional fields `{ status?: number, headers?: Record<string,string>, body?: unknown }`, those fields are used to build the response.
- If `status` or `headers` are not provided, Routecraft returns the body with `200` status and no additional headers.
- For serialization and setting `Content-Type`, use a formatting step in your capability (e.g., a `.transform(...)` that sets appropriate headers).

### cli

{% badge %}experimental{% /badge %}

```ts
cli(command: string, options?: CliServerOptions): Source<T>
cli.stdout(): Destination<unknown, void>
cli.stderr(): Destination<unknown, void>
```

Expose routecraft routes as typed CLI commands. When all routes in a file use `cli()` sources, `craft run` enters CLI mode: running without a command shows generated help; running with a command dispatches to the matching route.

Schema properties automatically become named flags (`--flag-name <value>`). Help text is derived from property descriptions. Standard Schema validates all input before the route runs.

```ts
import { craft } from '@routecraft/routecraft';
import { cli } from '@routecraft/os';
import { z } from 'zod';

export default [
  craft().id('greet')
    .from(cli('greet', {
      schema: z.object({
        name: z.string().describe('Name to greet'),
        loud: z.boolean().optional().describe('Use uppercase'),
      }),
      description: 'Greet someone',
    }))
    .transform(({ name, loud }) =>
      loud ? `HELLO ${name.toUpperCase()}!` : `Hello, ${name}!`
    )
    .to(cli.stdout()),
];
```

```bash
craft run mycli.ts                         # shows help
craft run mycli.ts greet --name Alice      # Hello, Alice!
craft run mycli.ts greet --name Alice --loud  # HELLO ALICE!
craft run mycli.ts greet --help            # per-command help with flag list
```

**`CliServerOptions`** (for `.from()`):

| Field | Type | Default | Required | Description |
|-------|------|---------|----------|-------------|
| `schema` | `StandardSchemaV1` | - | No | Object schema; properties become `--flag` arguments |
| `description` | `string` | - | No | One-line description shown in help output |

**`CliClientOptions`** (for `.to()`):

`cli.stdout()` and `cli.stderr()` are pre-configured factories. No user-facing options are exposed; the `stream` field is set internally by each factory.

| Field | Type | Default | Required | Description |
|-------|------|---------|----------|-------------|
| `stream` | `"stdout" \| "stderr"` | `"stdout"` | No | Output stream to write to (set by factory) |

**Notes:**
- All routes in a CLI-mode file must use `cli()` sources. Mixing CLI and non-CLI sources in the same file is an error.
- Schemas must describe flat objects. Nested objects are not currently converted to flags.
- Boolean flags use presence for `true` (`--verbose`) and `--no-flag` for `false`.
- kebab-case flags (`--dry-run`) are mapped to camelCase keys (`dryRun`) before validation.
- `cli.stdout()` writes strings as-is; objects/arrays are pretty-printed as JSON.

## Test adapters

### noop

```ts
noop<T>(): NoopAdapter<T>
```

A no-operation adapter that discards messages. Useful for testing, development, or conditional routing.

```ts
// Conditional destination based on environment
.to(process.env.NODE_ENV === 'production' ? realDestination() : noop())

// Testing placeholder
.to(noop()) // Messages are discarded but logged
```

### spy
```ts
spy<T>(): SpyAdapter<T>
```

Records all exchanges passing through it. Use as a destination, processor, or enricher to capture and assert on pipeline output.

```ts
import { spy } from '@routecraft/routecraft'

const spyAdapter = spy()

const route = craft()
  .id('my-route')
  .from(simple('payload'))
  .to(spyAdapter)

const t = await testContext().routes(route).build()
await t.test()

expect(spyAdapter.received).toHaveLength(1)
expect(spyAdapter.received[0].body).toBe('payload')
expect(spyAdapter.calls.send).toBe(1)
```

**Properties:**

| Field | Type | Default | Required | Description |
|-------|------|---------|----------|-------------|
| `received` | `Exchange[]` | `[]` | No | All exchanges recorded |
| `calls.send` | `number` | `0` | No | Number of times used as destination |
| `calls.process` | `number` | `0` | No | Number of times used as processor |
| `calls.enrich` | `number` | `0` | No | Number of times used as enricher |

**Methods:**

| Method | Returns | Description |
|--------|---------|-------------|
| `reset()` | `void` | Clear all recorded data |
| `lastReceived()` | `Exchange` | Most recent exchange |
| `receivedBodies()` | `unknown[]` | Array of just the body values |

See [Testing](/docs/introduction/testing) for full usage patterns.

### pseudo
```ts
pseudo<Opts>(name?: string, options?: PseudoOptions): PseudoFactory<Opts>
pseudo<Opts>(name: string, options: PseudoKeyedOptions): PseudoKeyedFactory<Opts>
```

Create a **typed placeholder adapter** that satisfies the DSL at compile time but throws at runtime (or no-ops when `runtime: "noop"`). Use it to write example routes and documentation that compile without real adapter implementations; later, swap in the real adapter by changing only the import.

The returned factory can be used in `.from()`, `.to()`, `.enrich()`, `.tap()`, and `.process()`. Specify the **result type** with a generic on the call so the route body type flows correctly:

```ts
import { craft, timer, log, pseudo } from "@routecraft/routecraft";

// Option types (move to real adapter package later)
interface McpCallOptions {
  server: string;
  tool: string;
  args?: Record<string, unknown>;
}

interface GmailListResult {
  messages: { id: string; subject?: string }[];
  nextPageToken?: string;
}

const mcp = pseudo<McpCallOptions>("mcp");

// Object-only call: mcp<Result>(options)
craft()
  .from(timer({ intervalMs: 60_000 }))
  .enrich(
    mcp<GmailListResult>({
      server: "gmail",
      tool: "messages.list",
      args: { query: "is:unread" },
    }),
  )
  .split((r) => r.messages)
  .tap(log());
```

**Keyed (string-first) signature:** use `args: "keyed"` when the real adapter takes a key then options (e.g. queue name, table name):

```ts
const queue = pseudo<{ ttl?: number }>("queue", { args: "keyed" });

craft()
  .from(source)
  .to(queue<void>("outbound", { ttl: 5000 }));
```

**Options:**

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `runtime` | `"throw"` or `"noop"` | `"throw"` | `"throw"` (default): throw with adapter name when executed. `"noop"`: resolve without error (for tests). |
| `args` | `"keyed"` | — | Set to `"keyed"` to get a factory `(key: string, opts?) => PseudoAdapter<R>`. |

**Replacing with a real adapter:** keep the same call shape; only the import changes:

```ts
// Before (pseudo)
import { pseudo } from "@routecraft/routecraft";
const mcp = pseudo<McpCallOptions>("mcp");

// After (real adapter)
import { mcp } from "@routecraft/mcp-adapter";
// mcp<GmailListResult>({ server, tool, args }) still works
```

**Exported types:** `PseudoAdapter<R>`, `PseudoFactory<Opts>`, `PseudoKeyedFactory<Opts>`, `PseudoOptions`, `PseudoKeyedOptions`

## File adapters

### file
```ts
file(options: FileOptions & { chunked: true }): Source<string>
file(options: FileOptions): FileAdapter   // Source<string> & Destination<unknown, void>
```

Read and write plain text files. For structured data, use `json` or `csv` adapters.

**Source mode** (reads files):
```ts
// Read file once
.from(file({ path: './input.txt' }))

// Custom encoding
.from(file({ path: './data.txt', encoding: 'latin1' }))
```

**Destination mode** (writes files):
```ts
// Write to file (overwrite)
.to(file({ path: './output.txt', mode: 'write' }))

// Append to file
.to(file({ path: './log.txt', mode: 'append' }))

// Dynamic file paths with directory creation
.to(file({
  path: (exchange) => `./data/${exchange.body.date}.txt`,
  mode: 'write',
  createDirs: true
}))
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `path` | `string \| (exchange) => string` | Required | File path (static or dynamic function) |
| `mode` | `'read' \| 'write' \| 'append'` | `'read'` for source, `'write'` for destination | File operation mode |
| `encoding` | `BufferEncoding` | `'utf-8'` | Text encoding |
| `createDirs` | `boolean` | `false` | Create parent directories (destination only) |
| `chunked` | `boolean` | `false` | Emit one exchange per line instead of entire file (source only) |

**Chunked mode:** When `chunked: true`, the file source emits one exchange per line. Each exchange includes `FILE_LINE` (1-based line number) and `FILE_PATH` headers. When chunked, the adapter returns `Source` only (no `Destination`).

```ts
// Per-line emission
.from(file({ path: './big.txt', chunked: true }))
```

**Exported types:** `FileAdapter`, `FileOptions`

### json
```ts
json(options?: JsonOptions): JsonAdapter | JsonFileAdapter
```

Parse and format JSON data, or read/write JSON files.

**Transformer mode** (in-memory JSON parsing):
```ts
// Parse JSON string from body
.transform(json())

// Extract nested data using dot notation
.transform(json({ path: 'data.items' }))

// Custom parsing with getValue
.transform(json({
  from: (b) => b.rawJson,
  getValue: (parsed) => parsed as User[]
}))

// Write to custom field
.transform(json({
  to: (body, result) => ({ ...body, parsed: result })
}))
```

**Source mode** (read JSON files):
```ts
// Read and parse JSON file
.from(json({ path: './data.json' }))

// With custom reviver
.from(json({
  path: './data.json',
  reviver: (key, value) => {
    if (key === 'date') return new Date(value);
    return value;
  }
}))
```

**Destination mode** (write JSON files):
```ts
// Write with formatting
.to(json({
  path: './output.json',
  indent: 2
}))

// Dynamic paths with directory creation
.to(json({
  path: (exchange) => `./exports/${exchange.body.id}.json`,
  createDirs: true
}))

// With custom replacer
.to(json({
  path: './filtered.json',
  replacer: (key, value) => {
    if (key.startsWith('_')) return undefined;
    return value;
  }
}))
```

**Transformer Options** (when no `path` provided):

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `path` | `string` | — | Dot-notation path to extract (e.g., `"data.items[0]"`) |
| `from` | `(body) => string` | Uses `body` or `body.body` | Extract JSON string from exchange |
| `getValue` | `(parsed) => V` | — | Transform parsed value |
| `to` | `(body, result) => R` | Replaces body | Where to put result |

**File Options** (when `path` is a file path):

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `path` | `string \| (exchange) => string` | Required | File path (static or dynamic) |
| `mode` | `'read' \| 'write' \| 'append'` | `'read'` for source, `'write'` for destination | File operation mode |
| `encoding` | `BufferEncoding` | `'utf-8'` | Text encoding |
| `createDirs` | `boolean` | `false` | Create parent directories (destination only) |
| `indent` / `space` | `number` | `0` | JSON formatting spaces (destination only) |
| `reviver` | `(key, value) => unknown` | — | JSON.parse reviver (source only) |
| `replacer` | `(key, value) => unknown` | — | JSON.stringify replacer (destination only) |

**Exported types:** `JsonAdapter`, `JsonFileAdapter`, `JsonOptions`, `JsonTransformerOptions`, `JsonFileOptions`

### csv
```ts
csv(options: CsvOptions & { chunked: true }): Source<CsvRow>
csv(options: CsvOptions): CsvAdapter   // Source<CsvData> & Destination<unknown, void>
```

Read and write CSV files with automatic parsing/formatting. **Requires `papaparse` as a peer dependency.**

```bash
npm install papaparse
```

**Source mode** (read CSV files):
```ts
// Read CSV with headers
.from(csv({ path: './data.csv', header: true }))
// Emits array of objects: [{ name: 'Alice', age: '30' }, ...]

// Read CSV without headers
.from(csv({ path: './data.csv', header: false }))
// Emits array of arrays: [['Alice', '30'], ['Bob', '25'], ...]

// Custom delimiter and encoding
.from(csv({
  path: './data.csv',
  delimiter: ';',
  encoding: 'latin1',
  header: true
}))
```

**Destination mode** (write CSV files):
```ts
// Write array of objects to CSV
.to(csv({
  path: './output.csv',
  header: true
}))
// Automatically includes headers from object keys

// Write to tab-separated file
.to(csv({
  path: './data.tsv',
  delimiter: '\t',
  header: true
}))

// Dynamic paths with directory creation
.to(csv({
  path: (exchange) => `./reports/${exchange.body.reportDate}.csv`,
  createDirs: true,
  header: true
}))

// Append to existing CSV (skips header if file exists)
.to(csv({
  path: './log.csv',
  mode: 'append',
  header: true
}))
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `path` | `string \| (exchange) => string` | Required | File path (static or dynamic) |
| `header` | `boolean` | `true` | Use first row as headers (source), include headers (destination) |
| `delimiter` | `string` | `','` | Field separator |
| `quoteChar` | `string` | `'"'` | Quote character |
| `skipEmptyLines` | `boolean` | `true` | Skip empty lines during parsing |
| `encoding` | `BufferEncoding` | `'utf-8'` | Text encoding |
| `mode` | `'write' \| 'append'` | `'write'` | File operation mode (destination only) |
| `createDirs` | `boolean` | `false` | Create parent directories (destination only) |
| `chunked` | `boolean` | `false` | Emit one exchange per row instead of entire array (source only) |

**Behavior:**
- **Source** (default): Emits entire CSV as array of records (objects if `header: true`, arrays if `header: false`)
- **Source** (`chunked: true`): Emits one exchange per row with `CSV_ROW` (1-based row number) and `CSV_PATH` headers. Returns `Source` only (no `Destination`). Parse errors throw and are handled by the route's error handler.
- **Destination**: Writes exchange body (array of objects/arrays) as CSV. For `mode: 'append'`, skips header row if file exists

```ts
// Per-row emission
.from(csv({ path: './big.csv', chunked: true }))
```

**Peer dependency:** Requires `papaparse` to be installed separately.

**Exported types:** `CsvAdapter`, `CsvOptions`, `CsvRow`, `CsvData`

### jsonl
```ts
jsonl<T>(options: JsonlSourceOptions & { chunked: true }): Source<T>
jsonl<T>(options: JsonlCombinedOptions): Source<T[]> & Destination<unknown, void>
jsonl(options: JsonlDestinationOptions): Destination<unknown, void>
```

Read and write [JSON Lines](https://jsonlines.org/) files (one JSON object per line).

**Source mode** (read JSONL files):
```ts
// Read all lines as array
.from(jsonl({ path: './events.jsonl' }))
// Emits: [{ type: 'click', ts: 1 }, { type: 'view', ts: 2 }, ...]

// Per-line emission (chunked)
.from(jsonl({ path: './events.jsonl', chunked: true }))
// Emits one exchange per line with JSONL_LINE and JSONL_PATH headers

// Custom reviver
.from(jsonl({
  path: './data.jsonl',
  reviver: (key, value) => key === 'date' ? new Date(value) : value
}))
```

**Destination mode** (write JSONL files):
```ts
// Append to JSONL file (default)
.to(jsonl({ path: './output.jsonl' }))

// Overwrite file
.to(jsonl({ path: './output.jsonl', mode: 'write' }))

// Dynamic path with directory creation
.to(jsonl({
  path: (exchange) => `./logs/${exchange.body.date}.jsonl`,
  createDirs: true
}))

// Custom replacer (omit sensitive fields)
.to(jsonl({
  path: './output.jsonl',
  replacer: (key, value) => key === 'secret' ? undefined : value
}))
```

**Source options (`JsonlSourceOptions`):**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `path` | `string` | Required | File path to the JSONL file |
| `encoding` | `BufferEncoding` | `'utf-8'` | Text encoding |
| `chunked` | `boolean` | `false` | Emit one exchange per line instead of a single array |
| `reviver` | `(key, value) => unknown` | - | Reviver function passed to `JSON.parse` |

**Destination options (`JsonlDestinationOptions`):**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `path` | `string \| (exchange) => string` | Required | File path (static or dynamic) |
| `encoding` | `BufferEncoding` | `'utf-8'` | Text encoding |
| `mode` | `'write' \| 'append'` | `'append'` | File operation mode |
| `createDirs` | `boolean` | `false` | Create parent directories |
| `replacer` | `((key, value) => unknown) \| Array<string \| number> \| null` | - | Replacer passed to `JSON.stringify` |

**Behavior:**
- **Source** (default): Reads file, splits lines, parses each as JSON, emits `T[]` array. Empty lines are skipped.
- **Source** (`chunked: true`): Emits one `T` exchange per line with `JSONL_LINE` (1-based) and `JSONL_PATH` headers. Returns `Source` only (no `Destination`). Parse errors throw and are handled by the route's error handler.
- **Destination**: Stringifies body to `JSON.stringify(body) + '\n'`. Array bodies write one line per element. Default mode is append.

**Chunked headers:**

| Header | Type | Description |
|--------|------|-------------|
| `JSONL_LINE` | `number` | 1-based line number in the source file |
| `JSONL_PATH` | `string` | Path of the source file |

**Exported types:** `JsonlSourceOptions`, `JsonlDestinationOptions`, `JsonlCombinedOptions`, `JsonlOptions`

### html
```ts
html(options: HtmlOptions): HtmlAdapter
```

Extract data from HTML using CSS selectors (powered by cheerio), or read/write HTML files.

**Transformer mode** (in-memory HTML parsing):
```ts
// Extract text from title
.transform(html({ selector: 'title', extract: 'text' }))

// Extract multiple elements (returns array)
.transform(html({ selector: 'h2', extract: 'text' }))
// Result: ['First Heading', 'Second Heading', ...]

// Extract HTML content
.transform(html({ selector: '.content', extract: 'html' }))

// Extract attribute value
.transform(html({ selector: 'a', extract: 'attr', attr: 'href' }))

// Extract outer HTML (including element tag)
.transform(html({ selector: 'article', extract: 'outerHtml' }))

// Custom parsing from sub-field
.transform(html({
  selector: 'p',
  extract: 'text',
  from: (body) => body.htmlContent,
  to: (body, result) => ({ ...body, paragraphs: result })
}))
```

**Source mode** (read HTML files and extract):
```ts
// Read HTML file and extract title
.from(html({
  path: './page.html',
  selector: 'title',
  extract: 'text'
}))

// Extract multiple links from file
.from(html({
  path: './page.html',
  selector: 'a',
  extract: 'attr',
  attr: 'href'
}))
// Emits array: ['https://example.com', '/about', ...]
```

**Destination mode** (write HTML files):
```ts
// Write HTML string to file
.to(html({ path: './output.html' }))

// Dynamic paths with directory creation
.to(html({
  path: (exchange) => `./pages/${exchange.body.slug}.html`,
  createDirs: true
}))

// Append to HTML file
.to(html({
  path: './log.html',
  mode: 'append'
}))
```

**Transformer Options** (when no `path` provided):

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `selector` | `string` | Required | CSS selector to match elements |
| `extract` | `'text' \| 'html' \| 'attr' \| 'outerHtml' \| 'innerText' \| 'textContent'` | `'text'` | What to extract from matched elements |
| `attr` | `string` | — | Attribute name (required when `extract: 'attr'`) |
| `from` | `(body) => string` | Uses `body` or `body.body` | Extract HTML string from exchange |
| `to` | `(body, result) => R` | Replaces body | Where to put extracted result |

**File Options** (when `path` is provided):

All transformer options above, plus:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `path` | `string \| (exchange) => string` | Required | File path (static or dynamic) |
| `mode` | `'read' \| 'write' \| 'append'` | `'read'` for source, `'write'` for destination | File operation mode |
| `encoding` | `BufferEncoding` | `'utf-8'` | Text encoding |
| `createDirs` | `boolean` | `false` | Create parent directories (destination only) |

**Extract types:**
- `text` / `innerText` / `textContent`: Plain text content (strips HTML tags, removes `<style>` and `<script>`)
- `html`: Inner HTML content
- `outerHtml`: Element including its tag
- `attr`: Attribute value (requires `attr` option)

**Behavior:**
- **Single match**: Returns string
- **Multiple matches**: Returns array of strings
- **No matches**: Returns empty string
- **Source mode**: Reads HTML file and extracts data using selector
- **Destination mode**: Writes HTML string (from `exchange.body` or `exchange.body.body`) to file

**Exported types:** `HtmlAdapter`, `HtmlOptions`, `HtmlResult`

## Messaging adapters

### mail
```ts
mail(folder: string, options: Partial<MailServerOptions>): Source<MailMessage>
mail(folder: string): Destination<unknown, MailFetchResult>
mail(options: Partial<MailServerOptions>): Destination<unknown, MailFetchResult>
mail(action: MailAction): Destination<unknown, void>
mail(options?: Partial<MailClientOptions>): Destination<MailSendPayload, MailSendResult>
```

Read email via IMAP, send via SMTP, or perform IMAP operations. The adapter has four modes determined by the arguments you pass.

**Source mode (IMAP push):** Pass a folder and options to receive new messages via IMAP IDLE or polling. Each new email becomes a separate exchange.

```ts
craft()
  .id('inbox-watcher')
  .from(mail('INBOX', { markSeen: true }))
  .to(log())
```

**Fetch destination (IMAP pull):** Pass a folder string or server options to fetch messages. Use with `.enrich()` to pull mail on demand.

```ts
craft()
  .id('check-inbox')
  .from(cron('0 */5 * * * *'))
  .enrich(mail('INBOX'))
  .to(log())
```

**Send destination (SMTP):** Call with no arguments or client options to send email. The exchange body must be a `MailSendPayload`.

```ts
craft()
  .id('send-welcome')
  .from(direct('outbound', {}))
  .to(mail())
```

**Combined read and send:**

```ts
// Forward unread mail to a different address
craft()
  .id('mail-forwarder')
  .from(mail('INBOX', { unseen: true, markSeen: true }))
  .transform((msg) => ({
    to: 'team@example.com',
    subject: `Fwd: ${msg.subject}`,
    text: msg.text ?? '',
  }))
  .to(mail())
```

**IMAP operations:** Call with a `MailAction` object to move, copy, delete, flag, unflag, or append messages.

```ts
// Archive after processing
craft()
  .id('archive-processed')
  .from(mail('INBOX', { unseen: true }))
  .tap(processMessage)
  .to(mail({ action: 'move', folder: 'Archive' }))

// Flag important messages
craft()
  .id('flag-important')
  .from(mail('INBOX', { subject: 'URGENT' }))
  .to(mail({ action: 'flag', flags: '\\Flagged' }))
```

**Configuration via named accounts:**

Mail connection details are set once in your `craft.config.ts` so individual routes do not need to repeat them. Each capability file re-exports the config:

```ts
// craft.config.ts
import type { CraftConfig } from '@routecraft/routecraft'

export const craftConfig: CraftConfig = {
  mail: {
    accounts: {
      default: {
        imap: {
          host: 'imap.gmail.com',
          auth: { user: process.env.MAIL_USER!, pass: process.env.MAIL_APP_PASSWORD! },
        },
        smtp: {
          host: 'smtp.gmail.com',
          auth: { user: process.env.MAIL_USER!, pass: process.env.MAIL_APP_PASSWORD! },
          from: process.env.MAIL_USER!,
        },
      },
    },
  },
}
```

```ts
// capabilities/inbox-watcher.ts
export { craftConfig } from '../craft.config'
import { craft, mail, log } from '@routecraft/routecraft'

export default craft()
  .id('inbox-watcher')
  .from(mail('INBOX', { markSeen: true }))
  .to(log())
```

When multiple accounts are configured, select one per adapter call with the `account` option:

```ts
.from(mail('INBOX', { account: 'support' }))
.to(mail({ account: 'notifications' }))
```

**Server options (`MailServerOptions`):**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `host` | `string` | | IMAP host (e.g. `'imap.gmail.com'`) |
| `port` | `number` | `993` | IMAP port |
| `secure` | `boolean` | `true` | Use TLS |
| `auth` | `MailAuth` | | `{ user, pass }` credentials |
| `folder` | `string` | `'INBOX'` | IMAP mailbox folder |
| `markSeen` | `boolean` | `true` | Mark fetched messages as seen |
| `since` | `Date` | | Only fetch messages since this date |
| `unseen` | `boolean` | `true` | Only fetch unseen messages |
| `from` | `string \| string[]` | | Filter by sender (IMAP FROM search). Array = OR |
| `to` | `string \| string[]` | | Filter by recipient (IMAP TO search). Array = OR |
| `subject` | `string \| string[]` | | Filter by subject text (IMAP SUBJECT search). Array = OR |
| `body` | `string \| string[]` | | Filter by body text (IMAP TEXT search). Array = OR |
| `header` | `Record<string, string \| string[]>` | | Filter by arbitrary IMAP headers. Array values = OR |
| `includeHeaders` | `true \| string[]` | | Raw headers to include on fetched messages. `true` = all |
| `limit` | `number` | | Maximum messages per fetch |
| `pollIntervalMs` | `number` | | Poll interval in ms (default: IMAP IDLE) |
| `account` | `string` | | Named account from context config (uses default if omitted) |

**Client options (`MailClientOptions`):**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `host` | `string` | | SMTP host (e.g. `'smtp.gmail.com'`) |
| `port` | `number` | `465` | SMTP port |
| `secure` | `boolean` | `true` | Use TLS |
| `auth` | `MailAuth` | | `{ user, pass }` credentials |
| `from` | `string` | | Default sender address |
| `replyTo` | `string` | | Default reply-to address |
| `cc` | `string \| string[]` | | Default CC recipients |
| `bcc` | `string \| string[]` | | Default BCC recipients |
| `account` | `string` | | Named account from context config (uses default if omitted) |

**`MailMessage` (exchange body in source/fetch modes):**

| Field | Type | Description |
|-------|------|-------------|
| `uid` | `number` | IMAP UID |
| `messageId` | `string` | Message-ID header |
| `from` | `string` | Sender address |
| `to` | `string \| string[]` | Recipient address(es) |
| `subject` | `string` | Subject line |
| `date` | `Date` | Date sent |
| `text` | `string?` | Plain text body |
| `html` | `string?` | HTML body |
| `cc` | `string[]?` | CC recipients |
| `bcc` | `string[]?` | BCC recipients |
| `replyTo` | `string?` | Reply-to address |
| `attachments` | `MailAttachment[]?` | File attachments |
| `rawHeaders` | `Record<string, string \| string[]>?` | Raw email headers (when `includeHeaders` is set) |
| `flags` | `Set<string>` | IMAP flags (e.g. `\Seen`, `\Flagged`) |
| `folder` | `string` | The IMAP folder this message was fetched from |

**`MailSendPayload` (exchange body for `.to(mail())`):**

| Field | Type | Description |
|-------|------|-------------|
| `to` | `string \| string[]` | Recipient address(es) |
| `subject` | `string` | Subject line |
| `text` | `string?` | Plain text body |
| `html` | `string?` | HTML body |
| `cc` | `string \| string[]?` | CC recipients |
| `bcc` | `string \| string[]?` | BCC recipients |
| `from` | `string?` | Sender (overrides option-level `from`) |
| `replyTo` | `string?` | Reply-to (overrides option-level `replyTo`) |
| `attachments` | `Array<{ filename, content, contentType? }>?` | File attachments |

**`MailSendResult`:**

| Field | Type | Description |
|-------|------|-------------|
| `messageId` | `string` | Message-ID of the sent email |
| `accepted` | `string[]` | Accepted recipient addresses |
| `rejected` | `string[]` | Rejected recipient addresses |
| `response` | `string` | SMTP server response string |

**Exported types:** `MailAuth`, `MailServerOptions`, `MailClientOptions`, `MailOptions`, `MailMessage`, `MailAttachment`, `MailSendPayload`, `MailSendResult`, `MailFetchResult`, `MailContextConfig`, `MailAccountConfig`, `MailAction`, `MailClientManager`, `MAIL_CLIENT_MANAGER`

---

## Browser adapters

### agentBrowser
```ts
import { agentBrowser } from '@routecraft/browser'
```

Automate a browser session using the [agent-browser](https://www.npmjs.com/package/agent-browser) library. Each exchange gets an isolated session (derived from `exchange.id`), so `split()`/`aggregate()` flows work correctly. Use with `.to()`, `.enrich()`, or `.tap()`. Requires `agent-browser` as a peer dependency.

**Navigate and take a snapshot:**

```ts
import { agentBrowser } from '@routecraft/browser'

craft()
  .id('scrape-page')
  .from(simple({ url: 'https://example.com' }))
  .to(agentBrowser('open', { url: (ex) => ex.body.url }))
  .enrich(agentBrowser('snapshot', { json: true }))
  .to(log())
// Result merged into body: { stdout: '...', parsed: { snapshot: '...', refs: {...} }, exitCode: 0 }
```

**Click an element and get text:**

```ts
craft()
  .id('click-and-read')
  .from(source)
  .to(agentBrowser('click', { selector: '#submit-btn' }))
  .enrich(agentBrowser('get', { info: 'text', selector: '.result' }))
  .to(log())
```

**Dynamic URL from exchange body:**

```ts
craft()
  .id('dynamic-browse')
  .from(simple({ link: 'https://example.com/page' }))
  .enrich(agentBrowser('open', { url: (ex) => ex.body.link }))
  .enrich(agentBrowser('snapshot'))
  .to(log())
```

**Close the session explicitly:**

```ts
.to(agentBrowser('close'))
```

**Commands:**

| Command | Required Options | Description |
|---------|-----------------|-------------|
| `open` | `url` | Navigate to a URL |
| `click` | `selector` | Click an element (optional `newTab`) |
| `dblclick` | `selector` | Double-click an element |
| `fill` | `selector`, `value` | Clear and fill a form field |
| `type` | `selector`, `value` | Type text into a focused element |
| `press` | `key` | Press a keyboard key |
| `hover` | `selector` | Hover over an element |
| `focus` | `selector` | Focus an element |
| `select` | `selector`, `value` | Select a dropdown option |
| `check` | `selector` | Check a checkbox |
| `uncheck` | `selector` | Uncheck a checkbox |
| `scroll` | `direction` | Scroll the page (`up`, `down`, `left`, `right`; optional `pixels`) |
| `snapshot` | | Take an accessibility snapshot (optional `interactive`) |
| `screenshot` | | Take a screenshot (optional `path`, `full`, `annotate`) |
| `eval` | `js` | Evaluate JavaScript in the page |
| `get` | `info` | Get page info: `text`, `html`, `value`, `title`, `url`, `count`, `attr`, `box`, `styles` (optional `selector`, `attr`) |
| `wait` | | Wait for a selector or timeout (optional `selector`, `ms`) |
| `close` | | Close the browser session |
| `back` | | Navigate back |
| `forward` | | Navigate forward |
| `reload` | | Reload the page |
| `tab` | | Manage tabs (optional `action`: `new`, `close`, `list`; `index`; `url`) |

Command-specific option values that accept `Resolvable<T, V>` can be a static value or a function `(exchange) => value` for dynamic resolution.

**Base options (available on every command):**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `session` | `string \| (exchange) => string` | `exchange.id` | Override auto-session derived from exchange ID |
| `headed` | `boolean` | `false` | Run browser in headed mode (show window) |
| `json` | `boolean` | `false` | Parse command output into `result.parsed` |
| `args` | `string[]` | | Extra CLI flags (ignored in library mode) |

**Result shape (`AgentBrowserResult`):**

| Field | Type | Description |
|-------|------|-------------|
| `stdout` | `string` | Text output from the command |
| `parsed` | `unknown` | Parsed JSON output (only when `json: true`) |
| `exitCode` | `number` | `0` for success, `1` for failure |

---

## AI adapters

### mcp
```ts
import { mcp } from '@routecraft/ai'
```

Expose capabilities as MCP tools or call remote MCP servers. Requires `mcpPlugin()` in your context plugins when used as a source.

**Source mode -- define a discoverable MCP tool:**

```ts
import { mcp } from '@routecraft/ai'
import { z } from 'zod'

craft()
  .id('fetch-webpage')
  .from(mcp('fetch-webpage', {
    description: 'Fetch the content of a webpage',
    schema: z.object({ url: z.string().url() }),
    keywords: ['fetch', 'web'],
  }))
  .transform(async ({ url }) => {
    const res = await fetch(url)
    return { content: await res.text() }
  })
```

`description` is required whenever options are passed. Schema and keywords are optional.

**Destination mode -- call a remote MCP tool:**

```ts
// Recommended: by server id registered in mcpPlugin({ clients }).
// Auth is inherited from the client config automatically.
.enrich(mcp('browser:browser_navigate', { args: (ex) => ({ url: ex.body.url }) }))

// By URL and tool name (use inline auth if needed)
.enrich(mcp({ url: 'http://127.0.0.1:8089/mcp', tool: 'browser_navigate' }, { args: (ex) => ({ url: ex.body.url }) }))
```

When using the `serverId` path (recommended), auth configured on the client in `mcpPlugin({ clients })` flows to the destination automatically. Inline `auth` on `McpClientOptions` is available as an escape hatch for the raw `url` path or to override registered config, but prefer centralizing credentials in the plugin config.

**Options (McpServerOptions -- source):**

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `description` | `string` | Yes | Human-readable description for AI discovery |
| `schema` | `StandardSchemaV1` | No | Body validation schema (Zod, Valibot, ArkType) |
| `headerSchema` | `StandardSchemaV1` | No | Header validation schema |
| `keywords` | `string[]` | No | Keywords for discovery and categorization |

**Options (McpClientOptions -- destination):**

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `url` | `string` | One of url/serverId | Direct HTTP URL of the remote MCP server |
| `serverId` | `string` | One of url/serverId | Named server registered via `mcpPlugin({ clients })` |
| `tool` | `string` | No | Tool name to invoke (or set `exchange.body.tool`) |
| `args` | `(exchange) => Record<string, unknown>` | No | Extractor for tool arguments; defaults to `exchange.body` |
| `auth` | `McpClientAuthOptions` | No | Auth credentials for HTTP requests. Auto-inherited from `mcpPlugin({ clients })` when using `serverId`; use to override or for inline `url` connections |

**McpClientAuthOptions:**

| Field | Type | Description |
|-------|------|-------------|
| `token` | `string \| string[] \| (() => string \| Promise<string>)` | Bearer token, array of tokens (round-robin), or provider function called per request |
| `headers` | `Record<string, string>` | Additional request headers; overrides `token` if `Authorization` is set |

**Relation to `direct()`:** `mcp()` is built on `direct()`. The key difference is that `description` is required when passing options, ensuring every exposed tool is discoverable by AI agents.

See [Expose as MCP](/docs/advanced/expose-as-mcp) and [Call an MCP](/docs/advanced/call-an-mcp).

### llm
```ts
import { llm } from '@routecraft/ai'
```

Call a language model and get text or structured output. Requires `llmPlugin()` in your context plugins.

```ts
import { llm } from '@routecraft/ai'

// Text output
craft()
  .id('summarise')
  .from(source)
  .enrich(llm('anthropic:claude-haiku-4-5-20251001', {
    systemPrompt: 'Summarise the following in one sentence.',
    userPrompt: (ex) => ex.body.content,
  }))
  .to(log())
// Result merged into body: { ..., text: '...', usage: { inputTokens, outputTokens } }

// Structured output with Zod schema
import { z } from 'zod'

const sentimentSchema = z.object({
  sentiment: z.enum(['positive', 'neutral', 'negative']),
  confidence: z.number(),
})

craft()
  .id('classify')
  .from(source)
  .enrich(llm('openai:gpt-4o', {
    systemPrompt: 'Classify the sentiment of the text.',
    userPrompt: (ex) => ex.body.text,
    outputSchema: sentimentSchema,
  }))
  .to(log())
// result.output is typed as { sentiment: string, confidence: number }
```

Model ID format: `"provider:model-name"` (e.g., `"ollama:llama3.2"`, `"anthropic:claude-sonnet-4-6"`).

**Supported providers:** `openai`, `anthropic`, `ollama`, `openrouter`, `gemini`

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `systemPrompt` | `string \| (exchange) => string` | — | System prompt (static or derived from exchange) |
| `userPrompt` | `string \| (exchange) => string` | — | User prompt (static or derived from exchange) |
| `outputSchema` | `StandardSchemaV1` | — | Zod/Valibot/ArkType schema for structured output |
| `temperature` | `number` | — | Sampling temperature |
| `maxTokens` | `number` | — | Maximum tokens to generate |
| `topP` | `number` | — | Top-p sampling |
| `frequencyPenalty` | `number` | — | Frequency penalty |
| `presencePenalty` | `number` | — | Presence penalty |

**Result shape (merged into body by `.enrich()`):**

| Field | Type | Description |
|-------|------|-------------|
| `text` | `string` | Raw model output |
| `output` | `T` | Parsed structured output (only when `outputSchema` provided) |
| `usage.inputTokens` | `number` | Input token count |
| `usage.outputTokens` | `number` | Output token count |
| `usage.totalTokens` | `number` | Total token count |

Provider credentials are configured once in `llmPlugin()` and shared across all `llm()` calls. See [Plugins reference](/docs/reference/plugins).

### embedding
```ts
import { embedding } from '@routecraft/ai'
```

Generate vector embeddings from text. Requires `embeddingPlugin()` in your context plugins.

```ts
import { embedding } from '@routecraft/ai'

craft()
  .id('embed-document')
  .from(source)
  .enrich(embedding('openai:text-embedding-3-small', {
    using: (ex) => ex.body.content,
  }))
  .to(vectorStore)
// Result merged into body: { ..., embedding: [0.123, -0.456, ...] }

// Embed a combination of fields
.enrich(embedding('ollama:nomic-embed-text', {
  using: (ex) => `${ex.body.title} ${ex.body.description}`,
}))
```

Model ID format: `"provider:model-name"` (e.g., `"huggingface:all-MiniLM-L6-v2"`, `"ollama:nomic-embed-text"`).

**Supported providers:** `huggingface` (local ONNX, no API key), `ollama`, `openai`, `mock` (deterministic test vectors)

**Options:**

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `using` | `(exchange) => string \| string[]` | Yes | Extract the text to embed from the exchange |

**Result shape (merged into body by `.enrich()`):**

| Field | Type | Description |
|-------|------|-------------|
| `embedding` | `number[]` | Vector representation of the input text |

Provider credentials are configured once in `embeddingPlugin()` and shared across all `embedding()` calls. See [Plugins reference](/docs/reference/plugins).

---

## Related

{% quick-links %}

{% quick-link title="Adapters" icon="presets" href="/docs/introduction/adapters" description="How adapters work and how to configure them." /%}
{% quick-link title="Creating adapters" icon="plugins" href="/docs/advanced/custom-adapters" description="Build your own source, destination, or processor adapter." /%}
{% quick-link title="Testing" icon="presets" href="/docs/introduction/testing" description="Test your capabilities with testContext() and the spy() adapter." /%}

{% /quick-links %}