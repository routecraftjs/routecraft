import { createReadStream } from "node:fs";
import type { Source, CallableSource } from "../../operations/from.ts";
import type { CsvOptions, CsvData, CsvRow } from "./types.ts";
import { HeadersKeys, type ExchangeHeaders } from "../../exchange.ts";
import { file } from "../file/index.ts";
import { ensurePapaparse } from "./shared.ts";
import { logger } from "../../logger.ts";

/**
 * CsvSourceAdapter reads CSV files and parses them to arrays of objects.
 * When chunked is true, emits one exchange per row.
 */
export class CsvSourceAdapter implements Source<CsvData | CsvRow> {
  readonly adapterId = "routecraft.adapter.csv";

  constructor(private readonly options: CsvOptions) {}

  subscribe: CallableSource<CsvData | CsvRow> = async (
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
      chunked = false,
      onParseError = "throw",
    } = this.options;

    if (chunked) {
      await this.subscribeChunked(
        Papa,
        handler as (
          message: CsvRow,
          headers?: ExchangeHeaders,
        ) => Promise<import("../../exchange.ts").Exchange>,
        abortController,
        { header, delimiter, quoteChar, skipEmptyLines, onParseError },
      );
    } else {
      const fileAdapter = file({
        path: this.options.path,
        encoding: this.options.encoding || "utf-8",
      });

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

            return await (
              handler as (
                message: CsvData,
                headers?: ExchangeHeaders,
              ) => Promise<import("../../exchange.ts").Exchange>
            )(parseResult.data as CsvData);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(`csv adapter: failed to parse CSV: ${message}`);
          }
        },
        abortController,
        onReady,
      );
      return;
    }

    if (onReady) onReady();
  };

  private async subscribeChunked(
    Papa: ReturnType<typeof ensurePapaparse>,
    handler: (
      message: CsvRow,
      headers?: ExchangeHeaders,
    ) => Promise<import("../../exchange.ts").Exchange>,
    abortController: AbortController,
    parseOptions: {
      header: boolean;
      delimiter: string;
      quoteChar: string;
      skipEmptyLines: boolean;
      onParseError: "throw" | "skip";
    },
  ): Promise<void> {
    if (abortController.signal.aborted) return;

    const filePath = this.options.path;
    if (typeof filePath !== "string") {
      throw new Error(
        "csv adapter: path must be a string for source mode (dynamic paths are only supported for destinations)",
      );
    }

    const encoding = this.options.encoding || "utf-8";

    return new Promise<void>((resolve, reject) => {
      const stream = createReadStream(filePath, { encoding });
      let rowNumber = 0;
      let aborted = false;
      let settled = false;

      const settle = (fn: () => void) => {
        if (!settled) {
          settled = true;
          fn();
        }
      };

      const onAbort = () => {
        aborted = true;
        stream.destroy();
        settle(() => resolve());
      };
      abortController.signal.addEventListener("abort", onAbort, { once: true });

      Papa.parse(stream, {
        header: parseOptions.header,
        delimiter: parseOptions.delimiter,
        quoteChar: parseOptions.quoteChar,
        skipEmptyLines: parseOptions.skipEmptyLines,
        step: (
          results: { data: CsvRow; errors: Array<{ message: string }> },
          parser: { pause: () => void; resume: () => void; abort: () => void },
        ) => {
          if (aborted) {
            parser.abort();
            return;
          }

          rowNumber++;

          if (results.errors.length > 0) {
            const firstError = results.errors[0];
            if (parseOptions.onParseError === "skip") {
              logger.warn(
                `csv adapter: skipping row ${rowNumber}: ${firstError.message}`,
              );
              return;
            }
            parser.abort();
            settle(() =>
              reject(
                new Error(
                  `csv adapter: parse error at row ${rowNumber}: ${firstError.message}`,
                ),
              ),
            );
            return;
          }

          parser.pause();
          const headers: ExchangeHeaders = {
            [HeadersKeys.CSV_ROW]: rowNumber,
            [HeadersKeys.CSV_PATH]: filePath,
          } as ExchangeHeaders;

          handler(results.data as CsvRow, headers)
            .then(() => {
              if (!aborted) {
                parser.resume();
              }
            })
            .catch((err) => {
              parser.abort();
              settle(() => reject(err));
            });
        },
        complete: () => {
          abortController.signal.removeEventListener("abort", onAbort);
          settle(() => resolve());
        },
        error: (err: Error) => {
          abortController.signal.removeEventListener("abort", onAbort);
          if (aborted) {
            settle(() => resolve());
            return;
          }
          const message = err instanceof Error ? err.message : String(err);
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            settle(() =>
              reject(new Error(`csv adapter: file not found: ${filePath}`)),
            );
          } else if ((err as NodeJS.ErrnoException).code === "EACCES") {
            settle(() =>
              reject(
                new Error(
                  `csv adapter: permission denied reading file: ${filePath}`,
                ),
              ),
            );
          } else {
            settle(() =>
              reject(new Error(`csv adapter: failed to read CSV: ${message}`)),
            );
          }
        },
      });
    });
  }
}
