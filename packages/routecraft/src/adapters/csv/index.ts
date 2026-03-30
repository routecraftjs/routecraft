import type { Source } from "../../operations/from.ts";
import type { Destination } from "../../operations/to.ts";
import type { CsvOptions, CsvData, CsvRow } from "./types.ts";
import { CsvSourceAdapter } from "./source.ts";
import { CsvDestinationAdapter } from "./destination.ts";

/** Combined CSV adapter type exposing both Source and Destination interfaces. */
export type CsvAdapter = Source<CsvData> &
  Destination<unknown, void> & { readonly adapterId: string };

/**
 * Creates a CSV adapter in chunked source mode.
 * Emits one exchange per row with CSV_ROW and CSV_PATH headers.
 *
 * @beta
 * Requires `papaparse` to be installed as a peer dependency.
 *
 * @param options - CSV options with chunked: true
 * @returns A Source-only adapter
 */
export function csv(
  options: CsvOptions & { chunked: true },
): Source<CsvRow> & { readonly adapterId: string };
/**
 * Creates a CSV adapter for reading or writing CSV files.
 *
 * @beta
 * As a **source** (.from):
 * - Reads CSV file and parses to array of objects
 *
 * As a **destination** (.to):
 * - Writes array of objects to CSV file
 * - Supports write and append modes
 * - Can create parent directories automatically
 *
 * Requires `papaparse` to be installed as a peer dependency.
 *
 * @param options - CSV path, parsing/formatting options
 * @returns Combined Source and Destination adapter
 *
 * @example
 * ```typescript
 * // Read CSV file as source
 * .from(csv({ path: './data.csv', header: true }))
 *
 * // Write to CSV file
 * .to(csv({ path: './output.csv', header: true }))
 *
 * // Custom delimiter
 * .to(csv({ path: './data.tsv', delimiter: '\t' }))
 *
 * // Dynamic path with directory creation
 * .to(csv({
 *   path: (ex) => `./exports/${ex.body.date}.csv`,
 *   createDirs: true
 * }))
 * ```
 */
export function csv(options: CsvOptions): CsvAdapter;
export function csv(options: CsvOptions): Source<CsvRow> | CsvAdapter {
  const source = new CsvSourceAdapter(options);
  if (options.chunked) {
    return {
      adapterId: "routecraft.adapter.csv",
      subscribe: source.subscribe,
    } as Source<CsvRow>;
  }
  const destination = new CsvDestinationAdapter(options);
  return {
    adapterId: "routecraft.adapter.csv",
    subscribe: source.subscribe,
    send: destination.send,
  } as CsvAdapter;
}

// Re-export types
export type { CsvOptions, CsvRow, CsvData } from "./types.ts";
