import { type Transformer } from "../operations/transform.ts";
import * as cheerio from "cheerio";

export type HtmlResult = string | string[];

export interface HtmlOptions<T = unknown, R = unknown> {
  /** CSS selector to match elements. */
  selector: string;
  /**
   * What to extract. Default: "text".
   * - text: cheerio .text() (all descendant text), trimmed
   * - html: inner HTML (cheerio .html())
   * - attr: attribute value (requires attr option)
   * - outerHtml: element including its tag (cheerio .prop('outerHTML'))
   * - innerText: text only, no HTML (cheerio .text()); server-side no layout so same as textContent
   * - textContent: text only, no HTML (cheerio .text())
   */
  extract?:
    | "text"
    | "html"
    | "attr"
    | "outerHtml"
    | "innerText"
    | "textContent";
  /** Attribute name when extract is "attr". */
  attr?: string;
  /** Pluck HTML string from body. If omitted: body is used when it's a string, or body.body when body is an object (e.g. after http()). */
  from?: (body: T) => string;
  /** Where to put the extracted result. If omitted, result replaces the entire body (same default as from). Use e.g. (body, result) => ({ ...body, field: result }) to write to a sub-field. */
  to?: (body: T, result: HtmlResult) => R;
}

function getHtml<T>(body: T, from: ((body: T) => string) | undefined): string {
  if (from) return from(body);
  if (typeof body === "string") return body;
  if (
    body &&
    typeof body === "object" &&
    "body" in body &&
    typeof (body as { body: unknown }).body === "string"
  ) {
    return (body as { body: string }).body;
  }
  throw new Error(
    "html adapter: body must be a string, an object with a string body property (e.g. http() result), or provide a from() option",
  );
}

/** Strip HTML tags so only plain text remains. Used as a safeguard for text extraction. */
function stripHtmlTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export class HtmlAdapter<T = unknown, R = HtmlResult> implements Transformer<
  T,
  R
> {
  readonly adapterId = "routecraft.adapter.html";

  constructor(private readonly options: HtmlOptions<T, R>) {}

  transform(body: T): R {
    const htmlString = getHtml(body, this.options.from);
    const extract = this.options.extract ?? "text";
    const selector = this.options.selector;
    const attr = this.options.attr;

    if (extract === "attr" && !attr) {
      throw new Error('html adapter: extract "attr" requires an attr option');
    }

    const $ = cheerio.load(htmlString);
    const $el = $(selector);
    const length = $el.length;

    const isTextExtract =
      extract === "text" ||
      extract === "innerText" ||
      extract === "textContent";
    const textFrom = ($node: ReturnType<typeof $>) =>
      isTextExtract
        ? $node.clone().find("style, script").remove().end().text().trim()
        : $node.text().trim();

    const getOne = (): string => {
      if (
        extract === "text" ||
        extract === "innerText" ||
        extract === "textContent"
      )
        return stripHtmlTags(textFrom($el));
      if (extract === "html") return $el.html()?.trim() ?? "";
      if (extract === "attr") return $el.attr(attr!) ?? "";
      if (extract === "outerHtml") return $el.prop("outerHTML") ?? "";
      return "";
    };
    const getMany = (): string[] => {
      const values: string[] = [];
      $el.each((_, el) => {
        const $e = $(el);
        if (
          extract === "text" ||
          extract === "innerText" ||
          extract === "textContent"
        )
          values.push(stripHtmlTags(textFrom($e)));
        else if (extract === "html") values.push($e.html()?.trim() ?? "");
        else if (extract === "attr") values.push($e.attr(attr!) ?? "");
        else if (extract === "outerHtml")
          values.push($e.prop("outerHTML") ?? "");
      });
      return values;
    };

    let result: HtmlResult;
    if (length === 0) {
      result = "";
    } else if (length === 1) {
      result = getOne();
    } else {
      result = getMany();
    }

    const to = this.options.to;
    if (to) return to(body, result) as R;
    return result as unknown as R;
  }
}

/**
 * Creates an HTML transformer that extracts content using CSS selectors (cheerio).
 * By default uses body (or body.body when body is an object) as the HTML string and replaces the body with the extracted result. Use `from` to read HTML from a sub-field and `to` to write the result into a sub-field.
 *
 * @param options - `selector`, `extract` (text | html | attr | outerHtml | innerText | textContent), optional `from(body)`, `to(body, result)`, and for attr: `attr`
 * @returns A Transformer usable with `.transform(html(options))`
 *
 * @example
 * ```typescript
 * .transform(html({ selector: 'h1', extract: 'text' }))
 * .transform(html({ selector: '.price', extract: 'attr', attr: 'data-value', from: (b) => b.html, to: (b, v) => ({ ...b, price: v }) }))
 * ```
 */
export function html<T = unknown, R = HtmlResult>(
  options: HtmlOptions<T, R>,
): Transformer<T, R> {
  return new HtmlAdapter<T, R>(options);
}
