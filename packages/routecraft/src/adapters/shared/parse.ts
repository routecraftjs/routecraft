/**
 * How a source adapter handles a parse failure on an individual item.
 *
 * Source adapters that translate raw bytes into a structured body (json,
 * html, csv, jsonl, mail) accept this option to control what happens when
 * the parse step throws.
 *
 * @experimental The shape of this option may evolve as more parsing adapters
 * adopt the contract.
 */
export type OnParseError =
  /**
   * Default. The exchange fails: the route's `.error()` handler is invoked
   * with an `RC5016` error, or `exchange:failed` is emitted when no handler
   * is set. Streaming adapters continue to the next item.
   *
   * Use when you want parse failures to be observable per item and the rest
   * of the source to keep flowing.
   */
  | "fail"
  /**
   * The source aborts on the first parse failure. No exchange is created;
   * the subscribe promise rejects and `context:error` fires.
   *
   * Use when partial-data is unacceptable and a malformed item should stop
   * the import (atomic-load semantics).
   */
  | "abort"
  /**
   * The parse failure is silently dropped. No exchange is created; a
   * `warn`-level log is emitted. Streaming adapters continue to the next
   * item.
   *
   * Use when malformed items are expected (scraping, lossy upstreams) and
   * you do not want them to surface as route errors.
   */
  | "skip";

/**
 * Default `OnParseError` value applied when a parsing adapter does not set
 * one explicitly.
 */
export const DEFAULT_ON_PARSE_ERROR: OnParseError = "fail";
