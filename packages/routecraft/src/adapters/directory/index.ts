import type { Source } from "../../operations/from.ts";
import type { Enricher } from "../../operations/enrich.ts";
import { tagAdapter, factoryArgs } from "../shared/factory-tag.ts";
import type { DirectoryEntry, DirectoryOptions } from "./types.ts";
import { DirectorySourceAdapter } from "./source.ts";
import { DirectoryEnricherAdapter } from "./enricher.ts";

/**
 * Directory adapter type: source and enricher on one honest type. The
 * operation keyword selects the role (`.from()` subscribes and emits the
 * listing, `.enrich()` fetches it mid-route). There is no `send`: a listing
 * is a read, so `.to(directory({ path }))` resolves to the fetch and the
 * listing replaces the body.
 */
export type DirectoryAdapter = Source<DirectoryEntry[]> &
  Enricher<unknown, DirectoryEntry[]> & { readonly adapterId: string };

/**
 * Directory adapter type in chunked mode: the source emits one
 * {@link DirectoryEntry} per exchange. The enricher role is unaffected by
 * `chunked` (a fetch produces one value) and still returns the full listing.
 */
export type DirectoryChunkedAdapter = Source<DirectoryEntry> &
  Enricher<unknown, DirectoryEntry[]> & { readonly adapterId: string };

/**
 * Creates a directory adapter in chunked mode: the source emits one exchange
 * per entry, each body a {@link DirectoryEntry}. Filter by metadata or name
 * with `.filter()`, then read content with the file adapter. Chunked is a
 * source-only emission shape, so the path must be a static string.
 *
 * @param options - Directory options with `chunked: true`
 * @returns A Source emitting one {@link DirectoryEntry} per entry (plus the
 *   unchanged enricher role)
 *
 * @example
 * ```typescript
 * // Read the content of every .json file in a directory
 * craft()
 *   .from(directory({ path: "./inbox", chunked: true }))
 *   .filter((ex) => ex.body.ext === ".json")
 *   .enrich(
 *     file({ path: (ex) => ex.body.path }),
 *     only((content: string) => content, "content"),
 *   )
 *   .to(log());
 * ```
 */
export function directory(
  options: Omit<DirectoryOptions, "path"> & { path: string; chunked: true },
): DirectoryChunkedAdapter;
/**
 * Creates a directory adapter that scans a directory and produces the full
 * {@link DirectoryEntry}`[]` listing (sorted by relative path). One factory,
 * one type; the POSITION in the route selects the role:
 *
 * - **`.from(directory({ path }))`** emits a single exchange whose body is the
 *   listing, mirroring the non-chunked `csv` / `jsonl` adapters; pass
 *   `chunked: true` to emit one exchange per entry instead. The source role
 *   needs a static string path.
 * - **`.enrich(directory({ path }))`** scans the directory mid-route and the
 *   listing replaces the body (pass an aggregator such as `only()` to merge
 *   instead). Dynamic (function) paths resolve against the exchange.
 * - **`.to(directory({ path }))`** has no `send` to prefer, so it resolves to
 *   the same fetch and the listing becomes the body. This is what makes the
 *   adapter usable inside a `direct()` capability.
 *
 * Filtering is not built in by design: list the entries, then narrow with the
 * normal operations (`.filter()` per-entry in chunked mode, or `.split()` /
 * `.transform()` on the array), and read content with the file adapter. This
 * keeps "find the files" and "decide which ones" composable.
 *
 * @param options - Directory path plus `recursive`, `includeDirs`, `chunked`
 * @returns The combined Source + Enricher adapter
 *
 * @example
 * ```typescript
 * // Get the whole listing as one body, then act on the collection
 * craft()
 *   .from(directory({ path: "./inbox" }))
 *   .transform((entries) => entries.filter((e) => e.ext === ".json"))
 *   .split((ex) => ex.body)
 *   .enrich(
 *     file({ path: (ex) => ex.body.path }),
 *     only((content: string) => content, "content"),
 *   )
 *   .to(log());
 *
 * // List a directory mid-route, e.g. inside a direct() capability
 * craft()
 *   .from(direct("search-notes"))
 *   .to(directory({ path: "./notes", recursive: true }))
 *   .transform((entries) => entries.filter((e) => e.ext === ".md"))
 *   .to(log());
 * ```
 */
export function directory(options: DirectoryOptions): DirectoryAdapter;
export function directory(
  options: DirectoryOptions,
): (Source<DirectoryEntry | DirectoryEntry[]> &
  Enricher<unknown, DirectoryEntry[]>) & { readonly adapterId: string } {
  return tagAdapter(
    {
      adapterId: "routecraft.adapter.directory",
      subscribe: new DirectorySourceAdapter(options).subscribe,
      fetch: new DirectoryEnricherAdapter(options).fetch,
    },
    directory,
    factoryArgs(options),
  );
}

// Re-export types for the public API.
export type { DirectoryEntry, DirectoryOptions } from "./types.ts";

// Re-export role classes for internal use, matching the file adapter.
export { DirectorySourceAdapter } from "./source.ts";
export { DirectoryEnricherAdapter } from "./enricher.ts";
