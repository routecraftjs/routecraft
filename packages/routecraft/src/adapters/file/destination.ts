import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { Destination, CallableDestination } from "../../operations/to.ts";
import type { FileOptions } from "./types.ts";
import { throwFileError } from "../shared/line-reader.ts";

/**
 * FileDestinationAdapter implements the Destination interface for file I/O.
 *
 * - `write` / `append` (default): write the exchange body to the file and
 *   return nothing (the body is unchanged downstream).
 * - `read`: read the file and return its content as a string. This makes the
 *   adapter usable mid-route via `.enrich()` / `.to()`, mirroring how an HTTP
 *   GET is a destination that returns the fetched body. Unlike source mode,
 *   read-as-destination supports dynamic (function) paths, because the
 *   exchange is available when the read runs.
 * - `delete`: delete the file and return nothing (the body is unchanged). The
 *   delete is idempotent: a path that is already absent is a no-op, since the
 *   goal of delete is to ensure the file does not exist.
 */
export class FileDestinationAdapter implements Destination<
  unknown,
  string | void
> {
  readonly adapterId = "routecraft.adapter.file";

  constructor(private readonly options: FileOptions) {}

  /**
   * Destination implementation. Reads (read mode), deletes (delete mode), or
   * writes (write/append mode) the resolved path. Static and dynamic paths are
   * supported in all modes.
   */
  send: CallableDestination<unknown, string | void> = async (exchange) => {
    const {
      path: filePath,
      mode = "write",
      encoding = "utf-8",
      createDirs = false,
    } = this.options;

    // Resolve path (static or dynamic)
    const resolvedPath =
      typeof filePath === "function" ? filePath(exchange) : filePath;

    // Read mode: return the file content so downstream steps can use it.
    if (mode === "read") {
      const content = await fsp
        .readFile(resolvedPath, { encoding })
        .catch((err) => throwFileError("file", resolvedPath, err));
      return content;
    }

    // Delete mode: remove the file. Idempotent (force) so an already-absent
    // path succeeds; the body is unchanged.
    if (mode === "delete") {
      try {
        await fsp.rm(resolvedPath, { force: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if ((err as NodeJS.ErrnoException).code === "EACCES") {
          throw new Error(
            `file adapter: permission denied deleting file: ${resolvedPath}`,
          );
        }
        throw new Error(`file adapter: failed to delete file: ${message}`);
      }
      return undefined;
    }

    // Get content from exchange body
    let content: string;
    if (typeof exchange.body === "string") {
      content = exchange.body;
    } else {
      // Convert to string if not already
      content = JSON.stringify(exchange.body, null, 2);
    }

    // Create parent directories if requested
    if (createDirs) {
      const dir = path.dirname(resolvedPath);
      try {
        await fsp.mkdir(dir, { recursive: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `file adapter: failed to create directories for ${resolvedPath}: ${message}`,
        );
      }
    }

    // Write or append to file
    try {
      if (mode === "append") {
        await fsp.appendFile(resolvedPath, content, { encoding });
      } else if (mode === "write") {
        await fsp.writeFile(resolvedPath, content, { encoding });
      } else {
        throw new Error(`file adapter: unsupported destination mode: ${mode}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          `file adapter: directory not found for file: ${resolvedPath} (use createDirs: true to create parent directories)`,
        );
      }
      if ((err as NodeJS.ErrnoException).code === "EACCES") {
        throw new Error(
          `file adapter: permission denied writing file: ${resolvedPath}`,
        );
      }
      throw new Error(`file adapter: failed to write file: ${message}`);
    }

    // Destination returns void (no body modification)
    return undefined;
  };
}
