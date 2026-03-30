---
title: The Exchange
---

The data envelope that flows through every capability. {% .lead %}

## What is an exchange?

Every piece of data that moves through a capability is wrapped in an **exchange**. When a source produces data, it becomes an exchange. Every operation receives that exchange and passes it along. The destination receives it last.

An exchange has two parts:

- **`body`** -- the main payload. This is your data: an object, a string, a number, whatever your capability is working with.
- **`headers`** -- metadata about the exchange. Timestamps, IDs, adapter-specific context, and anything you want to carry alongside the data without putting it in the body.

```json
{
  "id": "a3f4e1b2-9c6d-4e8a-b1f3-2d7c0e5a9f12",
  "body": {
    "to": "alice@example.com",
    "subject": "Your order is confirmed"
  },
  "headers": {
    "routecraft.correlation_id": "req-abc-123",
    "routecraft.route": "send-confirmation"
  }
}
```

## Body

The body is what your operations act on. `.transform()`, `.filter()`, and `.process()` all receive the current body (or the full exchange) and return something new.

```ts
craft()
  .id('greet')
  .from(simple({ name: 'Alice' }))
  .transform((body) => `Hello, ${body.name}!`)  // body is { name: 'Alice' }
  .to(log())                                      // body is now 'Hello, Alice!'
```

The body type flows through the DSL. TypeScript tracks what shape the body is at each step, giving you full type safety throughout the pipeline.

## Headers

Headers travel alongside the body without being part of it. They are useful for metadata you want available throughout the pipeline but do not want polluting the body.

Set a header with `.header()`:

```ts
craft()
  .id('process-order')
  .from(simple({ orderId: '123', amount: 49.99 }))
  .header('x-tenant', 'acme-corp')
  .header('x-priority', (exchange) => exchange.body.amount > 100 ? 'high' : 'normal')
  .process((exchange) => {
    const tenant = exchange.headers['x-tenant']     // 'acme-corp'
    const priority = exchange.headers['x-priority'] // 'normal'
    return exchange
  })
  .to(log())
```

Headers can be static values or derived from the exchange at runtime.

## Built-in headers

Routecraft sets a number of `routecraft.*` headers automatically on every exchange:

| Header | Description |
| --- | --- |
| `routecraft.exchange_id` | Unique ID for this exchange |
| `routecraft.correlation_id` | Shared ID across split/tap branches for tracing |
| `routecraft.route` | ID of the capability that produced this exchange |
| `routecraft.context_id` | ID of the running context |

These are useful for logging, debugging, and correlating exchanges across capability chains.

### Adapter-specific headers

Chunked file-based adapters set additional headers on each emitted exchange:

| Header | Type | Set by | Description |
| --- | --- | --- | --- |
| `routecraft.file.line` | `number` | `file({ chunked: true })` | 1-based line number in the source file |
| `routecraft.file.path` | `string` | `file({ chunked: true })` | Path of the source file |
| `routecraft.csv.row` | `number` | `csv({ chunked: true })` | 1-based data row number (excludes header row) |
| `routecraft.csv.path` | `string` | `csv({ chunked: true })` | Path of the source CSV file |
| `routecraft.jsonl.line` | `number` | `jsonl({ chunked: true })` | 1-based line number in the source JSONL file |
| `routecraft.jsonl.path` | `string` | `jsonl({ chunked: true })` | Path of the source JSONL file |

Access these via the exported `HeadersKeys` constant for type safety:

```ts
import { HeadersKeys } from '@routecraft/routecraft'

.process((exchange) => {
  const lineNum = exchange.headers[HeadersKeys.JSONL_LINE]
  const filePath = exchange.headers[HeadersKeys.JSONL_PATH]
  return exchange
})
```

## Body vs full exchange access

Most operations give you a choice: work with just the body, or the full exchange.

**Body only** with `.transform()`:

```ts
.transform((body) => body.toUpperCase())
```

**Full exchange** with `.process()`:

```ts
.process((exchange) => {
  const tenantId = exchange.headers['x-tenant']
  return { ...exchange, body: { ...exchange.body, tenantId } }
})
```

**Full exchange** with `.filter()`:

```ts
.filter((exchange) => exchange.headers['x-priority'] === 'high')
```

Use `.transform()` when you only need the data. Use `.process()` or `.filter()` when you need headers, correlation IDs, or the context.

## Exchange in taps

When you `.tap()`, the tap receives a **deep copy** of the exchange with a new ID. The correlation ID is preserved so you can trace the tap back to its parent exchange. The main pipeline continues immediately without waiting for the tap.

```ts
craft()
  .id('order-pipeline')
  .from(source)
  .tap((exchange) => {
    // exchange.headers['routecraft.correlation_id'] links back to the parent
    auditLog.write(exchange)
  })
  .to(destination)
```

---

## Related

{% quick-links %}

{% quick-link title="Exchange headers reference" icon="presets" href="/docs/reference/configuration#headers" description="Full list of built-in routecraft.* headers." /%}

{% /quick-links %}
