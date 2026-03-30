import type { Source } from "../../operations/from.ts";
import type { Destination } from "../../operations/to.ts";
import type { FileOptions } from "./types.ts";
import { FileSourceAdapter } from "./source.ts";
import { FileDestinationAdapter } from "./destination.ts";

/** Combined file adapter type exposing both Source and Destination interfaces. */
export type FileAdapter = Source<string> &
  Destination<unknown, void> & { readonly adapterId: string };

/**
 * Creates a file adapter in chunked source mode.
 * Emits one exchange per line with FILE_LINE and FILE_PATH headers.
 *
 * @beta
 * @param options - File options with chunked: true
 * @returns A Source-only adapter
 */
export function file(
  options: FileOptions & { chunked: true },
): Source<string> & { readonly adapterId: string };
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
 * @returns A combined Source and Destination adapter
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
export function file(options: FileOptions): FileAdapter;
export function file(options: FileOptions): Source<string> | FileAdapter {
  const source = new FileSourceAdapter(options);
  if (options.chunked) {
    return {
      adapterId: "routecraft.adapter.file",
      subscribe: source.subscribe,
    };
  }
  const destination = new FileDestinationAdapter(options);
  return {
    adapterId: "routecraft.adapter.file",
    subscribe: source.subscribe,
    send: destination.send,
  };
}

// Re-export types for public API
export type { FileOptions } from "./types.ts";

// Re-export classes for internal use (e.g., by html and csv adapters)
export { FileSourceAdapter } from "./source.ts";
export { FileDestinationAdapter } from "./destination.ts";
