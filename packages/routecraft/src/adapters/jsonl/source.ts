import * as fsp from "node:fs/promises";
import type { Source, CallableSource } from "../../operations/from.ts";
import type { JsonlSourceOptions } from "./types.ts";
import { HeadersKeys, type ExchangeHeaders } from "../../exchange.ts";
import { forEachLine, throwFileError } from "../shared/line-reader.ts";

/**
 * JsonlSourceAdapter reads JSON Lines files.
 * Non-chunked: emits a single array of all parsed objects.
 * Chunked: emits one exchange per line with JSONL_LINE and JSONL_PATH headers.
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

            const parsed = JSON.parse(trimmed, reviver) as T;

            const headers: ExchangeHeaders = {
              [HeadersKeys.JSONL_LINE]: lineNumber,
              [HeadersKeys.JSONL_PATH]: filePath,
            } as ExchangeHeaders;

            await (
              handler as (
                message: T,
                headers?: ExchangeHeaders,
              ) => Promise<import("../../exchange.ts").Exchange>
            )(parsed, headers);
          },
        );
      } catch (err) {
        if (abortController.signal.aborted) return;
        throwFileError("jsonl", filePath, err);
      }
    } else {
      const content = await fsp
        .readFile(filePath, { encoding })
        .catch((err) => throwFileError("jsonl", filePath, err));

      if (abortController.signal.aborted) return;

      const lines = content.split("\n");
      const results: T[] = [];

      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed === "") continue;
        results.push(JSON.parse(trimmed, reviver) as T);
      }

      await (
        handler as (
          message: T[],
          headers?: ExchangeHeaders,
        ) => Promise<import("../../exchange.ts").Exchange>
      )(results);

      if (onReady) onReady();
    }
  };
}
