import type { Source, CallableSource } from "../../operations/from.ts";
import type { HtmlOptions, HtmlResult } from "./types.ts";
import type { FileOptions } from "../file/types.ts";
import { file } from "../file/index.ts";
import { extractHtml } from "./shared.ts";
import { DEFAULT_ON_PARSE_ERROR } from "../shared/parse.ts";
import { logger } from "../../logger.ts";

/**
 * HtmlSourceAdapter reads HTML from a file and extracts data using CSS selectors.
 * Only available when path option is provided.
 *
 * Extraction is deferred to the route's pipeline by passing a `parse`
 * callback to `handler(...)`: the runtime applies it as a synthetic first
 * step so a malformed HTML file becomes a normal pipeline error that the
 * route's `.error()` handler can catch (default `onParseError: 'fail'`).
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
    const filePath = this.options.path as string;
    const opts = this.options as HtmlOptions<T, R>;

    return this.fileAdapter.subscribe(
      context,
      async (htmlContent: string) => {
        if (onParseError === "fail") {
          // Defer extraction to the pipeline so route.error() can catch it.
          return await handler(
            htmlContent as unknown as HtmlResult,
            undefined,
            (raw) => extractHtml(raw as T, opts) as HtmlResult,
          );
        }

        // 'abort' or 'skip': run extraction inline.
        let result: HtmlResult;
        try {
          result = extractHtml(htmlContent as T, opts) as HtmlResult;
        } catch (err) {
          if (onParseError === "skip") {
            logger.warn(
              { err, path: filePath, adapter: "html" },
              "html adapter: skipped malformed HTML file (onParseError: 'skip')",
            );
            return undefined as never;
          }
          // 'abort'
          throw err;
        }
        return handler(result);
      },
      abortController,
      onReady,
      meta,
    );
  };
}
