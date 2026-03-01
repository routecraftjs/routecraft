---
title: Adapters
---

Catalog of adapters and authoring guidance. {% .lead %}

## Adapter overview

| Adapter | Category | Description | Types |
|---------|----------|-------------|-------|
| [`simple`](#simple) | Core | Static or dynamic data sources | `Source` |
| [`log`](#log) | Core | Console logging for debugging | `Destination` |
| [`timer`](#timer) | Core | Scheduled/recurring execution | `Source` |
| [`direct`](#direct) | Core | Synchronous inter-route communication | `Source`, `Destination` |
| [`http`](#http-client) | Core | HTTP client requests | `Destination` |
| [`noop`](#noop) | Core | No-operation placeholder | `Destination` |
| [`pseudo`](#pseudo) | Core | Typed placeholder for docs/examples | `Source`, `Destination`, `Processor` |
| [`file`](#file) | File | Read/write text files | `Source`, `Destination` |
| [`json`](#json) | File | JSON file handling with parsing | `Source`, `Destination`, `Transformer` |
| [`csv`](#csv) | File | CSV file processing | `Source`, `Destination` |
| [`html`](#html) | File | HTML parsing and file handling | `Source`, `Destination`, `Transformer` |
| — | HTTP | HTTP server (inbound) | Planned |

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
log<T>(formatter?: (exchange: Exchange<T>) => unknown, options?: { level?: LogLevel }): LogAdapter<T>
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
debug<T>(formatter?: (exchange: Exchange<T>) => unknown): LogAdapter<T>
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

// HTTP API with direct routing
craft()
  .id('api-endpoint')
  .from(httpServer('/api/orders'))
  .to(direct('order-processing')) // Synchronous call

craft()
  .id('order-processor')
  .from(direct('order-processing', {}))
  .process(validateOrder)
  .process(saveOrder)
  .transform(() => ({ status: 'created', orderId: '12345' }))
  // Response goes back to HTTP client automatically

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
| `z.strictObject()` | Error (RC5011) | Reject unexpected fields |

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
// RC5011: { userId: '...', missing: 'action' }
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
// RC5011: { userId: '...', action: 'create', extra: 'field' }
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
const ctx = context().routes(...).build()
await ctx.start()

const registry = ctx.getStore(DirectAdapter.ADAPTER_DIRECT_REGISTRY)
const routes = registry ? Array.from(registry.values()) : []
// [{ endpoint: 'fetch-content', description: '...', schema, keywords }]
```

Useful for runtime introspection, documentation generation, and building dynamic routing systems.

### http (client)

```ts
http<T, R>(options: HttpOptions<T>): HttpAdapter<T, R>
```

Make HTTP requests. Returns a `Destination` adapter that works with both `.to()` and `.enrich()`.

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

**Returns:** `HttpResult` object with `status`, `headers`, `body`, and `url`

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

### file

```ts
file(options: FileOptions): FileAdapter
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
csv(options: CsvOptions): CsvAdapter
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

**Behavior:**
- **Source**: Emits entire CSV as array of records (objects if `header: true`, arrays if `header: false`)
- **Destination**: Writes exchange body (array of objects/arrays) as CSV. For `mode: 'append'`, skips header row if file exists.

**Peer dependency:** Requires `papaparse` to be installed separately.

**Exported types:** `CsvAdapter`, `CsvOptions`

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

### http {% badge %}wip{% /badge %}

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

## Testing

RouteCraft uses standard Vitest mocking for testing. No special spy adapters needed!

### Testing Destinations

```ts
import { context, craft, simple } from '@routecraft/routecraft'

const destSpy = vi.fn()

const ctx = context()
  .routes(
    craft()
      .from(simple('test-data'))
      .to(destSpy)
  )
  .build()

await ctx.start()

// Standard Vitest assertions
expect(destSpy).toHaveBeenCalledTimes(1)
const sentExchange = destSpy.mock.calls[0][0]
expect(sentExchange.body).toBe('test-data')
expect(sentExchange.headers['x-test']).toBe('value')
```

### Testing Processors

```ts
const processorSpy = vi.fn((exchange) => {
  // Your processor logic here
  return exchange
})

const ctx = context()
  .routes(
    craft()
      .from(simple('input'))
      .process(processorSpy)
      .to(vi.fn())
  )
  .build()

await ctx.start()

expect(processorSpy).toHaveBeenCalled()
```

### Helper Functions for Common Patterns

```ts
// Helper to get all received bodies
function getReceivedBodies(spy: any) {
  return spy.mock.calls.map(call => call[0].body)
}

// Helper to get all received headers
function getReceivedHeaders(spy: any, headerName: string) {
  return spy.mock.calls.map(call => call[0].headers[headerName])
}

const destSpy = vi.fn()
await ctx.start()

expect(getReceivedBodies(destSpy)).toEqual(['test-data'])
expect(getReceivedHeaders(destSpy, 'x-test')).toEqual(['value'])
```

## Custom adapters

Adapters implement operation interfaces and can use the context store for shared state.

### Basic adapter structure

```ts
import { Source, Destination, Processor } from '@routecraft/routecraft'

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

class MyDestination implements Destination<any, void> {
  readonly adapterId = 'my.destination.adapter'

  async send(exchange): Promise<void> {
    // Destination implementation (no return value)
    console.log('Received:', exchange.body)
  }
}

class MyDataFetcher implements Destination<any, { data: string }> {
  readonly adapterId = 'my.data.adapter'

  async send(exchange): Promise<{ data: string }> {
    // Fetch and return data
    const result = await fetchSomeData(exchange.body);
    return result; // Can be used with .to() or .enrich()
  }
}
```

### Using context store

```ts
// Extend StoreRegistry for type safety
declare module '@routecraft/routecraft' {
  interface StoreRegistry {
    'my.adapter.config': { apiKey: string }
    'my.adapter.cache': Map<string, any>
  }
}

class ConfigurableAdapter implements Destination<any, void> {
  readonly adapterId = 'configurable.adapter'

  async send(exchange): Promise<void> {
    const config = exchange.context.getStore('my.adapter.config')
    const cache = exchange.context.getStore('my.adapter.cache')
    
    // Use config and cache...
  }
}
```

### Merged options pattern

```ts
import { MergedOptions } from '@routecraft/routecraft'

interface MyAdapterOptions {
  timeout: number
  retries: number
}

class MyAdapter implements Destination<any, void>, MergedOptions<MyAdapterOptions> {
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

  async send(exchange): Promise<void> {
    const opts = this.mergedOptions(exchange.context)
    // Use merged options...
  }
}
```

### Implementation interfaces

| Interface | Method | Purpose | Used With |
|-----------|--------|---------|-----------|
| `Source<T>` | `subscribe(context, handler, abortController)` | Produce messages for routes | `.from()` |
| `Destination<T, R>` | `send(exchange): R` | Send/fetch data, optionally return result | `.to()`, `.enrich()`, `.tap()` |
| `Processor<T, R>` | `process(exchange)` | Transform exchanges in route steps | `.process()` |

Use `Destination<T, R>` for `.to()`, `.enrich()`, and `.tap()`. The difference is in how results are used:
- `.to()` ignores the result by default (side-effect) or replaces body if a value is returned
- `.enrich()` merges the result into the body by default
- `.tap()` receives a snapshot and runs fire-and-forget (result ignored)

**Adapters that return data should specify the return type:**

```ts
class MyDataAdapter implements Destination<InputType, OutputType> {
  async send(exchange: Exchange<InputType>): Promise<OutputType> {
    const result = await fetchData();
    return result; // Available to both .to() and .enrich()
  }
}
```

**Adapters with no return value use `void`:**

```ts
class MyLogAdapter implements Destination<any, void> {
  async send(exchange: Exchange): Promise<void> {
    console.log(exchange.body);
    // No return value
  }
}
```

For detailed type definitions, see `packages/routecraft/src/types.ts` and operation files in `packages/routecraft/src/operations/`.

### Best practices

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