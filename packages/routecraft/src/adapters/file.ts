import * as fs from "node:fs";
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
   * Watch file for changes (source mode only).
   * When enabled, the source will emit a message whenever the file changes.
   * Default: false
   */
  watch?: boolean;

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
   * Reads the file once, and optionally watches for changes.
   */
  subscribe: CallableSource<string> = async (
    _context,
    handler,
    abortController,
    onReady,
  ) => {
    const { path: filePath, encoding = "utf-8", watch = false } = this.options;

    if (typeof filePath !== "string") {
      throw new Error(
        "file adapter: path must be a string for source mode (dynamic paths are only supported for destinations)",
      );
    }

    // Read initial file content
    const readAndEmit = async () => {
      try {
        const content = await fsp.readFile(filePath, { encoding });
        await handler(content);
      } catch (err) {
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
      }
    };

    // Read file initially
    await readAndEmit();

    // Set up file watcher if requested
    if (watch) {
      let watcher: fs.FSWatcher | null = null;
      let debounceTimer: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        if (watcher) watcher.close();
      };

      abortController.signal.addEventListener("abort", cleanup);

      try {
        watcher = fs.watch(filePath, async (eventType) => {
          // Debounce rapid changes (some editors trigger multiple events)
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(async () => {
            if (eventType === "change" && !abortController.signal.aborted) {
              await readAndEmit();
            }
          }, 50);
        });
      } catch (err) {
        cleanup();
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`file adapter: failed to watch file: ${message}`);
      }
    }

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
      } else {
        // mode === 'write'
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

    // Destination returns void (no body modification)
    return undefined;
  };
}

/**
 * Creates a file adapter for reading or writing plain text files.
 *
 * As a **source** (.from):
 * - Reads file content as a string
 * - Optionally watches for changes and emits new content
 *
 * As a **destination** (.to):
 * - Writes exchange body to file (write or append mode)
 * - Supports dynamic paths based on exchange content
 * - Can create parent directories automatically
 *
 * @param options - File path, mode, encoding, watch, and createDirs options
 * @returns FileAdapter implementing Source and Destination
 *
 * @example
 * ```typescript
 * // Read file as source
 * .from(file({ path: './input.txt' }))
 *
 * // Watch file for changes
 * .from(file({ path: './config.txt', watch: true }))
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
