import type { Source } from "../../operations/from.ts";
import type { Destination } from "../../operations/to.ts";
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
import { CsvTransformerAdapter } from "./transformer.ts";

/** Combined CSV adapter type exposing both Source and Destination interfaces. */
export type CsvAdapter = Source<CsvData> &
  Destination<unknown, void> & { readonly adapterId: string };

/**
 * Read-mode CSV adapter. As a destination its `send` reads + parses the file
 * and returns the rows, so it works mid-route via `.enrich()` / `.to()` (like
 * an HTTP GET). It remains usable as a `.from()` source.
 */
export type CsvReadAdapter = Source<CsvData> &
  Destination<unknown, CsvData> & { readonly adapterId: string };

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
/**
 * Creates a CSV adapter in chunked source mode.
 * Emits one exchange per row with CSV_ROW and CSV_PATH headers.
 *
 * Requires `papaparse` to be installed as a peer dependency.
 *
 * @param options - CSV options with chunked: true
 * @returns A Source-only adapter
 */
export function csv(
  options: CsvFileOptions & { chunked: true },
): Source<CsvRow> & { readonly adapterId: string };
/**
 * Creates a read-mode CSV adapter (source, and destination that returns rows).
 *
 * @param options - CSV file options with mode: 'read'
 * @returns A Source + read Destination adapter
 */
export function csv(options: CsvFileOptions & { mode: "read" }): CsvReadAdapter;
/**
 * Creates a CSV adapter for reading or writing CSV files.
 *
 * As a **source** (.from):
 * - Reads CSV file and parses to array of objects
 *
 * As a **destination** (.to):
 * - Writes array of objects to CSV file
 * - Supports write and append modes
 * - Can create parent directories automatically
 * - `mode: 'read'` returns the parsed rows mid-route; `mode: 'delete'` removes
 *   the file (idempotent) and passes the body through
 *
 * Requires `papaparse` to be installed as a peer dependency.
 *
 * @param options - CSV path, parsing/formatting options
 * @returns Combined Source and Destination adapter
 *
 * @example
 * ```typescript
 * // Parse a CSV string already in the body (transformer mode)
 * .transform(csv({ from: (b) => b.body }))
 *
 * // Read CSV file as source
 * .from(csv({ path: './data.csv', header: true }))
 *
 * // Read mid-route (destination that returns the parsed rows)
 * .enrich(csv({ path: './data.csv', mode: 'read' }), only((rows) => rows, 'rows'))
 *
 * // Write to CSV file
 * .to(csv({ path: './output.csv', header: true }))
 *
 * // Delete a CSV file (idempotent)
 * .to(csv({ path: (ex) => ex.body.processedPath, mode: 'delete' }))
 * ```
 */
export function csv(options: CsvFileOptions): CsvAdapter;
export function csv<T = unknown, R = unknown>(
  options: CsvOptions<T, R> = {},
):
  | (Transformer<T, R> & { readonly adapterId: string })
  | Source<CsvRow>
  | CsvReadAdapter
  | CsvAdapter {
  const args = factoryArgs(options);

  // Transformer mode: no path means parse a CSV string already in the body.
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
  if (fileOptions.chunked) {
    return tagAdapter(
      {
        adapterId: "routecraft.adapter.csv",
        subscribe: source.subscribe,
      },
      csv,
      args,
    ) as Source<CsvRow>;
  }
  const destination = new CsvDestinationAdapter(fileOptions);
  const tagged = tagAdapter(
    {
      adapterId: "routecraft.adapter.csv",
      subscribe: source.subscribe,
      send: destination.send,
    },
    csv,
    args,
  );
  // In read mode `send` resolves to the parsed rows; narrow accordingly so
  // `.enrich()`/`.to()` infer the rows. Otherwise `send` is a write (void).
  // The runtime object is identical; only its declared type differs.
  if (fileOptions.mode === "read") {
    return tagged as unknown as CsvReadAdapter;
  }
  return tagged as unknown as CsvAdapter;
}

// Re-export types
export type {
  CsvOptions,
  CsvTransformerOptions,
  CsvFileOptions,
  CsvRow,
  CsvData,
} from "./types.ts";
