import type { Enricher, CallableEnricher } from "../../operations/enrich.ts";
import type { Exchange } from "../../exchange.ts";
import type { HtmlOptions, HtmlResult } from "./types.ts";
import { FileEnricherAdapter } from "../file/enricher.ts";
import { extractHtml } from "./shared.ts";

/**
 * HtmlEnricherAdapter implements the Enricher (fetch) role for HTML files:
 * `fetch` reads the resolved path, extracts via the selector, and returns
 * the raw extracted result, so `.enrich(html({ path, selector }))` pulls an
 * extraction into the route mid-flow. The transformer-role `to` mapping is
 * not applied (the raw `HtmlResult` is returned and placement is left to
 * the aggregator). Extraction failures throw (the route boundary surfaces
 * them as `exchange:failed`); the `onParseError` lifecycle controls apply to
 * the source role only.
 */
export class HtmlEnricherAdapter<
  T = unknown,
  R = HtmlResult,
> implements Enricher<unknown, HtmlResult> {
  readonly adapterId = "routecraft.adapter.html";
  private readonly pathOption: string | ((exchange: Exchange) => string);

  constructor(private readonly options: HtmlOptions<T, R>) {
    if (!options.path) {
      throw new Error(
        "html adapter: the fetch role requires the path option to be provided",
      );
    }
    this.pathOption = options.path;
  }

  /** Fetch implementation: read the resolved path and return the extraction. */
  fetch: CallableEnricher<unknown, HtmlResult> = async (exchange, ctx) => {
    const resolvedPath =
      typeof this.pathOption === "function"
        ? this.pathOption(exchange)
        : this.pathOption;
    // Only the fetch slot is needed; skip the full file() facade on the
    // hot path.
    const content = await new FileEnricherAdapter({
      path: resolvedPath,
      encoding: this.options.encoding ?? "utf-8",
    }).fetch(exchange, ctx);
    const extractOpts: HtmlOptions<string, HtmlResult> = {};
    if (this.options.selector !== undefined)
      extractOpts.selector = this.options.selector;
    if (this.options.extract !== undefined)
      extractOpts.extract = this.options.extract;
    if (this.options.attr !== undefined) extractOpts.attr = this.options.attr;
    return extractHtml<string, HtmlResult>(content, extractOpts);
  };
}
