import { type Transformer } from "../operations/transform.ts";
import { type Source, type CallableSource } from "../operations/from.ts";
import {
  type Destination,
  type CallableDestination,
} from "../operations/to.ts";
import { type Exchange } from "../exchange.ts";
import { file, type FileAdapter } from "./file.ts";
import * as cheerio from "cheerio";

export type HtmlResult = string | string[];

export interface HtmlOptions<T = unknown, R = unknown> {
  /**
   * CSS selector to match elements.
   * Optional when using file destination mode (path + mode: "write"/"append").
   * Required for transformer mode and source mode.
   */
  selector?: string;
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

  // File options (when path is provided, html becomes a source/destination)
  /**
   * File path for source/destination mode.
   * When provided, html() reads/writes HTML files using file() adapter.
   * For sources, the HTML is read from file and parsed.
   * For destinations, the exchange body (HTML string) is written to file.
   */
  path?: string | ((exchange: Exchange) => string);
  /**
   * File operation mode (only when path is provided).
   * - 'read': Read file (source mode)
   * - 'write': Write/overwrite file (destination mode)
   * - 'append': Append to file (destination mode)
   * Default: 'read' for source, 'write' for destination
   */
  mode?: "read" | "write" | "append";
  /**
   * Text encoding (only when path is provided). Default: 'utf-8'
   */
  encoding?: BufferEncoding;
  /**
   * Create parent directories if they don't exist (destination mode only, only when path is provided).
   * Default: false
   */
  createDirs?: boolean;
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

export class HtmlAdapter<T = unknown, R = HtmlResult>
  implements Transformer<T, R>, Source<HtmlResult>, Destination<unknown, void>
{
  readonly adapterId = "routecraft.adapter.html";
  private fileAdapter?: FileAdapter;

  constructor(private readonly options: HtmlOptions<T, R>) {
    // If path is provided, create file adapter for I/O
    if (options.path) {
      const fileOpts: {
        path: string | ((exchange: Exchange) => string);
        mode?: "read" | "write" | "append";
        encoding?: BufferEncoding;
        createDirs?: boolean;
      } = {
        path: options.path,
      };
      if (options.mode !== undefined) fileOpts.mode = options.mode;
      if (options.encoding !== undefined) fileOpts.encoding = options.encoding;
      if (options.createDirs !== undefined)
        fileOpts.createDirs = options.createDirs;
      this.fileAdapter = file(fileOpts);
    }
  }

  transform(body: T): R {
    const htmlString = getHtml(body, this.options.from);
    const extract = this.options.extract ?? "text";
    const selector = this.options.selector;
    const attr = this.options.attr;

    if (!selector) {
      throw new Error(
        "html adapter: selector is required for transformer mode (use with .transform() or source mode)",
      );
    }

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

  /**
   * Source implementation: read HTML file and extract data.
   * Only available when path option is provided.
   */
  subscribe: CallableSource<HtmlResult> = async (
    context,
    handler,
    abortController,
    onReady,
  ) => {
    if (!this.fileAdapter) {
      throw new Error(
        "html adapter: source mode requires path option to be provided",
      );
    }

    // Use file adapter to read HTML, then transform it
    return this.fileAdapter.subscribe(
      context,
      async (htmlContent: string) => {
        // Transform the HTML content using the html extraction logic
        const result = this.transform(htmlContent as T);
        return handler(result as HtmlResult);
      },
      abortController,
      onReady,
    );
  };

  /**
   * Destination implementation: write HTML string to file.
   * Only available when path option is provided.
   */
  send: CallableDestination<unknown, void> = async (exchange) => {
    if (!this.fileAdapter) {
      throw new Error(
        "html adapter: destination mode requires path option to be provided",
      );
    }

    // Extract HTML string from exchange body
    let htmlContent: string;
    if (typeof exchange.body === "string") {
      htmlContent = exchange.body;
    } else if (
      exchange.body &&
      typeof exchange.body === "object" &&
      "body" in exchange.body &&
      typeof (exchange.body as { body: unknown }).body === "string"
    ) {
      htmlContent = (exchange.body as { body: string }).body;
    } else {
      throw new Error(
        "html adapter: destination mode requires exchange.body to be a string or an object with a string body property",
      );
    }

    // Create modified exchange with HTML content as body
    const modifiedExchange: Exchange = {
      ...exchange,
      body: htmlContent,
    };

    // Use file adapter to write HTML
    await this.fileAdapter.send(modifiedExchange);
  };
}

/**
 * Create an HTML adapter that extracts data from HTML using CSS selectors (cheerio).
 *
 * **Transformer mode** (no path option):
 * - Extracts data from HTML string in exchange body
 * - By default uses body (or body.body when object) as HTML source
 * - Use `from` to read a sub-field and `to` to write result to a sub-field
 *
 * **Source/Destination mode** (with path option):
 * - As a **source** (.from): Reads HTML file, extracts data using selector
 * - As a **destination** (.to): Writes HTML string to file
 * - Uses file() adapter internally for I/O operations
 * - Supports file options: encoding, createDirs, mode
 *
 * @param options - selector, extract type, optional path for file I/O, optional from/to for transformer mode
 * @returns HtmlAdapter implementing Transformer, Source, and Destination
 *
 * @example
 * ```typescript
 * // Transformer mode (existing)
 * .transform(html({ selector: 'title', extract: 'text' }))
 *
 * // Source mode: read HTML file and extract
 * .from(html({ path: './page.html', selector: 'h1', extract: 'text' }))
 *
 * // Destination mode: write HTML to file
 * .to(html({ path: './output.html', mode: 'write' }))
 * ```
 */
export function html<T = unknown, R = HtmlResult>(
  options: HtmlOptions<T, R>,
): HtmlAdapter<T, R> {
  return new HtmlAdapter<T, R>(options);
}
