---
title: csv
---

[← All adapters](/docs/reference/adapters) {% .lead %}

```ts
csv(options?: CsvTransformerOptions): Transformer   // no path: parse a CSV string in the body
csv(options: CsvFileOptions & { chunked: true }): Source<CsvRow>
csv(options: CsvFileOptions & { mode: 'read' }): CsvReadAdapter
csv(options: CsvFileOptions): CsvAdapter   // Source<CsvData> & Destination<unknown, void>
```

Read and write CSV files with automatic parsing/formatting. **Requires `papaparse` as a peer dependency.**

```bash
bun add papaparse
```

**Transformer mode** (parse a CSV string already in the body):
```ts
// Parse a CSV string (e.g. an http() response body) into rows
.transform(csv())

// Pluck the string and write the rows to a sub-field
.transform(csv({
  from: (b) => b.body,
  to: (b, rows) => ({ ...b, rows })
}))
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

**Read mid-route** (read + parse a CSV file partway through a route): In `read` mode the adapter is also a destination whose `send` reads and parses the file and returns the rows, so `.enrich()` / `.to()` can pull them in, the same way an HTTP `GET` returns a body. Read-as-destination accepts dynamic (function) paths. Parse failures throw and surface through the pipeline (the `onParseError` lifecycle controls apply to source mode only).

```ts
// Enrich the body with the parsed rows, keeping the existing fields
.enrich(
  csv({ path: './catalogue.csv', mode: 'read' }),
  only((rows) => rows, 'rows'),
)

// Replace the body with the parsed rows
.to(csv({ path: './data.csv', mode: 'read' }))
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

// Delete a CSV file (idempotent: an already-absent path is a no-op)
.to(csv({ path: (ex) => ex.body.processedPath, mode: 'delete' }))
```

**Transformer Options** (when no `path` provided):

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `from` | `(body) => string` | Uses `body` or `body.body` | Extract the CSV string from the exchange |
| `to` | `(body, rows) => R` | Replaces body | Where to put the parsed rows |
| `header` / `delimiter` / `quoteChar` / `skipEmptyLines` | | | Same parsing options as below |

**File Options** (when `path` is provided):

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `path` | `string \| (exchange) => string` | Required | File path (static or dynamic) |
| `header` | `boolean` | `true` | Use first row as headers (source), include headers (destination) |
| `delimiter` | `string` | `','` | Field separator |
| `quoteChar` | `string` | `'"'` | Quote character |
| `skipEmptyLines` | `boolean` | `true` | Skip empty lines during parsing |
| `encoding` | `BufferEncoding` | `'utf-8'` | Text encoding |
| `mode` | `'read' \| 'write' \| 'append' \| 'delete'` | `'read'` for source, `'write'` for destination | File operation mode (`read` returns parsed rows mid-route; `delete` removes the file, idempotently) |
| `createDirs` | `boolean` | `false` | Create parent directories (destination only) |
| `chunked` | `boolean` | `false` | Emit one exchange per row instead of entire array (source only) |
| `onParseError` | `'fail' \| 'abort' \| 'drop'` | `'fail'` | How to handle a row parse failure (source only). See [parse error handling](/docs/reference/adapters#parse-error-handling). |

**Behavior:**
- **Source** (default): Emits entire CSV as array of records (objects if `header: true`, arrays if `header: false`)
- **Source** (`chunked: true`): Emits one exchange per row with `CsvHeaders.ROW` (1-based row number) and `CsvHeaders.PATH` headers. Returns `Source` only (no `Destination`). With `onParseError: 'fail'` (default) malformed rows are routed through the route's `.error()` handler and the stream continues; `'abort'` reverts to fail-fast on the first bad row; `'drop'` emits `exchange:dropped` with `reason: 'parse-failed'`.
- **Destination**: Writes exchange body (array of objects/arrays) as CSV. For `mode: 'append'`, skips header row if file exists

```ts
// Per-row emission
.from(csv({ path: './big.csv', chunked: true }))
```

**Peer dependency:** Requires `papaparse` to be installed separately.

**Exported symbols:** `CsvHeaders` (the header key object used above, e.g. `CsvHeaders.ROW` / `CsvHeaders.PATH`); types `CsvAdapter`, `CsvReadAdapter`, `CsvOptions`, `CsvTransformerOptions`, `CsvFileOptions`, `CsvRow`, `CsvData`
