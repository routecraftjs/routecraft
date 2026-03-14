import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { type Source, type CallableSource } from "../operations/from.ts";
import {
  type Destination,
  type CallableDestination,
} from "../operations/to.ts";
import { type Exchange } from "../exchange.ts";

export interface FileOptions {
  /**
   * File path string or function that returns the path.
   * For destinations, the function receives the exchange to enable dynamic paths.
   */
  path: string | ((exchange: Exchange) => string);

  /**
   * File operation mode.
   * - 'read': Read file (source mode)
   * - 'write': Write/overwrite file (destination mode)
   * - 'append': Append to file (destination mode)
   * Default: 'read' for source, 'write' for destination
   */
  mode?: "read" | "write" | "append";

  /**
   * Text encoding. Default: 'utf-8'
   */
  encoding?: BufferEncoding;

  /**
   * Create parent directories if they don't exist (destination mode only).
   * Default: false
   */
  createDirs?: boolean;
}

export class FileAdapter implements Source<string>, Destination<unknown, void> {
  readonly adapterId = "routecraft.adapter.file";

  constructor(private readonly options: FileOptions) {}

  /**
   * Source implementation: subscribe to file content.
   * Reads the file once.
   */
  subscribe: CallableSource<string> = async (
    _context,
    handler,
    abortController,
    onReady,
  ) => {
    // Check if already aborted
    if (abortController.signal.aborted) return;

    const { path: filePath, encoding = "utf-8" } = this.options;

    if (typeof filePath !== "string") {
      throw new Error(
        "file adapter: path must be a string for source mode (dynamic paths are only supported for destinations)",
      );
    }

    // Read file content
    const content = await fsp.readFile(filePath, { encoding }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`file adapter: file not found: ${filePath}`);
      }
      if ((err as NodeJS.ErrnoException).code === "EACCES") {
        throw new Error(
          `file adapter: permission denied reading file: ${filePath}`,
        );
      }
      throw new Error(`file adapter: failed to read file: ${message}`);
    });

    // Check if aborted before emitting
    if (abortController.signal.aborted) return;

    // Emit the content
    await handler(content);

    // Signal that source is ready
    if (onReady) onReady();
  };

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

/**
 * Creates a file adapter for reading or writing plain text files.
 *
 * @beta
 * As a **source** (.from):
 * - Reads file content as a string
 *
 * As a **destination** (.to):
 * - Writes exchange body to file (write or append mode)
 * - Supports dynamic paths based on exchange content
 * - Can create parent directories automatically
 *
 * @param options - File path, mode, encoding, and createDirs options
 * @returns FileAdapter implementing Source and Destination
 *
 * @example
 * ```typescript
 * // Read file as source
 * .from(file({ path: './input.txt' }))
 *
 * // Write to file
 * .to(file({ path: './output.txt', mode: 'write' }))
 *
 * // Append to log
 * .to(file({ path: './log.txt', mode: 'append' }))
 *
 * // Dynamic path with directory creation
 * .to(file({
 *   path: (ex) => `./data/${ex.body.date}.txt`,
 *   mode: 'write',
 *   createDirs: true
 * }))
 * ```
 */
export function file(options: FileOptions): FileAdapter {
  return new FileAdapter(options);
}
