/**
 * Shared filesystem error mapping for adapters that read files or scan
 * directories. Maps the common errno codes to clear, adapter-prefixed
 * messages so `file`, `csv`, `jsonl`, and `directory` report the same
 * underlying failure the same way.
 *
 * @internal Not exported from the package public API.
 */

/** The filesystem noun the error message speaks about. */
type FsNoun = "file" | "directory";

/**
 * Shared errno-to-message mapping. ENOTDIR is only meaningful for
 * directory targets (a path component that is not a directory); file
 * adapters keep their historical messages for that code via the generic
 * fallback.
 */
function throwFsError(
  adapter: string,
  noun: FsNoun,
  target: string,
  err: unknown,
): never {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT") {
    throw new Error(`${adapter} adapter: ${noun} not found: ${target}`);
  }
  if (noun === "directory" && code === "ENOTDIR") {
    throw new Error(`${adapter} adapter: not a directory: ${target}`);
  }
  if (code === "EACCES") {
    throw new Error(
      `${adapter} adapter: permission denied reading ${noun}: ${target}`,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  throw new Error(`${adapter} adapter: failed to read ${noun}: ${message}`);
}

/**
 * Throws a standardized file-related error for an adapter.
 * Handles ENOENT, EACCES, and generic errors.
 *
 * @param adapter - Adapter name for the error prefix (e.g. 'file', 'csv', 'jsonl')
 * @param filePath - The file path that caused the error
 * @param err - The original error
 */
export function throwFileError(
  adapter: string,
  filePath: string,
  err: unknown,
): never {
  throwFsError(adapter, "file", filePath, err);
}

/**
 * Throws a standardized directory-related error for an adapter.
 * Handles ENOENT, ENOTDIR, EACCES, and generic errors.
 *
 * @param adapter - Adapter name for the error prefix (e.g. 'directory')
 * @param dir - The directory path that caused the error
 * @param err - The original error
 */
export function throwDirectoryError(
  adapter: string,
  dir: string,
  err: unknown,
): never {
  throwFsError(adapter, "directory", dir, err);
}
