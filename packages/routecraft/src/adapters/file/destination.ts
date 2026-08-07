import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { Destination, CallableDestination } from "../../operations/to.ts";
import type { FileOptions } from "./types.ts";
import { assertExclusiveSendBehavior } from "../shared/file-role-guards.ts";

/**
 * FileDestinationAdapter implements the Destination (send) role for file I/O.
 *
 * `send` is strictly void: it writes the exchange body to the resolved path
 * (overwrite by default, `append: true` to append) or removes the file
 * (`delete: true`, idempotent). Reading lives on the fetch role
 * (FileEnricherAdapter); the source role reads at subscribe time.
 */
export class FileDestinationAdapter implements Destination<unknown> {
  readonly adapterId = "routecraft.adapter.file";

  constructor(private readonly options: FileOptions) {
    assertExclusiveSendBehavior("file", options);
  }

  /**
   * Send implementation. Deletes (delete: true) or writes/appends the
   * resolved path. Static and dynamic paths are supported.
   */
  send: CallableDestination<unknown> = async (exchange) => {
    const {
      path: filePath,
      encoding = "utf-8",
      createDirs = false,
      append = false,
      delete: remove = false,
    } = this.options;

    // Resolve path (static or dynamic)
    const resolvedPath =
      typeof filePath === "function" ? filePath(exchange) : filePath;

    // Delete behavior: remove the file. Idempotent (force) so an
    // already-absent path succeeds; the body is unchanged.
    if (remove) {
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
      return;
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
      if (append) {
        await fsp.appendFile(resolvedPath, content, { encoding });
      } else {
        await fsp.writeFile(resolvedPath, content, { encoding });
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
  };
}
