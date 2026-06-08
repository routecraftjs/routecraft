import * as fsp from "node:fs/promises";
import type { Destination, CallableDestination } from "../../operations/to.ts";
import type { CsvFileOptions, CsvData } from "./types.ts";
import { file } from "../file/index.ts";
import { ensurePapaparse, parseCsv } from "./shared.ts";

/**
 * CsvDestinationAdapter handles CSV file I/O as a destination.
 *
 * - `write` / `append` (default): format the exchange body (object or array of
 *   objects) as CSV and write it.
 * - `read`: read the file, parse it, and return the parsed rows, so the adapter
 *   works mid-route via `.enrich()` / `.to()` (like an HTTP GET). Parse failures
 *   throw; the route boundary surfaces them as `exchange:failed`. The
 *   `onParseError` lifecycle controls (`'abort'` / `'drop'`) remain source-only.
 * - `delete`: delete the file and pass the body through unchanged. Idempotent.
 */
export class CsvDestinationAdapter implements Destination<unknown, unknown> {
  readonly adapterId = "routecraft.adapter.csv";

  constructor(private readonly options: CsvFileOptions) {}

  send: CallableDestination<unknown, unknown> = async (exchange) => {
    const resolvedPath =
      typeof this.options.path === "function"
        ? this.options.path(exchange)
        : this.options.path;

    // Read mode: read the file via the file adapter, then parse and return.
    if (this.options.mode === "read") {
      const readAdapter = file({
        path: resolvedPath,
        mode: "read",
        encoding: this.options.encoding || "utf-8",
      });
      const content = await readAdapter.send(exchange);
      return parseCsv(content, this.options) as CsvData;
    }

    // Delete mode: delegate to the file adapter (no format). Idempotent.
    if (this.options.mode === "delete") {
      const deleteAdapter = file({ path: resolvedPath, mode: "delete" });
      return deleteAdapter.send(exchange);
    }

    const Papa = ensurePapaparse();
    const {
      header = true,
      delimiter = ",",
      quoteChar = '"',
      skipEmptyLines = true,
    } = this.options;

    // Extract data from exchange body
    let data: Array<Record<string, unknown>>;
    if (Array.isArray(exchange.body)) {
      data = exchange.body;
    } else if (exchange.body && typeof exchange.body === "object") {
      data = [exchange.body as Record<string, unknown>];
    } else {
      throw new Error(
        "csv adapter: destination mode requires exchange body to be an object or array of objects",
      );
    }

    // Check if file exists (for append mode header handling)
    let fileExists = false;
    if (this.options.mode === "append") {
      try {
        await fsp.access(resolvedPath);
        fileExists = true;
      } catch {
        fileExists = false;
      }
    }

    const includeHeader =
      header && !(this.options.mode === "append" && fileExists);
    let csvContent: string;
    try {
      csvContent = Papa.unparse(data, {
        header: includeHeader,
        delimiter,
        quotes: false,
        quoteChar,
        skipEmptyLines,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`csv adapter: failed to format CSV: ${message}`);
    }

    const fileAdapter = file({
      path: resolvedPath,
      encoding: this.options.encoding || "utf-8",
      mode: this.options.mode || "write",
      createDirs: this.options.createDirs || false,
    });

    const fileExchange = {
      ...exchange,
      body: csvContent,
    };
    await fileAdapter.send(fileExchange);

    return undefined;
  };
}
