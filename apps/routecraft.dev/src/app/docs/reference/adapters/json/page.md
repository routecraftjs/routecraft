---
title: json
---

[← All adapters](/docs/reference/adapters) {% .lead %}

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
| `path` | `string` | -- | Dot-notation path to extract (e.g., `"data.items[0]"`) |
| `from` | `(body) => string` | Uses `body` or `body.body` | Extract JSON string from exchange |
| `getValue` | `(parsed) => V` | -- | Transform parsed value |
| `to` | `(body, result) => R` | Replaces body | Where to put result |

**File Options** (when `path` is a file path):

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `path` | `string \| (exchange) => string` | Required | File path (static or dynamic) |
| `mode` | `'read' \| 'write' \| 'append'` | `'read'` for source, `'write'` for destination | File operation mode |
| `encoding` | `BufferEncoding` | `'utf-8'` | Text encoding |
| `createDirs` | `boolean` | `false` | Create parent directories (destination only) |
| `indent` / `space` | `number` | `0` | JSON formatting spaces (destination only) |
| `reviver` | `(key, value) => unknown` | -- | JSON.parse reviver (source only) |
| `replacer` | `(key, value) => unknown` | -- | JSON.stringify replacer (destination only) |
| `onParseError` | `'fail' \| 'abort' \| 'drop'` | `'fail'` | How to handle a parse failure (source only). See [parse error handling](/docs/reference/adapters#parse-error-handling). |

**Exported types:** `JsonAdapter`, `JsonFileAdapter`, `JsonOptions`, `JsonTransformerOptions`, `JsonFileOptions`
