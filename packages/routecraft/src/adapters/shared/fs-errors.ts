/**
 * Shared filesystem error mapping for adapters that read files or scan
 * directories, and write or delete files, so `file`, `csv`, `jsonl`, and `directory` report the same
 * underlying failure the same way: a missing path is `RC5014`, a path the
 * process may not read or change is `RC5015`, and anything else is a plain error. The
 * errno error is always the `cause`, so its `code` survives.
 *
 * @internal Not exported from the package public API.
 */
import { rcError } from "../../error.ts";

/** The filesystem noun the error message speaks about. */
type FsNoun = "file" | "directory";

/**
 * ENOTDIR means a component of the path is not a directory: for a file
 * target the file cannot exist, for a directory target the path names
 * something else. Both are `RC5014`.
 */
function throwFsError(
  adapter: string,
  noun: FsNoun,
  target: string,
  err: unknown,
): never {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || (noun === "file" && code === "ENOTDIR")) {
    throw rcError("RC5014", err, {
      message: `${adapter} adapter: ${noun} not found: ${target}`,
      suggestion: `Check the path, and that the ${noun} exists when the route runs.`,
    });
  }
  if (code === "ENOTDIR") {
    throw rcError("RC5014", err, {
      message: `${adapter} adapter: not a directory: ${target}`,
      suggestion: "Point the adapter at a directory.",
    });
  }
  if (code === "EACCES") {
    throw rcError("RC5015", err, {
      message: `${adapter} adapter: permission denied reading ${noun}: ${target}`,
      suggestion: `Give the process read access to the ${noun}.`,
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  throw new Error(`${adapter} adapter: failed to read ${noun}: ${message}`, {
    cause: err,
  });
}

/**
 * Throws a standardized error for a failed write, append or delete.
 * A missing parent directory is `RC5014`, a path the process may not
 * change is `RC5015`.
 *
 * @param adapter - Adapter name for the error prefix (e.g. 'file', 'csv', 'jsonl')
 * @param action - What the adapter was doing to the file
 * @param filePath - The file path that caused the error
 * @param err - The original error
 */
export function throwFileWriteError(
  adapter: string,
  action: "write" | "delete",
  filePath: string,
  err: unknown,
): never {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") {
    throw rcError("RC5014", err, {
      message: `${adapter} adapter: directory not found for file: ${filePath} (use createDirs: true to create parent directories)`,
      suggestion:
        "Create the parent directory, or set `createDirs: true` to have the adapter create it.",
    });
  }
  if (code === "EACCES" || code === "EPERM") {
    throw rcError("RC5015", err, {
      message: `${adapter} adapter: permission denied ${action === "write" ? "writing" : "deleting"} file: ${filePath}`,
      suggestion:
        "Give the process write access to the file and its directory.",
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  throw new Error(`${adapter} adapter: failed to ${action} file: ${message}`, {
    cause: err,
  });
}

/**
 * Throws a standardized file-related error for an adapter.
 * A missing file is `RC5014`, an unreadable one `RC5015`.
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
 * A missing directory or a non-directory is `RC5014`, an unreadable one `RC5015`.
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
