import { createReadStream } from "node:fs";
import type { Source, CallableSource } from "../../operations/from.ts";
import type { CsvOptions, CsvData, CsvRow } from "./types.ts";
import { HeadersKeys, type ExchangeHeaders } from "../../exchange.ts";
import { file } from "../file/index.ts";
import { ensurePapaparse } from "./shared.ts";
import { throwFileError } from "../shared/line-reader.ts";
import { DEFAULT_ON_PARSE_ERROR, type OnParseError } from "../shared/parse.ts";
import type { CraftContext } from "../../context.ts";

/**
 * CsvSourceAdapter reads CSV files and parses them via PapaParse.
 *
 * Non-chunked: emits a single exchange whose body is the full parsed array.
 * Chunked: streams rows from disk and emits one exchange per row with
 * `CSV_ROW` and `CSV_PATH` headers; uses `parser.pause()` /
 * `parser.resume()` around each handler call for backpressure.
 *
 * Per-row parse failures are observable via the events bus:
 *
 * | `onParseError` | Lifecycle on bad row (chunked)                                  |
 * |----------------|-----------------------------------------------------------------|
 * | `'fail'` (default) | `exchange:failed` (or `error:caught`); next row continues |
 * | `'abort'`      | `exchange:failed` for the bad row, then source dies (`context:error`) |
 * | `'drop'`       | `exchange:dropped` (`reason: "parse-failed"`); next row continues |
 *
 * See #187.
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
          parseFailureMode?: OnParseError,
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
          parseFailureMode?: OnParseError,
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
            throw new Error(
              `csv adapter: parse error at row ${firstError.row}: ${firstError.message}`,
            );
          }
          return result.data as CsvData;
        };

        const promise = rowHandler(
          csvContent as unknown as CsvData,
          undefined,
          parseFn,
          onParseError,
        );
        if (onParseError === "abort") {
          return await promise;
        }
        return await promise.catch(() => undefined as never);
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
      parseFailureMode?: OnParseError,
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

          parser.pause();

          // Only attach a parse callback when the row actually has errors.
          // Clean rows take the normal handler path with no synthetic parse
          // step so we do not emit a no-op `step:started`/`step:completed`
          // for every valid row in a 1M-row CSV.
          const hasRowErrors = rowErrors.length > 0;
          const callPromise = hasRowErrors
            ? handler(
                results.data as CsvRow,
                headers,
                () => {
                  const firstError = rowErrors[0];
                  throw new Error(
                    `csv adapter: parse error at row ${currentRow}: ${firstError.message}`,
                  );
                },
                onParseError,
              )
            : handler(results.data as CsvRow, headers);

          callPromise
            .then(() => {
              if (!aborted) parser.resume();
            })
            .catch((err) => {
              if (onParseError === "abort") {
                // Abort the stream and reject the subscribe promise so
                // the source dies. The route boundary already emitted
                // exchange:failed for this row.
                parser.abort();
                settle(() => reject(err));
                return;
              }
              // 'fail' or 'drop': route boundary has already emitted the
              // appropriate lifecycle event (exchange:failed or
              // exchange:dropped); just keep the stream flowing.
              context.logger.debug(
                { err, path: filePath, row: currentRow, adapter: "csv" },
                "csv adapter: pipeline failed for row; continuing",
              );
              if (!aborted) parser.resume();
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
