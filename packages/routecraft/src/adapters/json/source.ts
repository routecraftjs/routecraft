import type { Source, CallableSource } from "../../operations/from.ts";
import type { JsonFileOptions } from "./types.ts";
import type { FileOptions } from "../file/types.ts";
import { file } from "../file/index.ts";
import { DEFAULT_ON_PARSE_ERROR } from "../shared/parse.ts";
import { logger } from "../../logger.ts";

/**
 * JsonSourceAdapter reads and parses JSON files.
 *
 * Parses are deferred to the route's pipeline by passing a `parse` callback
 * to `handler(...)`: the runtime applies it as a synthetic first step so a
 * malformed JSON file becomes a normal pipeline error that the route's
 * `.error()` handler can catch (default `onParseError: 'fail'`). See #187.
 */
export class JsonSourceAdapter implements Source<unknown> {
  readonly adapterId = "routecraft.adapter.json.file";
  private readonly fileAdapter;

  constructor(private readonly options: JsonFileOptions) {
    if (typeof options.path !== "string") {
      throw new Error(
        "json adapter: dynamic paths (path as function) are only supported for destination mode",
      );
    }
    // Build options object, only including defined properties to satisfy exactOptionalPropertyTypes
    const fileOptions: FileOptions = { path: options.path };
    if (options.mode !== undefined) fileOptions.mode = options.mode;
    if (options.encoding !== undefined) fileOptions.encoding = options.encoding;
    if (options.createDirs !== undefined)
      fileOptions.createDirs = options.createDirs;
    this.fileAdapter = file(fileOptions);
  }

  subscribe: CallableSource<unknown> = async (
    context,
    handler,
    abortController,
    onReady,
    meta,
  ) => {
    const onParseError = this.options.onParseError ?? DEFAULT_ON_PARSE_ERROR;
    const reviver = this.options.reviver;
    const filePath = this.options.path as string;

    return this.fileAdapter.subscribe(
      context,
      async (content: string) => {
        if (onParseError === "fail") {
          // Defer parse to the pipeline so route.error() can catch it.
          return await handler(content as unknown, undefined, (raw) =>
            JSON.parse(raw as string, reviver as never),
          );
        }

        // 'abort' or 'skip': parse inline so we can either throw out of the
        // source or silently swallow without ever creating an exchange.
        let parsed: unknown;
        try {
          parsed = JSON.parse(content, reviver as never);
        } catch (err) {
          if (onParseError === "skip") {
            logger.warn(
              { err, path: filePath, adapter: "json" },
              "json adapter: skipped malformed JSON file (onParseError: 'skip')",
            );
            return undefined as never;
          }
          // 'abort'
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(`json adapter: failed to parse JSON: ${message}`);
        }
        return await handler(parsed);
      },
      abortController,
      onReady,
      meta,
    );
  };
}
