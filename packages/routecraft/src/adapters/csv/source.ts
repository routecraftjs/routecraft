import { createReadStream } from "node:fs";
import type { Source, CallableSource } from "../../operations/from.ts";
import type { CsvOptions, CsvData, CsvRow } from "./types.ts";
import { HeadersKeys, type ExchangeHeaders } from "../../exchange.ts";
import { file } from "../file/index.ts";
import { ensurePapaparse } from "./shared.ts";
import { throwFileError } from "../shared/line-reader.ts";
import { DEFAULT_ON_PARSE_ERROR, type OnParseError } from "../shared/parse.ts";
import { rcError } from "../../error.ts";
import type { CraftContext } from "../../context.ts";

/**
 * CsvSourceAdapter reads CSV files and parses them via PapaParse.
 *
 * Non-chunked: emits a single exchange whose body is the full parsed array.
 * Chunked: streams rows from disk and emits one exchange per row with
 * `CSV_ROW` and `CSV_PATH` headers; uses `parser.pause()` /
 * `parser.resume()` around each handler call for backpressure.
 *
 * Per-row parse failures are routed by the `onParseError` option (default
 * `'fail'`). With `'fail'` in chunked mode the parse runs as a synthetic
 * first pipeline step so the route's `.error()` handler can catch it (or
 * `exchange:failed` fires) and the source continues to the next row. See
 * #187.
 */
export class CsvSourceAdapter implements Source<CsvData | CsvRow> {
  readonly adapterId = "routecraft.adapter.csv";

  constructor(private readonly options: CsvOptions) {}

  subscribe: CallableSource<CsvData | CsvRow> = async (
    context,
    handler,
    abortController,
    onReady,
    meta,
  ) => {
    const Papa = ensurePapaparse();
    const {
      header = true,
      delimiter = ",",
      quoteChar = '"',
      skipEmptyLines = true,
      chunked = false,
      onParseError = DEFAULT_ON_PARSE_ERROR,
    } = this.options;

    if (chunked) {
      if (onReady) onReady();
      await this.subscribeChunked(
        context,
        Papa,
        handler as (
          message: CsvRow,
          headers?: ExchangeHeaders,
          parse?: (raw: unknown) => unknown | Promise<unknown>,
        ) => Promise<import("../../exchange.ts").Exchange>,
        abortController,
        { header, delimiter, quoteChar, skipEmptyLines },
        onParseError,
      );
      return;
    }

    const filePath = this.options.path;
    if (typeof filePath !== "string") {
      throw new Error(
        "csv adapter: path must be a string for source mode (dynamic paths are only supported for destinations)",
      );
    }

    const fileAdapter = file({
      path: filePath,
      encoding: this.options.encoding || "utf-8",
    });

    await fileAdapter.subscribe(
      context,
      async (csvContent: string) => {
        const rowHandler = handler as (
          message: CsvData,
          headers?: ExchangeHeaders,
          parse?: (raw: unknown) => unknown | Promise<unknown>,
        ) => Promise<import("../../exchange.ts").Exchange>;

        const parseFn = (raw: unknown): CsvData => {
          const result = Papa.parse(raw as string, {
            header,
            delimiter,
            quoteChar,
            skipEmptyLines,
          });
          if (result.errors.length > 0) {
            const firstError = result.errors[0];
            throw rcError("RC5016", undefined, {
              message: `csv adapter: parse error at row ${firstError.row}: ${firstError.message}`,
            });
          }
          return result.data as CsvData;
        };

        if (onParseError === "fail") {
          // Defer parse to the pipeline; route.error() catches failures.
          return await rowHandler(
            csvContent as unknown as CsvData,
            undefined,
            (raw) => parseFn(raw),
          );
        }

        // 'abort' or 'skip': parse inline.
        let data: CsvData;
        try {
          data = parseFn(csvContent);
        } catch (err) {
          if (onParseError === "skip") {
            context.logger.warn(
              { err, path: filePath, adapter: "csv" },
              "csv adapter: skipped malformed CSV file (onParseError: 'skip')",
            );
            // FileSourceAdapter ignores the resolved value of this callback,
            // so a no-exchange short-circuit is safe to fudge as `never`.
            return undefined as never;
          }
          // 'abort': parseFn already wrapped as RC5016.
          throw err;
        }
        return await rowHandler(data);
      },
      abortController,
      onReady,
      meta,
    );
  };

