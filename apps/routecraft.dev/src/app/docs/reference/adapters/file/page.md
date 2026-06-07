---
title: file
---

[← All adapters](/docs/reference/adapters) {% .lead %}

```ts
file(options: FileOptions & { chunked: true }): Source<string>
file(options: FileOptions & { mode: 'read' }): FileReadAdapter // Source<string> & Destination<unknown, string>
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

// Delete a file (idempotent: an already-absent path is a no-op)
.to(file({ path: (ex) => ex.body.processedPath, mode: 'delete' }))

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
| `mode` | `'read' \| 'write' \| 'append' \| 'delete'` | `'read'` for source, `'write'` for destination | File operation mode (`delete` removes the file, idempotently) |
| `encoding` | `BufferEncoding` | `'utf-8'` | Text encoding |
| `createDirs` | `boolean` | `false` | Create parent directories (destination only) |
| `chunked` | `boolean` | `false` | Emit one exchange per line instead of entire file (source only) |

**Read mid-route:** In `read` mode the adapter is also a destination whose `send` returns the file content, so you can read a file partway through a route with `.enrich()` or `.to()`, the same way an HTTP `GET` is a destination that returns a body. Unlike source mode, read-as-destination accepts dynamic (function) paths, because the exchange exists when the read runs.

```ts
// Pull a file into the body mid-route, alongside the existing data
.enrich(file({ path: './config.txt', mode: 'read' }), only((s: string) => s, 'config'))

// Read a file whose path depends on the exchange
.to(file({ path: (ex) => `./data/${ex.body.id}.txt`, mode: 'read' }))
```

**Chunked mode:** When `chunked: true`, the file source emits one exchange per line. Each exchange includes `FILE_LINE` (1-based line number) and `FILE_PATH` headers. When chunked, the adapter returns `Source` only (no `Destination`).

```ts
// Per-line emission
.from(file({ path: './big.txt', chunked: true }))
```

**Exported types:** `FileAdapter`, `FileReadAdapter`, `FileOptions`
