---
title: folder
---

[← All adapters](/docs/reference/adapters) {% .lead %}

```ts
folder(options: FolderOptions): Source<FolderEntry>
```

Scan a directory and emit one exchange per entry. The folder adapter is the "find the files" half of working with a directory; the [`file`](/docs/reference/adapters/file) adapter reads or writes a single file. Compose the two to process every file in a folder.

Each exchange body is a `FolderEntry` carrying the entry's path and metadata. Filtering is intentionally not built in: emit every entry, narrow with the normal `.filter()` operation, then read content with the file adapter. "Find the files" and "decide which ones" stay as separate, composable steps.

```ts
// Read the content of every .json file in a folder
craft()
  .from(folder({ path: './inbox' }))
  .filter((ex) => ex.body.ext === '.json')
  .enrich(
    file({ path: (ex) => ex.body.path, mode: 'read' }),
    only((content: string) => content, 'content'),
  )
  .to(log())

// Recurse, then drop anything modified more than a day ago
craft()
  .from(folder({ path: './data', recursive: true }))
  .filter((ex) => Date.now() - ex.body.modifiedAt.getTime() < 86_400_000)
  .to(log())
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `path` | `string` | Required | Directory to scan (a source scans one directory, so no dynamic function form) |
| `recursive` | `boolean` | `false` | Descend into subdirectories |
| `includeDirs` | `boolean` | `false` | Emit directory entries too, not just files |

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

**Deterministic order:** entries are emitted sorted by `relativePath`, so emission order is stable across platforms (raw directory listing order is not).

**Files only by default:** directories are skipped unless `includeDirs: true`. With `recursive: true` the scan still descends into subdirectories regardless of `includeDirs`; that flag only controls whether the directories themselves are emitted as exchanges.

**Robust scanning:** an entry that vanishes between listing and reading its metadata (or a broken symlink) is skipped with a debug log rather than failing the whole scan. A missing or unreadable directory throws (`directory not found`, `not a directory`, or `permission denied`).

**Exported symbols:** `folder`; types `FolderAdapter`, `FolderOptions`, `FolderEntry`
