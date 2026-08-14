# csv

[← All adapters](/docs/reference/adapters)

```ts
csv(options?: CsvTransformerOptions): Transformer   // no path: parse a CSV string in the body
csv(options: CsvFileOptions & { chunked: true }): CsvChunkedAdapter // Source<CsvRow> & Destination<unknown> & Enricher<unknown, CsvData>
csv(options: CsvFileOptions): CsvAdapter   // Source<CsvData> & Destination<unknown> & Enricher<unknown, CsvData>
```

Read and write CSV files with automatic parsing/formatting. One factory, one type; the operation keyword selects the role: `.from()` reads, `.to()` writes, `.enrich()` reads mid-route. **Requires `papaparse` as a peer dependency.**

"Presence" means the key was **supplied**, not that it holds something truthy. Only an omitted `path` selects the transformer role; a supplied `path` that is empty or `undefined` is refused with `RC5003` rather than silently demoted to a transformer that would ignore every file option passed alongside it.

```bash
bun add papaparse
```

**Transformer role** (parse a CSV string already in the body):
```ts
// Parse a CSV string (e.g. an http() response body) into rows
.transform(csv())

// Pluck the string and write the rows to a sub-field
.transform(csv({
  from: (b) => b.body,
  to: (b, rows) => ({ ...b, rows })
}))
```

**Source role** (read CSV files):
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

**Read mid-route** (read + parse a CSV file partway through a route): The adapter is also an enricher whose `fetch` reads and parses the file, so `.enrich()` can pull the rows in. The rows replace the body; pass an aggregator such as `only()` to merge instead. The fetch role accepts dynamic (function) paths. Parse failures throw and surface through the pipeline (the `onParseError` lifecycle controls apply to the source role only).

```ts
// Replace the body with the parsed rows
.enrich(csv({ path: './data.csv' }))

// Enrich the body with the parsed rows, keeping the existing fields
.enrich(
  csv({ path: './catalogue.csv' }),
  only((rows) => rows, 'rows'),
)
```

**Destination role** (write CSV files). The send is void: the body flows through the `.to()` step unchanged.
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

// Append to existing CSV (header only written when the file does not exist yet)
.to(csv({
  path: './log.csv',
  append: true,
  header: true
}))

// Delete a CSV file (idempotent: an already-absent path is a no-op)
.to(csv({ path: (ex) => ex.body.processedPath, delete: true }))
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
| `path` | `string \| (exchange) => string` | Required | File path (static for the source role; send/fetch also accept a function) |
| `header` | `boolean` | `true` | Use first row as headers (read), include headers (write) |
| `delimiter` | `string` | `','` | Field separator |
| `quoteChar` | `string` | `'"'` | Quote character |
| `skipEmptyLines` | `boolean` | `true` | Skip empty lines during parsing |
| `encoding` | `BufferEncoding` | `'utf-8'` | Text encoding |
| `append` | `boolean` | `false` | Send role: append rows instead of overwriting; mutually exclusive with `delete` |
| `delete` | `boolean` | `false` | Send role: delete the file instead of writing (idempotent); mutually exclusive with `append` |
| `createDirs` | `boolean` | `false` | Create parent directories (send role only) |
| `chunked` | `true` | `false` | Emit one exchange per row instead of entire array (source role only). Must be the literal `true`: a widened `boolean` is a compile error, so dynamic chunking is an explicit branch at the call site |
| `onParseError` | `'fail' \| 'abort' \| 'drop'` | `'fail'` | How to handle a row parse failure (source role only). See [parse error handling](/docs/reference/adapters#parse-error-handling). |

Passing both `append: true` and `delete: true` throws `RC5003` at construction.

**Behavior:**
- **Source** (default): Emits entire CSV as array of records (objects if `header: true`, arrays if `header: false`)
- **Source** (`chunked: true`): Emits one exchange per row with `CsvHeaders.ROW` (1-based row number) and `CsvHeaders.PATH` headers. Chunking concerns the source role only; the send/fetch roles are unchanged. With `onParseError: 'fail'` (default) malformed rows are routed through the route's `.error()` handler and the stream continues; `'abort'` reverts to fail-fast on the first bad row; `'drop'` emits `exchange:dropped` with `reason: 'parse-failed'`.
- **Destination**: Writes exchange body (array of objects/arrays) as CSV; overwrite by default. With `append: true`, the header row is only written when the file does not exist yet

```ts
// Per-row emission
.from(csv({ path: './big.csv', chunked: true }))
```

**Peer dependency:** Requires `papaparse` to be installed separately.

**Exported symbols:** `CsvHeaders` (the header key object used above, e.g. `CsvHeaders.ROW` / `CsvHeaders.PATH`); types `CsvAdapter`, `CsvChunkedAdapter`, `CsvOptions`, `CsvTransformerOptions`, `CsvFileOptions`, `CsvRow`, `CsvData`
