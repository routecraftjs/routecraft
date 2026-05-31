---
title: file
---

[← All adapters](/docs/reference/adapters) {% .lead %}

```ts
file(options: FileOptions & { chunked: true }): Source<string>
file(options: FileOptions): FileAdapter   // Source<string> & Destination<unknown, void>
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
| `chunked` | `boolean` | `false` | Emit one exchange per line instead of entire file (source only) |

**Chunked mode:** When `chunked: true`, the file source emits one exchange per line. Each exchange includes `FILE_LINE` (1-based line number) and `FILE_PATH` headers. When chunked, the adapter returns `Source` only (no `Destination`).

```ts
// Per-line emission
.from(file({ path: './big.txt', chunked: true }))
```

**Exported types:** `FileAdapter`, `FileOptions`
