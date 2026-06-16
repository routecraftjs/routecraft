---
"@routecraft/routecraft": minor
---

Add the `folder` source adapter for scanning a directory.

`folder({ path })` scans a directory and emits one exchange per entry, with each body a `FolderEntry` carrying the entry's `path`, `name`, `ext`, `relativePath`, `size`, `modifiedAt`, `createdAt`, and `isDirectory`. Supports `recursive` and `includeDirs`, skips files only by default, and emits in deterministic relative-path order. Filtering is left to the normal `.filter()` operation so you can narrow by metadata or name, then read content with the `file` adapter (`.enrich(file({ path: (ex) => ex.body.path, mode: 'read' }), ...)`). Entries that vanish mid-scan or broken symlinks are skipped with a debug log; a missing or unreadable directory throws a clear `folder adapter:` error.
