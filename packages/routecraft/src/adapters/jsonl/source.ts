import * as fsp from "node:fs/promises";
import type { Source, CallableSource } from "../../operations/from.ts";
import type { JsonlSourceOptions } from "./types.ts";
import { HeadersKeys, type ExchangeHeaders } from "../../exchange.ts";
import { forEachLine } from "../shared/line-reader.ts";
import { logger } from "../../logger.ts";

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
      onParseError = "throw",
      reviver,
    } = this.options;

    if (chunked) {
      try {
        await forEachLine(
          filePath,
          encoding,
          abortController.signal,
          async (line, lineNumber) => {
            const trimmed = line.trim();
            if (trimmed === "") return;

            let parsed: T;
            try {
              parsed = JSON.parse(trimmed, reviver) as T;
            } catch (err) {
              if (onParseError === "skip") {
                logger.warn(
                  `jsonl adapter: skipping line ${lineNumber}: ${err instanceof Error ? err.message : String(err)}`,
                );
                return;
              }
              throw new Error(
                `jsonl adapter: parse error at line ${lineNumber}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }

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
        const message = err instanceof Error ? err.message : String(err);
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`jsonl adapter: file not found: ${filePath}`);
        }
        if ((err as NodeJS.ErrnoException).code === "EACCES") {
          throw new Error(
            `jsonl adapter: permission denied reading file: ${filePath}`,
          );
        }
        throw new Error(`jsonl adapter: failed to read file: ${message}`);
      }
    } else {
      const content = await fsp
        .readFile(filePath, { encoding })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            throw new Error(`jsonl adapter: file not found: ${filePath}`);
          }
          if ((err as NodeJS.ErrnoException).code === "EACCES") {
            throw new Error(
              `jsonl adapter: permission denied reading file: ${filePath}`,
            );
          }
          throw new Error(`jsonl adapter: failed to read file: ${message}`);
        });

      if (abortController.signal.aborted) return;

      const lines = content.split("\n");
      const results: T[] = [];

      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed === "") continue;

        try {
          results.push(JSON.parse(trimmed, reviver) as T);
        } catch (err) {
          if (onParseError === "skip") {
            logger.warn(
              `jsonl adapter: skipping line ${i + 1}: ${err instanceof Error ? err.message : String(err)}`,
            );
            continue;
          }
          throw new Error(
            `jsonl adapter: parse error at line ${i + 1}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      await (
        handler as (
          message: T[],
          headers?: ExchangeHeaders,
        ) => Promise<import("../../exchange.ts").Exchange>
      )(results);
    }

    if (onReady) onReady();
  };
}
