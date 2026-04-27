import * as fsp from "node:fs/promises";
import type { Source, CallableSource } from "../../operations/from.ts";
import type { JsonlSourceOptions } from "./types.ts";
import { HeadersKeys, type ExchangeHeaders } from "../../exchange.ts";
import { forEachLine, throwFileError } from "../shared/line-reader.ts";
import { DEFAULT_ON_PARSE_ERROR } from "../shared/parse.ts";

/**
 * JsonlSourceAdapter reads JSON Lines files.
 *
 * Non-chunked: emits a single array of all parsed objects. With
 * `onParseError: 'fail'` a malformed line fails the entire array (one
 * `RC5016` covering the file) since non-chunked emits one exchange. Use
 * chunked mode for per-line `.error()` granularity.
 *
 * Chunked: emits one exchange per line with `JSONL_LINE` and `JSONL_PATH`
 * headers.
 *
 * Per-line `JSON.parse` failures are observable via the events bus:
 *
 * | `onParseError` | Lifecycle on bad line (chunked)                                  |
 * |----------------|------------------------------------------------------------------|
 * | `'fail'` (default) | `exchange:failed` (or `error:caught`); next line continues  |
 * | `'abort'`      | `exchange:failed` for the bad line, then source dies (`context:error`) |
 * | `'drop'`       | `exchange:dropped` (`reason: "parse-failed"`); next line continues |
 *
 * See #187.
 *
 * @beta
 */
export class JsonlSourceAdapter<T = unknown> implements Source<T | T[]> {
  readonly adapterId = "routecraft.adapter.jsonl";

  constructor(private readonly options: JsonlSourceOptions) {}

  subscribe: CallableSource<T | T[]> = async (
    context,
    handler,
    abortController,
    onReady,
  ) => {
    if (abortController.signal.aborted) return;

    const {
      path: filePath,
      encoding = "utf-8",
      chunked = false,
      reviver,
      onParseError = DEFAULT_ON_PARSE_ERROR,
    } = this.options;

    if (chunked) {
      if (onReady) onReady();
      try {
        await forEachLine(
          filePath,
          encoding,
          abortController.signal,
          async (line, lineNumber) => {
            const trimmed = line.trim();
            if (trimmed === "") return;

            const headers: ExchangeHeaders = {
              [HeadersKeys.JSONL_LINE]: lineNumber,
              [HeadersKeys.JSONL_PATH]: filePath,
            } as ExchangeHeaders;

            const lineHandler = handler as (
              message: T,
              headers?: ExchangeHeaders,
              parse?: (raw: unknown) => unknown | Promise<unknown>,
              parseFailureMode?: "fail" | "abort" | "drop",
            ) => Promise<import("../../exchange.ts").Exchange>;

            // Defer parse to the synthetic pipeline step. The mode the
            // runtime uses controls observability:
            //   'fail'  -> exchange:failed; we .catch() and continue
            //   'abort' -> exchange:failed; we let the rejection propagate
            //              out of forEachLine to abort the source
            //   'drop'  -> exchange:dropped; promise resolves cleanly
            const promise = lineHandler(
              trimmed as unknown as T,
              headers,
              (raw) => JSON.parse(raw as string, reviver) as T,
              onParseError,
            );

            if (onParseError === "abort") {
              await promise;
              return;
            }

            // 'fail' and 'drop': swallow rejection (route boundary already
            // emitted the lifecycle event). Debug-level avoids
            // double-logging what runSteps already logged.
            await promise.catch((err) => {
              context.logger.debug(
                { err, path: filePath, line: lineNumber, adapter: "jsonl" },
                "jsonl adapter: pipeline failed for line; continuing",
              );
            });
          },
        );
      } catch (err) {
        if (abortController.signal.aborted) return;
        throwFileError("jsonl", filePath, err);
      }
      return;
    }

    // Non-chunked: single exchange with the full parsed array. The
    // synthetic parse step parses ALL lines as one operation, so a single
    // bad line fails the whole array. For per-line granularity use
    // chunked mode.
    const content = await fsp
      .readFile(filePath, { encoding })
      .catch((err) => throwFileError("jsonl", filePath, err));

    if (abortController.signal.aborted) return;

    const lines = content.split("\n");
    const arrayHandler = handler as (
      message: T[],
      headers?: ExchangeHeaders,
      parse?: (raw: unknown) => unknown | Promise<unknown>,
      parseFailureMode?: "fail" | "abort" | "drop",
    ) => Promise<import("../../exchange.ts").Exchange>;

    const rawLines: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed !== "") rawLines.push(trimmed);
    }

    const promise = arrayHandler(
      rawLines as unknown as T[],
      undefined,
      (raw) => (raw as string[]).map((l) => JSON.parse(l, reviver) as T),
      onParseError,
    );

    if (onParseError === "abort") {
      await promise;
    } else {
      await promise.catch((err) => {
        context.logger.debug(
          { err, path: filePath, adapter: "jsonl" },
          "jsonl adapter: pipeline failed; non-chunked emits one exchange",
        );
      });
    }

    if (onReady) onReady();
  };
}
