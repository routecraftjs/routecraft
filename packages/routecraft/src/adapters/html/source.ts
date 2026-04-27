import type { Source, CallableSource } from "../../operations/from.ts";
import type { HtmlOptions, HtmlResult } from "./types.ts";
import type { FileOptions } from "../file/types.ts";
import { file } from "../file/index.ts";
import { extractHtml } from "./shared.ts";
import { DEFAULT_ON_PARSE_ERROR, isParseError } from "../shared/parse.ts";

/**
 * HtmlSourceAdapter reads HTML from a file and extracts data using CSS selectors.
 * Only available when path option is provided.
 *
 * Extraction is deferred to the route's pipeline by passing a `parse`
 * callback to `handler(...)`: the runtime applies it as a synthetic first
 * step so an extraction failure becomes an observable pipeline event.
 *
 * | `onParseError` | Lifecycle on extraction failure                                  |
 * |----------------|------------------------------------------------------------------|
 * | `'fail'` (default) | `exchange:failed` (or `error:caught` if `.error()` recovers) |
 * | `'abort'`      | `exchange:failed`, then source rejects and `context:error` fires |
 * | `'drop'`       | `exchange:dropped` with `reason: "parse-failed"`                 |
 *
 * See #187.
 */
export class HtmlSourceAdapter<
  T = unknown,
  R = HtmlResult,
> implements Source<HtmlResult> {
  readonly adapterId = "routecraft.adapter.html";
  private readonly fileAdapter;

  constructor(private readonly options: HtmlOptions<T, R>) {
    if (!options.path) {
      throw new Error(
        "html adapter: source mode requires path option to be provided",
      );
    }
    if (typeof options.path !== "string") {
      throw new Error(
        "html adapter: source mode requires a static string path (dynamic paths are only supported for destinations)",
      );
    }
    const fileOpts: FileOptions = { path: options.path };
    if (options.mode !== undefined) fileOpts.mode = options.mode;
    if (options.encoding !== undefined) fileOpts.encoding = options.encoding;
    if (options.createDirs !== undefined)
      fileOpts.createDirs = options.createDirs;
    this.fileAdapter = file(fileOpts);
  }

  subscribe: CallableSource<HtmlResult> = async (
    context,
    handler,
    abortController,
    onReady,
    meta,
  ) => {
    const onParseError = this.options.onParseError ?? DEFAULT_ON_PARSE_ERROR;
    const opts = this.options;
    const filePath = opts.path as string;

    return this.fileAdapter.subscribe(
      context,
      async (htmlContent: string) => {
        const promise = handler(
          htmlContent as unknown as HtmlResult,
          undefined,
          (raw) => extractHtml(raw as T, opts) as HtmlResult,
          onParseError,
        );
        // 'abort' is parse-specific: only RC5016 should tear down the
        // source. Downstream destination errors must NOT propagate as
        // an abort signal even when onParseError === 'abort'.
        return await promise.catch((err: unknown) => {
          if (onParseError === "abort" && isParseError(err)) throw err;
          // 'fail' / 'drop' / non-parse failures under 'abort': route
          // boundary already emitted the appropriate lifecycle event
          // (exchange:failed or exchange:dropped). Log at debug for
          // operator parity with jsonl/source.ts and swallow so the
          // file source keeps reading. The file adapter ignores the
          // resolved value, so returning undefined is safe.
          context.logger.debug(
            { err, path: filePath, adapter: "html" },
            "html adapter: pipeline failed for file; continuing",
          );
          return undefined as never;
        });
      },
      abortController,
      onReady,
      meta,
    );
  };
}
