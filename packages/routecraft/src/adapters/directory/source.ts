import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { Dirent, Stats } from "node:fs";
import type { Source, CallableSource } from "../../operations/from.ts";
import type { DirectoryEntry, DirectoryOptions } from "./types.ts";
import { throwDirectoryError } from "../shared/fs-errors.ts";

/**
 * Max concurrent `stat` calls while resolving directory entries. Bounds the
 * open-handle count so a huge recursive tree cannot exhaust file descriptors
 * (EMFILE), while still overlapping the syscall latency that dominates a scan.
 */
const STAT_CONCURRENCY = 32;

/**
 * DirectorySourceAdapter implements the Source interface for scanning a
 * directory. It lists the directory once and emits the result either as a
 * single exchange carrying the full {@link DirectoryEntry}`[]` listing (default)
 * or, when `chunked`, one exchange per entry.
 *
 * Filtering is intentionally not built in: list the entries and let the route
 * decide. In chunked mode, filter on the body (`.filter((ex) => ex.body.ext
 * === ".json")`), then read content with the file adapter (`file({ path: (ex)
 * => ex.body.path })`). This keeps "find files" and "decide which ones" as
 * separate, composable steps.
 *
 * Entries are sorted by their relative path with separators normalized to
 * `/`, so emission order (chunked) and array order (non-chunked) are
 * deterministic and identical across platforms (raw `readdir` order, the
 * concurrent stat phase below, and a raw sort on OS-separator paths are not).
 *
 * Symlinks are followed (`stat`): a symlink to a directory is treated as a
 * directory (skipped unless `includeDirs`), a symlink to a file is emitted
 * with the target's metadata, and a broken symlink is skipped.
 */
export class DirectorySourceAdapter implements Source<
  DirectoryEntry | DirectoryEntry[]
> {
  readonly adapterId = "routecraft.adapter.directory";

  constructor(private readonly options: DirectoryOptions) {}

  /**
   * Source implementation: scan the directory and emit the listing. Reads the
   * directory once (this is a finite source). When `chunked`, emits one
   * exchange per entry; otherwise a single exchange with the `DirectoryEntry[]`.
   */
  subscribe: CallableSource<DirectoryEntry | DirectoryEntry[]> = async (
    sub,
  ) => {
    if (sub.signal.aborted) return;

    const {
      path: dir,
      recursive = false,
      includeDirs = false,
      chunked = false,
    } = this.options;

    if (typeof dir !== "string") {
      throw new Error(
        "directory adapter: path must be a string (the directory source scans one directory)",
      );
    }

    // Ready means "wired and able to produce", so signal before scanning
    // rather than after every entry has been emitted.
    sub.ready();

    let dirents: Dirent[];
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true, recursive });
    } catch (err) {
      throwDirectoryError("directory", dir, err);
    }

    // Resolve each entry's stats with bounded concurrency. The results feed an
    // in-memory array that is not emitted until the whole scan completes, so
    // (unlike the emit() calls below) there is no backpressure reason to
    // serialise these syscalls, and a large recursive scan is dominated by
    // stat latency. Directory-ness is decided from the followed stats, not the
    // Dirent, so a symlink to a directory is treated consistently for both the
    // includeDirs filter and the emitted isDirectory field.
    const entries: DirectoryEntry[] = [];
    let cursor = 0;
    const resolveEntries = async (): Promise<void> => {
      while (!sub.signal.aborted) {
        // `cursor++` is a single synchronous step (no await between read and
        // increment), so workers never claim the same index.
        const index = cursor++;
        if (index >= dirents.length) return;
        const dirent = dirents[index];

        // Skip plain directories before paying for a stat. Dirent type
        // checks reflect lstat semantics, so isDirectory() is false for a
        // symlink pointing at a directory; those fall through to the
        // followed stat below and are filtered by the post-stat check.
        if (!includeDirs && dirent.isDirectory()) continue;

        // Node always sets parentPath on Dirents (>= 22); fall back to the
        // scanned dir for the non-recursive case to be safe.
        const parent = dirent.parentPath ?? dir;
        const fullPath = path.join(parent, dirent.name);

        let stats: Stats;
        try {
          stats = await fsp.stat(fullPath);
        } catch (err) {
          // ENOENT means the entry vanished between listing and statting,
          // or is a broken symlink: expected churn, skip at debug. Any
          // other failure (EACCES, EMFILE, ELOOP) also skips the entry so
          // one bad node cannot fail the whole scan, but warns, because
          // the listing is now silently incomplete otherwise.
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOENT") {
            sub.context.logger.debug(
              { err, path: fullPath, adapter: "directory" },
              "directory adapter: entry vanished or broken symlink; skipping",
            );
          } else {
            sub.context.logger.warn(
              { err, path: fullPath, adapter: "directory" },
              "directory adapter: could not stat entry; listing is incomplete",
            );
          }
          continue;
        }

        const isDirectory = stats.isDirectory();
        if (isDirectory && !includeDirs) continue;

        entries.push({
          path: fullPath,
          name: dirent.name,
          dir: parent,
          ext: path.extname(dirent.name).toLowerCase(),
          relativePath: path.relative(dir, fullPath),
          size: stats.size,
          modifiedAt: stats.mtime,
          createdAt: stats.birthtime,
          isDirectory,
        });
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(STAT_CONCURRENCY, dirents.length) }, () =>
        resolveEntries(),
      ),
    );
    if (sub.signal.aborted) return;

    // Sort on a separator-normalized key so the order is identical across
    // platforms: a raw sort on relativePath would diverge on Windows, where
    // the backslash separator (0x5C) sorts after characters that `/` (0x2F)
    // sorts before (digits, uppercase letters).
    const sortKey = (e: DirectoryEntry): string =>
      path.sep === "/"
        ? e.relativePath
        : e.relativePath.split(path.sep).join("/");
    entries.sort((a, b) => {
      const ka = sortKey(a);
      const kb = sortKey(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });

    if (chunked) {
      for (const entry of entries) {
        if (sub.signal.aborted) return;
        try {
          await sub.emit({ message: entry });
        } catch {
          // Pipeline failure for one entry, not a scan error: the route
          // boundary already emitted exchange:failed; keep emitting the rest
          // (matching the file/csv/jsonl chunked semantics).
          if (sub.signal.aborted) return;
          sub.context.logger.debug(
            { path: entry.path, adapter: "directory" },
            "directory adapter: pipeline failed for entry; continuing",
          );
        }
      }
    } else if (!sub.signal.aborted) {
      // Default: a single exchange carrying the whole listing, mirroring the
      // non-chunked csv/jsonl shape. An empty directory still emits one
      // exchange with an empty array.
      try {
        await sub.emit({ message: entries });
      } catch {
        // Exchange error already logged by the route pipeline; mirror the
        // chunked branch's debug line so the adapter is not silent when
        // its only exchange fails.
        sub.context.logger.debug(
          { path: dir, adapter: "directory" },
          "directory adapter: pipeline failed for listing exchange",
        );
      }
    }

    // Finite source: signal completion so a single-source route can finish.
    sub.complete();
  };
}
