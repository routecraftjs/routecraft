import type { Transformer } from "../../operations/transform.ts";
import type { HtmlOptions, HtmlResult } from "./types.ts";
import { extractHtml } from "./shared.ts";

/**
 * HtmlTransformerAdapter extracts data from HTML using CSS selectors (cheerio).
 */
export class HtmlTransformerAdapter<
  T = unknown,
  R = HtmlResult,
> implements Transformer<T, R> {
  readonly adapterId = "routecraft.adapter.html";

  constructor(private readonly options: HtmlOptions<T, R>) {}

  transform(body: T): R {
    return extractHtml(body, this.options);
  }
}
