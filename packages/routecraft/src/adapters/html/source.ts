import type { Source, CallableSource } from "../../operations/from.ts";
import type { HtmlOptions, HtmlResult } from "./types.ts";
import type { FileOptions } from "../file/types.ts";
import { file } from "../file/index.ts";
import { extractHtml } from "./shared.ts";

/**
 * HtmlSourceAdapter reads HTML from a file and extracts data using CSS selectors.
 * Only available when path option is provided.
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
  ) => {
    return this.fileAdapter.subscribe(
      context,
      async (htmlContent: string) => {
        const result = extractHtml(
          htmlContent as T,
          this.options as HtmlOptions<T, R>,
        );
        return handler(result as HtmlResult);
      },
      abortController,
      onReady,
    );
  };
}
