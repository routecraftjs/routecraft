import * as fsp from "node:fs/promises";
import type { Source, CallableSource } from "../../operations/from.ts";
import type { FileOptions } from "./types.ts";
import { HeadersKeys, type ExchangeHeaders } from "../../exchange.ts";
import { forEachLine, throwFileError } from "../shared/line-reader.ts";

/**
 * FileSourceAdapter implements the Source interface for reading files.
 * Reads the file once and emits its content as a string.
 * When chunked is true, emits one exchange per line.
 */
export class FileSourceAdapter implements Source<string> {
  readonly adapterId = "routecraft.adapter.file";

  constructor(private readonly options: FileOptions) {}

  /**
   * Source implementation: subscribe to file content.
   * Reads the file once (or line-by-line when chunked).
   */
  subscribe: CallableSource<string> = async (sub) => {
    // Check if already aborted
    if (sub.signal.aborted) return;

    const {
      path: filePath,
      encoding = "utf-8",
      chunked = false,
    } = this.options;

    if (typeof filePath !== "string") {
      throw new Error(
        "file adapter: path must be a string for source mode (dynamic paths are only supported for destinations)",
      );
    }

    // Ready means "wired and able to produce", so signal before reading
    // rather than after the file is fully emitted.
    sub.ready();

    if (chunked) {
      try {
        await forEachLine(
          filePath,
          encoding,
          sub.signal,
          async (line, lineNumber) => {
            const headers: ExchangeHeaders = {
              [HeadersKeys.FILE_LINE]: lineNumber,
              [HeadersKeys.FILE_PATH]: filePath,
            } as ExchangeHeaders;
            try {
              await sub.emit({ message: line, headers });
            } catch (err) {
              // Pipeline failure for one line, not a file error: the route
              // boundary already emitted exchange:failed; keep reading
              // (matching json/jsonl/csv chunked semantics).
              if (sub.signal.aborted) return;
              sub.context.logger.debug(
                { err, path: filePath, line: lineNumber, adapter: "file" },
                "file adapter: pipeline failed for line; continuing",
              );
            }
          },
        );
      } catch (err) {
        if (sub.signal.aborted) return;
        throwFileError("file", filePath, err);
      }
    } else {
      const content = await fsp
        .readFile(filePath, { encoding })
        .catch((err) => throwFileError("file", filePath, err));

      // Check if aborted before emitting
      if (sub.signal.aborted) return;

      // Emit the content
      await sub.emit({ message: content });
    }
  };
}