  private async subscribeChunked(
    context: CraftContext,
    Papa: ReturnType<typeof ensurePapaparse>,
    handler: (
      message: CsvRow,
      headers?: ExchangeHeaders,
      parse?: (raw: unknown) => unknown | Promise<unknown>,
    ) => Promise<import("../../exchange.ts").Exchange>,
    abortController: AbortController,
    parseOptions: {
      header: boolean;
      delimiter: string;
      quoteChar: string;
      skipEmptyLines: boolean;
    },
    onParseError: OnParseError,
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
      abortController.signal.addEventListener("abort", onAbort, {
        once: true,
      });

      Papa.parse(stream, {
        header: parseOptions.header,
        delimiter: parseOptions.delimiter,
        quoteChar: parseOptions.quoteChar,
        skipEmptyLines: parseOptions.skipEmptyLines,
        step: (
          results: { data: CsvRow; errors: Array<{ message: string }> },
          parser: {
            pause: () => void;
            resume: () => void;
            abort: () => void;
          },
        ) => {
          if (aborted) {
            parser.abort();
            return;
          }

          rowNumber++;
          const currentRow = rowNumber;
          const rowErrors = results.errors;
          const headers: ExchangeHeaders = {
            [HeadersKeys.CSV_ROW]: currentRow,
            [HeadersKeys.CSV_PATH]: filePath,
          } as ExchangeHeaders;

          // Inline 'abort' handling: row errors abort the source on the
          // first bad row, matching pre-#187 behaviour.
          if (rowErrors.length > 0 && onParseError === "abort") {
            const firstError = rowErrors[0];
            parser.abort();
            settle(() =>
              reject(
                rcError("RC5016", undefined, {
                  message: `csv adapter: parse error at row ${currentRow}: ${firstError.message}`,
                }),
              ),
            );
            return;
          }

          // Inline 'skip' handling: drop the row, continue to the next.
          if (rowErrors.length > 0 && onParseError === "skip") {
            context.logger.warn(
              {
                err: rowErrors[0],
                path: filePath,
                row: currentRow,
                adapter: "csv",
              },
              "csv adapter: skipped malformed row (onParseError: 'skip')",
            );
            return;
          }

          parser.pause();

          // For 'fail' mode, only attach a parse callback when the row has
          // errors. Clean rows take the normal handler path with no
          // synthetic parse step, avoiding `step:started`/`step:completed`
          // event noise on every valid row.
          const hasRowErrors = rowErrors.length > 0;
          const callPromise =
            onParseError === "fail" && hasRowErrors
              ? handler(results.data as CsvRow, headers, () => {
                  const firstError = rowErrors[0];
                  throw rcError("RC5016", undefined, {
                    message: `csv adapter: parse error at row ${currentRow}: ${firstError.message}`,
                  });
                })
              : handler(results.data as CsvRow, headers);

          callPromise
            .then(() => {
              if (!aborted) {
                parser.resume();
              }
            })
            .catch((err) => {
              if (onParseError === "fail") {
                // Per-row pipeline failure: log and continue. The route's
                // `.error()` handler (or `exchange:failed` event) has
                // already fired for this row; we just keep the stream
                // flowing. Debug-level avoids double-logging what the
                // route boundary already logged.
                context.logger.debug(
                  { err, path: filePath, row: currentRow, adapter: "csv" },
                  "csv adapter: pipeline failed for row; continuing",
                );
                if (!aborted) parser.resume();
                return;
              }
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
          try {
            throwFileError("csv", filePath, err);
          } catch (wrapped) {
            settle(() => reject(wrapped));
          }
        },
      });
    });
  }
}
