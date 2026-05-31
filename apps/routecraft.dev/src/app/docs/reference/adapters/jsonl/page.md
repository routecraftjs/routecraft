---
title: jsonl
---

[← All adapters](/docs/reference/adapters) {% .lead %}

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
| `onParseError` | `'fail' \| 'abort' \| 'drop'` | `'fail'` | How to handle a line parse failure. See [parse error handling](#parse-error-handling). |

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
- **Source** (`chunked: true`): Emits one `T` exchange per line with `JSONL_LINE` (1-based) and `JSONL_PATH` headers. Returns `Source` only (no `Destination`). With `onParseError: 'fail'` (default) malformed lines are routed through the route's `.error()` handler and the stream continues; `'abort'` aborts on the first bad line; `'drop'` emits `exchange:dropped` with `reason: 'parse-failed'`.
- **Destination**: Stringifies body to `JSON.stringify(body) + '\n'`. Array bodies write one line per element. Default mode is append.

**Chunked headers:**

| Header | Type | Description |
|--------|------|-------------|
| `JSONL_LINE` | `number` | 1-based line number in the source file |
| `JSONL_PATH` | `string` | Path of the source file |

**Exported types:** `JsonlSourceOptions`, `JsonlDestinationOptions`, `JsonlCombinedOptions`, `JsonlOptions`
