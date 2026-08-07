import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { Dirent, Stats } from "node:fs";
import type { CraftContext } from "../../context.ts";
import type { DirectoryEntry, DirectoryOptions } from "./types.ts";
import { throwDirectoryError } from "../shared/fs-errors.ts";

/**
 * Max concurrent `stat` calls while resolving directory entries. Bounds the
 * open-handle count so a huge recursive tree cannot exhaust file descriptors
 * (EMFILE), while still overlapping the syscall latency that dominates a scan.
 */
const STAT_CONCURRENCY = 32;

/**
 * IO hooks for {@link scanDirectory}. Both are optional so the scan works
 * from a source subscription (subscription signal + context logger) and from
 * an enricher fetch (step signal, exchange-resolved logger) alike.
 *
 * @internal
 */
export interface DirectoryScanIo {
  /**
   * When it aborts, workers stop claiming entries and the partial result is
   * returned. Callers that must not act on a partial listing check the
   * signal after the scan resolves (the enricher throws; the source simply
   * stops emitting).
   */
  signal?: AbortSignal | undefined;
  /** Logger for per-entry skip diagnostics; skips are silent when omitted. */
  logger?: CraftContext["logger"] | undefined;
}

/**
 * Scan a directory and return its entries, sorted deterministically. This is
 * the single scan implementation shared by the directory source (`.from()`)
 * and the directory enricher (`.enrich()` / `.to()`), so `recursive`,
 * `includeDirs`, symlink handling, and ordering behave identically in every
 * role by construction rather than by discipline.
 *
 * Entries are sorted by their relative path with separators normalized to
 * `/`, so emission order (chunked source), array order (non-chunked source),
 * and the enricher's returned array are deterministic and identical across
 * platforms (raw `readdir` order, the concurrent stat phase below, and a raw
 * sort on OS-separator paths are not).
 *
 * Symlinks are followed (`stat`): a symlink to a directory is treated as a
 * directory (skipped unless `includeDirs`), a symlink to a file is listed
 * with the target's metadata, and a broken symlink is skipped.
 *
 * A missing or unreadable directory throws via {@link throwDirectoryError}.
 *
 * @internal
 */
export async function scanDirectory(
  dir: string,
  options: Pick<DirectoryOptions, "recursive" | "includeDirs">,
  io: DirectoryScanIo = {},
): Promise<DirectoryEntry[]> {
  const { recursive = false, includeDirs = false } = options;
  const { signal, logger } = io;

  let dirents: Dirent[];
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true, recursive });
  } catch (err) {
    throwDirectoryError("directory", dir, err);
  }

  // Resolve each entry's stats with bounded concurrency. The results feed an
  // in-memory array that is not visible until the whole scan completes, so
  // there is no backpressure reason to serialise these syscalls, and a large
  // recursive scan is dominated by stat latency. Directory-ness is decided
  // from the followed stats, not the Dirent, so a symlink to a directory is
  // treated consistently for both the includeDirs filter and the returned
  // isDirectory field.
  const entries: DirectoryEntry[] = [];
  let cursor = 0;
  const resolveEntries = async (): Promise<void> => {
    while (!signal?.aborted) {
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
          logger?.debug(
            { err, path: fullPath, adapter: "directory" },
            "directory adapter: entry vanished or broken symlink; skipping",
          );
        } else {
          logger?.warn(
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

  return entries;
}
