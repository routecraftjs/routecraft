import type { Source } from "../../operations/from.ts";
import { tagAdapter, factoryArgs } from "../shared/factory-tag.ts";
import type { FolderEntry, FolderOptions } from "./types.ts";
import { FolderSourceAdapter } from "./source.ts";

/**
 * Folder adapter type: a source that emits the directory listing as a single
 * `FolderEntry[]` exchange (the default, non-chunked shape).
 */
export type FolderAdapter = Source<FolderEntry[]> & {
  readonly adapterId: string;
};

/**
 * Creates a folder source in chunked mode: one exchange per entry, each body a
 * {@link FolderEntry}. Filter by metadata or name with `.filter()`, then read
 * content with the file adapter.
 *
 * @param options - Folder options with `chunked: true`
 * @returns A Source emitting one {@link FolderEntry} per entry
 *
 * @example
 * ```typescript
 * // Read the content of every .json file in a folder
 * craft()
 *   .from(folder({ path: "./inbox", chunked: true }))
 *   .filter((ex) => ex.body.ext === ".json")
 *   .enrich(
 *     file({ path: (ex) => ex.body.path, mode: "read" }),
 *     only((content: string) => content, "content"),
 *   )
 *   .to(log());
 * ```
 */
export function folder(
  options: FolderOptions & { chunked: true },
): Source<FolderEntry> & { readonly adapterId: string };
/**
 * Creates a folder source that scans a directory and emits a single exchange
 * whose body is the full {@link FolderEntry}`[]` listing (sorted by relative
 * path). This is the default shape, mirroring the non-chunked `csv` / `jsonl`
 * adapters; pass `chunked: true` to emit one exchange per entry instead.
 *
 * Filtering is not built in by design: list the entries, then narrow with the
 * normal operations (`.filter()` per-entry in chunked mode, or `.split()` /
 * `.transform()` on the array), and read content with the file adapter. This
 * keeps "find the files" and "decide which ones" composable.
 *
 * @param options - Directory path plus `recursive`, `includeDirs`, `chunked`
 * @returns A Source usable with `.from(folder(...))`
 *
 * @example
 * ```typescript
 * // Get the whole listing as one body, then act on the collection
 * craft()
 *   .from(folder({ path: "./inbox" }))
 *   .transform((ex) => ex.body.filter((e) => e.ext === ".json"))
 *   .split((ex) => ex.body)
 *   .enrich(
 *     file({ path: (ex) => ex.body.path, mode: "read" }),
 *     only((content: string) => content, "content"),
 *   )
 *   .to(log());
 * ```
 */
export function folder(options: FolderOptions): FolderAdapter;
export function folder(
  options: FolderOptions,
): Source<FolderEntry | FolderEntry[]> & { readonly adapterId: string } {
  return tagAdapter(
    {
      adapterId: "routecraft.adapter.folder",
      subscribe: new FolderSourceAdapter(options).subscribe,
    },
    folder,
    factoryArgs(options),
  );
}

// Re-export types for the public API.
export type { FolderEntry, FolderOptions } from "./types.ts";

// Re-export the class for internal use (mirrors the file/csv adapters).
export { FolderSourceAdapter } from "./source.ts";
