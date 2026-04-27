import type { Source, CallableSource } from "../../operations/from.ts";
import type { JsonFileOptions } from "./types.ts";
import type { FileOptions } from "../file/types.ts";
import { file } from "../file/index.ts";
import { DEFAULT_ON_PARSE_ERROR } from "../shared/parse.ts";

/**
 * JsonSourceAdapter reads and parses JSON files.
 *
 * Parses are deferred to the route's pipeline by passing a `parse` callback
 * to `handler(...)`: the runtime applies it as a synthetic first step so a
 * malformed JSON file becomes an observable pipeline event:
 *
 * | `onParseError` | Lifecycle on bad JSON                                          |
 * |----------------|----------------------------------------------------------------|
 * | `'fail'` (default) | `exchange:failed` (or `error:caught` if `.error()` recovers) |
 * | `'abort'`      | `exchange:failed`, then source rejects and `context:error` fires |
 * | `'drop'`       | `exchange:dropped` with `reason: "parse-failed"`               |
 *
 * See #187.
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

    return this.fileAdapter.subscribe(
      context,
      async (content: string) => {
        // All three modes route through the synthetic parse step so the
        // exchange exists, lifecycle events fire, and the route can
        // observe each outcome:
        //   'fail'  -> exchange:failed (or .error() recovers)
        //   'abort' -> exchange:failed, then we rethrow to abort the source
        //   'drop'  -> exchange:dropped with reason "parse-failed"
        const promise = handler(
          content as unknown,
          undefined,
          (raw) => JSON.parse(raw as string, reviver as never),
          onParseError,
        );
        if (onParseError === "abort") {
          // Let the rejection propagate so FileSourceAdapter's caller
          // observes it and the source dies with context:error.
          return await promise;
        }
        // 'fail' and 'drop': swallow the rejection here (it has already
        // been emitted as exchange:failed or exchange:dropped). Single-
        // exchange adapter so there is no "next item" to continue to,
        // but we still need to not propagate the error out of subscribe.
        return await promise.catch(() => undefined as never);
      },
      abortController,
      onReady,
      meta,
    );
  };
}
