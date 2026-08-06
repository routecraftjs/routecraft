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
    "text" | "html" | "attr" | "outerHtml" | "innerText" | "textContent";
  /** Attribute name when extract is "attr". */
  attr?: string;
  /** Pluck HTML string from body. If omitted: body is used when it's a string, or body.body when body is an object (e.g. after http()). */
  from?: (body: T) => string;
  /** Where to put the extracted result. If omitted, result replaces the entire body (same default as from). Use e.g. (body, result) => ({ ...body, field: result }) to write to a sub-field. */
  to?: (body: T, result: HtmlResult) => R;

  // File options (when path is provided, html carries the file roles)
  /**
   * File path. Presence of `path` gives html() the file roles (source /
   * send / fetch) instead of the transformer role. The source and fetch
   * roles read the file and extract via the selector; the send role writes
   * the exchange body (HTML string) to the file. The function form receives
   * the exchange (send/fetch roles only; the source role needs a static
   * string).
   */
  path?: string | ((exchange: Exchange) => string);
  /**
   * Send role behavior: append to the file instead of overwriting it.
   * Mutually exclusive with `delete`. Default: false (overwrite)
   */
  append?: boolean;
  /**
   * Send role behavior: delete the file instead of writing it. Idempotent:
   * an already-absent path is a no-op. The body is unchanged. Mutually
   * exclusive with `append`. Default: false
   */
  delete?: boolean;
  /**
   * Text encoding (only when path is provided). Default: 'utf-8'
   */
  encoding?: BufferEncoding;
  /**
   * Create parent directories if they don't exist (send role only, only when path is provided).
   * Default: false
   */
  createDirs?: boolean;

  /**
   * How to handle an `extractHtml` failure on the file content (source role
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
   */
  onParseError?: OnParseError;
}
