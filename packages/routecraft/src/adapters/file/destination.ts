import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { Destination, CallableDestination } from "../../operations/to.ts";
import type { FileOptions } from "./types.ts";

/**
 * FileDestinationAdapter implements the Destination interface for writing files.
 * Supports write and append modes, static and dynamic paths.
 */
export class FileDestinationAdapter implements Destination<unknown, void> {
  readonly adapterId = "routecraft.adapter.file";

  constructor(private readonly options: FileOptions) {}

  /**
   * Destination implementation: write to file.
   * Supports write and append modes, static and dynamic paths.
   */
  send: CallableDestination<unknown, void> = async (exchange) => {
    const {
      path: filePath,
      mode = "write",
      encoding = "utf-8",
      createDirs = false,
    } = this.options;

    // Validate mode
    if (mode === "read") {
      throw new Error(
        "file adapter: mode 'read' is only valid for source mode, not destination",
      );
    }

    // Resolve path (static or dynamic)
    const resolvedPath =
      typeof filePath === "function" ? filePath(exchange) : filePath;

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
