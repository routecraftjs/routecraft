---
title: json
---

[← All adapters](/docs/reference/adapters) {% .lead %}

```ts
json(options?: JsonTransformerOptions): Transformer   // no path: parse a JSON string in the body
json<T>(options: JsonFileOptions): JsonFileAdapterType<T> // Source<T> & Destination<unknown> & Enricher<unknown, T>
```

Parse and format JSON data, or read/write JSON files. The mere presence of `path` selects the file roles: `path` always means a file path, and the transformer's extraction key is `pointer`. With `path`, the operation keyword selects the role: `.from()` reads, `.to()` writes, `.enrich()` reads mid-route.

"Presence" means the key was **supplied**, not that it holds something truthy. Only an omitted `path` selects the transformer role; a supplied `path` that is empty or `undefined` is refused with `RC5003` rather than silently demoted to a transformer that would ignore every file option passed alongside it.

**Transformer role** (in-memory JSON parsing):
```ts
// Parse JSON string from body
.transform(json())

// Extract nested data using dot notation
.transform(json({ pointer: 'data.items' }))

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

**Source role** (read JSON files):
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

**Read mid-route** (read + parse a JSON file partway through a route): The adapter is also an enricher whose `fetch` reads and parses the file, so `.enrich()` can pull the value in. The parsed value replaces the body; pass an aggregator such as `only()` to merge instead. Pass the type parameter for a typed body. The fetch role accepts dynamic (function) paths. Parse failures throw and surface through the pipeline (the `onParseError` lifecycle controls apply to the source role only).

```ts
// Replace the body with the parsed file
.enrich(json({ path: './data.json' }))

// Enrich the body with a parsed catalogue, keeping the existing fields
.enrich(
  json<Product[]>({ path: './products.json' }),
  only((catalogue) => catalogue, 'catalogue'),
)
```

**Destination role** (write JSON files). The send is void: the body flows through the `.to()` step unchanged.
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

// Delete a JSON file (idempotent: an already-absent path is a no-op)
.to(json({ path: (ex) => ex.body.processedPath, delete: true }))
```

**Transformer Options** (when no `path` provided):

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `pointer` | `string` | -- | Dot-notation pointer into the parsed value (e.g., `"data.items[0]"`) |
| `from` | `(body) => string` | Uses `body` or `body.body` | Extract JSON string from exchange |
| `getValue` | `(parsed) => V` | -- | Transform parsed value |
| `to` | `(body, result) => R` | Replaces body | Where to put result |

**File Options** (when `path` is provided):

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `path` | `string \| (exchange) => string` | Required | File path (static for the source role; send/fetch also accept a function) |
| `append` | `boolean` | `false` | Send role: append instead of overwriting; mutually exclusive with `delete` |
| `delete` | `boolean` | `false` | Send role: delete the file instead of writing (idempotent); mutually exclusive with `append` |
| `encoding` | `BufferEncoding` | `'utf-8'` | Text encoding |
| `createDirs` | `boolean` | `false` | Create parent directories (send role only) |
| `indent` / `space` | `number` | `0` | JSON formatting spaces (send role only) |
| `reviver` | `(key, value) => unknown` | -- | JSON.parse reviver (source/fetch roles) |
| `replacer` | `(key, value) => unknown` | -- | JSON.stringify replacer (send role only) |
| `onParseError` | `'fail' \| 'abort' \| 'drop'` | `'fail'` | How to handle a parse failure (source role only). See [parse error handling](/docs/reference/adapters#parse-error-handling). |

Passing both `append: true` and `delete: true` throws `RC5003` at construction.

**Exported types:** `JsonFileAdapterType`, `JsonOptions`, `JsonTransformerOptions`, `JsonFileOptions`
