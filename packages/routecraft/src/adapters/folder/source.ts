import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { Source, CallableSource } from "../../operations/from.ts";
import type { FolderEntry, FolderOptions } from "./types.ts";

/**
 * FolderSourceAdapter implements the Source interface for scanning a
 * directory. It lists the directory once and emits one exchange per entry,
 * whose body is a {@link FolderEntry} carrying the entry's path and metadata.
 *
 * Filtering is intentionally not built in: emit every entry and let the route
 * filter on the body (`.filter((ex) => ex.body.size < 1_000_000)`), then read
 * content with the file adapter (`file({ path: (ex) => ex.body.path })`). This
 * keeps "find files" and "decide which ones" as separate, composable steps.
 *
 * Entries are emitted sorted by their relative path, so emission order is
 * deterministic across platforms (raw `readdir` order is not).
 */
export class FolderSourceAdapter implements Source<FolderEntry> {
  readonly adapterId = "routecraft.adapter.folder";

  constructor(private readonly options: FolderOptions) {}

  /**
   * Source implementation: scan the directory and emit one exchange per entry.
   * Reads the listing once (this is a finite source).
   */
  subscribe: CallableSource<FolderEntry> = async (sub) => {
    if (sub.signal.aborted) return;

    const { path: dir, recursive = false, includeDirs = false } = this.options;

    if (typeof dir !== "string") {
      throw new Error(
        "folder adapter: path must be a string (the folder source scans one directory)",
      );
    }

    // Ready means "wired and able to produce", so signal before scanning
    // rather than after every entry has been emitted.
    sub.ready();

    let dirents: import("node:fs").Dirent[];
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true, recursive });
    } catch (err) {
      throwFolderError(dir, err);
    }

    const entries: FolderEntry[] = [];
    for (const dirent of dirents) {
      if (sub.signal.aborted) return;

      const isDir = dirent.isDirectory();
      if (isDir && !includeDirs) continue;

      // Node always sets parentPath on Dirents (>= 22); fall back to the
      // scanned dir for the non-recursive case to be safe.
      const parent = dirent.parentPath ?? dir;
      const fullPath = path.join(parent, dirent.name);

      let stats;
      try {
        stats = await fsp.stat(fullPath);
      } catch (err) {
        // The entry vanished between listing and statting, or is a broken
        // symlink. Skip it rather than failing the whole scan.
        sub.context.logger.debug(
          { err, path: fullPath, adapter: "folder" },
          "folder adapter: could not stat entry; skipping",
        );
        continue;
      }

      entries.push({
        path: fullPath,
        name: dirent.name,
        dir: parent,
        ext: path.extname(dirent.name).toLowerCase(),
        relativePath: path.relative(dir, fullPath),
        size: stats.size,
        modifiedAt: stats.mtime,
        createdAt: stats.birthtime,
        isDirectory: stats.isDirectory(),
      });
    }

    entries.sort((a, b) =>
      a.relativePath < b.relativePath
        ? -1
        : a.relativePath > b.relativePath
          ? 1
          : 0,
    );

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
          { path: entry.path, adapter: "folder" },
          "folder adapter: pipeline failed for entry; continuing",
        );
      }
    }

    // Finite source: signal completion so a single-source route can finish.
    sub.complete();
  };
}

/**
 * Throws a standardized folder-related error. Maps ENOENT and ENOTDIR to
 * clearer messages and EACCES to a permission error, mirroring the file
 * adapter's `throwFileError` for filesystem boundaries.
 */
function throwFolderError(dir: string, err: unknown): never {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT") {
    throw new Error(`folder adapter: directory not found: ${dir}`);
  }
  if (code === "ENOTDIR") {
    throw new Error(`folder adapter: not a directory: ${dir}`);
  }
  if (code === "EACCES") {
    throw new Error(
      `folder adapter: permission denied reading directory: ${dir}`,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  throw new Error(`folder adapter: failed to read directory: ${message}`);
}
