---
"@routecraft/routecraft": minor
---

Add the `directory` source adapter for scanning a directory.

`directory({ path })` scans a directory and lists its entries, each a `DirectoryEntry` carrying the entry's `path`, `name`, `ext`, `relativePath`, `size`, `modifiedAt`, `createdAt`, and `isDirectory`. By default it emits a single exchange with the full `DirectoryEntry[]` listing; pass `chunked: true` to emit one exchange per entry, matching the non-chunked/chunked convention of the `csv` and `jsonl` adapters. Supports `recursive` and `includeDirs`, lists files only by default, and orders entries deterministically by relative path. Filtering is left to the normal operations (`.filter()` per entry in chunked mode, or `.transform()` / `.split()` on the array) so you can narrow by metadata or name, then read content with the `file` adapter (`.enrich(file({ path: (ex) => ex.body.path, mode: 'read' }), ...)`). Entries that vanish mid-scan or broken symlinks are skipped with a debug log, other unreadable entries are skipped with a warning, and a missing or unreadable directory throws a clear `directory adapter:` error.
