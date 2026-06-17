/**
 * One file (or directory) discovered while scanning a folder. This is the
 * body shape the folder source emits, one exchange per entry.
 *
 * All metadata lives on the body rather than on headers: the entry is a
 * structured object, so duplicating its fields into `routecraft.folder.*`
 * headers would just be two copies of the same state. Filter and route on
 * the body directly (`.filter((ex) => ex.body.ext === ".json")`), then read
 * the content with the file adapter (`file({ path: (ex) => ex.body.path })`).
 */
export interface FolderEntry {
  /**
   * Path to the entry, resolved against the scanned folder, suitable for
   * handing straight to `file({ path })`. Relative when the scanned path is
   * relative, absolute when it is absolute.
   */
  path: string;
  /** Base name including extension, e.g. "report.json". */
  name: string;
  /** Directory containing the entry. */
  dir: string;
  /**
   * Lowercased file extension including the leading dot, e.g. ".json".
   * Empty string when the name has no extension. Lowercased so filtering is
   * predictable across platforms; `name` and `path` keep their original case.
   */
  ext: string;
  /**
   * Path relative to the scanned folder root. Useful with `recursive: true`
   * to see where in the tree the entry lives (e.g. "sub/report.json").
   */
  relativePath: string;
  /** File size in bytes (0 for directories on most platforms). */
  size: number;
  /** Last modification time. */
  modifiedAt: Date;
  /**
   * Creation time (birthtime). Some filesystems do not track this and report
   * the modification time (or epoch) instead.
   */
  createdAt: Date;
  /** True when the entry is a directory (only emitted when `includeDirs`). */
  isDirectory: boolean;
}

/**
 * Options for the folder source. The folder adapter is source-only: it scans
 * a directory and emits one exchange per entry.
 */
export interface FolderOptions {
  /** Directory to scan. Must be a string (a source is not per-exchange). */
  path: string;
  /**
   * Descend into subdirectories. When false, only the immediate children of
   * `path` are emitted. Default: false.
   */
  recursive?: boolean;
  /**
   * Also emit directory entries, not just files. Default: false (files only).
   * When recursive, the source still descends into subdirectories regardless
   * of this flag; this only controls whether the directories themselves are
   * emitted as exchanges.
   */
  includeDirs?: boolean;
  /**
   * Emission shape, matching the `csv` / `jsonl` convention:
   * - `false` (default): emit a single exchange whose body is the full
   *   `FolderEntry[]` listing. Good for acting on the collection as a whole,
   *   counting, or deciding before you `.split()`.
   * - `true`: emit one exchange per entry (body is a single `FolderEntry`).
   *   Good for filtering by metadata or name with `.filter()` and reading each
   *   file's content with the file adapter.
   */
  chunked?: boolean;
}
