---
title: Adapters
---

Catalog of adapters and authoring guidance. {% .lead %}

## Adapter overview

| Adapter | Category | Description | Types |
|---------|----------|-------------|-------|
| [`simple`](#simple) | Core | Static or dynamic data sources | `Source` |
| [`log`](#log) | Core | Console logging for debugging | `Destination`, `Tap` |
| [`timer`](#timer) | Core | Scheduled/recurring execution | `Source` |
| [`channel`](#channel) | Core | Inter-route communication | `Source`, `Destination` |
| [`fetch`](#fetch) | Core | HTTP client requests | `Destination`, `Enricher` |
| [`noop`](#noop) | Core | No-operation placeholder | `Destination` |
| [`spy`](#spy) | Core | Testing adapter that records interactions | `Destination`, `Processor`, `Enricher`, `Tap` |
| [`file`](#file) | File | Read/write text files | `Source`, `Destination`, `Enricher` |
| [`json`](#json) | File | JSON file handling with parsing | `Source`, `Destination`, `Enricher` |
| [`csv`](#csv) | File | CSV file processing | `Source`, `Destination`, `Enricher` |
| [`http`](#http) | HTTP | HTTP server endpoints | `Source` |
| [`smtp`](#smtp) | Email | SMTP email sending | `Destination` |

## Core adapters

### simple

```ts
simple<T>(producer: (() => T | Promise<T>) | T): SimpleAdapter<T>
```

Create a static or dynamic data source. Can produce a single value, an array of values, or use a function to generate data.

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
log<T>(): LogAdapter<T>
```

Log messages to the console. Can be used as a destination with `.to()` or for side effects with `.tap()`.

```ts
// Log final result
.to(log())

// Log intermediate data without changing flow
.tap(log())
```

**Output format:** Logs exchange ID, body, and headers in a clean format

### timer

```ts
timer(options?: TimerOptions): TimerAdapter
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
| `jitterMs` | `number` | `0` | No | Random jitter added to each scheduled run |

**Headers added:** Timer metadata including fired time, counter, period, and next run time

### channel

```ts
channel<T>(name: string, options?: Partial<ChannelAdapterOptions>): ChannelAdapter<T>
```

Enable inter-route communication. Routes can send messages to channels and other routes can consume from the same channels.

```ts
// Producer route
craft()
  .id('data-producer')
  .from(source)
  .transform(processData)
  .to(channel('processed-data'))

// Consumer route
craft()
  .id('data-consumer')
  .from(channel('processed-data'))
  .to(destination)

// Bidirectional communication
craft()
  .id('request-handler')
  .from(channel('requests'))
  .transform(handleRequest)
  .to(channel('responses'))
```

**Options:**
- `channelType` - Custom channel implementation (default: in-memory)

**Features:**
- Automatic channel name sanitization (special chars become dashes)
- Context store integration for shared channels
- Pluggable channel implementations (Redis, message queues, etc.)

### fetch

```ts
fetch<T, R>(options: FetchOptions<T>): FetchAdapter<T, R>
```

Make HTTP requests. Can be used as an enricher with `.enrich()` or destination with `.to()`.

```ts
// Static GET request as enricher
.enrich(fetch({ 
  method: 'GET',
  url: 'https://api.example.com/users'
}))

// Dynamic URL based on exchange data
.enrich(fetch({ 
  method: 'GET',
  url: (exchange) => `https://api.example.com/users/${exchange.body.userId}`
}))

// POST with body as destination
.to(fetch({
  method: 'POST',
  url: 'https://api.example.com/users',
  body: (exchange) => ({ name: exchange.body.name }),
  headers: { 'Content-Type': 'application/json' }
}))

// With query parameters
.enrich(fetch({
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

**Returns:** `FetchResult` object with `status`, `headers`, `body`, and `url`

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

A testing adapter that records all interactions and provides assertion helpers. Implements multiple interfaces so it can be used anywhere in a route.

```ts
// Test destinations
const spyDest = spy()
.id('test-route')
.from(simple('data'))
.to(spyDest)

expect(spyDest.received).toHaveLength(1)
expect(spyDest.receivedBodies()).toEqual(['data'])

// Test processors
const processSpy = spy()
.from(simple('input'))
.process(processSpy)
.to(spy())

expect(processSpy.calls.process).toBe(1)

// Test enrichers
const enrichSpy = spy()
.from(simple({ name: 'John' }))
.enrich(enrichSpy)
.to(spy())

expect(enrichSpy.calls.enrich).toBe(1)
```

**Available properties:**
- `received: Exchange[]` - All exchanges received
- `calls.send: number` - Number of send() calls
- `calls.process: number` - Number of process() calls  
- `calls.enrich: number` - Number of enrich() calls

**Available methods:**
- `reset()` - Clear all recorded data
- `lastReceived()` - Get most recent exchange
- `receivedBodies()` - Get array of body values

**Use cases:** Testing, debugging, development verification

**Behavior:** Logs that message was discarded, then resolves immediately

### file

```ts
file(options: FileOptions): FileAdapter
```

Read and write files as strings. For structured data, use `json` or `csv` adapters.

```ts
// Read file as source
.id('file-reader')
.from(file({ path: './input.txt', encoding: 'utf-8' }))

// Watch file for changes
.id('config-watcher')
.from(file({ path: './config.txt', watch: true }))

// Write to file
.to(file({ path: './output.txt', mode: 'write' }))

// Append to file
.to(file({ path: './log.txt', mode: 'append' }))

// Dynamic file paths
.to(file({ 
  path: (exchange) => `./data/${exchange.body.date}.txt`,
  mode: 'write',
  createDirs: true
}))
```

**Options:**
- `path` - File path string or function
- `mode` - 'read', 'write', 'append' (default: 'read' for source, 'write' for destination)
- `encoding` - Text encoding (default: 'utf-8')
- `watch` - Watch for file changes (source only, default: false)
- `createDirs` - Create parent directories if needed (default: false)

### json

```ts
json(options: JsonOptions): JsonAdapter
```

Read and write JSON files with automatic parsing/stringification.

```ts
// Read JSON file
.id('json-loader')
.from(json({ path: './data.json' }))

// Watch JSON file for changes
.id('config-watcher')
.from(json({ path: './config.json', watch: true }))

// Write JSON with formatting
.to(json({ 
  path: './output.json', 
  indent: 2,
  mode: 'write'
}))

// Dynamic JSON files
.to(json({ 
  path: (exchange) => `./exports/${exchange.body.id}.json`,
  mode: 'write'
}))
```

**Options:**
- `path` - File path string or function
- `mode` - 'read', 'write', 'append' (default: 'read' for source, 'write' for destination)
- `watch` - Watch for file changes (source only, default: false)
- `indent` - JSON formatting spaces (default: 0)
- `createDirs` - Create parent directories if needed (default: false)

**Behavior:**
- **Source**: Parses JSON and emits the parsed object
- **Destination**: Stringifies exchange body to JSON

### csv

```ts
csv(options: CsvOptions): CsvAdapter
```

Read and write CSV files with configurable parsing options.

```ts
// Read CSV with headers
.id('csv-import')
.from(csv({ path: './data.csv', headers: true }))

// Read CSV without headers (array of arrays)
.id('raw-csv')
.from(csv({ path: './data.csv', headers: false }))

// Custom delimiter and encoding
.id('european-csv')
.from(csv({ 
  path: './data.csv', 
  delimiter: ';', 
  encoding: 'latin1',
  headers: true
}))

// Write CSV
.to(csv({ 
  path: './output.csv', 
  headers: ['name', 'email', 'age']
}))

// Dynamic CSV files
.to(csv({ 
  path: (exchange) => `./reports/${exchange.body.reportDate}.csv`,
  headers: true
}))
```

**Options:**
- `path` - File path string or function
- `headers` - Use first row as headers (boolean) or provide header array
- `delimiter` - Field separator (default: ',')
- `encoding` - Text encoding (default: 'utf-8')
- `quote` - Quote character (default: '"')
- `escape` - Escape character (default: '"')
- `mode` - 'read', 'write', 'append' (default: 'read' for source, 'write' for destination)
- `createDirs` - Create parent directories if needed (default: false)

**Behavior:**
- **Source**: Emits one exchange per CSV row (object if headers=true, array if headers=false)
- **Destination**: Writes exchange body as CSV row

### http

Standard signature: `http({ path, method, ...options })`.

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
- If `status` or `headers` are not provided, RouteCraft returns the body with `200` status and no additional headers.
- For serialization and setting `Content-Type`, use a formatting step in your route (e.g., a `.format(...)` or `.transform(...)` that sets appropriate headers). If you set a response content type header in your pipeline, it will be used.

### smtp

```ts
smtp(options: SmtpOptions): SmtpAdapter
```

Send emails via SMTP protocol. Focused implementation for SMTP servers only.

```ts
// Basic SMTP email
.to(smtp({
  host: 'smtp.gmail.com',
  port: 587,
  auth: { user: 'user@gmail.com', pass: 'password' },
  to: (exchange) => exchange.body.userEmail,
  subject: 'Welcome!',
  text: (exchange) => `Hello ${exchange.body.name}!`
}))

// HTML email with templates
.to(smtp({
  host: 'mail.company.com',
  port: 25,
  from: 'noreply@company.com',
  to: (exchange) => exchange.body.recipients,
  subject: (exchange) => `Order ${exchange.body.orderId} confirmed`,
  html: (exchange) => renderTemplate('order-confirmation', exchange.body)
}))

// With attachments
.to(smtp({
  host: 'smtp.company.com',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  to: 'admin@company.com',
  subject: 'Daily Report',
  text: 'Please find attached report.',
  attachments: (exchange) => [
    { filename: 'report.pdf', content: exchange.body.pdfBuffer }
  ]
}))
```

**Options:**
- `host` - SMTP server hostname (required)
- `port` - SMTP server port (default: 587)
- `secure` - Use TLS (default: false)
- `auth` - Authentication `{ user, pass }` (optional)
- `from` - From address string or function
- `to` - To address(es) string, array, or function (required)
- `cc` - CC address(es) string, array, or function
- `bcc` - BCC address(es) string, array, or function
- `subject` - Subject string or function
- `text` - Plain text body string or function
- `html` - HTML body string or function
- `attachments` - Attachments array or function returning attachments

**Attachment format:** `{ filename: string, content: Buffer | string, contentType?: string }`

## Best practices

- **Provide a DSL factory for adapters**: expose a function that returns the adapter instance so routes read naturally and avoid `new`.

```ts
// ✅ Prefer: DSL factory function
import { xyz } from '@acme/routecraft-xyz'

export default craft()
  .id('uses-xyz')
  .from(xyz({ /* options */ }))

// ❌ Avoid: direct class instantiation in routes
import { XyzAdapter } from '@acme/routecraft-xyz'

export default craft()
  .id('uses-xyz')
  .from(new XyzAdapter({ /* options */ }))
```

## Custom adapters

Adapters implement operation interfaces and can use the context store for shared state.

### Basic adapter structure

```ts
import { Source, Destination, Processor } from '@routecraftjs/routecraft'

class MyAdapter implements Source<string> {
  readonly adapterId = 'my.custom.adapter'

  async subscribe(context, handler, abortController) {
    // Source implementation
    while (!abortController.signal.aborted) {
      await handler('data')
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }
}

class MyDestination implements Destination<any> {
  readonly adapterId = 'my.destination.adapter'

  async send(exchange) {
    // Destination implementation
    console.log('Received:', exchange.body)
  }
}
```

### Using context store

```ts
// Extend StoreRegistry for type safety
declare module '@routecraftjs/routecraft' {
  interface StoreRegistry {
    'my.adapter.config': { apiKey: string }
    'my.adapter.cache': Map<string, any>
  }
}

class ConfigurableAdapter implements Destination<any> {
  readonly adapterId = 'configurable.adapter'

  async send(exchange) {
    const config = exchange.context.getStore('my.adapter.config')
    const cache = exchange.context.getStore('my.adapter.cache')
    
    // Use config and cache...
  }
}
```

### Merged options pattern

```ts
import { MergedOptions } from '@routecraftjs/routecraft'

interface MyAdapterOptions {
  timeout: number
  retries: number
}

class MyAdapter implements Destination<any>, MergedOptions<MyAdapterOptions> {
  constructor(public options: Partial<MyAdapterOptions> = {}) {}

  mergedOptions(context): MyAdapterOptions {
    const globalOptions = context.getStore('my.adapter.global.options') || {}
    return {
      timeout: 5000,
      retries: 3,
      ...globalOptions,
      ...this.options
    }
  }

  async send(exchange) {
    const opts = this.mergedOptions(exchange.context)
    // Use merged options...
  }
}
```

### Implementation interfaces

| Interface | Method | Purpose |
|-----------|--------|---------|
| `Source<T>` | `subscribe(context, handler, abortController)` | Produce messages for routes |
| `Destination<T>` | `send(exchange)` | Consume final messages from routes |
| `Processor<T, R>` | `process(exchange)` | Transform exchanges in route steps |
| `Enricher<T, R>` | `enrich(exchange)` | Add data for enrichment operations |
| `Tap<T>` | `tap(exchange)` | Side effects without changing exchange |

For detailed type definitions, see `packages/routecraft/src/types.ts` and operation files in `packages/routecraft/src/operations/`.