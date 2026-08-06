import * as fsp from "node:fs/promises";
import type { Destination, CallableDestination } from "../../operations/to.ts";
import type { CsvFileOptions } from "./types.ts";
import { file } from "../file/index.ts";
import { ensurePapaparse } from "./shared.ts";
import { assertExclusiveSendBehavior } from "../shared/file-role-guards.ts";

/**
 * CsvDestinationAdapter implements the Destination (send) role for CSV files.
 *
 * `send` is strictly void: it formats the exchange body (object or array of
 * objects) as CSV and writes it (overwrite by default, `append: true` to
 * append with header handling, `delete: true` to remove the file). Reading
 * lives on the fetch role (CsvEnricherAdapter).
 */
export class CsvDestinationAdapter implements Destination<unknown> {
  readonly adapterId = "routecraft.adapter.csv";

  constructor(private readonly options: CsvFileOptions) {
    assertExclusiveSendBehavior("csv", options);
  }

  send: CallableDestination<unknown> = async (exchange) => {
    const resolvedPath =
      typeof this.options.path === "function"
        ? this.options.path(exchange)
        : this.options.path;

    // Delete behavior: delegate to the file adapter (no format). Idempotent.
    if (this.options.delete) {
      await file({ path: resolvedPath, delete: true }).send(exchange);
      return;
    }

    const Papa = ensurePapaparse();
    const {
      header = true,
      delimiter = ",",
      quoteChar = '"',
      skipEmptyLines = true,
      append = false,
    } = this.options;

    // Extract data from exchange body
    let data: Array<Record<string, unknown>>;
    if (Array.isArray(exchange.body)) {
      data = exchange.body;
    } else if (exchange.body && typeof exchange.body === "object") {
      data = [exchange.body as Record<string, unknown>];
    } else {
      throw new Error(
        "csv adapter: send role requires exchange body to be an object or array of objects",
      );
    }

    // Check if file exists (for append header handling)
    let fileExists = false;
    if (append) {
      try {
        await fsp.access(resolvedPath);
        fileExists = true;
      } catch {
        fileExists = false;
      }
    }

    const includeHeader = header && !(append && fileExists);
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
      append,
      createDirs: this.options.createDirs || false,
    });

    const fileExchange = {
      ...exchange,
      body: csvContent,
    };
    await fileAdapter.send(fileExchange);
  };
}
