---
title: folder
---

[← All adapters](/docs/reference/adapters) {% .lead %}

```ts
folder(options: FolderOptions & { chunked: true }): Source<FolderEntry>
folder(options: FolderOptions): Source<FolderEntry[]>
```

Scan a directory and list its entries. The folder adapter is the "find the files" half of working with a directory; the [`file`](/docs/reference/adapters/file) adapter reads or writes a single file. Compose the two to process every file in a folder.

By default the source emits a single exchange whose body is the full `FolderEntry[]` listing, the same collection-in-one-exchange shape as the non-chunked [`csv`](/docs/reference/adapters/csv) and [`jsonl`](/docs/reference/adapters/jsonl) adapters. Pass `chunked: true` to emit one exchange per entry instead. Filtering is intentionally not built in either way: list the entries, then decide which ones.

```ts
// Chunked: one exchange per file, filter by name/metadata, read each
craft()
  .from(folder({ path: './inbox', chunked: true }))
  .filter((ex) => ex.body.ext === '.json')
  .enrich(
    file({ path: (ex) => ex.body.path, mode: 'read' }),
    only((content: string) => content, 'content'),
  )
  .to(log())

// Default: the whole listing as one body, act on the collection then split
craft()
  .from(folder({ path: './inbox' }))
  .transform((ex) => ex.body.filter((e) => e.ext === '.json'))
  .split((ex) => ex.body)
  .enrich(
    file({ path: (ex) => ex.body.path, mode: 'read' }),
    only((content: string) => content, 'content'),
  )
  .to(log())
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `path` | `string` | Required | Directory to scan (a source scans one directory, so no dynamic function form) |
| `recursive` | `boolean` | `false` | Descend into subdirectories |
| `includeDirs` | `boolean` | `false` | Emit directory entries too, not just files |
| `chunked` | `boolean` | `false` | Emit one exchange per entry instead of a single `FolderEntry[]` exchange |

**Entry shape (`FolderEntry`):** the body of every emitted exchange.

| Field | Type | Description |
|-------|------|-------------|
| `path` | `string` | Path resolved against the scanned folder, ready for `file({ path })` |
| `name` | `string` | Base name including extension, e.g. `report.json` |
| `dir` | `string` | Directory containing the entry |
| `ext` | `string` | Lowercased extension including the dot, e.g. `.json` (empty when none) |
| `relativePath` | `string` | Path relative to the scanned folder root |
| `size` | `number` | File size in bytes |
| `modifiedAt` | `Date` | Last modification time |
| `createdAt` | `Date` | Creation time (birthtime; may fall back to the mtime on some filesystems) |
| `isDirectory` | `boolean` | True for directory entries (only emitted when `includeDirs`) |

**Metadata lives on the body, not headers:** the entry is already a structured object, so its fields are not duplicated into `routecraft.folder.*` headers. Filter and route on the body directly. This differs from the file adapter's chunked mode, whose body is a bare line string and so carries its line number and path on headers.

**Deterministic order:** entries are sorted by `relativePath`, so emission order (chunked) and array order (non-chunked) are stable across platforms (raw directory listing order is not). An empty directory emits one exchange with an empty array in the default shape, and nothing in chunked mode.

**Files only by default:** directories are skipped unless `includeDirs: true`. With `recursive: true` the scan still descends into subdirectories regardless of `includeDirs`; that flag only controls whether the directories themselves are emitted as exchanges.

**Robust scanning:** an entry that vanishes between listing and reading its metadata (or a broken symlink) is skipped with a debug log rather than failing the whole scan. A missing or unreadable directory throws (`directory not found`, `not a directory`, or `permission denied`).

**Exported symbols:** `folder`; types `FolderAdapter`, `FolderOptions`, `FolderEntry`
