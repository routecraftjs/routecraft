import type { Source } from "../../operations/from.ts";
import type { Destination } from "../../operations/to.ts";
import type { Enricher } from "../../operations/enrich.ts";
import { rcError } from "../../error.ts";
import { tagAdapter, factoryArgs } from "../shared/factory-tag.ts";
import type { FileOptions } from "./types.ts";
import { FileSourceAdapter } from "./source.ts";
import { FileDestinationAdapter } from "./destination.ts";
import { FileEnricherAdapter } from "./enricher.ts";

/**
 * Combined file adapter type: all three roles on one honest type. The
 * operation keyword selects the role (`.from()` subscribes, `.to()` sends,
 * `.enrich()` fetches).
 */
export type FileAdapter = Source<string> &
  Destination<unknown> &
  Enricher<unknown, string> & { readonly adapterId: string };

/**
 * Creates a file adapter for plain text files. One factory, one type; the
 * POSITION in the route selects the role:
 *
 * - **`.from(file({ path }))`** reads the file and emits its content
 *   (`chunked: true` emits one exchange per line with FILE_LINE / FILE_PATH
 *   headers). The source role needs a static string path.
 * - **`.to(file({ path }))`** writes the exchange body to the file
 *   (overwrite; `append: true` appends; `delete: true` removes the file).
 *   The body flows through unchanged.
 * - **`.enrich(file({ path }))`** reads the file mid-route and the content
 *   replaces the body (pass an aggregator such as `only()` to merge
 *   instead). Dynamic (function) paths resolve against the exchange.
 *
 * @param options - File path, encoding, createDirs, append/delete, chunked
 * @returns The combined Source + Destination + Enricher adapter
 *
 * @example
 * ```typescript
 * // Read file as source
 * .from(file({ path: './input.txt' }))
 *
 * // Read one exchange per line
 * .from(file({ path: './input.txt', chunked: true }))
 *
 * // Write to file
 * .to(file({ path: './output.txt' }))
 *
 * // Append to log
 * .to(file({ path: './log.txt', append: true }))
 *
 * // Pull a file into the body mid-route, alongside the existing data
 * .enrich(file({ path: './config.txt' }), only((s: string) => s, 'config'))
 *
 * // Dynamic path with directory creation
 * .to(file({
 *   path: (ex) => `./data/${ex.body.date}.txt`,
 *   createDirs: true
 * }))
 * ```
 */
export function file(options: FileOptions): FileAdapter {
  if (options.append && options.delete) {
    throw rcError("RC5003", undefined, {
      message:
        "file adapter: `append` and `delete` are mutually exclusive send behaviors",
      suggestion: "Pass at most one of `append: true` / `delete: true`",
    });
  }
  const source = new FileSourceAdapter(options);
  const destination = new FileDestinationAdapter(options);
  const enricher = new FileEnricherAdapter(options);
  return tagAdapter(
    {
      adapterId: "routecraft.adapter.file",
      subscribe: source.subscribe,
      send: destination.send,
      fetch: enricher.fetch,
    },
    file,
    factoryArgs(options),
  );
}

// Re-export types for public API
export type { FileOptions } from "./types.ts";
export { FileHeaders } from "./types.ts";

// Re-export classes for internal use (e.g., by html and csv adapters)
export { FileSourceAdapter } from "./source.ts";
export { FileDestinationAdapter } from "./destination.ts";
export { FileEnricherAdapter } from "./enricher.ts";
