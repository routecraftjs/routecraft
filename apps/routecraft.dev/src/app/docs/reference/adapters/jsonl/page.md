---
title: jsonl
---

[← All adapters](/docs/reference/adapters) {% .lead %}

```ts
jsonl<T, R>(options?: JsonlTransformerOptions): Transformer   // no path: parse a JSONL string in the body
jsonl<T>(options: JsonlFileOptions & { path: string; chunked: true }): Source<T>
jsonl<T>(options: JsonlFileOptions & { mode: 'read' }): JsonlReadAdapter<T>
jsonl<T>(options: JsonlFileOptions & { path: string }): Source<T[]> & Destination<unknown, void>
jsonl(options: JsonlFileOptions): Destination<unknown, void>   // dynamic (function) path
```

Read and write [JSON Lines](https://jsonlines.org/) files (one JSON object per line).

**Transformer mode** (parse a JSONL string already in the body):
```ts
// Parse a JSONL string (e.g. an http() response body) into an array
.transform(jsonl())

// Pluck the string and write the array to a sub-field
.transform(jsonl({
  from: (b) => b.body,
  to: (b, rows) => ({ ...b, rows })
}))
```

**Source mode** (read JSONL files):
```ts
// Read all lines as array
.from(jsonl({ path: './events.jsonl' }))
// Emits: [{ type: 'click', ts: 1 }, { type: 'view', ts: 2 }, ...]

// Per-line emission (chunked)
.from(jsonl({ path: './events.jsonl', chunked: true }))
// Emits one exchange per line with JsonlHeaders.LINE and JsonlHeaders.PATH headers

// Custom reviver
.from(jsonl({
  path: './data.jsonl',
  reviver: (key, value) => key === 'date' ? new Date(value) : value
}))
```

**Read mid-route** (read + parse a JSONL file partway through a route): In `read` mode the adapter is also a destination whose `send` reads and parses the file and returns the array, so `.enrich()` / `.to()` can pull it in, the same way an HTTP `GET` returns a body. Read-as-destination accepts dynamic (function) paths. Parse failures throw and surface through the pipeline (the `onParseError` lifecycle controls apply to source mode only).

```ts
// Enrich the body with the parsed array, keeping the existing fields
.enrich(
  jsonl<Event>({ path: './events.jsonl', mode: 'read' }),
  only((events) => events, 'events'),
)

// Replace the body with the parsed array
.to(jsonl({ path: './events.jsonl', mode: 'read' }))
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

// Delete a JSONL file (idempotent: an already-absent path is a no-op)
.to(jsonl({ path: (ex) => ex.body.processedPath, mode: 'delete' }))
```

**Transformer options (`JsonlTransformerOptions`, when no `path` provided):**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `from` | `(body) => string` | Uses `body` or `body.body` | Extract the JSONL string from the exchange |
| `to` | `(body, rows) => R` | Replaces body | Where to put the parsed array |
| `reviver` | `(key, value) => unknown` | - | Reviver passed to `JSON.parse` |

**File options (`JsonlFileOptions`):**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `path` | `string \| (exchange) => string` | Required | File path. Function (dynamic) paths are destination-only; source mode requires a static string |
| `mode` | `'read' \| 'write' \| 'append' \| 'delete'` | `'append'` (destination) | File operation mode (`read` returns the parsed array mid-route; `delete` removes the file, idempotently) |
| `encoding` | `BufferEncoding` | `'utf-8'` | Text encoding |
| `chunked` | `boolean` | `false` | Emit one exchange per line instead of a single array (source mode only) |
| `createDirs` | `boolean` | `false` | Create parent directories (destination mode only) |
| `reviver` | `(key, value) => unknown` | - | Reviver passed to `JSON.parse` (read/source mode) |
| `replacer` | `((key, value) => unknown) \| Array<string \| number> \| null` | - | Replacer passed to `JSON.stringify` (write modes) |
| `onParseError` | `'fail' \| 'abort' \| 'drop'` | `'fail'` | How to handle a line parse failure (source mode only). See [parse error handling](/docs/reference/adapters#parse-error-handling). |

**Behavior:**
- **Source** (default): Reads file, splits lines, parses each as JSON, emits `T[]` array. Empty lines are skipped.
- **Source** (`chunked: true`): Emits one `T` exchange per line with `JsonlHeaders.LINE` (1-based) and `JsonlHeaders.PATH` headers. Returns `Source` only (no `Destination`). With `onParseError: 'fail'` (default) malformed lines are routed through the route's `.error()` handler and the stream continues; `'abort'` aborts on the first bad line; `'drop'` emits `exchange:dropped` with `reason: 'parse-failed'`.
- **Destination**: Stringifies body to `JSON.stringify(body) + '\n'`. Array bodies write one line per element. Default mode is append.

**Chunked headers:**

| Header | Type | Description |
|--------|------|-------------|
| `JsonlHeaders.LINE` (`routecraft.jsonl.line`) | `number` | 1-based line number in the source file |
| `JsonlHeaders.PATH` (`routecraft.jsonl.path`) | `string` | Path of the source file |

**Exported types:** `JsonlReadAdapter`, `JsonlFileOptions`, `JsonlTransformerOptions`, `JsonlOptions`
