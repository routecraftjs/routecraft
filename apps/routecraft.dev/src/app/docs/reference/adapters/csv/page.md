---
title: csv
---

[← All adapters](/docs/reference/adapters) {% .lead %}

```ts
csv(options: CsvOptions & { chunked: true }): Source<CsvRow>
csv(options: CsvOptions): CsvAdapter   // Source<CsvData> & Destination<unknown, void>
```

Read and write CSV files with automatic parsing/formatting. **Requires `papaparse` as a peer dependency.**

```bash
bun add papaparse
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
| `chunked` | `boolean` | `false` | Emit one exchange per row instead of entire array (source only) |
| `onParseError` | `'fail' \| 'abort' \| 'drop'` | `'fail'` | How to handle a row parse failure (source only). See [parse error handling](/docs/reference/adapters#parse-error-handling). |

**Behavior:**
- **Source** (default): Emits entire CSV as array of records (objects if `header: true`, arrays if `header: false`)
- **Source** (`chunked: true`): Emits one exchange per row with `CSV_ROW` (1-based row number) and `CSV_PATH` headers. Returns `Source` only (no `Destination`). With `onParseError: 'fail'` (default) malformed rows are routed through the route's `.error()` handler and the stream continues; `'abort'` reverts to fail-fast on the first bad row; `'drop'` emits `exchange:dropped` with `reason: 'parse-failed'`.
- **Destination**: Writes exchange body (array of objects/arrays) as CSV. For `mode: 'append'`, skips header row if file exists

```ts
// Per-row emission
.from(csv({ path: './big.csv', chunked: true }))
```

**Peer dependency:** Requires `papaparse` to be installed separately.

**Exported types:** `CsvAdapter`, `CsvOptions`, `CsvRow`, `CsvData`
