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

**Options:**
- `intervalMs` - Time between executions (default: 1000ms)
- `delayMs` - Delay before first execution (default: 0ms)
- `repeatCount` - Number of executions before stopping (default: Infinity)
- `fixedRate` - Execute at exact intervals ignoring processing time (default: false)
- `exactTime` - Execute at specific time of day in "HH:mm:ss" format
- `jitterMs` - Add random delay to prevent synchronized spikes (default: 0ms)

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

**Options:**
- `method` - HTTP method (default: 'GET')
- `url` - URL string or function that returns URL
- `headers` - Static headers or function that returns headers
- `query` - Query parameters as object or function
- `body` - Request body as value or function
- `timeoutMs` - Request timeout in milliseconds
- `throwOnHttpError` - Throw on non-2xx responses (default: true)

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

## File adapters

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

## HTTP adapters

### http

```ts
http(options: HttpOptions): HttpAdapter
```

HTTP server using Node.js built-in HTTP module. Creates endpoints that can receive requests.

```ts
// Simple webhook endpoint
.id('webhook-receiver')
.from(http({ port: 3000, path: '/webhook' }))

// POST endpoint with JSON parsing
.id('user-api')
.from(http({ 
  port: 8080, 
  path: '/api/users',
  method: 'POST',
  parseJson: true
}))

// Multiple methods on same path
.id('data-api')
.from(http({ 
  port: 3000, 
  path: '/api/data',
  method: ['GET', 'POST', 'PUT']
}))

// With custom request handling
.id('file-upload')
.from(http({ 
  port: 3000, 
  path: '/upload',
  method: 'POST',
  parseJson: false, // Handle raw body
  maxBodySize: '10mb'
}))
```

**Options:**
- `port` - Server port (required)
- `path` - URL path pattern (default: '/')
- `method` - HTTP method(s) to accept (default: 'POST')
- `parseJson` - Auto-parse JSON request bodies (default: true)
- `maxBodySize` - Maximum request body size (default: '1mb')
- `cors` - Enable CORS headers (default: false)
- `timeout` - Request timeout in ms (default: 30000)

**Exchange body:** Request object with `{ method, url, headers, body, query, params }`

**Response:** Use `.to()` destination to send HTTP responses, or responses default to 200 OK

## Email adapters

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