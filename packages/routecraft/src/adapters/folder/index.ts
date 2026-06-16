import type { Source } from "../../operations/from.ts";
import { tagAdapter, factoryArgs } from "../shared/factory-tag.ts";
import type { FolderEntry, FolderOptions } from "./types.ts";
import { FolderSourceAdapter } from "./source.ts";

/** Folder adapter type: a source that emits one {@link FolderEntry} per file. */
export type FolderAdapter = Source<FolderEntry> & {
  readonly adapterId: string;
};

/**
 * Creates a folder source that scans a directory and emits one exchange per
 * entry. Each exchange body is a {@link FolderEntry} carrying the entry's
 * path and metadata (name, ext, size, modifiedAt, ...).
 *
 * Filtering is not built in by design: emit every entry, then narrow with the
 * normal `.filter()` operation, and read content with the file adapter. This
 * keeps "find the files" and "decide which ones" composable.
 *
 * @param options - Directory path plus `recursive` and `includeDirs` flags
 * @returns A Source usable with `.from(folder(...))`
 *
 * @example
 * ```typescript
 * // Read the content of every .json file in a folder
 * craft()
 *   .from(folder({ path: "./inbox" }))
 *   .filter((ex) => ex.body.ext === ".json")
 *   .enrich(
 *     file({ path: (ex) => ex.body.path, mode: "read" }),
 *     only((content: string) => content, "content"),
 *   )
 *   .to(log());
 *
 * // Recurse and skip anything modified more than a day ago
 * craft()
 *   .from(folder({ path: "./data", recursive: true }))
 *   .filter((ex) => Date.now() - ex.body.modifiedAt.getTime() < 86_400_000)
 *   .to(log());
 * ```
 */
export function folder(options: FolderOptions): FolderAdapter {
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
