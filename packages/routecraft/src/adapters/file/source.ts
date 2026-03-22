import * as fsp from "node:fs/promises";
import type { Source, CallableSource } from "../../operations/from.ts";
import type { FileOptions } from "./types.ts";

/**
 * FileSourceAdapter implements the Source interface for reading files.
 * Reads the file once and emits its content as a string.
 */
export class FileSourceAdapter implements Source<string> {
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
}
