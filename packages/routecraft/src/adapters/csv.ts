import { type Source, type CallableSource } from "../operations/from.ts";
import {
  type Destination,
  type CallableDestination,
} from "../operations/to.ts";
import { type Exchange } from "../exchange.ts";
import { file } from "./file.ts";
import * as fsp from "node:fs/promises";

function ensurePapaparse(): typeof import("papaparse") {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const papa = require("papaparse");
    // Handle both CommonJS default export and named exports
    return papa.default || papa;
  } catch {
    throw new Error(
      "csv adapter requires 'papaparse' to be installed. Install it with: npm install papaparse",
    );
  }
}

export interface CsvOptions {
  /**
   * File path for source/destination mode.
   * Required for source/destination mode.
   */
  path: string | ((exchange: Exchange) => string);

  /**
   * Whether the CSV has a header row (source mode) or should include headers (destination mode).
   * Default: true
   */
  header?: boolean;

  /**
   * Field delimiter. Default: ','
   */
  delimiter?: string;

  /**
   * Quote character. Default: '"'
   */
  quoteChar?: string;

  /**
   * Skip empty lines. Default: true
   */
  skipEmptyLines?: boolean;

  /**
   * Text encoding. Default: 'utf-8'
   */
  encoding?: BufferEncoding;

  /**
   * Watch file for changes (source mode only).
   * Default: false
   */
  watch?: boolean;

  /**
   * Create parent directories if they don't exist (destination mode only).
   * Default: false
   */
  createDirs?: boolean;

  /**
   * File operation mode (destination mode only).
   * - 'write': Write/overwrite file
   * - 'append': Append to file
   * Default: 'write'
   */
  mode?: "write" | "append";
}

export class CsvAdapter
  implements Source<Array<Record<string, unknown>>>, Destination<unknown, void>
{
  readonly adapterId = "routecraft.adapter.csv";

  constructor(private readonly options: CsvOptions) {}

  /**
   * Source implementation: read CSV file and parse to array of objects.
   * Uses file() adapter underneath for I/O and watching.
   */
  subscribe: CallableSource<Array<Record<string, unknown>>> = async (
    context,
    handler,
    abortController,
    onReady,
  ) => {
    const Papa = ensurePapaparse();
    const {
      header = true,
      delimiter = ",",
      quoteChar = '"',
      skipEmptyLines = true,
    } = this.options;

    // Create file adapter for reading
    const fileAdapter = file({
      path: this.options.path,
      encoding: this.options.encoding || "utf-8",
    });

    // Subscribe to file content and parse CSV
    await fileAdapter.subscribe(
      context,
      async (csvContent: string) => {
        try {
          const parseResult = Papa.parse(csvContent, {
            header,
            delimiter,
            quoteChar,
            skipEmptyLines,
          });

          if (parseResult.errors.length > 0) {
            const firstError = parseResult.errors[0];
            throw new Error(
              `csv adapter: parse error at row ${firstError.row}: ${firstError.message}`,
            );
          }

          // Papa.parse returns data as unknown[], but with header: true it's Record<string, unknown>[]
          // Call handler and return the exchange it produces
          return await handler(
            parseResult.data as Array<Record<string, unknown>>,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(`csv adapter: failed to parse CSV: ${message}`);
        }
      },
      abortController,
      onReady,
    );
  };

  /**
   * Destination implementation: write array of objects to CSV file.
   * Uses file() adapter underneath for I/O.
   */
  send: CallableDestination<unknown, void> = async (exchange) => {
    const Papa = ensurePapaparse();
    const {
      header = true,
      delimiter = ",",
      quoteChar = '"',
      skipEmptyLines = true,
    } = this.options;

    // Extract data from exchange body
    // Handle both single records and arrays of records
    let data: Array<Record<string, unknown>>;
    if (Array.isArray(exchange.body)) {
      data = exchange.body;
    } else if (exchange.body && typeof exchange.body === "object") {
      // Single record - wrap in array
      data = [exchange.body as Record<string, unknown>];
    } else {
      throw new Error(
        "csv adapter: destination mode requires exchange body to be an object or array of objects",
      );
    }

    // Resolve the file path
    const resolvedPath =
      typeof this.options.path === "function"
        ? this.options.path(exchange)
        : this.options.path;

    // Check if file exists (for append mode header handling)
    let fileExists = false;
    if (this.options.mode === "append") {
      try {
        await fsp.access(resolvedPath);
        fileExists = true;
      } catch {
        // File doesn't exist yet
        fileExists = false;
      }
    }

    // Convert to CSV string
    // When appending to existing file, don't include header
    const includeHeader =
      header && !(this.options.mode === "append" && fileExists);
    let csvContent: string;
    try {
      csvContent = Papa.unparse(data, {
        header: includeHeader,
        delimiter,
        quotes: false, // Only quote when necessary
        quoteChar,
        skipEmptyLines,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`csv adapter: failed to format CSV: ${message}`);
    }

    // Create file adapter for writing
    const fileAdapter = file({
      path: this.options.path,
      encoding: this.options.encoding || "utf-8",
      mode: this.options.mode || "write",
      createDirs: this.options.createDirs || false,
    });

    // Write CSV content to file
    // We need to pass the CSV string as the body to the file adapter
    const fileExchange = {
      ...exchange,
      body: csvContent,
    };
    await fileAdapter.send(fileExchange);

    // Return void - don't modify the exchange body
    return undefined;
  };
}

/**
 * Creates a CSV adapter for reading or writing CSV files.
 *
 * As a **source** (.from):
 * - Reads CSV file and parses to array of objects
 * - Optionally watches for changes
 *
 * As a **destination** (.to):
 * - Writes array of objects to CSV file
 * - Supports write and append modes
 * - Can create parent directories automatically
 *
 * Requires `papaparse` to be installed as a peer dependency.
 *
 * @param options - CSV path, parsing/formatting options
 * @returns CsvAdapter implementing Source and Destination
 *
 * @example
 * ```typescript
 * // Read CSV file as source
 * .from(csv({ path: './data.csv', header: true }))
 *
 * // Watch CSV file for changes
 * .from(csv({ path: './data.csv', watch: true }))
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
export function csv(options: CsvOptions): CsvAdapter {
  return new CsvAdapter(options);
}
