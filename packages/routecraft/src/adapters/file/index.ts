import type { Source } from "../../operations/from.ts";
import type { Destination } from "../../operations/to.ts";
import { tagAdapter, factoryArgs } from "../shared/factory-tag.ts";
import type { FileOptions } from "./types.ts";
import { FileSourceAdapter } from "./source.ts";
import { FileDestinationAdapter } from "./destination.ts";

/** Combined file adapter type exposing both Source and Destination interfaces. */
export type FileAdapter = Source<string> &
  Destination<unknown, void> & { readonly adapterId: string };

/**
 * Read-mode file adapter. As a destination its `send` returns the file content
 * (string), so it works mid-route with `.enrich()` / `.to()`, like an HTTP GET
 * is a destination that returns the fetched body. It remains usable as a
 * `.from()` source too.
 */
export type FileReadAdapter = Source<string> &
  Destination<unknown, string> & { readonly adapterId: string };

/**
 * Creates a file adapter in chunked source mode.
 * Emits one exchange per line with FILE_LINE and FILE_PATH headers.
 *
 * @param options - File options with chunked: true
 * @returns A Source-only adapter
 */
export function file(
  options: FileOptions & { chunked: true },
): Source<string> & { readonly adapterId: string };
/**
 * Creates a file adapter in read mode. Usable as a `.from()` source and,
 * because read mode returns the file content, mid-route via `.enrich()` /
 * `.to()`. Supports dynamic (function) paths when used as a destination.
 *
 * @param options - File options with mode: 'read'
 * @returns A combined Source and content-returning Destination adapter
 *
 * @example
 * ```typescript
 * // Pull a file into the body mid-route, alongside the existing data
 * .enrich(file({ path: './config.txt', mode: 'read' }), only((s: string) => s, 'config'))
 * ```
 */
export function file(options: FileOptions & { mode: "read" }): FileReadAdapter;
/**
 * Creates a file adapter for reading or writing plain text files.
 *
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
export function file(
  options: FileOptions,
): Source<string> | FileAdapter | FileReadAdapter {
  const args = factoryArgs(options);
  const source = new FileSourceAdapter(options);
  if (options.chunked) {
    return tagAdapter(
      {
        adapterId: "routecraft.adapter.file",
        subscribe: source.subscribe,
      },
      file,
      args,
    );
  }
  const destination = new FileDestinationAdapter(options);
  const adapter = tagAdapter(
    {
      adapterId: "routecraft.adapter.file",
      subscribe: source.subscribe,
      send: destination.send,
    },
    file,
    args,
  );
  // The single `send` resolves to the file content (string) in read mode and
  // to nothing (void) when writing/appending. Narrow the public type per mode
  // so callers infer the right body: a string in read mode, an unchanged body
  // otherwise. The runtime object is identical; only its declared `send` return
  // differs.
  if (options.mode === "read") {
    return adapter as unknown as FileReadAdapter;
  }
  return adapter as unknown as FileAdapter;
}

// Re-export types for public API
export type { FileOptions } from "./types.ts";
export { FileHeaders } from "./types.ts";

// Re-export classes for internal use (e.g., by html and csv adapters)
export { FileSourceAdapter } from "./source.ts";
export { FileDestinationAdapter } from "./destination.ts";
