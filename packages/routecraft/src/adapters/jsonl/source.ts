import * as fsp from "node:fs/promises";
import type { Source, CallableSource } from "../../operations/from.ts";
import type { JsonlSourceOptions } from "./types.ts";
import { HeadersKeys, type ExchangeHeaders } from "../../exchange.ts";
import { forEachLine, throwFileError } from "../shared/line-reader.ts";
import { DEFAULT_ON_PARSE_ERROR } from "../shared/parse.ts";
import { logger } from "../../logger.ts";

/**
 * JsonlSourceAdapter reads JSON Lines files.
 *
 * Non-chunked: emits a single array of all parsed objects.
 * Chunked: emits one exchange per line with `JSONL_LINE` and `JSONL_PATH`
 * headers.
 *
 * Per-line `JSON.parse` failures are routed by the `onParseError` option
 * (default `'fail'`). With `'fail'`, the parse runs as a synthetic first
 * pipeline step so the route's `.error()` handler can catch it (or
 * `exchange:failed` fires) and the source continues to the next line in
 * chunked mode. See #187.
 *
 * @beta
 */
export class JsonlSourceAdapter<T = unknown> implements Source<T | T[]> {
  readonly adapterId = "routecraft.adapter.jsonl";

  constructor(private readonly options: JsonlSourceOptions) {}

  subscribe: CallableSource<T | T[]> = async (
    _context,
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
            ) => Promise<import("../../exchange.ts").Exchange>;

            if (onParseError === "fail") {
              // Defer parse to the pipeline; per-line errors flow through
              // route.error() and the source continues to the next line.
              await lineHandler(
                trimmed as unknown as T,
                headers,
                (raw) => JSON.parse(raw as string, reviver) as T,
              ).catch((err) => {
                logger.debug(
                  { err, path: filePath, line: lineNumber, adapter: "jsonl" },
                  "jsonl adapter: pipeline failed for line; continuing",
                );
              });
              return;
            }

            // 'abort' or 'skip': parse inline.
            let parsed: T;
            try {
              parsed = JSON.parse(trimmed, reviver) as T;
            } catch (err) {
              if (onParseError === "skip") {
                logger.warn(
                  { err, path: filePath, line: lineNumber, adapter: "jsonl" },
                  "jsonl adapter: skipped malformed line (onParseError: 'skip')",
                );
                return;
              }
              // 'abort': rethrow so forEachLine's caller aborts the source.
              throw err;
            }
            await lineHandler(parsed, headers);
          },
        );
      } catch (err) {
        if (abortController.signal.aborted) return;
        throwFileError("jsonl", filePath, err);
      }
      return;
    }

    // Non-chunked: single exchange with the full parsed array.
    const content = await fsp
      .readFile(filePath, { encoding })
      .catch((err) => throwFileError("jsonl", filePath, err));

    if (abortController.signal.aborted) return;

    const lines = content.split("\n");
    const arrayHandler = handler as (
      message: T[],
      headers?: ExchangeHeaders,
      parse?: (raw: unknown) => unknown | Promise<unknown>,
    ) => Promise<import("../../exchange.ts").Exchange>;

    if (onParseError === "fail") {
      // Pass raw non-empty lines; the synthetic parse step parses each one.
      const rawLines: string[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed !== "") rawLines.push(trimmed);
      }
      await arrayHandler(rawLines as unknown as T[], undefined, (raw) =>
        (raw as string[]).map((l) => JSON.parse(l, reviver) as T),
      );
      if (onReady) onReady();
      return;
    }

    // 'abort' or 'skip': parse inline.
    const results: T[] = [];
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed === "") continue;
      try {
        results.push(JSON.parse(trimmed, reviver) as T);
      } catch (err) {
        if (onParseError === "skip") {
          logger.warn(
            { err, path: filePath, line: i + 1, adapter: "jsonl" },
            "jsonl adapter: skipped malformed line (onParseError: 'skip')",
          );
          continue;
        }
        // 'abort'
        throw err;
      }
    }

    await arrayHandler(results);
    if (onReady) onReady();
  };
}
