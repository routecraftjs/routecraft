import * as fsp from "node:fs/promises";
import type { Destination, CallableDestination } from "../../operations/to.ts";
import type { Exchange } from "../../exchange.ts";
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

  /**
   * Tail of the in-flight append chain per resolved path. An append is a
   * read-then-write (does the file exist? then write the header or not), so
   * two concurrent sends to the same file could both observe "missing" and
   * both emit a header. Chaining serialises them within this process; a
   * second writer in another process is still outside our reach.
   */
  private readonly appendQueues = new Map<string, Promise<void>>();

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

    if (!this.options.append) {
      await this.write(exchange, resolvedPath);
      return;
    }

    // Serialise appends to this path: the previous append must have landed
    // before the next one probes for the file's existence.
    const previous = this.appendQueues.get(resolvedPath) ?? Promise.resolve();
    const current = previous
      // A failed append must not poison the queue for the next writer, so the
      // chain swallows the rejection; `current` below still rethrows it to
      // this caller.
      .catch(() => undefined)
      .then(() => this.write(exchange, resolvedPath));
    this.appendQueues.set(
      resolvedPath,
      current.catch(() => undefined),
    );
    await current;
  };

  private async write(
    exchange: Exchange<unknown>,
    resolvedPath: string,
  ): Promise<void> {
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

    // Papa.unparse emits no trailing newline, so an append would splice the
    // new first record onto the previous last one ("a,b" + "c,d" =>
    // "a,bc,d"). Terminate the chunk so repeated appends stay parseable,
    // reusing the record separator Papa just emitted (CRLF by default, per
    // RFC 4180) so one file never mixes the two.
    if (append && csvContent.length > 0 && !csvContent.endsWith("\n")) {
      csvContent += csvContent.includes("\r\n") ? "\r\n" : "\n";
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
  }
}
