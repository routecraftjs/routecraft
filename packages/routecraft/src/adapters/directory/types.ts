import type { Exchange } from "../../exchange.ts";

/**
 * One file (or directory) discovered while scanning a directory. This is the
 * body shape the directory source emits, one exchange per entry.
 *
 * All metadata lives on the body rather than on headers: the entry is a
 * structured object, so duplicating its fields into `routecraft.directory.*`
 * headers would just be two copies of the same state. Filter and route on
 * the body directly (`.filter((ex) => ex.body.ext === ".json")`), then read
 * the content with the file adapter (`file({ path: (ex) => ex.body.path })`).
 */
export interface DirectoryEntry {
  /**
   * Path to the entry, resolved against the scanned directory, suitable for
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
   * Path relative to the scanned directory root. Useful with `recursive: true`
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
 * Options for the directory adapter, in both of its roles. As a source
 * (`.from()`) it scans a directory and emits the listing; as an enricher
 * (`.enrich()` / `.to()`) its `fetch` returns the listing, so a directory can
 * be listed mid-route (a listing is a read, like the file adapter's fetch).
 * `recursive`, `includeDirs`, and the deterministic ordering behave
 * identically in either role; `chunked` is a source-only emission shape.
 */
export interface DirectoryOptions {
  /**
   * Directory to scan: a path string, or a function that returns one.
   * The source role requires a static string (a source is not per-exchange);
   * the enricher role also accepts the function form, which receives the
   * exchange when the scan runs.
   */
  path: string | ((exchange: Exchange) => string);
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
   *   `DirectoryEntry[]` listing. Good for acting on the collection as a whole,
   *   counting, or deciding before you `.split()`.
   * - `true`: emit one exchange per entry (body is a single `DirectoryEntry`).
   *   Good for filtering by metadata or name with `.filter()` and reading each
   *   file's content with the file adapter.
   */
  chunked?: boolean;
}
