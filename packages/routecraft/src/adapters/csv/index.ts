import type { Source } from "../../operations/from.ts";
import type { Destination } from "../../operations/to.ts";
import type { Enricher } from "../../operations/enrich.ts";
import type { Transformer } from "../../operations/transform.ts";
import { tagAdapter, factoryArgs } from "../shared/factory-tag.ts";
import type {
  CsvOptions,
  CsvFileOptions,
  CsvTransformerOptions,
  CsvData,
  CsvRow,
} from "./types.ts";
import { CsvSourceAdapter } from "./source.ts";
import { CsvDestinationAdapter } from "./destination.ts";
import { CsvEnricherAdapter } from "./enricher.ts";
import { CsvTransformerAdapter } from "./transformer.ts";

/**
 * Combined CSV file adapter type: all three roles on one honest type. The
 * operation keyword selects the role (`.from()` subscribes, `.to()` sends,
 * `.enrich()` fetches).
 */
export type CsvAdapter = Source<CsvData> &
  Destination<unknown> &
  Enricher<unknown, CsvData> & { readonly adapterId: string };

/**
 * Chunked CSV adapter: identical to {@link CsvAdapter} except the source
 * emits one exchange per row (`CsvRow`) instead of one `CsvData` array. The
 * send/fetch roles are unchanged (the chunked option concerns the subscribe
 * role only).
 */
export type CsvChunkedAdapter = Source<CsvRow> &
  Destination<unknown> &
  Enricher<unknown, CsvData> & { readonly adapterId: string };

/**
 * Creates a CSV adapter in chunked source mode: one exchange per row with
 * CSV_ROW and CSV_PATH headers. `chunked` must be the literal `true`; a
 * widened boolean is a compile error, so dynamic chunking is an explicit
 * branch at the call site.
 *
 * Requires `papaparse` to be installed as a peer dependency.
 *
 * @param options - CSV file options with chunked: true
 * @returns The combined adapter with a per-row Source
 */
export function csv(
  options: CsvFileOptions & { chunked: true },
): CsvChunkedAdapter;
/**
 * Creates a CSV adapter for a CSV file. One factory, one type; the POSITION
 * in the route selects the role:
 *
 * - **`.from(csv({ path }))`** reads + parses the file and emits the rows.
 * - **`.to(csv({ path }))`** formats the exchange body as CSV and writes it
 *   (overwrite; `append: true` appends; `delete: true` removes the file).
 *   The body flows through unchanged.
 * - **`.enrich(csv({ path }))`** reads + parses mid-route; the rows replace
 *   the body (pass an aggregator such as `only()` to merge instead).
 *
 * Requires `papaparse` to be installed as a peer dependency.
 *
 * @param options - CSV path, parsing/formatting options
 * @returns The combined Source + Destination + Enricher adapter
 *
 * @example
 * ```typescript
 * // Read CSV file as source
 * .from(csv({ path: './data.csv', header: true }))
 *
 * // Read mid-route (the parsed rows replace the body)
 * .enrich(csv({ path: './data.csv' }))
 *
 * // Write to CSV file
 * .to(csv({ path: './output.csv', header: true }))
 *
 * // Append to CSV file
 * .to(csv({ path: './log.csv', append: true }))
 *
 * // Delete a CSV file (idempotent)
 * .to(csv({ path: (ex) => ex.body.processedPath, delete: true }))
 * ```
 */
export function csv(options: CsvFileOptions & { chunked?: false }): CsvAdapter;
/**
 * Creates a CSV transformer that parses a CSV string already in the body.
 *
 * Requires `papaparse` to be installed as a peer dependency.
 *
 * @param options - Transformer options (`from`, `to`, parsing options); no `path`
 * @returns A Transformer
 */
export function csv<T = unknown, R = unknown>(
  options?: CsvTransformerOptions<T, R>,
): Transformer<T, R> & { readonly adapterId: string };
export function csv<T = unknown, R = unknown>(
  options: CsvOptions<T, R> = {},
):
  | (Transformer<T, R> & { readonly adapterId: string })
  | CsvChunkedAdapter
  | CsvAdapter {
  const args = factoryArgs(options);

  // Transformer role: no path means parse a CSV string already in the body.
  // The `.transform()` keyword enforces the category, so dropping `path`
  // fails loudly at `.from()` / `.to()` (no subscribe/send slot) instead of
  // silently changing the adapter's kind.
  if (!("path" in options) || options.path === undefined) {
    const transformer = new CsvTransformerAdapter<T, R>(
      options as CsvTransformerOptions<T, R>,
    );
    return tagAdapter(
      {
        adapterId: "routecraft.adapter.csv",
        transform: transformer.transform.bind(transformer),
      },
      csv,
      args,
    ) as Transformer<T, R> & { readonly adapterId: string };
  }

  const fileOptions = options as CsvFileOptions;
  const source = new CsvSourceAdapter(fileOptions);
  const destination = new CsvDestinationAdapter(fileOptions);
  const enricher = new CsvEnricherAdapter(fileOptions);
  return tagAdapter(
    {
      adapterId: "routecraft.adapter.csv",
      subscribe: source.subscribe,
      send: destination.send,
      fetch: enricher.fetch,
    },
    csv,
    args,
  ) as CsvChunkedAdapter | CsvAdapter;
}

// Re-export types
export type {
  CsvOptions,
  CsvTransformerOptions,
  CsvFileOptions,
  CsvRow,
  CsvData,
} from "./types.ts";
export { CsvHeaders } from "./types.ts";
