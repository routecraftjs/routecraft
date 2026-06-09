import type { Destination, CallableDestination } from "../../operations/to.ts";
import type { Exchange } from "../../exchange.ts";
import type { HtmlOptions, HtmlResult } from "./types.ts";
import { file } from "../file/index.ts";
import { extractHtml, getHtml } from "./shared.ts";

/**
 * HtmlDestinationAdapter handles HTML file I/O as a destination.
 *
 * - `write` / `append` (default): write the HTML string from the body to a file.
 * - `read`: read the file, extract via the selector, and return the result, so
 *   the adapter works mid-route via `.enrich()` / `.to()` (like an HTTP GET).
 *   Extraction failures throw; the route boundary surfaces them as
 *   `exchange:failed`. The `onParseError` lifecycle controls apply to source
 *   mode only.
 * - `delete`: delete the file and pass the body through unchanged. Idempotent.
 */
export class HtmlDestinationAdapter<
  T = unknown,
  R = HtmlResult,
> implements Destination<unknown, unknown> {
  readonly adapterId = "routecraft.adapter.html";
  private readonly pathOption: string | ((exchange: Exchange) => string);

  constructor(private readonly options: HtmlOptions<T, R>) {
    if (!options.path) {
      throw new Error(
        "html adapter: destination mode requires path option to be provided",
      );
    }
    this.pathOption = options.path;
  }

  send: CallableDestination<unknown, unknown> = async (exchange) => {
    const resolvedPath =
      typeof this.pathOption === "function"
        ? this.pathOption(exchange)
        : this.pathOption;

    // Read mode: read the file, then extract via the selector and return.
    if (this.options.mode === "read") {
      const readAdapter = file({
        path: resolvedPath,
        mode: "read",
        encoding: this.options.encoding ?? "utf-8",
      });
      const content = await readAdapter.send(exchange);
      const extractOpts: HtmlOptions<string, HtmlResult> = {};
      if (this.options.selector !== undefined)
        extractOpts.selector = this.options.selector;
      if (this.options.extract !== undefined)
        extractOpts.extract = this.options.extract;
      if (this.options.attr !== undefined) extractOpts.attr = this.options.attr;
      return extractHtml<string, HtmlResult>(content, extractOpts);
    }

    // Delete mode: delegate to the file adapter (no write). Idempotent.
    if (this.options.mode === "delete") {
      const deleteAdapter = file({ path: resolvedPath, mode: "delete" });
      return deleteAdapter.send(exchange);
    }

    // Write / append: pull the HTML string from the body and write it.
    const htmlContent = getHtml(exchange.body, undefined);

    const writeMode = this.options.mode === "append" ? "append" : "write";
    const adapter = file({
      path: resolvedPath,
      mode: writeMode,
      ...(this.options.encoding !== undefined
        ? { encoding: this.options.encoding }
        : {}),
      ...(this.options.createDirs !== undefined
        ? { createDirs: this.options.createDirs }
        : {}),
    });

    await adapter.send({ ...exchange, body: htmlContent });
    return undefined;
  };
}
