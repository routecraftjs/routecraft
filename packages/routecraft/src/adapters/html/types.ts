import type { Exchange } from "../../exchange.ts";
import type { OnParseError } from "../shared/parse.ts";

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

  /**
   * How to handle an `extractHtml` failure on the file content (source mode
   * only).
   *
   * - `'fail'` (default): `exchange:failed` fires; the route's `.error()`
   *   handler can recover.
   * - `'abort'`: `exchange:failed` fires, then the source dies
   *   (`context:error`).
   * - `'drop'`: `exchange:dropped` fires with `reason: "parse-failed"`.
   *
   * See `OnParseError` for full semantics.
   *
   * @default "fail"
   * @experimental
   */
  onParseError?: OnParseError;
}
