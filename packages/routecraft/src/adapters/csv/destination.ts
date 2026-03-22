import * as fsp from "node:fs/promises";
import type { Destination, CallableDestination } from "../../operations/to.ts";
import type { CsvOptions } from "./types.ts";
import { file } from "../file/index.ts";
import { ensurePapaparse } from "./shared.ts";

/**
 * CsvDestinationAdapter writes arrays of objects to CSV files.
 */
export class CsvDestinationAdapter implements Destination<unknown, void> {
  readonly adapterId = "routecraft.adapter.csv";

  constructor(private readonly options: CsvOptions) {}

  send: CallableDestination<unknown, void> = async (exchange) => {
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
