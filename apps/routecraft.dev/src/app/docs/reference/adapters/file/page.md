---
title: file
---

[← All adapters](/docs/reference/adapters) {% .lead %}

```ts
file(options: FileOptions): FileAdapter // Source<string> & Destination<unknown> & Enricher<unknown, string>
```

Read and write plain text files. For structured data, use `json` or `csv` adapters. One factory, one type; the operation keyword selects the role: `.from()` reads, `.to()` writes, `.enrich()` reads mid-route.

**Source role** (reads files):
```ts
// Read file once
.from(file({ path: './input.txt' }))

// Custom encoding
.from(file({ path: './data.txt', encoding: 'latin1' }))
```

**Destination role** (writes files). The send is void: the body flows through the `.to()` step unchanged.
```ts
// Write to file (overwrite)
.to(file({ path: './output.txt' }))

// Append to file
.to(file({ path: './log.txt', append: true }))

// Delete a file (idempotent: an already-absent path is a no-op)
.to(file({ path: (ex) => ex.body.processedPath, delete: true }))

// Dynamic file paths with directory creation
.to(file({
  path: (exchange) => `./data/${exchange.body.date}.txt`,
  createDirs: true
}))
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `path` | `string \| (exchange) => string` | Required | File path (static for the source role; send/fetch also accept a function) |
| `encoding` | `BufferEncoding` | `'utf-8'` | Text encoding |
| `createDirs` | `boolean` | `false` | Create parent directories (send role only) |
| `append` | `boolean` | `false` | Send role: append instead of overwriting; mutually exclusive with `delete` |
| `delete` | `boolean` | `false` | Send role: delete the file instead of writing (idempotent); mutually exclusive with `append` |
| `chunked` | `boolean` | `false` | Emit one exchange per line instead of entire file (source role only) |

Passing both `append: true` and `delete: true` throws `RC5003` at construction.

**Read mid-route:** The adapter is also an enricher whose `fetch` returns the file content, so you can read a file partway through a route with `.enrich()`. The content replaces the body; pass an aggregator such as `only()` to merge instead. Unlike the source role, the fetch role accepts dynamic (function) paths, because the exchange exists when the read runs.

```ts
// Replace the body with the file content
.enrich(file({ path: './config.txt' }))

// Pull a file into the body mid-route, alongside the existing data
.enrich(file({ path: './config.txt' }), only((s: string) => s, 'config'))

// Read a file whose path depends on the exchange
.enrich(file({ path: (ex) => `./data/${ex.body.id}.txt` }))
```

**Chunked mode:** When `chunked: true`, the file source emits one exchange per line. Each exchange includes `FileHeaders.LINE` (1-based line number) and `FileHeaders.PATH` headers. Chunking concerns the source role only; the send/fetch roles are identical under `chunked`.

```ts
// Per-line emission
.from(file({ path: './big.txt', chunked: true }))
```

**Exported symbols:** `FileHeaders` (chunked-mode header keys, `FileHeaders.LINE` / `FileHeaders.PATH`); types `FileAdapter`, `FileOptions`
